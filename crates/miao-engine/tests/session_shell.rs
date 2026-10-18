#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{CollaborationMode, Error, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    session_shell::Invocation,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct NoProvider;
#[async_trait]
impl Provider for NoProvider {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        panic!("operator shell must not call the provider")
    }
}
async fn fixture(root: &Path, decision: Decision) -> (Runtime, Store, PathBuf) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(NoProvider),
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
                decision,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    store
        .initialize(
            "s",
            "fixture",
            std::fs::canonicalize(&workspace).unwrap().to_str().unwrap(),
        )
        .await
        .unwrap();
    (runtime, store, workspace)
}
fn invocation(id: &str, command: &str) -> Invocation {
    Invocation {
        call_id: id.into(),
        command: command.into(),
        timeout_ms: 10000,
    }
}
async fn settled(runtime: &Runtime, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let receipt = runtime.shell_status("s", id).await.unwrap();
            if !matches!(receipt["state"].as_str(), Some("pending" | "running")) {
                return receipt;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn operator_shell_executes_once_without_a_model_tool_or_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, workspace) = fixture(dir.path(), Decision::Allow).await;
    let call = invocation(
        "operator-one",
        "printf x >> marker; printf stdout; printf stderr >&2; exit 7",
    );
    runtime.shell("s", call.clone()).await.unwrap();
    let receipt = settled(&runtime, &call.call_id).await;
    assert_eq!(receipt["state"], "ended");
    assert_eq!(receipt["result"]["exit_code"], 7);
    assert_eq!(receipt["result"]["output"], "stdoutstderr");
    assert_eq!(receipt["result"]["origin"], "operator");
    assert_eq!(
        runtime.shell("s", call.clone()).await.unwrap()["duplicate"],
        true
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("marker")).unwrap(),
        "x"
    );
    assert!(matches!(
        runtime
            .shell("s", invocation("operator-one", "printf changed"))
            .await,
        Err(Error::Conflict)
    ));
    let events = store.events("s", 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "shell.started")
            .count(),
        1
    );
    assert!(!events.iter().any(|event| matches!(
        event.kind.as_str(),
        "input.admitted" | "input.promoted" | "tool.dispatched" | "provider.started"
    )));
    let history = store.selected_history("s").await.unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("operator-shell"));
    store
        .message("s", "assistant", json!([{"type":"text","text":"done"}]))
        .await
        .unwrap();
    store.fork("s", "child", None).await.unwrap();
    let copied = store.events("child", 0, 100).await.unwrap();
    assert!(copied
        .iter()
        .any(|event| event.kind == "shell.started" && event.data["origin"] == "operator"));
    assert!(copied
        .iter()
        .any(|event| event.kind == "shell.ended" && event.data["exit_code"] == 7));
    assert!(!copied.iter().any(|event| event.kind == "input.promoted"));
    store.fork("child", "grandchild", None).await.unwrap();
    assert!(store
        .events("grandchild", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "shell.ended"));
    let recalled = store.archived_output("s", "operator-one", 0).await.unwrap();
    assert_eq!(recalled["origin"], "operator");
    assert_eq!(recalled["text"], "stdoutstderr");
    runtime.shutdown().await;
}

