//! AGT-02: delegation boundaries, cancellation, and budget inheritance.
//!
//! A delegation is an explicit contract between the delegating turn and its
//! child: the parent may state the child's turn and wall-clock budget and
//! withhold tools, the grant is durably recorded as `delegation.boundary`
//! before the child's first wake, and a subtask with an unknown outcome
//! refuses redispatch until it is settled.

use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    state::Mutation,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn policy(max_provider_turns: Option<u32>) -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_subagents: true,
        max_provider_turns,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

fn text_reply(text: &str) -> Reply {
    Reply {
        content: json!([{"type":"text","text":text}]),
        usage: json!({}),
        needs_tools: false,
    }
}

fn tool_reply(id: &str, name: &str, input: Value) -> Reply {
    Reply {
        content: json!([{"type":"tool_use","id":id,"name":name,"input":input}]),
        usage: json!({}),
        needs_tools: true,
    }
}

async fn harness(
    max_provider_turns: Option<u32>,
    provider: Arc<impl Provider + 'static>,
) -> (tempfile::TempDir, Runtime, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), provider, tools, policy(max_provider_turns))
        .await
        .unwrap();
    (dir, runtime, store)
}

async fn admit(store: &Store, prompt: &str) {
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "parent".into(),
            input_id: "one".into(),
            prompt: prompt.into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
}

async fn finish(store: &Store, session: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events(session, 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the run finished");
}

async fn delegated_child(store: &Store, parent: &str) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(start) = store
                .events(parent, 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "subagent_start")
            {
                return start.data["subagent_id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn boundary(store: &Store, child: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(event) = store
                .events(child, 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "delegation.boundary")
            {
                return event.data;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

/// The last user prompt of a request, the branch selector every scripted
/// provider below relies on.
fn last_user(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .filter(|message| message.role == "user")
        .find_map(|message| {
            message
                .content
                .as_array()
                .and_then(|parts| parts.iter().find_map(|part| part["text"].as_str()))
        })
        .unwrap_or("")
        .to_string()
}

fn has_result(request: &ModelRequest, call: &str) -> bool {
    request.messages.iter().any(|message| {
        message.content.as_array().is_some_and(|parts| {
            parts
                .iter()
                .any(|part| part["type"] == "tool_result" && part["tool_use_id"] == json!(call))
        })
    })
}

/// A parent that delegates once with an explicit budget; the child answers
/// every turn with another tool call until an engine bound closes it.
struct Bounded {
    budget: Option<Value>,
    child_sleep_ms: u64,
    child_turns: AtomicUsize,
}

#[async_trait]
impl Provider for Bounded {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if last_user(&request).contains("loop until bounded") {
            if request.messages.iter().any(|message| {
                message
                    .content
                    .to_string()
                    .contains("MAXIMUM STEPS REACHED")
            }) {
                return Ok(text_reply("child summary"));
            }
            if self.child_sleep_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(self.child_sleep_ms)).await;
            }
            let turn = self.child_turns.fetch_add(1, Ordering::SeqCst);
            return Ok(tool_reply(
                &format!("c{turn}"),
                "bash",
                json!({"command": format!("echo {turn}")}),
            ));
        }
        if !has_result(&request, "d1") {
            let mut input = json!({"prompt": "loop until bounded"});
            if let Some(budget) = &self.budget {
                input["budget"] = budget.clone();
            }
            return Ok(tool_reply("d1", "task", input));
        }
        Ok(text_reply("parent done"))
    }
}

#[tokio::test]
async fn an_explicit_parent_budget_closes_the_child_at_the_stated_turn_allowance() {
    let provider = Arc::new(Bounded {
        budget: Some(json!({"max_turns": 2})),
        child_sleep_ms: 0,
        child_turns: AtomicUsize::new(0),
    });
    let (_dir, runtime, store) = harness(None, provider.clone()).await;
    admit(&store, "delegate with a budget").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let child = delegated_child(&store, "parent").await;
    let granted = boundary(&store, &child).await;
    assert_eq!(granted["max_turns"], json!(2));
    assert_eq!(granted["source"], json!("parent"));
    assert_eq!(granted["parent_session_id"], json!("parent"));
    // The recorded grant, not the host default, is what closed the child.
    let history = store.history(&child).await.unwrap();
    assert!(
        history.iter().any(|message| message
            .content
            .to_string()
            .contains("delegated turn allowance")),
        "the child transcript explains the explicit bound {}",
        history
            .iter()
            .map(|m| m.content.to_string())
            .collect::<Vec<_>>()
            .join("")
    );
    assert!(provider.child_turns.load(Ordering::SeqCst) <= 4);
}

#[tokio::test]
async fn an_explicit_wallclock_closes_the_child_at_the_stated_deadline() {
    let provider = Arc::new(Bounded {
        budget: Some(json!({"wallclock_ms": 400})),
        child_sleep_ms: 120,
        child_turns: AtomicUsize::new(0),
    });
    let (_dir, runtime, store) = harness(None, provider.clone()).await;
    admit(&store, "delegate under a deadline").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let child = delegated_child(&store, "parent").await;
    let granted = boundary(&store, &child).await;
    assert_eq!(granted["wallclock_ms"], json!(400));
    let history = store.history(&child).await.unwrap();
    assert!(
        history
            .iter()
            .any(|message| message.content.to_string().contains("delegated time limit")),
        "the child transcript explains the deadline {}",
        history
            .iter()
            .map(|m| m.content.to_string())
            .collect::<Vec<_>>()
            .join("")
    );
}

/// A parent whose delegation is refused before any child exists: the scripted
/// provider issues the input, reads the error result, and closes the turn.
struct Refusing {
    input: Value,
}

#[async_trait]
impl Provider for Refusing {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if !has_result(&request, "d1") {
            return Ok(tool_reply("d1", "task", self.input.clone()));
        }
        Ok(text_reply("parent done"))
    }
}

