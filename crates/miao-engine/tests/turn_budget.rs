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
    for (budget, expected, reason) in [(3, 3, "failed"), (25, 25, "failed"), (40, 33, "completed")]
    {
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
            expected.min(32)
        );
        runtime.shutdown().await;
    }
}

#[test]
fn budget_is_defaulted_validated_and_part_of_policy_identity() {
    let default: Config = serde_json::from_value(json!({})).unwrap();
    assert_eq!(default.max_provider_turns, 25);
    assert!(Policy::new(Config {
        max_provider_turns: 0,
        ..Config::default()
    })
    .is_err());
    assert!(Policy::new(Config {
        max_provider_turns: 10001,
        ..Config::default()
    })
    .is_err());
    assert_ne!(
        Policy::new(default).unwrap().revision(),
        Policy::new(Config {
            max_provider_turns: 100,
            ..Config::default()
        })
        .unwrap()
        .revision()
    );
}
