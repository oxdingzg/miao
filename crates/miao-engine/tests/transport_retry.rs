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

/// Fails the first provider call with a transport error, optionally after
/// emitting a delta, then succeeds. Exercises the retry boundary: pre-output
/// transport failures replay, post-output ones do not.
struct Flaky {
    calls: AtomicUsize,
    delta_then_fail: bool,
}
#[async_trait]
impl Provider for Flaky {
    async fn stream(
        &self,
        _: ModelRequest,
        progress: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            if self.delta_then_fail {
                let _ = progress
                    .send(json!({"kind":"text_delta","text":"partial"}))
                    .await;
                return Err(ProviderError::ResponseTransport);
            }
            return Err(ProviderError::Transport);
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"recovered"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn run(provider: Arc<Flaky>) -> (Store, Arc<Flaky>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "go".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    (store, provider)
}

#[tokio::test]
async fn pre_output_transport_failure_is_retried() {
    let provider = Arc::new(Flaky {
        calls: AtomicUsize::new(0),
        delta_then_fail: false,
    });
    let (store, provider) = run(provider).await;
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        2,
        "expected one retry"
    );
    let history = store.history("s").await.unwrap();
    assert_eq!(history.last().unwrap().content[0]["text"], "recovered");
    assert!(!store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "provider.failed"));
}

#[tokio::test]
async fn post_output_transport_failure_is_not_replayed() {
    let provider = Arc::new(Flaky {
        calls: AtomicUsize::new(0),
        delta_then_fail: true,
    });
    let (store, provider) = run(provider).await;
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        1,
        "streamed output must not be replayed"
    );
    assert!(store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "provider.failed"));
}
