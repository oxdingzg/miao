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

/// Parent: delegate "say hello". Child: answer "hello from child". Parent:
/// summarise once the delegated result is present.
struct Scripted;
#[async_trait]
impl Provider for Scripted {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user");
        let text = last
            .and_then(|message| {
                message
                    .content
                    .as_array()
                    .and_then(|parts| parts.iter().find_map(|part| part["text"].as_str()))
            })
            .unwrap_or("");
        if text.contains("say hello") {
            return Ok(Reply {
                content: json!([{"type":"text","text":"hello from child"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        let has_result = request.messages.iter().any(|message| {
            message
                .content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
        });
        if text.contains("delegate") && !has_result {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"d1","name":"task","input":{"prompt":"say hello"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"parent done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn policy(allow_subagents: bool) -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_subagents,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn run(allow_subagents: bool) -> (Value, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Scripted),
        tools,
        policy(allow_subagents),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "parent".into(),
                input_id: "one".into(),
                prompt: "delegate this".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("parent", 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history("parent").await.unwrap();
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
    (result, store)
}

#[tokio::test]
async fn task_delegates_to_a_child_session_and_returns_its_message() {
    let (result, store) = run(true).await;
    assert_eq!(result["text"], "hello from child", "{result}");
    let child = result["session_id"].as_str().unwrap();
    assert_eq!(
        store.lineage_parent(child).await.unwrap().as_deref(),
        Some("parent")
    );
    let child_history = store.history(child).await.unwrap();
    assert_eq!(
        child_history.last().unwrap().content[0]["text"],
        "hello from child"
    );
    let events = store.events("parent", 0, 500).await.unwrap();
    assert!(events.iter().any(|event| event.kind == "subagent_start"));
    assert!(events
        .iter()
        .any(|event| event.kind == "subagent_stop" && event.data["reason"] == "completed"));
}

#[tokio::test]
async fn task_is_denied_without_subagent_authority() {
    let (result, _) = run(false).await;
    assert!(!result["error"].is_null(), "{result}");
}
