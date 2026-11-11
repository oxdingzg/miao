//! Issue #2862: a delegated child whose provider turn fails must reach the
//! parent as a failure, not as a task that finished without saying anything.
//!
//! The engine already journalled the child's `run.finished` with `reason:
//! failed`; what was missing is the cause. A parent that could see only the
//! category had to rediscover the stall by polling the worktree, so the run's
//! terminal event now carries the reason the provider gave, the waiting `task`
//! call returns it, and the parent's own delegation rows name it.
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

/// The failure the issue measured, worded the way the engine reports it.
const RATE_LIMITED: &str =
    " · retry-after: 30s · {\"error\":{\"message\":\"The inference service is overloaded.\"}}";

/// Parent: delegate a child that will be rate limited. Child: fail. Parent:
/// report once the delegation settled, carrying whatever it was told.
struct RateLimited;

#[async_trait]
impl Provider for RateLimited {
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
        if text.contains("burst into flames") {
            return Err(ProviderError::Http(429, RATE_LIMITED.trim().to_owned()));
        }
        let has_result = request.messages.iter().any(|message| {
            message
                .content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
        });
        if text.contains("delegate") && !has_result {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"d1","name":"task",
                    "input":{"prompt":"burst into flames"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"parent settled"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_subagents: true,
        max_provider_turns: Some(25),
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

/// Run one delegation prompt and return the parent's tool result, the parent's
/// own journal and the store, once the parent's run settled.
async fn delegate(prompt: &str) -> (Value, Vec<miao_engine::protocol::Event>, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(RateLimited), tools, policy())
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "parent".into(),
                input_id: "one".into(),
                prompt: prompt.into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let events = store.events("parent", 0, 500).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                let history = store.history("parent").await.unwrap();
                let result = history
                    .iter()
                    .flat_map(|message| message.content.as_array().cloned().unwrap_or_default())
                    .find(|part| part["type"] == "tool_result")
                    .and_then(|part| part["content"].as_str().map(str::to_owned))
                    .map(|content| serde_json::from_str::<Value>(&content).unwrap())
                    .unwrap_or(Value::Null);
                return (result, events);
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the parent settled");
    runtime.shutdown().await;
    (result.0, result.1, store)
}

/// The waiting side: the report `task` returns states that the child failed and
/// why, instead of leaving the parent an empty result to interpret.
#[tokio::test]
async fn a_failed_child_reports_its_cause_to_the_waiting_parent() {
    let (result, events, store) = delegate("delegate this").await;
    assert_eq!(
        result["report"]["status"],
        json!("failed"),
        "the settled report must say the child failed: {result}"
    );
    let cause = result["report"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("the settlement lost the cause: {result}"));
    assert!(
        cause.contains("429"),
        "the report must carry the provider's own words: {cause}"
    );

    // The parent's durable delegation row names the same cause, so a report can
    // answer "why did this task stop" without the live turn.
    let stop = events
        .iter()
        .find(|event| event.kind == "subagent_stop")
        .expect("the parent records a terminal subagent_stop");
    assert_eq!(stop.data["reason"], json!("failed"), "{:?}", stop.data);
    let message = stop.data["message"]
        .as_str()
        .unwrap_or_else(|| panic!("the stop row lost the cause: {:?}", stop.data));
    assert!(
        message.contains("429"),
        "unexpected stop message: {message}"
    );

    // The child's own run states how and why it ended.
    let child = stop.data["subagent_id"].as_str().unwrap().to_owned();
    let finished = store
        .events(&child, 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "run.finished")
        .expect("the child's run finished");
    assert_eq!(finished.data["reason"], json!("failed"));
    let message = finished.data["message"].as_str().unwrap_or_else(|| {
        panic!(
            "the run's terminal event lost the cause: {:?}",
            finished.data
        )
    });
    assert!(message.contains("429"), "unexpected run message: {message}");
}

/// The query side: an orchestrator that reads its children can tell a child
/// that delivered from one that stalled, and can read why.
#[tokio::test]
async fn a_failed_child_is_queryable_with_its_cause() {
    let (_, _, store) = delegate("delegate this").await;
    let children = store.children("parent", 10).await.unwrap();
    let child = &children["children"][0];
    assert_eq!(child["status"], json!("idle"), "{children}");
    assert_eq!(child["run"]["state"], json!("failed"), "{children}");
    assert_eq!(child["run"]["reason"], json!("failed"), "{children}");
    let message = child["run"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("a failed child lost its cause: {children}"));
    assert!(
        message.contains("429"),
        "unexpected child message: {message}"
    );
}

/// A child that finished on its own still reports `completed` and no cause, so
/// the added fields never dress a clean run up as a failure.
#[tokio::test]
async fn a_child_that_delivered_reports_a_completion_and_no_cause() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("parent", "parent", "/tmp").await.unwrap();
    store.fork("parent", "worker", None).await.unwrap();
    store.start_run("worker", "run-1").await.unwrap();
    store
        .finish_run("worker", "run-1", "completed")
        .await
        .unwrap();
    let children = store.children("parent", 10).await.unwrap();
    let run = &children["children"][0]["run"];
    assert_eq!(run["state"], json!("completed"), "{children}");
    assert_eq!(run["reason"], json!("completed"), "{children}");
    assert!(run["message"].is_null(), "{children}");
}
