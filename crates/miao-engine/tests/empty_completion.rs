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
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// First `empty_turns` replies carry neither text nor tool calls; later replies
/// answer with text.
struct Script {
    calls: AtomicUsize,
    empty_turns: usize,
}
#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if index < self.empty_turns {
            return Ok(Reply {
                needs_tools: false,
                content: json!([{"type":"text","text":""}]),
                usage: json!({}),
            });
        }
        Ok(Reply {
            needs_tools: false,
            content: json!([{"type":"text","text":"recovered"}]),
            usage: json!({}),
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn run(empty_turns: usize) -> (Vec<(String, Value)>, Result<(), String>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Script {
            calls: AtomicUsize::new(0),
            empty_turns,
        }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "do the task".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("s", 0, 200).await.unwrap();
            if let Some(finished) = events.iter().find(|event| event.kind == "run.finished") {
                let reason = finished.data["reason"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let _ = runtime;
                return reason;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let events = store
        .events("s", 0, 200)
        .await
        .unwrap()
        .into_iter()
        .map(|event| (event.kind, event.data))
        .collect();
    (
        events,
        if result == "completed" {
            Ok(())
        } else {
            Err(result)
        },
    )
}

#[tokio::test]
async fn one_empty_completion_is_continued_with_a_reminder() {
    let (events, outcome) = run(1).await;
    assert!(outcome.is_ok(), "a single empty turn must not fail the run");
    assert!(events
        .iter()
        .any(|(kind, data)| kind == "loop.continuation" && data["reason"] == "empty-completion"));
    assert!(!events.iter().any(|(kind, _)| kind == "loop.stopped"));
    let reply: String = events
        .iter()
        .filter(|(kind, _)| kind == "message.committed")
        .filter_map(|(_, data)| data["content"][0]["text"].as_str().map(str::to_owned))
        .collect::<Vec<_>>()
        .join("");
    assert!(reply.contains("recovered"));
}

#[tokio::test]
async fn a_second_consecutive_empty_completion_is_a_classified_closure() {
    let (events, outcome) = run(2).await;
    assert!(outcome.is_err(), "two empty turns end the run as failed");
    assert!(events
        .iter()
        .any(|(kind, data)| kind == "loop.stopped" && data["reason"] == "empty-completion"));
    assert_eq!(
        events
            .iter()
            .filter(
                |(kind, data)| kind == "loop.continuation" && data["reason"] == "empty-completion"
            )
            .count(),
        1
    );
}
