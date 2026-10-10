//! M1 control-lane gate: a Session waiting on an approval must not block another
//! Session's run. Complements `supervision.rs`, which covers a lagging progress
//! subscriber and a provider panic.
use async_trait::async_trait;
use miao_engine::{
    approval::{Approval, Response},
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Event, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Fixture;

#[async_trait]
impl Provider for Fixture {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let task = request.messages[0].content[0]["text"].as_str().unwrap();
        if request.messages.len() == 1 && task == "wait" {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn input(session: &str, prompt: &str) -> Input {
    Input {
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

async fn event(store: &Store, session: &str, kind: &str) -> Option<Event> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events(session, 0, 100)
                .await
                .unwrap()
                .into_iter()
                .find(|e| e.kind == kind)
            {
                return event;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .ok()
}

#[tokio::test]
async fn a_session_waiting_on_approval_does_not_block_another_session() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let policy = Policy::new(Config {
        rules: vec![Rule {
            tool: "read_file".into(),
            path: "file".into(),
            decision: Decision::Ask,
        }],
        approval_timeout_ms: 60_000,
        ..Config::default()
    })
    .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Fixture),
        Tools::new(dir.path()).await.unwrap(),
        policy,
    )
    .await
    .unwrap();

    // "blocked" reaches an approval it will not answer yet.
    runtime.admit(input("blocked", "wait"), true).await.unwrap();
    let requested = event(&store, "blocked", "approval.requested")
        .await
        .expect("blocked Session requests approval");

    // "control" is admitted while "blocked" is parked, and must finish on its own.
    runtime
        .admit(input("control", "plain"), true)
        .await
        .unwrap();
    let finished = event(&store, "control", "run.finished")
        .await
        .expect("control Session finishes while the other waits");
    assert_eq!(finished.data["reason"], "completed");
    assert!(
        event(&store, "blocked", "run.finished").await.is_none(),
        "the waiting Session must still be parked"
    );

    // Resolve the parked approval so the run can complete cleanly.
    let approval: Approval = serde_json::from_value(requested.data).unwrap();
    runtime
        .approve(
            &runtime.controller(),
            "blocked",
            Response {
                request_id: approval.request_id.clone(),
                input_hash: approval.input_hash.clone(),
                policy_revision: approval.policy_revision.clone(),
                decision: Decision::Allow,
                matcher: Some(approval.matcher.clone()),
            },
        )
        .await
        .unwrap();
    let finished = event(&store, "blocked", "run.finished")
        .await
        .expect("blocked Session completes after approval");
    assert_eq!(finished.data["reason"], "completed");
    runtime.shutdown().await;
}
