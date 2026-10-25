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
use std::sync::atomic::{AtomicUsize, Ordering};
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
                usage: json!({"inputTokens": 30, "outputTokens": 5, "totalTokens": 35}),
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
    let stop = events
        .iter()
        .find(|event| event.kind == "subagent_stop" && event.data["reason"] == "completed")
        .unwrap();
    // Delegation outcome evidence (A10): the child's billed totals and turn
    // count ride the deterministic stop payload, so a report can price
    // parent+child without reconstructing provenance.
    assert_eq!(stop.data["tokens"]["input"], 30);
    assert_eq!(stop.data["tokens"]["output"], 5);
    assert!(stop.data["turns"].as_u64().unwrap_or(0) >= 1);
}

#[tokio::test]
async fn task_is_denied_without_subagent_authority() {
    let (result, _) = run(false).await;
    assert!(!result["error"].is_null(), "{result}");
}

/// A child that needs many provider turns to finish, so its event journal
/// outgrows the single page a delegation watcher reads in one pass.
struct Chatty {
    turns: AtomicUsize,
}

#[async_trait]
impl Provider for Chatty {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let texts: Vec<&str> = request
            .messages
            .iter()
            .filter(|message| message.role == "user")
            .flat_map(|message| message.content.as_array().into_iter().flatten())
            .filter_map(|part| part["text"].as_str())
            .collect();
        if texts.iter().any(|text| text.contains("say hello")) {
            let turn = self.turns.fetch_add(1, Ordering::SeqCst);
            if turn < 200 {
                return Ok(Reply {
                    content: json!([{"type":"tool_use","id":format!("c{turn}"),"name":"bash","input":{"command":"true"}}]),
                    usage: json!({}),
                    needs_tools: true,
                });
            }
            return Ok(Reply {
                content: json!([{"type":"text","text":"hello from child"}]),
                usage: json!({"inputTokens": 30, "outputTokens": 5, "totalTokens": 35}),
                needs_tools: false,
            });
        }
        let has_result = request.messages.iter().any(|message| {
            message
                .content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
        });
        if texts.iter().any(|text| text.contains("delegate")) && !has_result {
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

#[tokio::test]
async fn task_returns_a_child_result_that_outlives_one_event_page() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Chatty {
            turns: AtomicUsize::new(0),
        }),
        tools,
        policy(true),
    )
    .await
    .unwrap();
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
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let events = store.events("parent", 0, 1000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("parent finished while the child outgrew one event page");
    runtime.shutdown().await;
    let parent = store.events("parent", 0, 1000).await.unwrap();
    let child = parent
        .iter()
        .find(|event| event.kind == "subagent_start")
        .and_then(|event| event.data["subagent_id"].as_str())
        .unwrap()
        .to_owned();
    let child_events = store.events(&child, 0, 1000).await.unwrap();
    assert!(
        child_events.len() > 500,
        "child produced {} events",
        child_events.len()
    );
    assert!(parent
        .iter()
        .any(|event| event.kind == "subagent_stop" && event.data["reason"] == "completed"));
}

struct Background {
    step: AtomicUsize,
}

#[async_trait]
impl Provider for Background {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let text = request
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
            .unwrap_or("");
        if text.contains("say hello") {
            return Ok(Reply {
                content: json!([{"type":"text","text":"hello from child"}]),
                usage: json!({"inputTokens": 30, "outputTokens": 5, "totalTokens": 35}),
                needs_tools: false,
            });
        }
        let results: Vec<Value> = request
            .messages
            .iter()
            .flat_map(|message| message.content.as_array().into_iter().flatten())
            .filter(|part| part["type"] == "tool_result")
            .cloned()
            .collect();
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let content = match step {
            0 => {
                json!([{"type":"tool_use","id":"start","name":"task","input":{"prompt":"say hello","background":true}}])
            }
            1 => {
                let started: Value =
                    serde_json::from_str(results[0]["content"].as_str().unwrap()).unwrap();
                assert_eq!(started["background"], true);
                json!([{"type":"tool_use","id":"list","name":"task_list","input":{}}])
            }
            2 => {
                let listed: Value =
                    serde_json::from_str(results[1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);
                let id = listed["tasks"][0]["id"].as_str().unwrap();
                json!([{"type":"tool_use","id":"result","name":"task_result","input":{"id":id}}])
            }
            3 => {
                let id = results[2]["content"]
                    .as_str()
                    .and_then(|content| serde_json::from_str::<Value>(content).ok())
                    .and_then(|result| result["task"]["id"].as_str().map(str::to_owned))
                    .unwrap();
                json!([{"type":"tool_use","id":"result2","name":"task_result","input":{"id":id}}])
            }
            _ => json!([{"type":"text","text":"parent done"}]),
        };
        Ok(Reply {
            content,
            usage: json!({}),
            needs_tools: step < 4,
        })
    }
}

