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
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}
async fn terminal(store: &Store, session: &str) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events(session, 0, 100)
                .await
                .unwrap()
                .iter()
                .find(|e| e.kind == "run.finished")
            {
                return event.data["reason"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn repeated_unchanged_results_stop_before_spending_entire_turn_allowance() {
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
    assert_eq!(terminal(&store, "s").await, "failed");
    let events = store.events("s", 0, 100).await.unwrap();
    assert_eq!(
        events.iter().filter(|e| e.kind == "tool.completed").count(),
        3
    );
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
