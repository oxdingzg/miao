// M2 gate: compression/recovery/fork/rewind fault scenarios. These cover the
// rewind-specific gaps not exercised elsewhere (idle requirement, durability
// across a store recovery, and fork excluding reverted messages).
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

/// The dedicated SQLite worker releases the store lease when the last handle
/// drops, and that release is asynchronous: a reopen in the same process can
/// briefly observe `Busy` even though the previous store is gone. Wait for it
/// instead of asserting on scheduler timing.
async fn reopen(path: &std::path::Path) -> Store {
    for _ in 0..200 {
        match Store::open(path).await {
            Ok(store) => return store,
            Err(Error::Busy) => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            Err(error) => panic!("open {path:?}: {error:?}"),
        }
    }
    panic!("store lease for {path:?} was not released");
}

fn input(id: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: id.into(),
        prompt: format!("prompt {id}"),
        delivery: Delivery::Steer,
    }
}
fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}
async fn seed(store: &Store) {
    for id in ["one", "two"] {
        store.admit(input(id)).await.unwrap();
        store.promote("s", true).await.unwrap();
        store
            .message(
                "s",
                "assistant",
                json!([{"type":"text","text":format!("answer {id}")}]),
            )
            .await
            .unwrap();
    }
}

/// A provider that holds the run open until released, so the session is busy.
struct Blocking {
    started: mpsc::Sender<()>,
    release: Arc<Notify>,
}
#[async_trait]
impl Provider for Blocking {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let _ = self.started.send(()).await;
        self.release.notified().await;
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

#[tokio::test]
async fn rewind_requires_an_idle_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (started, mut start) = mpsc::channel(1);
    let release = Arc::new(Notify::new());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Blocking {
            started,
            release: release.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
        policy(),
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
    // Wait until the run is actually started and the prompt is promoted.
    start.recv().await.unwrap();
    let checkpoint = store.history("s").await.unwrap()[0]
        .checkpoint
        .clone()
        .unwrap();
    // A busy session refuses rewind instead of corrupting an in-flight run.
    assert!(matches!(
        store.revert("s", &checkpoint).await,
        Err(Error::Invalid(_))
    ));
    release.notify_waiters();
    runtime.shutdown().await;
}

#[tokio::test]
async fn rewind_survives_recovery_and_fork_excludes_reverted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let (first, second) = {
        let store = Store::open(&path).await.unwrap();
        seed(&store).await;
        let history = store.history("s").await.unwrap();
        let boundaries = (
            history[0].checkpoint.clone().unwrap(),
            history[2].checkpoint.clone().unwrap(),
        );
        store.close().await.unwrap();
        boundaries
    };
    {
        let store = reopen(&path).await;
        store.revert("s", &second).await.unwrap();
        assert_eq!(store.history("s").await.unwrap().len(), 2);
        store.close().await.unwrap();
    }
    // Recovery: a fresh Store over the same database keeps the rewind.
    let store = reopen(&path).await;
    let remaining = store.history("s").await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[0].checkpoint.clone().unwrap(), first);
    // A fork of the rewound session copies only visible messages.
    store.fork("s", "child", None).await.unwrap();
    assert_eq!(store.history("child").await.unwrap().len(), 2);
    // Unrevert restores the full projection, and it, too, survives recovery.
    store.unrevert("s").await.unwrap();
    assert_eq!(store.history("s").await.unwrap().len(), 4);
    store.close().await.unwrap();
    let reopened = reopen(&path).await;
    assert_eq!(reopened.history("s").await.unwrap().len(), 4);
}
