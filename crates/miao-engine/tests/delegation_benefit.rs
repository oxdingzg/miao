//! AGT-03: delegation settled against net benefit, with structured reports.
//! Each settlement lands as a durable `delegation.settled` row on the parent
//! carrying the child's and the parent's cost, the combined total, the wall
//! clock, and a verdict. A child that returned nothing may be retried once;
//! that retry settles as rework and closes further delegation for the run,
//! so the remaining work finishes in a single agent.

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

async fn engine(provider: Arc<dyn Provider>) -> (tempfile::TempDir, Store, Runtime) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), provider, tools, policy())
        .await
        .unwrap();
    (dir, store, runtime)
}

async fn delegate_and_settle(store: &Store, runtime: &Runtime) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "parent".into(),
                input_id: "one".into(),
                prompt: "delegate this".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("parent", 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

async fn parent_tool_results(store: &Store) -> Vec<String> {
    store
        .history("parent")
        .await
        .unwrap()
        .iter()
        .flat_map(|message| message.content.as_array().cloned().unwrap_or_default())
        .filter(|part| part["type"] == "tool_result")
        .filter_map(|part| part["content"].as_str().map(str::to_owned))
        .collect()
}

async fn settlements(store: &Store) -> Vec<Value> {
    store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "delegation.settled")
        .map(|event| event.data)
        .collect()
}

fn last_user_text(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .and_then(|message| {
            message
                .content
                .as_array()
                .and_then(|parts| parts.iter().find_map(|part| part["text"].as_str()))
        })
        .unwrap_or("")
        .to_owned()
}

fn tool_result_count(request: &ModelRequest) -> usize {
    request
        .messages
        .iter()
        .flat_map(|message| message.content.as_array().cloned().unwrap_or_default())
        .filter(|part| part["type"] == "tool_result")
        .count()
}

