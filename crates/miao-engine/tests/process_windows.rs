#![cfg(windows)]
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

struct Executor;
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
                content: json!([{"type":"tool_use","id":"call","name":"run_command","input":{"argv":["cmd","/c","echo hi"]}}]),
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
async fn run_command_is_confined_and_captures_output_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Executor), tools, policy())
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
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history("s").await.unwrap();
                return serde_json::from_str::<Value>(
                    history[2].content[0]["content"].as_str().unwrap(),
                )
                .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert!(
        result["stdout"].as_str().unwrap_or("").contains("hi"),
        "{result}"
    );
}
