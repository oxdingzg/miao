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

async fn launch(
    root: &std::path::Path,
    command: &str,
    provider: Arc<dyn Provider>,
) -> (Runtime, Store) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(store.clone(), provider, tools, policy())
        .await
        .unwrap();
    runtime.verify_with(Some(command.into())).await;
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
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
    let command = if cfg!(unix) {
        format!("printf '%s\\n' '{}'; exit 1", "中".repeat(200))
    } else {
        "exit 1".into()
    };
    let (runtime, store) = launch(dir.path(), &command, Arc::new(Quiet)).await;
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
    let (runtime, store) = launch(dir.path(), "echo verification-ok", Arc::new(Quiet)).await;
    assert_eq!(reason(&store).await, "completed");
    let events = kinds(&store).await;
    assert!(events.iter().any(|(kind, _)| kind == "verification.passed"));
    assert!(!events.iter().any(|(kind, _)| kind == "verification.failed"));
    let receipt = events
        .iter()
        .find(|(kind, _)| kind == "verification.completed")
        .unwrap();
    assert_eq!(receipt.1["command"], "echo verification-ok");
    assert_eq!(receipt.1["result"]["exit_code"], 0);
    assert_eq!(receipt.1["accepted"], true);
    assert_eq!(
        receipt.1["source_after"]["coverage"],
        "native-write-targets"
    );
    assert!(
        receipt.1["completed_at"].as_i64().unwrap() >= receipt.1["started_at"].as_i64().unwrap()
    );
    runtime.shutdown().await;
}

struct Writer;
#[async_trait]
impl Provider for Writer {
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                needs_tools: true,
                usage: json!({}),
                content: json!([{"type":"tool_use","id":"write","name":"write_file","input":{"path":"source.txt","text":"old","expected_sha256":null}}]),
            });
        }
        Quiet.stream(request, progress, cancel).await
    }
}

#[tokio::test]
async fn cancellation_records_an_unaccepted_receipt_without_admitting_a_repair_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let command = if cfg!(windows) {
        "ping -n 10 127.0.0.1 >NUL"
    } else {
        "sleep 5"
    };
    let (runtime, store) = launch(dir.path(), command, Arc::new(Quiet)).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "verification.started")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    assert_eq!(reason(&store).await, "interrupted");
    let events = store.events("s", 0, 100).await.unwrap();
    let receipt = events
        .iter()
        .find(|event| event.kind == "verification.completed")
        .unwrap();
    assert_eq!(receipt.data["accepted"], false);
    assert_eq!(receipt.data["cancelled"], true);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| event.kind == "verification.passed"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_zero_exit_cannot_validate_a_tracked_revision_changed_during_the_check() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(dir.path(), "echo changed>source.txt", Arc::new(Writer)).await;
    assert_eq!(reason(&store).await, "completed");
    let events = store.events("s", 0, 300).await.unwrap();
    let receipts: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "verification.completed")
        .collect();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].data["command_passed"], true);
    assert_eq!(receipts[0].data["source_stable"], false);
    assert_eq!(receipts[0].data["accepted"], false);
    assert_eq!(
        receipts[0].data["source_before"]["files"][0]["path"],
        "source.txt"
    );
    assert_eq!(
        receipts[0].data["source_before"]["files"][0]["state"]["sha256"],
        miao_engine::permission::digest(b"old")
    );
    assert_eq!(receipts[1].data["accepted"], true);
    let passed = events
        .iter()
        .find(|event| event.kind == "verification.passed")
        .unwrap();
    assert_eq!(passed.data["receipt_seq"], receipts[1].seq);
    assert!(events
        .iter()
        .any(|event| event.kind == "verification.failed"
            && event.data["receipt_seq"] == receipts[0].seq));
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_check_is_bound_to_the_task_revision_it_started_with() {
    let dir = tempfile::tempdir().unwrap();
    let command="python3 -c \"import pathlib,time; [time.sleep(0.01) for _ in range(500) if not pathlib.Path('release').exists()]\"";
    let (runtime, store) = launch(dir.path(), command, Arc::new(Quiet)).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "verification.started")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let updated = store
        .update_state(
            "s",
            "changed-task",
            miao_engine::state::Mutation::parse(
                "goal",
                json!({"objective":"changed acceptance","status":"active","autonomous":false}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    std::fs::write(dir.path().join("workspace/release"), "").unwrap();
    assert_eq!(reason(&store).await, "completed");
    let events = kinds(&store).await;
    let receipts: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "verification.completed")
        .collect();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].1["command_passed"], true);
    assert_eq!(receipts[0].1["task_stable"], false);
    assert_eq!(receipts[0].1["accepted"], false);
    assert_eq!(
        receipts[1].1["task_before"]["goal_revision"],
        updated["revision"]
    );
    assert_eq!(receipts[1].1["accepted"], true);
    runtime.shutdown().await;
}
