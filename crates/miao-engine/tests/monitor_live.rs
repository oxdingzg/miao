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
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Submitter {
    next: Arc<Notify>,
    monitor_command: String,
}
#[async_trait]
impl Provider for Submitter {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call_monitor","name":"monitor","input":{"command":self.monitor_command,"description":"fixture watch","pattern":"READY","timeout_ms":30000}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        if request.messages.last().is_some_and(|message| {
            message.content.as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["type"] == "text"
                        && part["text"]
                            .as_str()
                            .is_some_and(|text| text.contains("READY"))
                })
            })
        }) {
            self.next.notify_one();
            cancel.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        cancel.cancelled().await;
        Err(ProviderError::Interrupted)
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        allow_background: true,
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
async fn monitor_streams_pattern_matched_notices_and_cancel_stops_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let next = Arc::new(Notify::new());
    let monitor_command =
        "echo READY-line; echo noise-line; echo READY-final; sleep 60".to_string();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter {
            next: next.clone(),
            monitor_command,
        }),
        Tools::new(&root)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "watch".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // The child is alive for the remainder of the test; cancel it through the
    // session state flow and assert the cancellation path marks the monitor.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let jobs = store.jobs("s").await.unwrap();
        if jobs.len() == 1 && jobs[0]["state"] == json!("running") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "monitor job never reached running: {jobs:?} events={:?}",
            store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .map(|event| (event.kind.clone(), event.data.clone()))
                .collect::<Vec<_>>(),
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let job_id = store.jobs("s").await.unwrap()[0]["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(runtime.cancel_job("s", &job_id).await.unwrap());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let jobs = store.jobs("s").await.unwrap();
        if jobs[0]["state"] != json!("running") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "monitor job never settled after cancel"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    runtime.shutdown().await;
}