/// The child Session ID a settled delegation reported, read from the tool
/// result the parent already received.
fn child_from(request: &ModelRequest, call: &str) -> String {
    request
        .messages
        .iter()
        .flat_map(|message| message.content.as_array().cloned().unwrap_or_default())
        .find(|part| part["type"] == "tool_result" && part["tool_use_id"] == json!(call))
        .and_then(|part| {
            part["content"]
                .as_str()
                .and_then(|content| serde_json::from_str::<Value>(content).ok())
        })
        .and_then(|result| result["session_id"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn text_reply(text: &str, input: u64, output: u64) -> Reply {
    Reply {
        content: json!([{"type":"text","text":text}]),
        usage: if input == 0 && output == 0 {
            json!({})
        } else {
            json!({"inputTokens": input, "outputTokens": output, "totalTokens": input + output})
        },
        needs_tools: false,
    }
}

fn task_call(id: &str, input: Value) -> Reply {
    Reply {
        content: json!([{"type":"tool_use","id":id,"name":"task","input":input}]),
        usage: json!({}),
        needs_tools: true,
    }
}

/// Parent: delegate a greeting with a stated goal. Child: deliver it.
struct Scripted;
#[async_trait]
impl Provider for Scripted {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = last_user_text(&request);
        if last.contains("say hello") {
            return Ok(text_reply("hello from child", 30, 5));
        }
        if tool_result_count(&request) == 0 {
            let mut call = task_call(
                "d1",
                json!({"prompt":"say hello","goal":"a warm greeting","completion_criteria":["the exact words"]}),
            );
            call.usage = json!({"inputTokens": 100, "outputTokens": 10, "totalTokens": 110});
            return Ok(call);
        }
        Ok(text_reply("parent done", 0, 0))
    }
}

#[tokio::test]
async fn a_delivered_delegation_settles_positive_with_a_structured_report() {
    let (_dir, store, runtime) = engine(Arc::new(Scripted)).await;
    delegate_and_settle(&store, &runtime).await;
    runtime.shutdown().await;

    let results = parent_tool_results(&store).await;
    assert_eq!(results.len(), 1, "{results:?}");
    let result: Value = serde_json::from_str(&results[0]).unwrap();
    assert_eq!(result["text"], "hello from child", "{result}");
    assert!(result["session_id"].as_str().is_some(), "{result}");
    // The report is structured and self-contained: status, result, cost, wall
    // clock — and a pointer to the child instead of copied history.
    assert_eq!(result["report"]["status"], "completed", "{result}");
    assert_eq!(result["report"]["result"], "hello from child", "{result}");
    assert!(result["report"]["wallclock_ms"].as_u64().is_some(), "{result}");
    assert_eq!(result["report"]["cost"]["child"]["input_tokens"], 30, "{result}");
    assert_eq!(result["report"]["cost"]["child"]["output_tokens"], 5, "{result}");
    // Parent 100 + child 30; the parent's output 10 + the child's 5.
    assert_eq!(result["report"]["cost"]["combined"]["inputTokens"], 130, "{result}");
    assert_eq!(result["report"]["cost"]["combined"]["outputTokens"], 15, "{result}");
    assert!(result["report"]["history"].as_str().is_some(), "{result}");

    let settled = settlements(&store).await;
    assert_eq!(settled.len(), 1, "{settled:?}");
    let row = &settled[0];
    assert_eq!(row["verdict"], "positive", "{row}");
    assert_eq!(row["verdict_reason"], "delivered", "{row}");
    assert_eq!(row["recommendation"], "delegate", "{row}");
    assert_eq!(row["redispatched"], false, "{row}");
    assert_eq!(row["child"]["input_tokens"], 30, "{row}");
    assert_eq!(row["parent"]["input_tokens"], 100, "{row}");
    assert_eq!(row["combined"]["inputTokens"], 130, "{row}");
    assert!(row["wallclock_ms"].as_u64().is_some(), "{row}");
    assert_eq!(row["subagent_id"], result["session_id"], "{row}");

    // The stop row keeps its pre-existing shape beside the settlement.
    let stop = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_stop")
        .expect("subagent_stop recorded");
    assert_eq!(stop.data["text"], "hello from child", "{stop}");
    assert_eq!(stop.data["reason"], "completed", "{stop}");
}

/// Child: an empty report on the first dispatch, a delivery on the retry.
struct Rework;
#[async_trait]
impl Provider for Rework {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = last_user_text(&request);
        if last.contains("say hello") {
            return Ok(text_reply("hello from child", 30, 5));
        }
        if last.contains("report nothing") {
            return Ok(text_reply("   ", 10, 1));
        }
        match tool_result_count(&request) {
            0 => Ok(task_call("d1", json!({"prompt":"report nothing"}))),
            1 => {
                let child = child_from(&request, "d1");
                assert!(!child.is_empty(), "the first result names the child");
                Ok(task_call(
                    "d2",
                    json!({"prompt":"say hello","session_id":child}),
                ))
            }
            2 => Ok(task_call("d3", json!({"prompt":"say hello"}))),
            _ => Ok(text_reply("parent done", 0, 0)),
        }
    }
}

#[tokio::test]
async fn an_empty_report_reads_no_result_and_the_retry_settles_rework_then_delegation_closes() {
    let (_dir, store, runtime) = engine(Arc::new(Rework)).await;
    delegate_and_settle(&store, &runtime).await;
    runtime.shutdown().await;

    let settled = settlements(&store).await;
    assert_eq!(settled.len(), 2, "{settled:?}");
    assert_eq!(settled[0]["verdict"], "insufficient", "{settled:?}");
    assert_eq!(settled[0]["verdict_reason"], "no_result", "{settled:?}");
    assert_eq!(settled[0]["recommendation"], "single_agent", "{settled:?}");
    // The retry delivered, but the same task was paid for twice: rework.
    assert_eq!(settled[1]["verdict"], "insufficient", "{settled:?}");
    assert_eq!(settled[1]["verdict_reason"], "rework", "{settled:?}");
    assert_eq!(settled[1]["redispatched"], true, "{settled:?}");
    assert_eq!(settled[1]["child"]["input_tokens"], 30, "{settled:?}");

    let results = parent_tool_results(&store).await;
    assert_eq!(results.len(), 3, "{results:?}");
    // The retry's own result still carries its delivered report.
    let retry: Value = serde_json::from_str(&results[1]).unwrap();
    assert_eq!(retry["report"]["status"], "completed", "{retry}");
    assert_eq!(retry["text"], "hello from child", "{retry}");
    // The next delegation in the run is refused outright.
    let refusal = &results[2];
    assert!(refusal.contains("rework"), "{refusal}");
    assert!(refusal.contains("single agent"), "{refusal}");
}

/// Child: a provider failure on the first dispatch, a delivery on a fresh one.
struct Flaky;
#[async_trait]
impl Provider for Flaky {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = last_user_text(&request);
        if last.contains("explode") {
            return Err(ProviderError::Transport("boom".into()));
        }
        if last.contains("say hello") {
            return Ok(text_reply("recovered", 20, 4));
        }
        match tool_result_count(&request) {
            0 => Ok(task_call("d1", json!({"prompt":"explode the build"}))),
            1 => Ok(task_call("d2", json!({"prompt":"say hello"}))),
            _ => Ok(text_reply("parent done", 0, 0)),
        }
    }
}

#[tokio::test]
async fn a_failed_child_settles_no_result_but_does_not_close_the_gate() {
    let (_dir, store, runtime) = engine(Arc::new(Flaky)).await;
    delegate_and_settle(&store, &runtime).await;
    runtime.shutdown().await;

    let settled = settlements(&store).await;
    assert_eq!(settled.len(), 2, "{settled:?}");
    // The failed child paid cost without a result.
    assert_eq!(settled[0]["verdict"], "insufficient", "{settled:?}");
    assert_eq!(settled[0]["verdict_reason"], "no_result", "{settled:?}");
    assert_eq!(settled[0]["reason"], "failed", "{settled:?}");
    // A no_result settlement is not rework: a different child may still be
    // tried in the same run, and its delivery settles positive.
    assert_eq!(settled[0]["redispatched"], false, "{settled:?}");
    assert_eq!(settled[1]["verdict"], "positive", "{settled:?}");
    assert_eq!(settled[1]["verdict_reason"], "delivered", "{settled:?}");

    let results = parent_tool_results(&store).await;
    assert_eq!(results.len(), 2, "{results:?}");
    let failed: Value = serde_json::from_str(&results[0]).unwrap();
    assert_eq!(failed["report"]["status"], "failed", "{failed}");
    let retry: Value = serde_json::from_str(&results[1]).unwrap();
    assert_eq!(retry["text"], "recovered", "{retry}");
}
