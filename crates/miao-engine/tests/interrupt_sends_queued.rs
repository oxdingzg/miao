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
    input_with_delivery(id, prompt, Delivery::Steer)
}

fn input_with_delivery(id: &str, prompt: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: id.into(),
        prompt: prompt.into(),
        delivery,
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

/// Waits until `want` inputs have been promoted, then returns their ids in
/// promotion order. Promotion is the durable point where an input becomes a
/// visible user message, so that order is the order the model reads.
async fn promoted(store: &Store, want: usize) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let ids: Vec<String> = store
            .events("s", 0, 200)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "input.promoted")
            .filter_map(|event| event.data["input_id"].as_str().map(str::to_owned))
            .collect();
        if ids.len() >= want || std::time::Instant::now() >= deadline {
            return ids;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Promotion is durable before the turn that carries the input starts, so a
/// count read right after the last promotion can still miss the provider call
/// it leads to. Waiting for the count keeps the assertion about turns, not
/// about who won a race with the next drain.
async fn calls_settle(calls: &Arc<AtomicUsize>, want: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while calls.load(Ordering::SeqCst) < want && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Escape interrupts the turn, not the messages the operator typed behind it:
/// the coalesced wake outlives the stop, so the successor drain sends them.
/// Every scenario lives in one test because a Runtime shutdown tears down
/// process-wide tool state, so two scenarios must never overlap: several steers
/// ride one continuation turn, several queued prompts are all promoted in the
/// order they were typed (one turn or two, depending on the boundary), and a
/// stop with nothing queued leaves the Session stopped, which is what a plain
/// interrupt means.
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
    // Typed while the first turn is still waiting on the model. Several
    // messages must all survive the stop, not just the newest one.
    runtime.admit(input("two", "second"), true).await.unwrap();
    runtime.admit(input("three", "third"), true).await.unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("the interrupted turn took the queued messages with it");
    let store = runtime.store().clone();
    let order = promoted(&store, 3).await;
    runtime.shutdown().await;
    assert_eq!(
        order,
        vec!["one".to_owned(), "two".to_owned(), "three".to_owned()],
        "every queued message survives the stop, in the order it was typed"
    );
    // Steers join the conversation at one boundary, so the continuation runs
    // once for all of them rather than once each.
    calls_settle(&calls, 2).await;
    assert!(
        calls.load(Ordering::SeqCst) >= 2,
        "the interrupted turn never continued with the queued steers"
    );

    // The TUI queues prompts typed during a run, and a queued prompt becomes
    // its own turn. Several of them must all run, one turn after another.
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let runtime = open_runtime(&dir, &calls, &started).await;
    runtime.admit(input("one", "first"), true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    for (id, prompt) in [("two", "second"), ("three", "third")] {
        runtime
            .admit(input_with_delivery(id, prompt, Delivery::Queue), true)
            .await
            .unwrap();
    }
    assert!(runtime.cancel("s").await.unwrap());
    let store = runtime.store().clone();
    let order = promoted(&store, 3).await;
    runtime.shutdown().await;
    assert_eq!(
        order,
        vec!["one".to_owned(), "two".to_owned(), "three".to_owned()],
        "queued prompts run in the order they were typed"
    );
    // How the queue is split across turns depends on when the running drain
    // reaches a promotion boundary, so the number of turns is not the promise:
    // every queued prompt reaching history once, in order, and the Session
    // continuing afterwards is.
    calls_settle(&calls, 2).await;
    assert!(
        calls.load(Ordering::SeqCst) >= 2,
        "the interrupted turn never continued with the queued prompts"
    );

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
