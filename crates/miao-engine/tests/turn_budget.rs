use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct MultiStep(AtomicUsize);
#[async_trait]
impl Provider for MultiStep {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let step = self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            needs_tools: step < 32,
            content: if step < 32 {
                json!([{"type":"tool_use","id":format!("read-{step}"),"name":"read_file","input":{"path":format!("fixture-{step}")}}])
            } else {
                json!([{"type":"text","text":"verified"}])
            },
            usage: json!({}),
        })
    }
}

#[tokio::test]
async fn host_budget_allows_long_tasks_and_still_bounds_provider_work() {
    // The turn that spends the last allowance is text-only, so it runs one
    // fewer tool batch than the turns before it.
    for (budget, expected, completed, reason) in [
        (Some(3), 3, 2, "completed"),
        (Some(25), 25, 24, "completed"),
        (Some(40), 33, 32, "completed"),
        (None, 33, 32, "completed"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        for step in 0..32 {
            std::fs::write(
                dir.path().join(format!("fixture-{step}")),
                format!("actual content {step}"),
            )
            .unwrap();
        }
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let provider = Arc::new(MultiStep(AtomicUsize::new(0)));
        let runtime = Runtime::with_policy(
            store.clone(),
            provider.clone(),
            Tools::new(dir.path()).await.unwrap(),
            Policy::new(Config {
                max_provider_turns: budget,
                rules: vec![Rule {
                    tool: "read_file".into(),
                    path: "fixture-*".into(),
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
                    session_id: "s".into(),
                    input_id: "one".into(),
                    prompt: "Read and verify the fixture in 32 steps".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let events = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let events = store.events("s", 0, 1000).await.unwrap();
                if events.iter().any(|event| event.kind == "run.finished") {
                    break events;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(provider.0.load(Ordering::SeqCst), expected);
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            reason
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "tool.completed")
                .count(),
            completed
        );
        runtime.shutdown().await;
    }
}

/// What one provider request carried, as the model side would see it.
struct Recorded {
    tools: usize,
    wrap_up: bool,
}

/// A provider that always asks for a tool. Without the allowance guard the run
/// would keep dispatching; the last turn must be withheld and closed instead.
struct AlwaysTools(Arc<tokio::sync::Mutex<Vec<Recorded>>>, AtomicUsize);

#[async_trait]
impl Provider for AlwaysTools {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let step = self.1.fetch_add(1, Ordering::SeqCst);
        self.0.lock().await.push(Recorded {
            tools: request.tools.len(),
            wrap_up: request.messages.iter().any(|message| {
                message
                    .content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|block| {
                        block["text"].as_str().is_some_and(|text| {
                            text.starts_with("CRITICAL - MAXIMUM STEPS REACHED")
                        })
                    })
            }),
        });
        Ok(Reply {
            needs_tools: true,
            content: json!([{"type":"tool_use","id":format!("read-{step}"),"name":"read_file","input":{"path":"fixture"}}]),
            usage: json!({}),
        })
    }
}

#[tokio::test]
async fn the_last_allowed_turn_closes_the_prompt_without_tools() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fixture"), "actual content").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(AlwaysTools(seen.clone(), AtomicUsize::new(0))),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            max_provider_turns: Some(2),
            rules: vec![Rule {
                tool: "read_file".into(),
                path: "fixture".into(),
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
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "keep reading".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if events
                .iter()
                .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed")
                && serde_json::to_string(&store.history("s").await.unwrap())
                    .unwrap()
                    .contains("Reached the provider turn allowance")
            {
                break events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let requests = seen.lock().await;
    assert_eq!(requests.len(), 2, "the allowance bounds provider work");
    assert!(requests[0].tools > 0, "the first turn may use tools");
    assert!(!requests[0].wrap_up, "the first turn is not closing");
    assert_eq!(requests[1].tools, 0, "the closing turn has no tool surface");
    assert!(
        requests[1].wrap_up,
        "the closing turn carries the step note"
    );
    drop(requests);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed")
            .count(),
        1,
        "the closing turn starts no tool call"
    );
    assert!(serde_json::to_string(&store.history("s").await.unwrap())
        .unwrap()
        .contains("Send a message to continue"));
    runtime.shutdown().await;
}

#[test]
fn budget_is_defaulted_validated_and_part_of_policy_identity() {
    let default: Config = serde_json::from_value(json!({})).unwrap();
    assert_eq!(default.max_provider_turns, Some(25));
    let unlimited: Config = serde_json::from_value(json!({"max_provider_turns":null})).unwrap();
    assert_eq!(Policy::new(unlimited).unwrap().max_provider_turns(), None);
    assert!(Policy::new(Config {
        max_provider_turns: Some(0),
        ..Config::default()
    })
    .is_err());
    assert!(Policy::new(Config {
        max_provider_turns: Some(10001),
        ..Config::default()
    })
    .is_err());
    assert_ne!(
        Policy::new(default).unwrap().revision(),
        Policy::new(Config {
            max_provider_turns: Some(100),
            ..Config::default()
        })
        .unwrap()
        .revision()
    );
}
