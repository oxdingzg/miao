use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, Message},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Scripted {
    calls: mpsc::Sender<Vec<Message>>,
    release: Arc<Notify>,
}

#[async_trait]
impl Provider for Scripted {
    async fn stream(
        &self,
        history: Vec<Message>,
        _progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.send(history.clone()).await.unwrap();
        if history.len() == 1 {
            tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),_=self.release.notified()=>{}}
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
                usage: json!({"input_tokens":1}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({"output_tokens":1}),
            needs_tools: false,
        })
    }
}

fn input(id: &str, mode: Delivery) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: mode,
    }
}

async fn finished(store: &Store, reason: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished" && e.data["reason"] == reason)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn steer_promotes_at_tool_boundary_queue_at_idle_and_retry_does_not_run_again() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (calls, mut receive) = mpsc::channel(10);
    let release = Arc::new(Notify::new());
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Scripted {
            calls,
            release: release.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(input("first", Delivery::Steer), true)
        .await
        .unwrap();
    let first = receive.recv().await.unwrap();
    assert_eq!(first.len(), 1);
    runtime
        .admit(input("queued", Delivery::Queue), true)
        .await
        .unwrap();
    runtime
        .admit(input("steer", Delivery::Steer), true)
        .await
        .unwrap();
    release.notify_one();
    let second = receive.recv().await.unwrap();
    assert!(second.iter().any(|m| m.content[0]["text"] == "steer"));
    assert!(!second.iter().any(|m| m.content[0]["text"] == "queued"));
    assert!(second.iter().any(|m| m.content[0]["tool_use_id"] == "call"));
    let third = receive.recv().await.unwrap();
    assert!(third.iter().any(|m| m.content[0]["text"] == "queued"));
    finished(&store, "completed").await;
    assert!(
        runtime
            .admit(input("first", Delivery::Steer), true)
            .await
            .unwrap()
            .duplicate
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), receive.recv())
            .await
            .is_err()
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn cancellation_is_handled_while_provider_is_waiting_and_does_not_block_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (calls, mut receive) = mpsc::channel(10);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Scripted {
            calls,
            release: Arc::new(Notify::new()),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(input("first", Delivery::Steer), true)
        .await
        .unwrap();
    receive.recv().await.unwrap();
    runtime
        .admit(
            Input {
                session_id: "other".into(),
                ..input("other-input", Delivery::Steer)
            },
            true,
        )
        .await
        .unwrap();
    receive.recv().await.unwrap();
    let cancelled =
        tokio::time::timeout(std::time::Duration::from_millis(250), runtime.cancel("s"))
            .await
            .unwrap()
            .unwrap();
    assert!(cancelled);
    finished(&store, "interrupted").await;
    assert!(!store
        .events("other", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.finished"));
    assert!(!runtime.cancel("missing").await.unwrap());
    runtime.shutdown().await;
    assert!(store
        .events("other", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.finished" && e.data["reason"] == "interrupted"));
}

#[tokio::test]
async fn interrupted_committed_tool_calls_have_unknown_results_without_rerun() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("first", Delivery::Steer)).await.unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
        )
        .await
        .unwrap();
    let (calls, _receive) = mpsc::channel(10);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Scripted {
            calls,
            release: Arc::new(Notify::new()),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let history = store.history("s").await.unwrap();
    assert_eq!(history.last().unwrap().content[0]["tool_use_id"], "call");
    assert_eq!(history.last().unwrap().content[0]["is_error"], true);
    assert!(store
        .tool_result("s", "run", "call", json!({}), false)
        .await
        .is_err());
    assert!(store.recover().await.unwrap().is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn wrong_session_cannot_commit_assistant_dispatch_and_settlement_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("first", Delivery::Steer)).await.unwrap();
    store
        .admit(Input {
            session_id: "other".into(),
            ..input("other", Delivery::Steer)
        })
        .await
        .unwrap();
    store.start_run("s", "run").await.unwrap();
    let tool = json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]);
    assert!(store
        .assistant_reply("other", "run", tool.clone())
        .await
        .is_err());
    assert!(store.history("other").await.unwrap().is_empty());
    store.assistant_reply("s", "run", tool).await.unwrap();
    assert!(store
        .tool_result("other", "run", "call", json!({}), false)
        .await
        .is_err());
    store
        .tool_result("s", "run", "call", json!({"text":"contents"}), false)
        .await
        .unwrap();
    assert_eq!(
        store.history("s").await.unwrap().last().unwrap().content[0]["tool_use_id"],
        "call"
    );
    assert!(store
        .tool_result("s", "run", "call", json!({}), false)
        .await
        .is_err());
    assert!(store
        .recover_session(Some("other"))
        .await
        .unwrap()
        .is_empty());
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.finished"));
}
