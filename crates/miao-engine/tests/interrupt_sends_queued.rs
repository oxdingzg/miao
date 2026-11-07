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
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

/// The first provider call is the turn an interrupt lands on, so it holds the
/// stream open until the stop arrives the way a slow model would. Every later
/// call is the message that was queued behind that turn, which has to be sent.
struct Interrupted {
    calls: Arc<AtomicUsize>,
    started: Arc<Notify>,
}

#[async_trait]
impl Provider for Interrupted {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        if call == 0 {
            cancel.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"answered"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn input(id: &str, prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: id.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

async fn open_runtime(
    dir: &tempfile::TempDir,
    calls: &Arc<AtomicUsize>,
    started: &Arc<Notify>,
) -> Runtime {
    Runtime::new(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Interrupted {
            calls: calls.clone(),
            started: started.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap()
}

/// Escape interrupts the turn, not the message the operator typed behind it:
/// the coalesced wake outlives the stop, so the successor drain sends it. With
/// nothing queued there is no wake and the Session stays stopped, which is what
/// a plain interrupt means. Both directions live in one test because a Runtime
/// shutdown tears down process-wide tool state, so they must not overlap.
#[tokio::test]
async fn interrupting_a_turn_sends_the_input_queued_behind_it() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = open_runtime(&dir, &calls, &started).await;
    runtime.admit(input("one", "first"), true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    // Typed while the first turn is still waiting on the model.
    runtime.admit(input("two", "second"), true).await.unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("the interrupted turn took the queued message with it");
    let store = runtime.store().clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let promoted = loop {
        let ids: Vec<String> = store
            .events("s", 0, 200)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "input.promoted")
            .filter_map(|event| event.data["input_id"].as_str().map(str::to_owned))
            .collect();
        if ids.len() > 1 || std::time::Instant::now() >= deadline {
            break ids;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    runtime.shutdown().await;
    assert_eq!(promoted, vec!["one".to_owned(), "two".to_owned()]);
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    // The same Escape with nothing queued must leave the Session stopped.
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = open_runtime(&dir, &calls, &started).await;
    runtime.admit(input("one", "only"), true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    runtime.shutdown().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
