#![cfg(any(target_os = "macos", target_os = "linux"))]
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
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Answer(AtomicUsize);
#[async_trait]
impl Provider for Answer {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn input(id: &str) -> Input {
    serde_json::from_value(json!({"session_id":"s","input_id":id,"prompt":"inspect !`printf x >> marker; printf prepared`","delivery":"steer","command":{"name":"inspect","arguments":"","subtask":false}})).unwrap()
}
async fn fixture(root: &std::path::Path) -> (Runtime, Store, Arc<Answer>) {
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let provider = Arc::new(Answer::default());
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    (runtime, store, provider)
}
async fn settled(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| matches!(event.kind.as_str(), "command.completed" | "command.failed"))
                && store.active_run("s").await.unwrap().is_none()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn command_admission_and_exact_retry_never_replay_substitution() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = fixture(dir.path()).await;
    let command = input("one");
    runtime.admit(command.clone(), false).await.unwrap();
    assert!(!dir.path().join("workspace/marker").exists());
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    runtime.resume("s").await.unwrap();
    settled(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace/marker")).unwrap(),
        "x"
    );
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    runtime.admit(command.clone(), true).await.unwrap();
    let mut changed = command;
    changed.command.as_mut().unwrap().arguments = "changed".into();
    assert!(matches!(
        runtime.admit(changed, true).await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace/marker")).unwrap(),
        "x"
    );
    let events = store.events("s", 0, 500).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "shell.started")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "command.completed")
            .count(),
        1
    );
    assert!(store
        .selected_history("s")
        .await
        .unwrap()
        .iter()
        .any(|message| message.content.to_string().contains("inspect prepared")));
}
#[tokio::test]
async fn interrupted_preparation_is_failed_without_replaying_external_effects() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        std::fs::create_dir_all(dir.path().join("workspace")).unwrap();
        store
            .initialize(
                "s",
                "fixture",
                std::fs::canonicalize(dir.path().join("workspace"))
                    .unwrap()
                    .to_str()
                    .unwrap(),
            )
            .await
            .unwrap();
        store.admit(input("interrupted")).await.unwrap();
        store.promote("s", true).await.unwrap();
        store
            .record(
                "s",
                "command.started",
                json!({"input_id":"interrupted","run_id":"lost"}),
            )
            .await
            .unwrap();
        std::fs::create_dir_all(dir.path().join("workspace")).unwrap();
        std::fs::write(dir.path().join("workspace/marker"), "already-executed").unwrap();
        store.close().await.unwrap();
    }
    let (runtime, store, _) = fixture(dir.path()).await;
    runtime.resume("s").await.unwrap();
    settled(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace/marker")).unwrap(),
        "already-executed"
    );
    let events = store.events("s", 0, 500).await.unwrap();
    assert!(!events.iter().any(|event| event.kind == "shell.started"));
    assert!(events.iter().any(|event| event.kind == "command.failed"
        && event.data.to_string().contains("It was not replayed")));
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
}
#[tokio::test]
async fn command_is_a_promotion_barrier_before_later_steers() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("command")).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "later".into(),
            prompt: "later".into(),
            delivery: Delivery::Steer,
            command: None,
            agent_references: Default::default(),
        })
        .await
        .unwrap();
    let first = store.promote("s", true).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].data["input_id"], "command");
    let next = store.promote("s", false).await.unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].data["input_id"], "later");
}
