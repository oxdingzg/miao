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

/// Reports distinct usage per attempt so the run aggregate can be checked:
/// step 0 is a tool call, step 1 the final answer, with nested details.
struct Metered;
#[async_trait]
impl Provider for Metered {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"c","name":"read_file","input":{"path":"file.txt"}}]),
                usage: json!({"input_tokens":5,"output_tokens":3,"input_tokens_details":{"cached_tokens":1}}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}),
            needs_tools: false,
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

#[tokio::test]
async fn run_usage_aggregates_provider_attempts() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file.txt"), "hi").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Metered),
        Tools::new(dir.path()).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "read".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 1000)
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
    runtime.shutdown().await;

    let events = store.events("s", 0, 1000).await.unwrap();
    let aggregate = events
        .iter()
        .find(|event| event.kind == "run.usage")
        .expect("run.usage recorded");
    assert_eq!(aggregate.data["steps"], 2);
    assert_eq!(aggregate.data["usage"]["input_tokens"], 12);
    assert_eq!(aggregate.data["usage"]["output_tokens"], 5);
    assert_eq!(
        aggregate.data["usage"]["input_tokens_details"]["cached_tokens"],
        5
    );
    // The per-step usage events remain for auditability.
    assert_eq!(
        events.iter().filter(|event| event.kind == "usage").count(),
        2
    );
}
