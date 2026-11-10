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
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

/// The turn an interrupt lands on holds its stream open until the stop arrives,
/// the way a slow model does. The first call fails at the transport before that,
/// so the interrupted run also carries the retry fact its note has to explain.
struct Slow {
    calls: Arc<AtomicUsize>,
    started: Arc<Notify>,
    fail_first: bool,
}

#[async_trait]
impl Provider for Slow {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 && self.fail_first {
            return Err(ProviderError::Transport(
                "connect failed: tls handshake eof".into(),
            ));
        }
        self.started.notify_one();
        cancel.cancelled().await;
        Err(ProviderError::Interrupted)
    }
}

/// Answers once, so the run under test has a reply to show before it stops.
struct Answers {
    calls: Arc<AtomicUsize>,
    started: Arc<Notify>,
}

#[async_trait]
impl Provider for Answers {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        Ok(Reply {
            content: json!([{"type":"text","text":"answered"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn input() -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "继续".into(),
        delivery: Delivery::Steer,
    }
}

/// Notes are written while the drain closes, so a read that runs right after the
/// stop can still miss the one it is about to write.
async fn notes(store: &Store) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let found: Vec<String> = store
            .events("s", 0, 500)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "message.synthetic")
            .filter(|event| event.data["source"] == "engine")
            .filter_map(|event| event.data["text"].as_str().map(str::to_owned))
            .collect();
        if !found.is_empty() || Instant::now() >= deadline {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn settled(store: &Store) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let finished = store
            .events("s", 0, 500)
            .await
            .unwrap()
            .into_iter()
            .any(|event| event.kind == "run.finished");
        if finished || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Every scenario lives in one test because a Runtime shutdown tears down
/// process-wide tool state, so two Runtimes must never overlap.
#[tokio::test]
async fn an_interrupted_turn_without_a_reply_says_so() {
    // A stop that lands before the model answered leaves the transcript empty:
    // the operator pressed Escape on a wait and has nothing to read afterwards.
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = Runtime::new(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Slow {
            calls: calls.clone(),
            started: started.clone(),
            fail_first: true,
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("the second attempt never reached the provider");
    assert!(runtime.cancel("s").await.unwrap());
    let store = runtime.store().clone();
    let written = notes(&store).await;
    runtime.shutdown().await;
    assert_eq!(written.len(), 1, "{written:?}");
    assert!(
        written[0].contains("Task interrupted")
            && written[0].contains("1 failed provider attempt")
            && written[0].contains("tls handshake eof"),
        "the note has to name the interruption and the attempts behind it: {}",
        written[0]
    );

    // A turn that answered and then stopped needs no note: its own reply is what
    // the operator already sees.
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = Runtime::new(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Answers {
            calls: calls.clone(),
            started: started.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("the answer never reached the provider");
    let store = runtime.store().clone();
    settled(&store).await;
    runtime.shutdown().await;
    assert!(
        notes(&store).await.is_empty(),
        "a completed turn must not be annotated as an interruption"
    );
}
