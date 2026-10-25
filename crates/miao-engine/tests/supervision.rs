use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Fixture {
    calls: AtomicUsize,
}
#[async_trait]
impl Provider for Fixture {
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let task = request.messages[0].content[0]["text"].as_str().unwrap();
        match task {
            "loop" => {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(Reply {
                    content: json!([{"type":"tool_use","id":format!("call_{call}"),"name":"read_file","input":{"path":"file"}}]),
                    usage: json!({}),
                    needs_tools: true,
                })
            }
            "panic" => panic!("fixture provider panic"),
            "notice" => {
                progress
                    .send(json!({"kind":"provider.attempt","protocol":"fixture","attempt":0,"status":200,"outcome":"headers_received","detail":null}))
                    .await
                    .unwrap();
                Ok(Reply {
                    content: json!([{"type":"text","text":"done"}]),
                    usage: json!({}),
                    needs_tools: false,
                })
            }
            // One attempt's notice, then no answer at all: the retry budget for
            // a turn that produced nothing must survive the notice.
            "notice-then-transport" => {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                progress
                    .send(json!({"kind":"provider.attempt","protocol":"fixture","attempt":call,"status":null,"outcome":"transport_unknown","detail":null}))
                    .await
                    .unwrap();
                Err(ProviderError::Transport)
            }
            "pending" => {
                cancel.cancelled().await;
                Err(ProviderError::Interrupted)
            }
            "progress" => {
                for i in 0..600 {
                    progress
                        .send(json!({"index":i,"text":"delta"}))
                        .await
                        .unwrap();
                }
                Ok(Reply {
                    content: json!([{"type":"text","text":"done"}]),
                    usage: json!({}),
                    needs_tools: false,
                })
            }
            _ => unreachable!(),
        }
    }
}
fn input(session: &str, prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}
async fn terminal(store: &Store, session: &str) -> String {
    let mut after = 0;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let events = store.events(session, after, 2000).await.unwrap();
            if let Some(event) = events.iter().find(|event| event.kind == "run.finished") {
                return event.data["reason"].as_str().unwrap().to_owned();
            }
            if let Some(event) = events.last() {
                after = event.seq;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("run.finished was not observed after journal cursor {after}"))
}

#[tokio::test]
async fn repeated_identical_calls_are_refused_with_a_corrective_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "unchanged").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Fixture {
            calls: AtomicUsize::new(0),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("s", "loop"), true).await.unwrap();
    assert_eq!(terminal(&store, "s").await, "completed");
    let events = store.events("s", 0, 2000).await.unwrap();
    assert_eq!(
        events.iter().filter(|e| e.kind == "tool.completed").count(),
        25
    );
    assert!(events.iter().any(|e| e.kind == "tool.completed"
        && e.data["result"]["error"]
            .as_str()
            .is_some_and(|text| text.contains("Refusing to run read_file again"))));
    assert_eq!(
        events.iter().filter(|e| e.kind == "loop.detected").count(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn lagging_progress_subscriber_does_not_block_completion() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Fixture {
            calls: AtomicUsize::new(0),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let mut lagging = runtime.progress();
    runtime.admit(input("s", "progress"), true).await.unwrap();
    assert_eq!(terminal(&store, "s").await, "completed");
    assert!(matches!(
        lagging.recv().await,
        Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
    ));
    assert_eq!(
        store.history("s").await.unwrap().last().unwrap().content[0]["text"],
        "done"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn provider_panic_is_reconciled_without_interrupting_another_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Fixture {
            calls: AtomicUsize::new(0),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(input("other", "pending"), true)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("other", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "provider.started")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    runtime.admit(input("s", "panic"), true).await.unwrap();
    assert_eq!(terminal(&store, "s").await, "interrupted");
    assert!(!store
        .events("other", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.finished"));
    runtime.shutdown().await;
    assert_eq!(terminal(&store, "other").await, "interrupted");
}

/// An attempt describes the request, not its answer: the evaluation runner reads
/// it from the progress feed under its own kind, exactly where `context.*`
/// reports already travel. Counting durable events alone saw nothing, because a
/// sweep cannot read the engine's store.
#[tokio::test]
async fn attempt_notices_reach_the_progress_feed_as_their_own_kind() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Fixture {
            calls: AtomicUsize::new(0),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let mut progress = runtime.progress();
    runtime.admit(input("s", "notice"), true).await.unwrap();
    assert_eq!(terminal(&store, "s").await, "completed");
    let mut notices = Vec::new();
    let mut deltas = Vec::new();
    while let Ok(item) = progress.try_recv() {
        match item["kind"].as_str() {
            Some("provider.attempt") => notices.push(item),
            Some("provider.delta") => deltas.push(item),
            _ => {}
        }
    }
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0]["protocol"], "fixture");
    assert_eq!(notices[0]["outcome"], "headers_received");
    assert!(
        deltas.is_empty(),
        "a notice is not provider output: {deltas:?}"
    );
    runtime.shutdown().await;
}

/// The retry budget belongs to a turn that produced nothing. A notice about the
/// attempt arrives before that verdict and must not consume it: the turn keeps
/// its retries, so the provider is called three times before it fails.
#[tokio::test]
async fn attempt_notice_does_not_disarm_the_pre_output_transport_retry() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Fixture {
        calls: AtomicUsize::new(0),
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(input("s", "notice-then-transport"), true)
        .await
        .unwrap();
    assert_eq!(terminal(&store, "s").await, "failed");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    runtime.shutdown().await;
}
