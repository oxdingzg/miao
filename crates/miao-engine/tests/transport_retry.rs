use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    routing::Fallback,
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
            return Err(ProviderError::Transport(
                "the primary endpoint is unreachable".into(),
            ));
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
                agent_references: Default::default(),
                command: None,
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

/// A route that cannot be reached at all, so the fallback wraps the transport
/// failure the same way a configured pair does.
struct Unreachable {
    model: &'static str,
    calls: AtomicUsize,
}
#[async_trait]
impl Provider for Unreachable {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: self.model.into(),
        })
    }
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::Transport(
            "the model endpoint is unreachable".into(),
        ))
    }
}

/// Both routes of a routed turn fail at transport level. The router wraps the
/// route's error, and that wrapper used to fall through the runtime's
/// availability check, so an unreachable endpoint was reported as
/// "invalid request: provider transport failed" and sent operators looking for
/// a malformed prompt.
#[tokio::test]
async fn a_routed_transport_failure_is_reported_as_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(
        Fallback::new(
            Arc::new(Unreachable {
                model: "primary",
                calls: AtomicUsize::new(0),
            }),
            Arc::new(Unreachable {
                model: "fallback",
                calls: AtomicUsize::new(0),
            }),
        )
        .unwrap(),
    );
    let runtime = Runtime::new(
        store.clone(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "go".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if events.iter().any(|event| event.kind == "stop_failure") {
                return events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let failure = events
        .iter()
        .find(|event| event.kind == "stop_failure")
        .unwrap();
    let message = failure.data["message"].as_str().unwrap();
    assert!(
        message.starts_with("provider unavailable: the model endpoint kept failing after retries"),
        "unexpected failure message: {message}"
    );
    runtime.shutdown().await;
}

/// A request that never reaches the endpoint keeps the reason the socket gave,
/// and never copies the URL: a route's query string can carry a credential.
#[tokio::test]
async fn a_transport_failure_keeps_the_underlying_cause() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let error = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/?api-key=sk-secret"))
        .send()
        .await
        .unwrap_err();
    let message = ProviderError::from(error).to_string();
    assert!(
        message.starts_with("provider transport failed: connect failed: "),
        "unexpected failure message: {message}"
    );
    assert!(
        message.to_ascii_lowercase().contains("refused"),
        "the socket's reason is missing: {message}"
    );
    assert!(
        !message.contains("sk-secret"),
        "the URL's query reached the message: {message}"
    );
}
