#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Event, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

/// The first turn reacts to the prompt: `jobs N` admits N background jobs,
/// `park` waits until the run is cancelled, anything else finishes at once.
/// Later turns just close the turn, the way jobs.rs closes its submitter.
struct Submitter {
    next: Arc<Notify>,
    seconds: u64,
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
            let prompt = request.messages[0].content[0]["text"]
                .as_str()
                .unwrap_or_default();
            if let Some(count) = prompt.strip_prefix("jobs ") {
                let calls = (0..count.parse::<usize>().unwrap())
                    .map(|index| {
                        json!({"type":"tool_use","id":format!("call_{index}"),"name":"start_job","input":{
                            "argv":["/bin/sh","-c",format!("sleep {}; printf result", self.seconds)],
                            "timeout_ms":10000
                        }})
                    })
                    .collect::<Vec<_>>();
                return Ok(Reply {
                    content: Value::Array(calls),
                    usage: json!({}),
                    needs_tools: true,
                });
            }
            if prompt == "park" {
                self.next.notify_one();
                cancel.cancelled().await;
                return Err(ProviderError::Interrupted);
            }
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
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

async fn setup(parent: &Path, seconds: u64) -> (Runtime, Store, Arc<Notify>) {
    let root = parent.join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("AGENTS.md"), "Preserve user changes.").unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let next = Arc::new(Notify::new());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter {
            next: next.clone(),
            seconds,
        }),
        Tools::new(root)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        policy(),
    )
    .await
    .unwrap();
    (runtime, store, next)
}

fn input(session: &str, prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

async fn event(store: &Store, session: &str, kind: &str) -> Option<Event> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(event) = store
                .events(session, 0, 100)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == kind)
            {
                return event;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .ok()
}

/// Waits until the Session has at least `count` durable job rows.
async fn jobs(store: &Store, session: &str, count: usize) -> Vec<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let jobs = store.jobs(session).await.unwrap();
            if jobs.len() >= count {
                return jobs;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("every admitted job is durable")
}

/// Waits until one job reaches a state outside queued/running.
async fn settled(store: &Store, session: &str, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if let Some(job) = store.job(session, id).await.unwrap() {
                if !matches!(job["state"].as_str(), Some("queued" | "running")) {
                    return job;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the job settles")
}

/// The fleet-wide job pool holds four slots and a Session's share is two, so
/// a Session asking for three holds two and its third stays queued even
/// though two fleet slots are still free. Another Session's first job takes a
/// free slot right away — that is the cross-session guarantee.
#[tokio::test]
async fn a_session_at_its_share_leaves_free_slots_to_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), 30).await;
    runtime.admit(input("hog", "jobs 3"), true).await.unwrap();
    let hog = jobs(&store, "hog", 3).await;
    let third = hog[2]["job_id"].as_str().unwrap().to_owned();
    let queued = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let job = store.job("hog", &third).await.unwrap().unwrap();
            if job["state"] == "queued" {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the third job queues behind the Session's own share");

    runtime.admit(input("peer", "jobs 1"), true).await.unwrap();
    let peer = jobs(&store, "peer", 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let job = store
                .job("peer", peer[0]["job_id"].as_str().unwrap())
                .await
                .unwrap()
                .unwrap();
            if job["state"] == "running" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the peer's job runs without waiting for the hog");
    let still_queued = store
        .job("hog", queued["job_id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_queued["state"], "queued");
    runtime.shutdown().await;
}

/// Queueing, not rejection: a Session's third job starts as soon as one of
/// that Session's own jobs frees its share, never earlier.
#[tokio::test]
async fn a_share_gated_job_starts_when_the_sessions_own_job_settles() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), 1).await;
    runtime.admit(input("s", "jobs 3"), true).await.unwrap();
    let batch = jobs(&store, "s", 3).await;
    for job in &batch {
        let state = settled(&store, "s", job["job_id"].as_str().unwrap()).await["state"].clone();
        assert_eq!(state, "completed", "{job}");
    }
    runtime.shutdown().await;
}

/// The observable half: limits, per-Session shares, and queue accounting are
/// readable from the runtime while the pools are loaded.
#[tokio::test]
async fn resources_reports_limits_shares_and_queue_accounting() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, ..) = setup(dir.path(), 30).await;
    runtime.admit(input("hog", "jobs 3"), true).await.unwrap();
    let snapshot = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let snapshot = runtime.resources().await;
            if snapshot["jobs"]["queued"].as_u64().unwrap_or(0) >= 1 {
                return snapshot;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the share-gated job registers as queued");
    assert_eq!(snapshot["jobs"]["limit"], 4, "{snapshot}");
    assert_eq!(snapshot["jobs"]["per_session"], 2, "{snapshot}");
    assert_eq!(snapshot["jobs"]["active"], 2, "{snapshot}");
    assert!(
        snapshot["jobs"]["queued"].as_u64().unwrap() >= 1,
        "{snapshot}"
    );
    assert!(
        snapshot["jobs"]["admitted"].as_u64().unwrap() >= 2,
        "{snapshot}"
    );
    assert_eq!(snapshot["drains"]["limit"], 8, "{snapshot}");
    assert_eq!(snapshot["terminals"]["limit"], 32, "{snapshot}");
    assert_eq!(snapshot["terminals"]["per_session"], 8, "{snapshot}");
    assert_eq!(snapshot["lsp"]["limit"], 8, "{snapshot}");
    runtime.shutdown().await;
}

/// A Session whose jobs saturate the pool must not slow another Session's
/// input admission or its operator's ability to interrupt it.
#[tokio::test]
async fn saturated_jobs_do_not_block_another_sessions_input_or_interrupt() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 30).await;
    runtime.admit(input("hog", "jobs 3"), true).await.unwrap();
    jobs(&store, "hog", 3).await;

    runtime.admit(input("parked", "park"), true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), next.notified())
        .await
        .expect("the parked Session reaches its provider");

    runtime.admit(input("worker", "plain"), true).await.unwrap();
    let finished = event(&store, "worker", "run.finished")
        .await
        .expect("the worker Session finishes while the pool is loaded");
    assert_eq!(finished.data["reason"], "completed");

    assert!(runtime.cancel("parked").await.unwrap());
    let finished = event(&store, "parked", "run.finished")
        .await
        .expect("the parked Session interrupts while the pool is loaded");
    assert_eq!(finished.data["reason"], "interrupted");
    runtime.shutdown().await;
}