async fn assert_refused(input: Value, needle: &str) {
    let provider = Arc::new(Refusing { input });
    let (_dir, runtime, store) = harness(None, provider).await;
    admit(&store, "delegate a refused input").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let started = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .any(|event| event.kind == "subagent_start");
    assert!(!started, "no child may be created for a refused input");
    let transcript = store.history("parent").await.unwrap();
    assert!(
        transcript
            .iter()
            .any(|message| message.content.to_string().contains(needle)),
        "the parent reads why the delegation was refused: {needle}"
    );
}

#[tokio::test]
async fn a_budget_that_states_no_feasible_bound_is_refused_without_a_child() {
    for input in [
        json!({"prompt": "loop until bounded", "budget": {}}),
        json!({"prompt": "loop until bounded", "budget": {"max_turns": 0}}),
        json!({"prompt": "loop until bounded", "budget": {"max_turns": 10001}}),
        json!({"prompt": "loop until bounded", "budget": {"wallclock_ms": 0}}),
        json!({"prompt": "loop until bounded", "budget": {"wallclock_ms": 86400001}}),
    ] {
        assert_refused(input, "invalid tool input").await;
    }
}

#[tokio::test]
async fn deny_tools_must_name_registered_tools() {
    assert_refused(
        json!({"prompt": "loop until bounded", "deny_tools": ["not_a_tool"]}),
        "does not register",
    )
    .await;
}

/// A child that reports which tools the engine actually offered it.
struct Denying {
    offered: Mutex<Vec<String>>,
}

#[async_trait]
impl Provider for Denying {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if last_user(&request).contains("loop until bounded") {
            let mut offered = self.offered.lock().unwrap();
            *offered = request.tools.iter().map(|tool| tool.name.clone()).collect();
            return Ok(text_reply("child saw the surface"));
        }
        if !has_result(&request, "d1") {
            return Ok(tool_reply(
                "d1",
                "task",
                json!({"prompt": "loop until bounded", "deny_tools": ["bash"]}),
            ));
        }
        Ok(text_reply("parent done"))
    }
}

#[tokio::test]
async fn deny_tools_narrow_the_child_surface() {
    let provider = Arc::new(Denying {
        offered: Mutex::new(Vec::new()),
    });
    let (_dir, runtime, store) = harness(None, provider.clone()).await;
    admit(&store, "delegate without bash").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let child = delegated_child(&store, "parent").await;
    let granted = boundary(&store, &child).await;
    assert_eq!(granted["deny_tools"], json!(["bash"]));
    let offered = provider.offered.lock().unwrap();
    assert!(offered.contains(&"read_file".to_string()), "{offered:?}");
    assert!(!offered.contains(&"bash".to_string()), "{offered:?}");
    // A delegated child is a leaf: the delegation tools are gone either way.
    assert!(!offered.contains(&"task".to_string()), "{offered:?}");
}

/// A parent that delegates in the background, tries a redispatch into the
/// still-running child, and only succeeds after settling its outcome.
struct Redispatch;

#[async_trait]
impl Provider for Redispatch {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        token: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = last_user(&request);
        if last.contains("second pass") {
            return Ok(text_reply("second report"));
        }
        if last.contains("hang quietly") {
            // The child parks until the engine cancels its run.
            token.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        if last.contains("start the watch") {
            if !has_result(&request, "watch") {
                return Ok(tool_reply(
                    "watch",
                    "task",
                    json!({"prompt": "hang quietly", "session_id": "kid", "background": true}),
                ));
            }
            if !has_result(&request, "again") {
                // Refused: the child is still running, its outcome is unknown.
                return Ok(tool_reply(
                    "again",
                    "task",
                    json!({"prompt": "second pass", "session_id": "kid"}),
                ));
            }
            if !has_result(&request, "stop") {
                return Ok(tool_reply("stop", "task_cancel", json!({"id": "kid"})));
            }
            if !has_result(&request, "final") {
                // The settled child may be redispatched.
                return Ok(tool_reply(
                    "final",
                    "task",
                    json!({"prompt": "second pass", "session_id": "kid"}),
                ));
            }
        }
        Ok(text_reply("parent done"))
    }
}

