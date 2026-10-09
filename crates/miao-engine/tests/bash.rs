#![cfg(any(target_os = "macos", target_os = "linux"))]
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
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Executor {
    tool: &'static str,
    input: Value,
}
#[async_trait]
impl Provider for Executor {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":self.tool,"input":self.input}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        process_network: false,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}
async fn start(parent: &Path, tool: &'static str, input: Value) -> (Runtime, Store) {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Executor { tool, input }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "execute".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store)
}
async fn finish(store: &Store) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished")
            {
                let history = store.history("s").await.unwrap();
                return serde_json::from_str(history[2].content[0]["content"].as_str().unwrap())
                    .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn bash_runs_a_shell_line_with_separate_stdout_and_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = start(
        dir.path(),
        "bash",
        json!({"command":"printf hi; printf err >&2"}),
    )
    .await;
    let result = finish(&store).await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert!(
        result["stdout"].as_str().unwrap().contains("hi"),
        "{result}"
    );
    assert!(
        result["stderr"].as_str().unwrap().contains("err"),
        "{result}"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn pty_allocates_a_terminal_and_merges_streams() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = start(
        dir.path(),
        "bash",
        json!({"command":"if [ -t 1 ]; then echo tty; else echo notty; fi","pty":true}),
    )
    .await;
    let result = finish(&store).await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert!(
        result["stdout"].as_str().unwrap().contains("tty"),
        "{result}"
    );
    assert_eq!(result["stderr"], "", "{result}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn without_pty_stdout_is_not_a_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = start(
        dir.path(),
        "bash",
        json!({"command":"if [ -t 1 ]; then echo tty; else echo notty; fi"}),
    )
    .await;
    let result = finish(&store).await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert!(
        result["stdout"].as_str().unwrap().contains("notty"),
        "{result}"
    );
    runtime.shutdown().await;
}
