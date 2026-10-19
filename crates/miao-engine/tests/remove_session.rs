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

struct Scheduler {
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for Scheduler {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            assert!(request
                .tools
                .iter()
                .any(|tool| tool.name == "schedule_wakeup"));
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"timer","name":"schedule_wakeup","input":{"prompt":"fire-me","delaySeconds":60}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"scheduled"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn setup(path: &std::path::Path) -> (Runtime, Store) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Scheduler {
        calls: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider,
        Tools::new(path).await.unwrap(),
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
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "schedule".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // The turn arms one durable wakeup and finishes; the timer task is what
    // removal has to stop.
    for _ in 0..50 {
        if !store.wakeups("s").await.unwrap().is_empty() {
            return (runtime, store);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the scheduling turn never armed a wakeup");
}

#[tokio::test]
async fn removing_a_session_stops_its_schedules_so_nothing_resurrects_it() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path()).await;
    let id = store.wakeups("s").await.unwrap()[0]["timer_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        runtime.remove("s").await.unwrap(),
        json!({"accepted": true})
    );
    assert!(store.sessions().await.unwrap().is_empty());
    assert!(store.wakeups("s").await.unwrap().is_empty());
    assert!(store.events("s", 0, 100).await.unwrap().is_empty());
    assert!(store.snapshot("s").await.is_err());
    assert!(!runtime.cancel_wakeup("s", &id).await.unwrap());
    // The armed timer would have admitted `wakeup/<id>` at its due time, and an
    // admission re-creates the Session row. Advancing virtual time past the due
    // time proves the in-process task really was stopped, not just its rows.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(3_600)).await;
    tokio::time::resume();
    assert!(store.sessions().await.unwrap().is_empty());
    assert!(store.events("s", 0, 100).await.unwrap().is_empty());
    assert!(store.snapshot("s").await.is_err());
    // Removal is reportable, not refusable, so a retry after the caller's own
    // cleanup cannot get stuck.
    assert_eq!(
        runtime.remove("s").await.unwrap(),
        json!({"accepted": false, "reason": "unknown"})
    );
    runtime.shutdown().await;
}