#[tokio::test]
async fn a_running_child_refuses_redispatch_until_its_outcome_is_settled() {
    let (_dir, runtime, store) = harness(None, Arc::new(Redispatch)).await;
    admit(&store, "start the watch").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let transcript = store.history("parent").await.unwrap();
    assert!(
        transcript
            .iter()
            .any(|message| message.content.to_string().contains("outcome is unknown")),
        "the refused redispatch explains itself"
    );
    assert!(
        transcript
            .iter()
            .any(|message| message.content.to_string().contains("second report")),
        "the settled child answers the redispatch"
    );
    let starts = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "subagent_start")
        .count();
    assert_eq!(starts, 1, "one delegation, one adoptive redispatch");
    // The refusal path settled the first run before the second one ran.
    let child = delegated_child(&store, "parent").await;
    let cancelled = store
        .events(&child, 0, 500)
        .await
        .unwrap()
        .into_iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "interrupted");
    assert!(cancelled, "task_cancel settles the running child");
}

#[tokio::test]
async fn an_explicit_budget_is_capped_by_what_the_delegating_turn_has_left() {
    let provider = Arc::new(Bounded {
        budget: Some(json!({"max_turns": 50})),
        child_sleep_ms: 0,
        child_turns: AtomicUsize::new(0),
    });
    // The parent holds four turns; the delegation spends one, so the child's
    // grant can never exceed the three the delegator may still spend.
    let (_dir, runtime, store) = harness(Some(4), provider).await;
    admit(&store, "delegate greedily").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let child = delegated_child(&store, "parent").await;
    let granted = boundary(&store, &child).await;
    assert_eq!(granted["max_turns"], json!(3), "{granted}");
    assert_eq!(granted["source"], json!("parent"));
}

#[tokio::test]
async fn the_parents_goal_budget_caps_a_child_when_the_parent_states_none() {
    let provider = Arc::new(Bounded {
        budget: None,
        child_sleep_ms: 0,
        child_turns: AtomicUsize::new(0),
    });
    let (_dir, runtime, store) = harness(None, provider).await;
    store
        .initialize("parent", "goal holder", "root")
        .await
        .unwrap();
    store
        .update_state(
            "parent",
            "seed-goal",
            Mutation::parse(
                "goal",
                json!({"objective": "hold the line", "status": "active", "budget": {"iterations": 2}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    admit(&store, "delegate under the goal").await;
    finish(&store, "parent").await;
    runtime.shutdown().await;
    let child = delegated_child(&store, "parent").await;
    let granted = boundary(&store, &child).await;
    assert_eq!(granted["max_turns"], json!(2), "{granted}");
    assert_eq!(granted["source"], json!("goal"));
    let history = store.history(&child).await.unwrap();
    assert!(
        history.iter().any(|message| message
            .content
            .to_string()
            .contains("delegated turn allowance")),
        "the inherited cap closed the child {}",
        history
            .iter()
            .map(|m| m.content.to_string())
            .collect::<Vec<_>>()
            .join("")
    );
}

/// A parent that delegates synchronously and blocks in the tool wait, so the
/// test can cancel the parent run while the child is still parked.
struct Parked;

#[async_trait]
impl Provider for Parked {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        token: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last = last_user(&request);
        if last.contains("hang quietly") {
            token.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        if !has_result(&request, "d1") {
            return Ok(tool_reply("d1", "task", json!({"prompt": "hang quietly"})));
        }
        Ok(text_reply("parent done"))
    }
}

#[tokio::test]
async fn cancelling_the_parent_run_settles_a_synchronously_waited_child() {
    let (_dir, runtime, store) = harness(None, Arc::new(Parked)).await;
    admit(&store, "delegate and wait").await;
    let child = delegated_child(&store, "parent").await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store.active_run(&child).await.unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let parent_run = store.active_run("parent").await.unwrap().unwrap();
    runtime.cancel_if("parent", &parent_run).await.unwrap();
    let stop = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let child_active = store.active_run(&child).await.unwrap();
            let parent_active = store.active_run("parent").await.unwrap();
            let stop = store
                .events("parent", 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "subagent_stop");
            if child_active.is_none() && parent_active.is_none() {
                if let Some(stop) = stop {
                    break stop;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the interrupted wait reports a terminal state");
    assert_eq!(stop.data["reason"], json!("interrupted"), "{:?}", stop.data);
    assert_eq!(stop.data["subagent_id"], json!(child));
    runtime.shutdown().await;
}
