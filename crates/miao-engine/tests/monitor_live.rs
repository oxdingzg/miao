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
use std::{sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

struct Submitter {
    command: String,
    timeout_ms: u64,
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
                content: json!([{"type":"tool_use","id":"call_monitor","name":"monitor","input":{"command":self.command,"description":"fixture watch","pattern":"READY","timeout_ms":self.timeout_ms}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        cancel.cancelled().await;
        Err(ProviderError::Interrupted)
    }
}

async fn start(
    command: &str,
    timeout_ms: u64,
) -> (
    Runtime,
    Store,
    broadcast::Receiver<Value>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let policy = Policy::new(Config {
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
    .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter {
            command: command.into(),
            timeout_ms,
        }),
        Tools::new(&root)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        policy,
    )
    .await
    .unwrap();
    let progress = runtime.progress();
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
    (runtime, store, progress, dir)
}

async fn settled(store: &Store) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let jobs = store.jobs("s").await.unwrap();
        if let Some(job) = jobs
            .first()
            .filter(|job| job["state"] != "queued" && job["state"] != "running")
        {
            return store
                .job("s", job["job_id"].as_str().unwrap())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "monitor never settled: {jobs:?}, events={:?}",
            store.events("s", 0, 200).await.unwrap()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn watching_command() -> &'static str {
    if cfg!(windows) {
        "echo READY-line & echo noise-line & echo READY-final & powershell -NoProfile -Command \"Start-Sleep -Seconds 60\""
    } else {
        "echo READY-line; echo noise-line; echo READY-final; sleep 60"
    }
}

#[tokio::test]
async fn monitor_streams_pattern_matched_notices_and_cancel_stops_it() {
    let (runtime, store, mut progress, _dir) = start(watching_command(), 30_000).await;
    let notice = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = progress.recv().await.unwrap();
            if event["kind"] == "monitor.notice" {
                break event;
            }
        }
    })
    .await
    .expect("monitor never streamed matching stdout");
    let lines = notice["lines"].as_array().unwrap();
    assert!(lines
        .iter()
        .any(|line| line.as_str().unwrap().trim() == "READY-line"));
    assert!(lines
        .iter()
        .any(|line| line.as_str().unwrap().trim() == "READY-final"));
    assert!(!lines
        .iter()
        .any(|line| line.as_str().unwrap().trim() == "noise-line"));
    assert!(
        store
            .events("s", 0, 200)
            .await
            .unwrap()
            .iter()
            .any(|event| {
                event.kind == "input.admitted"
                    && event.data["input_id"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("monitor:"))
            }),
        "monitor output must be durable admission, not only ephemeral progress"
    );
    let id = notice["job_id"].as_str().unwrap();
    assert!(runtime.cancel_job("s", id).await.unwrap());
    assert_eq!(settled(&store).await["state"], "cancelled");
    runtime.shutdown().await;
}

#[tokio::test]
async fn monitor_natural_exit_settles_the_durable_job() {
    let command = if cfg!(windows) {
        "echo READY-line & exit /b 0"
    } else {
        "echo READY-line"
    };
    let (runtime, store, mut progress, _dir) = start(command, 30_000).await;
    let job = settled(&store).await;
    assert_eq!(job["state"], "completed");
    assert_eq!(job["result"]["exit_code"], 0);
    let notice = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let event = progress.recv().await.unwrap();
            if event["kind"] == "monitor.notice" {
                break event;
            }
        }
    })
    .await
    .expect("short-lived stdout was lost during exit");
    assert!(notice["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line.as_str().unwrap().trim() == "READY-line"));
    assert!(
        store
            .events("s", 0, 200)
            .await
            .unwrap()
            .iter()
            .any(|event| {
                event.kind == "input.admitted"
                    && event.data["input_id"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("monitor:"))
            }),
        "short-lived output must be durably admitted before settling"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn monitor_timeout_settles_the_durable_job() {
    let (runtime, store, _progress, _dir) = start(watching_command(), 100).await;
    let job = settled(&store).await;
    assert_eq!(job["state"], "failed");
    assert_eq!(job["result"]["timed_out"], true);
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn closing_stdout_does_not_disable_cancellation() {
    let (runtime, store, _progress, _dir) = start("exec 1>&-; sleep 60", 30_000).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let id = loop {
        let jobs = store.jobs("s").await.unwrap();
        if let Some(job) = jobs.first().filter(|job| job["state"] == "running") {
            break job["job_id"].as_str().unwrap().to_owned();
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    // Let the EOF arrive before cancelling; the process itself remains alive.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(runtime.cancel_job("s", &id).await.unwrap());
    assert_eq!(settled(&store).await["state"], "cancelled");
    runtime.shutdown().await;
}
