use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, Message},
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
        _: Vec<Message>,
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
