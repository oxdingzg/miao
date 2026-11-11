#![cfg(any(target_os = "macos", target_os = "linux"))]
//! The waiting banner: whose work it counts, how it names it, and what it does
//! to the Session that is waiting.
//!
//! One orchestration paused with 59 delegated subagent ids in the note, most of
//! them the same child listed twice and the rest children of other Sessions.
//! The list was the Session's own event row rather than its lineage, so an
//! adopted child counted against a parent that never forked it, and a
//! re-dispatch left a duplicate row that only the first stop event settled.
//!
//! The note now answers with counts and no ids, and a running child on its own
//! does not pause the Session that delegated it.

use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    state::Mutation,
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

/// Answers every turn with text alone, so each provider turn is a chance for the
/// loop to decide whether the delegated work it knows about is a reason to stop.
/// The turn count is what each test reads: a Session that keeps continuing is
/// the behaviour a running child must not take away.
struct Idle {
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for Idle {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            needs_tools: false,
            content: json!([{"type":"text","text":"the delegated work is still going"}]),
            usage: json!({}),
        })
    }
}

/// One provider turn that starts a long background job, then idle text. The job
/// is what the waiting pause is for: a process this Session owns and cannot
/// finish for itself.
struct Stalls {
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for Stalls {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            needs_tools: index == 0,
            content: if index == 0 {
                json!([{"type":"tool_use","id":"stall","name":"start_job","input":{
                    "argv":["/bin/sh","-c","sleep 5"],"timeout_ms":30000
                }}])
            } else {
                json!([{"type":"text","text":"waiting on the job"}])
            },
            usage: json!({}),
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        allow_background: true,
        continuation_min_interval_ms: 0,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        max_provider_turns: Some(6),
        ..Config::default()
    })
    .unwrap()
}

/// A runnable todo plus a goal, so the loop has work to continue with. Without
/// it the drain ends on its own and never reaches the waiting decision.
async fn seed_work(store: &Store, workspace: &std::path::Path) {
    store
        .admit_attachments_at(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "Work on the authorized tasks".into(),
                delivery: Delivery::Steer,
            },
            Vec::new(),
            Some(
                std::fs::canonicalize(workspace)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
        )
        .await
        .unwrap();
    store
        .update_state(
            "s",
            "todos",
            Mutation::parse(
                "todowrite",
                json!({"todos":[
                    {"id":"4","content":"CI","status":"waiting","priority":"high"},
                    {"id":"7","content":"Audit","status":"pending","priority":"medium"}
                ]}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    store
        .update_state(
            "s",
            "goal",
            Mutation::parse(
                "goal",
                json!({"objective":"Finish tasks","status":"active","autonomous":true,
                       "evidence":"Explicit engagement state"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
}

async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the run finished");
}

/// A child Session forked by `parent`, with the lineage edge that says so.
async fn fork_child(store: &Store, parent: &str, child: &str) {
    store.ensure(parent).await.unwrap();
    store.fork(parent, child, Some(0)).await.unwrap();
}

/// A background delegation recorded in `owner`'s journal. The journal says who
/// asked; the lineage edge says who forked, and the two can disagree when a
/// Session adopts a child that another Session created.
async fn start(store: &Store, owner: &str, child: &str) {
    store
        .record(
            owner,
            "subagent_start",
            json!({"run_id":"r","subagent_id":child,"call_id":format!("call-{child}"),
                   "background":true,"description":"delegated work"}),
        )
        .await
        .unwrap();
}

/// The child counts once and it counts against the Session that forked it. A
/// second start for the same child is the re-dispatch a settled outcome allows;
/// it is not a second running task. A start recorded in one Session's journal for
/// a child that another Session forked is an adoption, and it is not this
/// Session's work to wait on.
#[tokio::test]
async fn only_this_sessions_running_children_are_counted_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    fork_child(&store, "s", "child-a").await;
    // The adopted child's durable parent is the other Session, whatever this
    // Session's journal says about who asked for it.
    fork_child(&store, "other", "child-foreign").await;
    start(&store, "s", "child-a").await;
    start(&store, "s", "child-a").await;
    start(&store, "s", "child-foreign").await;

    assert_eq!(
        store.subagents("s").await.unwrap().len(),
        2,
        "one row per child, not one per start event"
    );
    assert_eq!(
        store.running_subagents("s").await.unwrap(),
        vec!["child-a".to_string()],
        "only the child this Session forked is still running for it"
    );
    // A settled child stops counting, and the duplicate start must not keep a
    // phantom row running after the stop that settles it.
    store
        .record(
            "s",
            "subagent_stop",
            json!({"run_id":"r","subagent_id":"child-a","call_id":"call-child-a",
                   "reason":"completed","text":"ok"}),
        )
        .await
        .unwrap();
    assert!(
        store.running_subagents("s").await.unwrap().is_empty(),
        "a completed child leaves nothing to wait on"
    );
}

/// A running child is work this Session delegated, not a bound it must pause on:
/// the drain keeps continuing so the Session can do the rest of its list while
/// the child works. The note never names a child, so nothing here may print one.
#[tokio::test]
async fn a_running_child_does_not_pause_its_parent_and_prints_no_ids() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed_work(&store, &workspace).await;
    fork_child(&store, "s", "child-a").await;
    fork_child(&store, "other", "child-foreign").await;
    start(&store, "s", "child-a").await;
    start(&store, "s", "child-a").await;
    start(&store, "s", "child-foreign").await;
    let provider = Arc::new(Idle {
        calls: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    let events = store.events("s", 0, 5000).await.unwrap();
    runtime.shutdown().await;

    assert!(
        !events
            .iter()
            .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "waiting"),
        "a running child must not pause the Session that delegated it"
    );
    let notes = events
        .iter()
        .filter_map(|event| event.data["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !notes.contains("delegated subagent task(s) still running"),
        "a running child is not a pause, so it is not announced as one: {notes}"
    );
    assert!(
        !notes.contains("child-a") && !notes.contains("child-foreign"),
        "the note never enumerates child ids: {notes}"
    );
    assert!(
        provider.calls.load(Ordering::SeqCst) > 1,
        "the drain kept continuing its own list while the child ran"
    );
}

/// A background job is the one kind of background work that pauses, because
/// nothing about it finishes the Session's turn for it. The note then says how
/// many are running — the count is the whole decision — and never which.
#[tokio::test]
async fn a_running_job_pauses_with_a_count_and_no_ids() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed_work(&store, &workspace).await;
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Stalls {
            calls: AtomicUsize::new(0),
        }),
        Tools::new(&workspace)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        policy(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    let events = store.events("s", 0, 5000).await.unwrap();
    let jobs = store.jobs("s").await.unwrap();
    // The shell job is still sleeping; shutdown cancels and reaps it.
    runtime.shutdown().await;

    assert!(
        events
            .iter()
            .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "waiting"),
        "a job this Session owns is what the waiting pause is for"
    );
    let pause = events
        .iter()
        .filter_map(|event| event.data["text"].as_str())
        .find(|text| text.contains("Task paused"))
        .expect("the pause is visible in history");
    assert!(
        pause.contains("1 background job(s) still running"),
        "the pause counts the work it is waiting on: {pause}"
    );
    let id = jobs[0]["job_id"].as_str().unwrap();
    assert!(
        !pause.contains(id),
        "the pause reports a count, not the ids it counted: {pause}"
    );
    assert!(
        !pause.contains("delegated subagent task(s)"),
        "no child is running, so none is announced: {pause}"
    );
}
