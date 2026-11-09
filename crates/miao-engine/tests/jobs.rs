#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    host::Host,
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Command, Delivery, Input, ModelRequest},
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
    /// How long each started job lives, in seconds. A test that stops or
    /// shuts down running work needs jobs that outlive its own assertions.
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
            let calls=(0..self.count).map(|index|json!({"type":"tool_use","id":format!("call_{index}"),"name":"start_job","input":{"argv":["/bin/sh","-c",format!("sleep {sleep}; printf done > finished_{index}; printf result", sleep = self.seconds)],"timeout_ms":10000}})).collect::<Vec<_>>();
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
    seconds: u64,
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
    let (runtime, store, next) = setup(dir.path(), 1, true, 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
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
    let (runtime, store, next) = setup(dir.path(), 1, false, 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
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

/// `cancel_job` takes one id. An operator who wants everything stopped has no
/// list to walk from the TUI, so the Session needs a single call that stops all
/// of its own jobs and reports which ones it stopped.
#[tokio::test]
async fn stop_all_jobs_cancels_every_job_the_session_owns() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 3, false, 8).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
        .await
        .unwrap();
    let ids: Vec<String> = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let jobs = store.jobs("s").await.unwrap();
            if jobs.len() >= 3 {
                return jobs;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every admitted job is durable")
    .iter()
    .map(|job| job["job_id"].as_str().unwrap().to_string())
    .collect();

    // A job's durable row is committed before the task that owns it registers
    // with the runtime, so the rows alone can show three ids while only two are
    // stoppable yet. `owned_jobs` reads the same set `stop_all_jobs` walks,
    // which makes this wait exact instead of a guess.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while runtime.owned_jobs("s").await.len() < ids.len() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every admitted job registers with the runtime");

    let stopped = runtime.stop_all_jobs("s").await.unwrap();
    assert_eq!(stopped.len(), 3, "stopped {stopped:?} of {ids:?}");
    for id in &ids {
        assert_eq!(terminal(&store, id).await["state"], "cancelled", "{id}");
    }
    // Nothing is left to stop, so a second call reports nothing rather than
    // claiming work it did not do.
    assert!(runtime.stop_all_jobs("s").await.unwrap().is_empty());
    runtime.shutdown().await;
}

/// A Session's stop must not reach another Session's jobs.
#[tokio::test]
async fn stop_all_jobs_leaves_another_sessions_jobs_running() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, false, 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
        .await
        .unwrap();
    let id = store.jobs("s").await.unwrap()[0]["job_id"]
        .as_str()
        .unwrap()
        .to_string();
    // `other` owns nothing; stopping it must not touch `s`.
    assert!(runtime.stop_all_jobs("other").await.unwrap().is_empty());
    assert_ne!(
        terminal(&store, &id).await["state"].as_str(),
        Some("cancelled")
    );
    runtime.shutdown().await;
}

/// The `jobs` command serves the whole dialog in one frame: each row names its
/// owner and carries the command plus the tail of what it produced, and the
/// Session's delegated children ride along as read-only rows. `stop_all_jobs`
/// reaches the same set through the wire, which is what the dialog's global
/// stop calls.
#[tokio::test]
async fn the_jobs_command_serves_owners_output_and_children_in_one_answer() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, false, 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
        .await
        .unwrap();
    // One delegated child of the Session, so the side list has a row to show.
    store.fork("s", "sub", Some(0)).await.unwrap();

    let mut host = Host::new(runtime.clone());
    let answer = host
        .dispatch(Command::Jobs {
            session_id: "s".into(),
        })
        .await
        .unwrap();
    let rows = answer["jobs"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{answer}");
    let id = rows[0]["job_id"].as_str().unwrap();
    assert_eq!(rows[0]["session_id"], "s", "the row names its owner");
    assert_eq!(
        rows[0]["command"],
        "/bin/sh -c sleep 1; printf done > finished_0; printf result"
    );
    // A running job has no result yet, so the tail is empty rather than
    // invented; the `job` command answers the result once it lands.
    assert_eq!(rows[0]["output"], "");

    let subagents = answer["subagents"].as_array().unwrap();
    assert_eq!(subagents.len(), 1, "{answer}");
    assert_eq!(subagents[0]["id"], "sub");
    assert_eq!(subagents[0]["session_id"], "s");
    assert_eq!(subagents[0]["status"], "idle", "the child never ran");
    assert_eq!(subagents[0]["description"], "");

    // The durable row can exist before the owning task registers, so the
    // registration is awaited exactly like `stop_all_jobs` itself walks it.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while runtime.owned_jobs("s").await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the job registers with the runtime");

    let stopped = host
        .dispatch(Command::StopAllJobs {
            session_id: "s".into(),
        })
        .await
        .unwrap();
    assert_eq!(stopped["stopped"], serde_json::json!([id]), "{stopped}");
    assert_eq!(terminal(&store, id).await["state"], "cancelled");
    runtime.shutdown().await;
}

#[tokio::test]
async fn runtime_shutdown_joins_running_and_queued_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 3, false, 8).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
        .await
        .unwrap();
    let jobs = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let jobs = store.jobs("s").await.unwrap();
            if jobs.len() >= 3 {
                return jobs;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every admitted job is durable");
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
    let (runtime, store, next) = setup(dir.path(), 1, false, 1).await;
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

/// `{job_id, state}` alone cannot answer the question the list exists for:
/// which of my commands is still running, and what is it saying. The row now
/// carries the owner, the command, and the tail of its output.
#[tokio::test]
async fn the_job_list_names_the_owner_and_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, next) = setup(dir.path(), 1, false, 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), next.notified())
        .await
        .unwrap();
    let jobs = store.jobs("s").await.unwrap();
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    let job = &jobs[0];
    assert_eq!(job["session_id"], "s", "the owner must be named: {job}");
    assert!(
        job["command"]
            .as_str()
            .is_some_and(|command| !command.is_empty()),
        "the command that started the job must be visible: {job}"
    );
    // `output` is a tail, not the full log; it may legitimately be empty while
    // the process has not written yet, so only its presence is asserted.
    assert!(job.get("output").is_some(), "{job}");
    runtime.shutdown().await;
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
