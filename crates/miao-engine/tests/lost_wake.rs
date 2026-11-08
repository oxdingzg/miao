use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Gate {
    calls: Arc<AtomicUsize>,
    started: Arc<Notify>,
}
#[async_trait]
impl Provider for Gate {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        cancel.cancelled().await;
        Err(ProviderError::Interrupted)
    }
}

#[tokio::test]
async fn exact_retry_repairs_pending_wake_but_never_replays_promoted_work() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Gate {
            calls: calls.clone(),
            started: started.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let input = Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "hello".into(),
        delivery: Delivery::Steer,
    };
    // Durable commit succeeded but the caller did not deliver its advisory wake.
    runtime.admit(input.clone(), false).await.unwrap();
    let retry = runtime.admit(input.clone(), true).await.unwrap();
    assert!(retry.duplicate && retry.pending);
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    assert!(!runtime.admit(input, true).await.unwrap().pending);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    runtime.cancel("s").await.unwrap();
    runtime.shutdown().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "input.admitted")
            .count(),
        1
    );
}

/// Answers every turn, so a promoted input is visibly sent.
struct Answer {
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl Provider for Answer {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            content: serde_json::json!([{"type":"text","text":"answered"}]),
            usage: serde_json::json!({}),
            needs_tools: false,
        })
    }
}

/// A process that dies holding a queued message leaves it durably admitted but
/// never promoted. The engine that starts next inherits that row, so it has to
/// send it: otherwise the composer shows a message the operator already sent and
/// no turn ever runs it. The turn the dead process was running is not retried.
#[tokio::test]
async fn a_restart_sends_the_message_the_dead_process_left_pending() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let root = std::fs::canonicalize(&workspace).unwrap();
    let root = root.to_str().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("s", "fixture", root).await.unwrap();
    // The row a crashed process leaves behind: durably admitted, never promoted,
    // and no run to promote it. `engine_input` is the whole inbox, so writing it
    // here is the same durable state a restart reads.
    let admission = store
        .admit_at(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "survivor".into(),
                prompt: "keep going".into(),
                delivery: Delivery::Queue,
            },
            Some(root.to_owned()),
        )
        .await
        .unwrap();
    assert!(admission.pending);
    let calls = Arc::new(AtomicUsize::new(0));
    let restarted = Runtime::new(
        store.clone(),
        Arc::new(Answer {
            calls: calls.clone(),
        }),
        Tools::new(&workspace).await.unwrap(),
    )
    .await
    .unwrap();
    let sent = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await;
    let kinds: Vec<String> = store
        .events("s", 0, 200)
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect();
    let location = store.location("s").await.unwrap();
    assert!(
        sent.is_ok(),
        "restarted engine did not send the queued message; root={root} location={location:?} events={kinds:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(store.pending_inputs("s", None, 10).await.unwrap()["inputs"]
        .as_array()
        .unwrap()
        .is_empty());
    restarted.shutdown().await;
}