#[tokio::test]
async fn background_task_survives_the_parent_turn_and_reports_durably() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Background {
            step: AtomicUsize::new(0),
        }),
        Tools::new(dir.path()).await.unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "parent".into(),
                input_id: "one".into(),
                prompt: "delegate in background".into(),
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
    let start = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_start")
        .unwrap();
    assert_eq!(start.data["background"], true);
    let stop = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(stop) = store
                .events("parent", 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "subagent_stop")
            {
                return stop;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(stop.data["reason"], "completed");
    assert_eq!(stop.data["text"], "hello from child");
    let tasks = store.subagents("parent").await.unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["status"], "completed");
    assert_eq!(tasks[0]["text"], "hello from child");
    runtime.shutdown().await;
}

/// Parent: read a file, then delegate with a reference to that read. Child:
/// report whether the referenced material arrived, because a child forks empty.
struct Referencing;
#[async_trait]
impl Provider for Referencing {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let parts: Vec<Value> = request
            .messages
            .iter()
            .flat_map(|message| message.content.as_array().cloned().unwrap_or_default())
            .collect();
        let last = request
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
            .unwrap_or("");
        let settled = |call: &str| {
            parts.iter().any(|part| {
                part["type"] == "tool_result" && part["tool_use_id"].as_str() == Some(call)
            })
        };
        // The child's first message is the injected reference block, which the
        // delegating Session never sees.
        if last.contains("Referenced material from the delegating Session") {
            let text = if last.contains("ARCHIVED-MARKER") {
                "child saw the reference"
            } else {
                "child missed the reference"
            };
            return Ok(Reply {
                content: json!([{"type":"text","text":text}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        // The parent is scripted by phase: reading first, then delegating with
        // the read's handle and one handle that does not exist.
        if last.contains("delegate with a reference") && !settled("r1") {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"r1","name":"read_file","input":{"path":"src/archive.txt"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        if settled("r1") && !settled("d1") {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"d1","name":"task","input":{"prompt":"answer without any archive","references":[{"tool_use_id":"r1"},{"tool_use_id":"call-missing"}]}}]),
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

async fn run_referenced(reference: &str) -> (Value, Store) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(
        dir.path().join("src").join("archive.txt"),
        "ARCHIVED-MARKER: relay capacity is 7\n",
    )
    .unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Referencing), tools, policy(true))
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "parent".into(),
                input_id: "one".into(),
                prompt: format!("delegate with a reference to {reference}"),
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
                return history
                    .iter()
                    .rev()
                    .find_map(|message| {
                        message.content.as_array().and_then(|parts| {
                            parts.iter().rev().find_map(|part| {
                                part["content"]
                                    .as_str()
                                    .filter(|_| part["type"] == "tool_result")
                                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                                    .filter(|value| !value["session_id"].is_null())
                            })
                        })
                    })
                    .unwrap_or(json!({}));
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
async fn task_reference_injects_the_archived_window_into_the_child() {
    let (result, store) = run_referenced("the read of src/archive.txt").await;
    assert_eq!(result["text"], "child saw the reference", "{result}");
    let child = result["session_id"].as_str().unwrap();
    let child_input = serde_json::to_string(&store.history(child).await.unwrap()).unwrap();
    assert!(child_input.contains("ARCHIVED-MARKER"), "{child_input}");
    // The handle that does not exist is reported to the child, not fatal.
    assert!(
        child_input.contains("not found in the delegating Session"),
        "{child_input}"
    );
}
