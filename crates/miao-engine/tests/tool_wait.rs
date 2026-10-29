//! A dispatched call writes nothing durable until it settles, so a shell
//! command, language-server request or approval prompt that holds the turn for
//! minutes looks exactly like a wedged engine. The runtime repeats
//! `tool.waiting` on the ephemeral progress channel instead, and that notice
//! never enters the journal.
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
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Ask for one slow shell call, then end the run.
struct SlowShell;

#[async_trait]
impl Provider for SlowShell {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let first = request
            .messages
            .iter()
            .all(|message| !message.content.to_string().contains("tool_result"));
        Ok(if first {
            Reply {
                content: json!([{"type":"tool_use","id":"slow","name":"bash","input":{"command":"sleep 6","timeout_ms":30000}}]),
                usage: json!({}),
                needs_tools: true,
            }
        } else {
            Reply {
                content: json!([{"type":"text","text":"the command finished"}]),
                usage: json!({}),
                needs_tools: false,
            }
        })
    }
}

#[tokio::test]
async fn a_tool_that_has_not_settled_yet_announces_the_wait() {
    let dir = tempfile::tempdir().unwrap();
    // A process-enabled runtime keeps its database outside the workspace.
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(SlowShell),
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
    let mut progress = runtime.progress();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "run the slow command".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let notice = next_frame(&mut progress, "tool.waiting").await;
    assert_eq!(notice["session_id"], "s");
    assert_eq!(notice["call_id"], "slow");
    assert_eq!(notice["tool"], "bash");
    assert!(
        notice["elapsed_ms"].as_u64().unwrap() >= 4_000,
        "the notice reports how long the call has been outstanding: {notice}"
    );
    finished(&store).await;
    // The wait is progress, never a durable fact.
    assert!(store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .all(|event| event.kind != "tool.waiting"));
    runtime.shutdown().await;
}

async fn next_frame(progress: &mut tokio::sync::broadcast::Receiver<Value>, kind: &str) -> Value {
    let mut seen = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let frame = progress.recv().await.unwrap();
            seen.push(frame["kind"].clone());
            if frame["kind"] == kind {
                return frame;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the frame arrives; saw {seen:?}"))
}

async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let done = store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished");
            if done {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
