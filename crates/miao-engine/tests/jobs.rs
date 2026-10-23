#![cfg(any(target_os = "macos", target_os = "linux"))]
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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Submitter {
    next: Arc<Notify>,
    count: usize,
    pending: bool,
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
            let calls=(0..self.count).map(|index|json!({"type":"tool_use","id":format!("call_{index}"),"name":"start_job","input":{"argv":["/bin/sh","-c",format!("sleep 1; printf done > finished_{index}; printf result")],"timeout_ms":10000}})).collect::<Vec<_>>();
            return Ok(Reply {
                content: Value::Array(calls),
                usage: json!({}),
                needs_tools: true,
            });
        }
        self.next.notify_one();
        if self.pending {
            cancel.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"submitted"}]),
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
async fn setup(
    parent: &std::path::Path,
    count: usize,
    pending: bool,
) -> (Runtime, Store, Arc<Notify>) {
    let root = parent.join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("AGENTS.md"), "Preserve user changes.").unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let next = Arc::new(Notify::new());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter {
            next: next.clone(),
            count,
            pending,
        }),
        Tools::new(root)
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
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "submit jobs".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store, next)
}
async fn terminal(store: &Store, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(job) = store.job("s", id).await.unwrap() {
                if !matches!(job["state"].as_str(), Some("queued" | "running")) {
                    return job;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn admitted_job_survives_turn_cancel_and_instruction_reads_do_not_wait_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, true).await;
    tokio::time::timeout(std::time::Duration::from_secs(3), next.notified())
        .await
        .unwrap();
    let jobs = store.jobs("s").await.unwrap();
    let id = jobs[0]["job_id"].as_str().unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    let result = terminal(&store, id).await;
    assert_eq!(result["state"], "completed", "{result}");
    assert_eq!(result["result"]["stdout"], "result");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace/finished_0")).unwrap(),
        "done"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn job_ownership_and_explicit_cancel_are_separate_from_turn_control() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, false).await;
    tokio::time::timeout(std::time::Duration::from_secs(3), next.notified())
        .await
        .unwrap();
    let jobs = store.jobs("s").await.unwrap();
    let id = jobs[0]["job_id"].as_str().unwrap();
    assert!(store.job("other", id).await.unwrap().is_none());
    assert!(runtime.cancel_job("other", id).await.is_err());
    assert!(runtime.cancel_job("s", id).await.unwrap());
    assert_eq!(terminal(&store, id).await["state"], "cancelled");
    assert!(!runtime.cancel_job("s", id).await.unwrap());
    runtime.shutdown().await;
}

#[tokio::test]
async fn runtime_shutdown_joins_running_and_queued_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 3, false).await;
    tokio::time::timeout(std::time::Duration::from_secs(3), next.notified())
        .await
        .unwrap();
    let jobs = store.jobs("s").await.unwrap();
    assert_eq!(jobs.len(), 3);
    runtime.shutdown().await;
    for job in jobs {
        let result = store
            .job("s", job["job_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["state"], "cancelled", "{result}");
    }
}

#[tokio::test]
async fn crash_reconciliation_preserves_unknown_running_state_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "submit".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    let input = json!({"argv":["/bin/echo","effect"]});
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([{"type":"tool_use","id":"call","name":"start_job","input":input}]),
        )
        .await
        .unwrap();
    store.mark_dispatched("s", "run", "call").await.unwrap();
    let admitted = store
        .create_job("s", "run", "call", input.clone())
        .await
        .unwrap();
    let id = admitted["job_id"].as_str().unwrap();
    assert_eq!(
        store.create_job("s", "run", "call", input).await.unwrap()["duplicate"],
        true
    );
    assert!(store
        .create_job(
            "s",
            "run",
            "call",
            json!({"argv":["/bin/echo","different"]})
        )
        .await
        .is_err());
    store.start_job("s", id).await.unwrap();
    store.recover_jobs().await.unwrap();
    assert_eq!(
        store.job("s", id).await.unwrap().unwrap()["state"],
        "unknown"
    );
    store.recover_jobs().await.unwrap();
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "job.finished")
            .count(),
        1
    );
}

#[tokio::test]
async fn job_completion_after_idle_admits_once_and_wakes_the_existing_owner() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, false).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), next.notified())
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let events = store.events("s", 0, 500).await.unwrap();
            if events
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let jobs = store.jobs("s").await.unwrap();
    assert_eq!(jobs.len(), 1);
    let id = jobs[0]["job_id"].as_str().unwrap();
    assert_eq!(jobs[0]["state"], "completed");
    let events = store.events("s", 0, 500).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "job.started")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "job.finished")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.promoted")
            .count(),
        2
    );
    let finished = events
        .iter()
        .find(|event| event.kind == "job.finished")
        .unwrap();
    let notification = events
        .iter()
        .rfind(|event| event.kind == "input.admitted")
        .unwrap();
    assert!(finished.seq < notification.seq);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace/finished_0")).unwrap(),
        "done"
    );
    assert!(store
        .finish_job("s", id, "completed", json!({}))
        .await
        .is_err());
    assert_eq!(
        store
            .events("s", 0, 500)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count(),
        2
    );
    runtime.shutdown().await;
}

struct Observer {
    step: AtomicUsize,
    done: Arc<Notify>,
}

fn tool_results(request: &ModelRequest) -> Vec<Value> {
    request
        .messages
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .filter(|part| part["type"] == "tool_result")
        .cloned()
        .collect()
}

#[async_trait]
impl Provider for Observer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let results = tool_results(&request);
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let content = match step {
            0 => {
                json!([{"type":"tool_use","id":"start","name":"start_job","input":{"argv":["/bin/sh","-c","sleep 0.2; printf waited"],"timeout_ms":10000}}])
            }
            1 => {
                let started: Value =
                    serde_json::from_str(results[0]["content"].as_str().unwrap()).unwrap();
                assert_eq!(started["state"], "queued");
                json!([{"type":"tool_use","id":"list","name":"job_list","input":{}}])
            }
            2 => {
                let listed: Value =
                    serde_json::from_str(results[1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(listed["jobs"].as_array().unwrap().len(), 1);
                let id = listed["jobs"][0]["job_id"].as_str().unwrap();
                json!([{"type":"tool_use","id":"wait","name":"job_wait","input":{"job_id":id,"timeout_ms":5000}}])
            }
            3 => {
                let waited: Value =
                    serde_json::from_str(results[2]["content"].as_str().unwrap()).unwrap();
                assert_eq!(waited["timedOut"], false);
                assert_eq!(waited["job"]["state"], "completed");
                assert_eq!(waited["job"]["result"]["stdout"], "waited");
                json!([{"type":"tool_use","id":"missing","name":"job_wait","input":{"job_id":"missing","timeout_ms":10}}])
            }
            _ => {
                let missing: Value =
                    serde_json::from_str(results[3]["content"].as_str().unwrap()).unwrap();
                assert!(missing["job"].is_null());
                assert_eq!(missing["timedOut"], false);
                self.done.notify_one();
                json!([{"type":"text","text":"observed"}])
            }
        };
        Ok(Reply {
            content,
            usage: json!({}),
            needs_tools: step < 4,
        })
    }
}

#[tokio::test]
async fn job_list_and_wait_observe_a_completed_job() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let done = Arc::new(Notify::new());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Observer {
            step: AtomicUsize::new(0),
            done: done.clone(),
        }),
        Tools::new(root)
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
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "observe a job".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), done.notified())
        .await
        .unwrap();
    runtime.shutdown().await;
}
