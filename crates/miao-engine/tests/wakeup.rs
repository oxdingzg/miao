use async_trait::async_trait;
use miao_engine::{
    permission::{Access, Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    wakeup,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;
struct Schedule {
    submitted: Arc<Notify>,
    fired: Arc<Notify>,
    calls: AtomicUsize,
    hold: bool,
    count: usize,
}
#[async_trait]
impl Provider for Schedule {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            assert!(request
                .tools
                .iter()
                .any(|tool| tool.name == "schedule_wakeup"));
            return Ok(Reply{content:Value::Array((0..self.count).map(|index|json!({"type":"tool_use","id":format!("timer-{index}"),"name":"schedule_wakeup","input":{"prompt":"fire-me","delaySeconds":60}})).collect()),usage:json!({}),needs_tools:true});
        }
        if request.messages.last().is_some_and(|message| {
            message.content.as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["type"] == "text" && part["text"] == "fire-me")
            })
        }) {
            self.fired.notify_one();
            return Ok(Reply {
                content: json!([{"type":"text","text":"fired"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        self.submitted.notify_one();
        if self.hold {
            cancel.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"scheduled"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
async fn setup(
    path: &std::path::Path,
    hold: bool,
    count: usize,
) -> (Runtime, Store, Arc<Schedule>) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Schedule {
        submitted: Arc::new(Notify::new()),
        fired: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
        hold,
        count,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        miao_engine::tools::Tools::new(path).await.unwrap(),
        Policy::new(Config {
            allow_wakeup: true,
            rules: vec![Rule {
                tool: "schedule_wakeup".into(),
                path: "@session/wakeup".into(),
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
                prompt: "schedule".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        provider.submitted.notified(),
    )
    .await
    .unwrap();
    (runtime, store, provider)
}
#[tokio::test]
async fn timer_survives_turn_cancel_and_fires_one_atomic_admission() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), true, 1).await;
    let timers = store.wakeups("s").await.unwrap();
    let id = timers[0]["timer_id"].as_str().unwrap();
    assert_eq!(
        store.snapshot("s").await.unwrap()["wakeups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    runtime.cancel("s").await.unwrap();
    assert_eq!(store.wakeups("s").await.unwrap()[0]["state"], "scheduled");
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::time::resume();
    tokio::time::timeout(std::time::Duration::from_secs(3), provider.fired.notified())
        .await
        .unwrap();
    assert_eq!(store.wakeups("s").await.unwrap()[0]["state"], "fired");
    assert!(!runtime.cancel_wakeup("s", id).await.unwrap());
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(120)).await;
    tokio::time::resume();
    let events = store.events("s", 0, 100).await.unwrap();
    let input_id = format!("wakeup/{id}");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.admitted" && event.data["input_id"] == input_id)
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.planned" && event.data["name"] == "schedule_wakeup")
            .count(),
        1
    );
    runtime.shutdown().await;
}
#[tokio::test]
async fn independent_cancel_ownership_and_shutdown_close_timers_without_prompts() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), false, 2).await;
    let timers = store.wakeups("s").await.unwrap();
    let id = timers[0]["timer_id"].as_str().unwrap();
    assert!(store.wakeups("other").await.unwrap().is_empty());
    assert!(!runtime.cancel_wakeup("other", id).await.unwrap());
    assert!(runtime.cancel_wakeup("s", id).await.unwrap());
    assert!(!runtime.cancel_wakeup("s", id).await.unwrap());
    runtime.shutdown().await;
    assert!(store
        .wakeups("s")
        .await
        .unwrap()
        .iter()
        .all(|timer| timer["state"] == "cancelled"));
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count(),
        1
    );
}
#[tokio::test]
async fn capacity_and_recovery_are_bounded_and_fork_does_not_copy_timers() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), false, 9).await;
    let timers = store.wakeups("s").await.unwrap();
    assert_eq!(timers.len(), 8);
    let messages = store.snapshot("s").await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone();
    let boundary = messages
        .iter()
        .rfind(|message| message["role"] == "user")
        .unwrap()["seq"]
        .as_u64()
        .unwrap();
    runtime.fork("s", "child", Some(boundary)).await.unwrap();
    assert!(store.wakeups("child").await.unwrap().is_empty());
    runtime.shutdown().await;
    let mut orphan = timers[0].clone();
    orphan["timer_id"] = json!(uuid::Uuid::new_v4().to_string());
    store
        .record("s", "wakeup.scheduled", orphan.clone())
        .await
        .unwrap();
    store.recover_wakeups().await.unwrap();
    store.recover_wakeups().await.unwrap();
    let recovered = store.wakeups("s").await.unwrap();
    assert_eq!(recovered[0]["state"], "interrupted");
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count(),
        1
    );
}
#[test]
fn wakeup_has_explicit_permission_upper_bound_and_session_local_input() {
    let default = Policy::new(Config::default()).unwrap();
    assert_eq!(
        default.evaluate("schedule_wakeup", "@session/wakeup", Access::Schedule),
        Decision::Deny
    );
    let enabled = Policy::new(Config {
        allow_wakeup: true,
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        enabled.evaluate("schedule_wakeup", "@session/wakeup", Access::Schedule),
        Decision::Ask
    );
    assert_eq!(
        enabled.evaluate("write_file", "file", Access::Write),
        Decision::Deny
    );
    for value in [
        json!({"prompt":"work","delaySeconds":59}),
        json!({"prompt":"work","delaySeconds":3601}),
        json!({"prompt":" ","delaySeconds":60}),
        json!({"prompt":"work","delaySeconds":60,"session_id":"other"}),
    ] {
        assert!(wakeup::Input::parse(value).is_err());
    }
    assert_eq!(
        wakeup::Input::parse(json!({"prompt":"work","delaySeconds":60}))
            .unwrap()
            .delivery,
        Delivery::Queue
    );
}
