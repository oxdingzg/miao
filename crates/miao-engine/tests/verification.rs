use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Answers with text only, so only the configured completion check can stop it.
struct Quiet;
#[async_trait]
impl Provider for Quiet {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            needs_tools: false,
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
        })
    }
}

/// The completion check runs through the process sandbox, so the policy has to
/// allow process execution, the registry needs the sandbox runner, and the
/// engine database has to sit outside the model-writable workspace.
fn policy() -> Policy {
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
    .unwrap()
}

async fn launch(root: &std::path::Path, command: &str) -> (Runtime, Store) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Quiet), tools, policy())
        .await
        .unwrap();
    runtime.verify_with(Some(command.into())).await;
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "finish the task".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store)
}

async fn reason(store: &Store) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let events = store.events("s", 0, 300).await.unwrap();
            if let Some(finished) = events.iter().find(|event| event.kind == "run.finished") {
                return finished.data["reason"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn kinds(store: &Store) -> Vec<(String, Value)> {
    store
        .events("s", 0, 300)
        .await
        .unwrap()
        .into_iter()
        .map(|event| (event.kind, event.data))
        .collect()
}

#[tokio::test]
async fn a_failing_completion_check_continues_once_then_closes_with_a_classification() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(dir.path(), "exit 1").await;
    assert_eq!(reason(&store).await, "failed");
    let events = kinds(&store).await;
    assert_eq!(
        events
            .iter()
            .filter(|(kind, _)| kind == "verification.failed")
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|(kind, data)| kind == "loop.continuation"
                && data["reason"] == "verification-failed")
            .count(),
        1
    );
    assert!(events
        .iter()
        .any(|(kind, data)| kind == "loop.stopped" && data["reason"] == "verification-failed"));
    // The repair prompt carries the bounded output of the failed command.
    let history = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
    assert!(history.contains("The completion check failed"), "{history}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_passing_completion_check_lets_the_run_finish() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(dir.path(), "echo verification-ok").await;
    assert_eq!(reason(&store).await, "completed");
    let events = kinds(&store).await;
    assert!(events.iter().any(|(kind, _)| kind == "verification.passed"));
    assert!(!events.iter().any(|(kind, _)| kind == "verification.failed"));
    runtime.shutdown().await;
}
