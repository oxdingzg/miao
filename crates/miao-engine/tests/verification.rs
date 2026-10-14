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

#[tokio::test]
async fn a_failing_completion_check_continues_then_closes_with_a_classification() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Quiet), tools, policy())
        .await
        .unwrap();
    let exe = std::env::current_exe().unwrap();
    runtime
        .verify_with(Some(format!("{} --definitely-invalid-flag", exe.display())))
        .await;
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
    let reason = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
    .unwrap();
    let kinds = store
        .events("s", 0, 300)
        .await
        .unwrap()
        .into_iter()
        .map(|event| (event.kind, event.data))
        .collect::<Vec<_>>();
    assert_eq!(reason, "failed");
    assert_eq!(
        kinds
            .iter()
            .filter(|(kind, _)| kind == "verification.failed")
            .count(),
        2
    );
    assert_eq!(
        kinds
            .iter()
            .filter(|(kind, data)| kind == "loop.continuation"
                && data["reason"] == "verification-failed")
            .count(),
        1
    );
    assert!(kinds
        .iter()
        .any(|(kind, data)| kind == "loop.stopped" && data["reason"] == "verification-failed"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_passing_completion_check_lets_the_run_finish() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Quiet), tools, policy())
        .await
        .unwrap();
    let exe = std::env::current_exe().unwrap();
    // The libtest harness accepts --list and exits zero.
    runtime
        .verify_with(Some(format!("{} --list", exe.display())))
        .await;
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
    let reason = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
    .unwrap();
    let events = store.events("s", 0, 300).await.unwrap();
    assert_eq!(reason, "completed");
    assert!(events
        .iter()
        .any(|event| event.kind == "verification.passed"));
    assert!(!events
        .iter()
        .any(|event| event.kind == "verification.failed"));
    runtime.shutdown().await;
}
