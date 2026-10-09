#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    hooks::{self, Event, Hook},
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::path::Path;
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
                content: json!([
                    {"type":"tool_use","id":"probe","name":"run_command","input":{"argv":["python3","-c","import pathlib;pathlib.Path('probe.txt').write_text('ran')"],"timeout_ms":30000}},
                    {"type":"tool_use","id":"read","name":"read_file","input":{"path":"AGENTS.md"}}
                ]),
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
fn hook(event: Event, tool: &str, code: i32) -> Hook {
    Hook {
        event,
        tool: tool.into(),
        argv: vec![
            "python3".into(),
            "-c".into(),
            format!("import sys;sys.exit({code})"),
        ],
        timeout_ms: 30000,
    }
}
fn timeout_hook(event: Event, tool: &str) -> Hook {
    Hook {
        event,
        tool: tool.into(),
        argv: vec![
            "python3".into(),
            "-c".into(),
            "import time;time.sleep(5)".into(),
        ],
        timeout_ms: 400,
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
async fn drive(parent: &Path, hooks: Vec<Hook>) -> Store {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "rules").unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into())
        .with_hooks(hooks)
        .unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Executor), tools, policy())
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "work".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    store
}
async fn outcomes(store: &Store, phase: &str) -> Vec<String> {
    store
        .events("s", 0, 200)
        .await
        .unwrap()
        .iter()
        .filter(|event| event.kind == "hook.completed" && event.data["phase"] == phase)
        .map(|event| event.data["outcome"].as_str().unwrap().to_owned())
        .collect()
}
#[tokio::test]
async fn passing_before_hooks_allow_dispatch_and_are_durable() {
    let dir = tempfile::tempdir().unwrap();
    let store = drive(
        dir.path(),
        vec![
            hook(Event::PreToolUse, "run_command", 0),
            hook(Event::PostToolUse, "run_command", 0),
        ],
    )
    .await;
    assert_eq!(
        dir.path()
            .join("workspace")
            .join("probe.txt")
            .metadata()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(outcomes(&store, "pre_tool_use").await, vec!["ok"]);
    assert_eq!(outcomes(&store, "post_tool_use").await, vec!["ok"]);
    let transcript = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
    assert!(!transcript.contains("blocked by pre_tool_use hook"));
}
#[tokio::test]
async fn failing_or_slow_before_hooks_block_dispatch_without_side_effects() {
    for (hooks, matching) in [
        (vec![hook(Event::PreToolUse, "*", 3)], 2),
        (vec![timeout_hook(Event::PreToolUse, "run_command")], 1),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = drive(dir.path(), hooks).await;
        assert!(!dir.path().join("workspace").join("probe.txt").exists());
        let transcript = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
        assert!(transcript.contains("blocked by pre_tool_use hook"));
        assert_eq!(
            outcomes(&store, "pre_tool_use").await,
            vec!["failed"; matching]
        );
        assert_eq!(
            outcomes(&store, "post_tool_use").await,
            Vec::<String>::new()
        );
    }
}
#[tokio::test]
async fn after_hook_failures_are_observed_but_never_change_results() {
    let dir = tempfile::tempdir().unwrap();
    let store = drive(dir.path(), vec![hook(Event::PostToolUse, "*", 1)]).await;
    assert_eq!(
        dir.path()
            .join("workspace")
            .join("probe.txt")
            .metadata()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        outcomes(&store, "post_tool_use").await,
        vec!["failed", "failed"]
    );
    let transcript = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
    assert!(!transcript.contains("blocked by pre_tool_use hook"));
}
#[test]
fn hook_configuration_is_bounded_and_unambiguous() {
    for hooks in [
        vec![Hook {
            event: Event::PreToolUse,
            tool: String::new(),
            argv: vec!["true".into()],
            timeout_ms: 1000,
        }],
        vec![Hook {
            event: Event::PreToolUse,
            tool: "run command".into(),
            argv: vec!["true".into()],
            timeout_ms: 1000,
        }],
        vec![Hook {
            event: Event::PreToolUse,
            tool: "*".into(),
            argv: vec![],
            timeout_ms: 1000,
        }],
        vec![Hook {
            event: Event::PreToolUse,
            tool: "*".into(),
            argv: vec!["true".into()],
            timeout_ms: 0,
        }],
        vec![
            hook(Event::PreToolUse, "*", 0),
            hook(Event::PreToolUse, "*", 0),
        ],
    ] {
        assert!(matches!(
            hooks::validate(&hooks),
            Err(ToolError::InvalidInput)
        ));
    }
    assert!(hooks::validate(&[hook(Event::PreToolUse, "*", 0)]).is_ok());
    assert!(serde_json::from_str::<Hook>(
        r#"{"event":"pre_tool_use","tool":"*","argv":["true"],"timeout_ms":1000,"extra":1}"#
    )
    .is_err());
}