#[tokio::test]
async fn denied_or_plan_shell_is_refused_before_execution() {
    for plan in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, store, workspace) = fixture(
            dir.path(),
            if plan {
                Decision::Allow
            } else {
                Decision::Deny
            },
        )
        .await;
        if plan {
            runtime
                .set_mode("s", CollaborationMode::Plan)
                .await
                .unwrap();
        }
        runtime
            .shell("s", invocation("denied", "touch escaped"))
            .await
            .unwrap();
        assert_eq!(settled(&runtime, "denied").await["state"], "refused");
        assert!(!workspace.join("escaped").exists());
        assert!(!store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .any(|event| event.kind == "shell.started"));
        assert!(store.history("s").await.unwrap().is_empty());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn shell_work_is_serialized_and_cancellable_through_the_session_actor() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, workspace) = fixture(dir.path(), Decision::Allow).await;
    runtime
        .shell(
            "s",
            invocation("one", "printf A >> order; sleep 0.1; printf a >> order"),
        )
        .await
        .unwrap();
    runtime
        .shell("s", invocation("two", "printf B >> order"))
        .await
        .unwrap();
    assert_eq!(settled(&runtime, "two").await["state"], "ended");
    assert_eq!(
        std::fs::read_to_string(workspace.join("order")).unwrap(),
        "AaB"
    );
    runtime
        .shell(
            "s",
            invocation("cancel", "touch begun; sleep 30; touch should-not-exist"),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !workspace.join("begun").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await
        }
    })
    .await
    .unwrap();
    runtime
        .shell(
            "s",
            invocation("queued-cancel", "touch queued-should-not-exist"),
        )
        .await
        .unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    assert_eq!(settled(&runtime, "queued-cancel").await["state"], "refused");
    assert!(!workspace.join("queued-should-not-exist").exists());
    let receipt = settled(&runtime, "cancel").await;
    assert_eq!(receipt["state"], "ended");
    assert_ne!(receipt["result"]["reason"], "completed");
    assert!(!workspace.join("should-not-exist").exists());
    assert!(store.snapshot("s").await.unwrap()["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn operator_shell_uses_the_same_bound_approval_and_never_starts_early() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, workspace) = fixture(dir.path(), Decision::Ask).await;
    runtime
        .shell("s", invocation("approved", "touch approved"))
        .await
        .unwrap();
    let approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("s", 0, 100)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "approval.requested")
            {
                break event.data;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(!workspace.join("approved").exists());
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "shell.started"));
    let response = miao_engine::approval::Response {
        request_id: approval["request_id"].as_str().unwrap().into(),
        input_hash: approval["input_hash"].as_str().unwrap().into(),
        policy_revision: approval["policy_revision"].as_str().unwrap().into(),
        decision: Decision::Allow,
        matcher: None,
    };
    let mut wrong = response.clone();
    wrong.input_hash = "incorrect".into();
    assert!(runtime
        .approve(&runtime.controller(), "s", wrong)
        .await
        .is_err());
    assert!(!workspace.join("approved").exists());
    runtime
        .approve(&runtime.controller(), "s", response)
        .await
        .unwrap();
    assert_eq!(settled(&runtime, "approved").await["state"], "ended");
    assert!(workspace.join("approved").exists());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_crashed_operator_shell_identity_is_unknown_and_never_reexecuted() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let policy = dir.path().join("policy.json");
    std::fs::write(&policy,json!({"mode":"workspace","allow_process":true,"rules":[{"tool":"*","path":"**","decision":"allow"}]}).to_string()).unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            workspace.to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            "http://127.0.0.1:1",
            "--policy",
            policy.to_str().unwrap(),
        ])
        .env("OPENAI_API_KEY", "fixture")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let call = invocation("crash-id", "printf x >> marker; sleep 0.5");
    input.write_all(format!("{}\n{}\n",json!({"id":1,"method":"initialize","params":{"session_id":"s","title":"fixture"}}),json!({"id":2,"method":"shell","params":{"session_id":"s","call_id":call.call_id,"command":call.command,"timeout_ms":call.timeout_ms}})).as_bytes()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(line) = output.next_line().await.unwrap() {
            let reply: Value = serde_json::from_str(&line).unwrap();
            assert!(reply.get("error").is_none(), "{reply}");
            if reply["id"] == 2 {
                break;
            }
        }
        while !workspace.join("marker").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    drop(input);
    let (runtime, store, workspace) = fixture(dir.path(), Decision::Allow).await;
    let receipt = runtime.shell("s", call).await.unwrap();
    assert_eq!(receipt["state"], "unknown");
    assert_eq!(receipt["duplicate"], true);
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("marker")).unwrap(),
        "x"
    );
    let recovery = store.recoveries("s", "").await.unwrap();
    assert_eq!(recovery["calls"][0]["origin"], "operator");
    assert!(store
        .resolve_recovery(
            "s",
            recovery["calls"][0]["call_id"].as_str().unwrap(),
            "not-a-model-retry",
            miao_engine::recovery::Decision::Retry
        )
        .await
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn bounded_shell_history_retains_a_recallable_output_window() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = fixture(dir.path(), Decision::Allow).await;
    runtime
        .shell("s", invocation("large-output", "printf '%040000d' 0"))
        .await
        .unwrap();
    let receipt = settled(&runtime, "large-output").await;
    assert_eq!(receipt["result"]["truncated"], true);
    assert!(receipt["result"]["output"].as_str().unwrap().len() <= 32768);
    let history = store.history("s").await.unwrap();
    assert!(history[0].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("recall handle large-output"));
    let window = store
        .archived_output("s", "large-output", 16000)
        .await
        .unwrap();
    assert!(window["total_bytes"].as_u64().unwrap() > 16000);
    assert_eq!(window["origin"], "operator");
    store.fork("s", "output-copy", None).await.unwrap();
    let copied = store.events("output-copy", 0, 100).await.unwrap();
    let inherited = copied
        .iter()
        .find(|event| event.kind == "shell.ended")
        .unwrap();
    assert_eq!(inherited.data["timeout_ms"], 10000);
    let handle = inherited.data["call_id"].as_str().unwrap();
    let recalled = store
        .archived_output("output-copy", handle, 16000)
        .await
        .unwrap();
    assert_eq!(recalled["total_bytes"], window["total_bytes"]);
    assert!(
        store.history("output-copy").await.unwrap()[0].content[0]["text"]
            .as_str()
            .unwrap()
            .contains(handle)
    );
    runtime.shutdown().await;
}
