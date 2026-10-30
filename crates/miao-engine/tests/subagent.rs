use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    recall::Query,
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
    policy_turns(allow_subagents, 25)
}

fn policy_turns(allow_subagents: bool, max_provider_turns: u32) -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_subagents,
        max_provider_turns: Some(max_provider_turns),
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
            // A unique command per turn keeps the engine's loop detector from
            // ending the child early; the turns are only there to grow the
            // journal past one event page.
            let turn = self.turns.fetch_add(1, Ordering::SeqCst);
            if turn < 80 {
                return Ok(Reply {
                    content: json!([{"type":"tool_use","id":format!("c{turn}"),"name":"bash","input":{"command":format!("echo {turn}")}}]),
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
        policy_turns(true, 120),
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

/// A delegation whose referenced handle sits below one bounded scan page of
/// the parent archive: the reference block must walk pages until it resolves,
/// the way a model handle restore does.
struct DeepReference;
#[async_trait]
impl Provider for DeepReference {
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
        if last.contains("Referenced material from the delegating Session") {
            let text = if last.contains("ARCHIVED-MARKER") {
                "child saw the deep reference"
            } else {
                "child missed the deep reference"
            };
            return Ok(Reply {
                content: json!([{"type":"text","text":text}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        if last.contains("delegate deep") && !settled("d1") {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"d1","name":"task","input":{"prompt":"answer from the injected block","references":[{"tool_use_id":"deep-call"}]}}]),
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
async fn task_reference_reaches_an_archive_beyond_one_bounded_scan() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "parent".into(),
            input_id: "one".into(),
            prompt: "seed".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("parent", true).await.unwrap();
    // The referenced output sits at the bottom of the archive; the fillers
    // above push it past one bounded scan page.
    store
        .message(
            "parent",
            "assistant",
            json!([{"type":"tool_result","tool_use_id":"deep-call","content":"ARCHIVED-MARKER: buried"}]),
        )
        .await
        .unwrap();
    for i in 0..1001 {
        store
            .message(
                "parent",
                "assistant",
                json!([{"type":"text","text":format!("filler {i}")}]),
            )
            .await
            .unwrap();
    }
    // One page cannot reach the handle, so the fixture stays honest.
    let one_page = store
        .recall(
            "parent",
            Query {
                query: String::new(),
                limit: 10,
                before_message_seq: None,
                tool_use_id: Some("deep-call".into()),
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(one_page["text"], json!(null), "{one_page}");
    assert_eq!(one_page["exhausted"], false, "{one_page}");

    // The seeded messages each commit an event; poll from the cursor the run
    // starts at instead of paging through the seed.
    let start = store.latest_seq("parent").await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(store.clone(), Arc::new(DeepReference), tools, policy(true))
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "parent".into(),
                input_id: "two".into(),
                prompt: "delegate deep".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if store
                .events("parent", start, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history("parent").await.unwrap();
                break history
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
    assert_eq!(result["text"], "child saw the deep reference", "{result}");
    let child = result["session_id"].as_str().unwrap();
    let child_input = serde_json::to_string(&store.history(child).await.unwrap()).unwrap();
    assert!(child_input.contains("ARCHIVED-MARKER"), "{child_input}");
    assert!(
        !child_input.contains("not found in the delegating Session"),
        "{child_input}"
    );
}

/// A child that tries to delegate again. The child's surface must not carry the
/// delegation tools, and a call the model invents anyway must be refused, so one
/// foreground wait can never nest another inside it.
struct Recursive {
    child_saw_task: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl Provider for Recursive {
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
        if last.contains("say hello") {
            if request.tools.iter().any(|tool| tool.name == "task") {
                self.child_saw_task.store(true, Ordering::SeqCst);
            }
            if !settled("nested") {
                return Ok(Reply {
                    content: json!([{"type":"tool_use","id":"nested","name":"task","input":{"prompt":"say hello again"}}]),
                    usage: json!({}),
                    needs_tools: true,
                });
            }
            return Ok(Reply {
                content: json!([{"type":"text","text":"child done"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        if last.contains("delegate") && !settled("d1") {
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
async fn a_delegated_child_cannot_delegate_again() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Recursive {
        child_saw_task: std::sync::atomic::AtomicBool::new(false),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
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
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("parent finished");
    runtime.shutdown().await;
    assert!(
        !provider.child_saw_task.load(Ordering::SeqCst),
        "a child was offered the task tool"
    );
    let child = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_start")
        .and_then(|event| event.data["subagent_id"].as_str().map(str::to_owned))
        .unwrap();
    let child_events = store.events(&child, 0, 500).await.unwrap();
    let denied = child_events
        .iter()
        .find(|event| event.kind == "permission_denied")
        .expect("the invented delegation call was refused");
    assert_eq!(denied.data["reason"], "nested_delegation");
    assert!(
        !child_events
            .iter()
            .any(|event| event.kind == "subagent_start"),
        "the child forked a grandchild"
    );
}

/// The child never converges on its own: every real turn calls a fresh tool, so
/// only a bound can end it. The wrap-up turn is the one where the engine
/// withholds the tool surface and asks for text only.
struct Endless {
    turns: AtomicUsize,
}

#[async_trait]
impl Provider for Endless {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let wrap_up = request.messages.iter().any(|message| {
            message.content.as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("MAXIMUM STEPS REACHED"))
                })
            })
        });
        let child = request.messages.iter().any(|message| {
            message.role == "user" && message.content.to_string().contains("never finish")
        });
        if child {
            if wrap_up {
                return Ok(Reply {
                    content: json!([{"type":"text","text":"child summary"}]),
                    usage: json!({}),
                    needs_tools: false,
                });
            }
            let turn = self.turns.fetch_add(1, Ordering::SeqCst);
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":format!("c{turn}"),"name":"bash","input":{"command":format!("echo {turn}")}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        let has_result = request.messages.iter().any(|message| {
            message
                .content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
        });
        if !has_result {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"d1","name":"task","input":{"prompt":"never finish"}}]),
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
async fn a_child_the_host_left_unbounded_closes_itself_and_still_reports() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Endless {
        turns: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_subagents: true,
            max_provider_turns: None,
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
            if store
                .events("parent", 0, 500)
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
    .expect("the parent finished instead of waiting on an unbounded child");
    runtime.shutdown().await;
    let child = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_start")
        .and_then(|event| event.data["subagent_id"].as_str().map(str::to_owned))
        .unwrap();
    // The allowance reserves one closing text-only turn, and that turn does not
    // count as a tool turn.
    assert_eq!(
        provider.turns.load(Ordering::SeqCst),
        miao_engine::subagent::TURN_LIMIT as usize - 1
    );
    // Injected context is durable wire history, so the note the child stopped on
    // is readable after the fact instead of only living in the engine's exit.
    let child_history = store.history(&child).await.unwrap();
    assert!(
        child_history.iter().any(|message| message
            .content
            .to_string()
            .contains("delegated turn allowance")),
        "the child transcript explains why it stopped"
    );
    // The note must not become the child's report: the parent asked for the
    // work, and the child's own closing text still answers it.
    assert!(
        child_history
            .iter()
            .any(|message| message.role == "assistant"),
        "the child still holds its own answer"
    );
    let parent_history = store.history("parent").await.unwrap();
    let report = parent_history
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .find_map(|part| part["content"].as_str())
        .and_then(|content| serde_json::from_str::<Value>(content).ok())
        .unwrap();
    assert_eq!(report["text"], "child summary", "{report}");
}

/// AGT-02 terminal states. The child parks on its cancellation token, so both
/// an explicit `task_cancel` and the parent's own cancellation must settle it:
/// no orphaned running child, and a durable terminal state on both sides.
struct Cancelling {
    parent_parked: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl Provider for Cancelling {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        token: CancellationToken,
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
            .unwrap_or("")
            .to_string();
        let settled = |call: &str| {
            parts.iter().any(|part| {
                part["type"] == "tool_result" && part["tool_use_id"].as_str() == Some(call)
            })
        };
        if last.contains("hang quietly") {
            // Park until the engine cancels this child's turn.
            token.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        if last.contains("delegate in background") && !settled("start") {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"start","name":"task","input":{"prompt":"hang quietly","background":true}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        if self.parent_parked.load(Ordering::SeqCst) {
            // The parent turn parks too, so the test cancels the parent run
            // while the background child is still running.
            token.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        if settled("start") && !settled("stop") {
            let started: Value = serde_json::from_str(
                parts
                    .iter()
                    .rev()
                    .find(|part| {
                        part["type"] == "tool_result"
                            && part["tool_use_id"].as_str() == Some("start")
                    })
                    .and_then(|part| part["content"].as_str())
                    .unwrap_or("{}"),
            )
            .unwrap_or(json!({}));
            let child = started["session_id"].as_str().unwrap_or("").to_string();
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"stop","name":"task_cancel","input":{"id":child}}]),
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

async fn cancelled_child_id(store: &Store, parent: &str) -> String {
    let start = store
        .events(parent, 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_start")
        .unwrap();
    start.data["subagent_id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn task_cancel_settles_a_background_child_into_a_cancelled_terminal_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Cancelling {
            parent_parked: std::sync::atomic::AtomicBool::new(false),
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
    let child = cancelled_child_id(&store, "parent").await;
    // The explicit cancel settles the child: no run still active, and the
    // durable subagent row leaves "running".
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let active = store.active_run(&child).await.unwrap();
            let status = store
                .subagents("parent")
                .await
                .unwrap()
                .into_iter()
                .next()
                .map(|row| row["status"].clone())
                .unwrap_or(json!("missing"));
            if active.is_none() && status != json!("running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let stop = store
        .events("parent", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "subagent_stop")
        .expect("the parent records a terminal subagent_stop");
    assert_ne!(stop.data["reason"], json!("completed"), "{:?}", stop.data);
    runtime.shutdown().await;
}

#[tokio::test]
async fn cancelling_the_parent_run_settles_its_background_child() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Cancelling {
            parent_parked: std::sync::atomic::AtomicBool::new(true),
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
    let child = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("parent", 0, 500).await.unwrap();
            if let Some(start) = events
                .into_iter()
                .find(|event| event.kind == "subagent_start")
            {
                break start.data["subagent_id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
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
    // Cancelling the parent run must carry the child to a terminal state.
    runtime.cancel_if("parent", &parent_run).await.unwrap();
    let stop = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let child_active = store.active_run(&child).await.unwrap();
            let parent_active = store.active_run("parent").await.unwrap();
            // Clearing the active run precedes the watcher's durable report.
            // Wait for the report itself rather than racing its separate write.
            let stop = store
                .events("parent", 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "subagent_stop" && event.data["subagent_id"] == child);
            if child_active.is_none() && parent_active.is_none() {
                if let Some(stop) = stop {
                    break stop;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the child reports a terminal state to the parent");
    assert_eq!(stop.data["reason"], json!("cancelled"));
    runtime.shutdown().await;
}
