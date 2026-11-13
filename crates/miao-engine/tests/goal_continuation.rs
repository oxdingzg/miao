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

/// Serializes the tests that tune the no-progress floor through the process
/// environment; parallel set/remove would race each other.
static NO_PROGRESS_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Script {
    calls: AtomicUsize,
    progress: bool,
    churn: bool,
    finish_after: Option<usize>,
}
#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.churn {
            let status = if self.finish_after.is_some_and(|last| index >= last) {
                "completed"
            } else {
                "pending"
            };
            return Ok(Reply {
                needs_tools: index.is_multiple_of(2),
                content: if index.is_multiple_of(2) {
                    json!([{"type":"tool_use","id":format!("progress-{index}"),"name":"todowrite","input":{"todos":[
                        {"id":"7","content":format!("Ready update {index}"),"status":status,"priority":"medium"}
                    ]}}])
                } else {
                    json!([{"type":"text","text":"early stop"}])
                },
                usage: json!({}),
            });
        }
        let content = match (self.progress, index) {
            (true, 1) => {
                json!([{"type":"tool_use","id":"audit-write","name":"write_file","input":{"path":"audit","text":"once","expected_sha256":null}}])
            }
            (true, 2) => {
                json!([{"type":"tool_use","id":"audit-status","name":"todowrite","input":{"todos":[
                    {"id":"4","content":"CI","status":"waiting","priority":"high"},
                    {"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]},
                    {"id":"7","content":"Audit","status":"completed","priority":"medium"}
                ]}}])
            }
            _ => json!([{"type":"text","text":"waiting"}]),
        };
        Ok(Reply {
            needs_tools: self.progress && (index == 1 || index == 2),
            content,
            usage: json!({}),
        })
    }
}

async fn seed_work(store: &Store, ready: bool, location: &std::path::Path) {
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
                std::fs::canonicalize(location)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
        )
        .await
        .unwrap();
    let mut todos = vec![
        json!({"id":"4","content":"CI","status":"waiting","priority":"high"}),
        json!({"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]}),
    ];
    if ready {
        todos.push(json!({"id":"7","content":"Audit","status":"pending","priority":"medium"}));
    }
    store
        .update_state(
            "s",
            "todos",
            Mutation::parse("todowrite", json!({"todos":todos})).unwrap(),
        )
        .await
        .unwrap();
}

async fn setup(
    store: &Store,
    status: &str,
    autonomous: bool,
    ready: bool,
    location: &std::path::Path,
) {
    seed_work(store, ready, location).await;
    store.update_state("s", "goal", Mutation::parse("goal", json!({"objective":"Finish tasks","status":status,"autonomous":autonomous,"evidence":"Explicit engagement state"})).unwrap()).await.unwrap();
}
/// Wait for the n-th completed run. `finished` returns on the first one it
/// finds, which is enough for one run but not for a sequence of runs.
async fn finished_runs(store: &Store, wanted: usize) {
    let mut after = 0;
    let mut seen = 0;
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let events = store.events("s", after, 5000).await.unwrap();
            seen += events
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count();
            if seen >= wanted {
                return;
            }
            if let Some(event) = events.last() {
                after = event.seq;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("run.finished #{wanted} was not seen after cursor {after}"));
}

fn notification(index: usize) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: format!("monitor:job1:{index}"),
        prompt: format!("watch \"job1\" matched: tick {index}"),
        delivery: Delivery::Queue,
    }
}

fn operator(index: usize) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: format!("in_operator_{index}"),
        prompt: "继续".into(),
        delivery: Delivery::Queue,
    }
}

async fn waiting_runtime(store: &Store, provider: Arc<Script>, dir: &std::path::Path) -> Runtime {
    Runtime::with_policy(
        store.clone(),
        provider,
        Tools::new(dir).await.unwrap(),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            mode: Mode::Workspace,
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn finished(store: &Store) {
    // Advance through the bounded journal pages rather than repeatedly
    // parsing the entire growing prefix and competing with durable writes.
    let mut after = 0;
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            let events = store.events("s", after, 5000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return;
            }
            if let Some(event) = events.last() {
                after = event.seq;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("run.finished was not observed after journal cursor {after}"));
}

#[tokio::test]
async fn continues_independent_work_without_a_human_prompt_then_idles_with_locked_dependents() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: true,
        churn: false,
        finish_after: None,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "write_file".into(),
                path: "*".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        4,
        "{:?}",
        store
            .events("s", 0, 500)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind.contains("tool") || event.kind.contains("state"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("audit")).unwrap(),
        "once"
    );
    let events = store.events("s", 0, 500).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "loop.continuation")
            .count(),
        1
    );
    assert!(
        miao_engine::state::runnable_state(&store.state("s").await.unwrap())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.promoted")
            .count(),
        2
    );
}

#[tokio::test]
async fn no_progress_is_bounded_and_synthetic_admissions_do_not_restart_the_loop_budget() {
    let _env = NO_PROGRESS_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    // The no-progress pause requires the stall to persist past the
    // configurable floor (MIAO_NO_PROGRESS_MIN_SECS, default 120s); this
    // test pins the immediate-pause behaviour with the floor disabled.
    std::env::set_var("MIAO_NO_PROGRESS_MIN_SECS", "0");
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
        finish_after: None,
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    std::env::remove_var("MIAO_NO_PROGRESS_MIN_SECS");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "no-progress"));
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .any(|event| {
            event.kind == "message.synthetic"
                && event.data["source"] == "engine"
                && event.data["input_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("loop-paused-"))
                && event.data["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Task paused"))
        }));
}

#[tokio::test]
async fn only_waits_paused_goals_and_missing_authorization_never_create_extra_turns() {
    for (status, autonomous, ready) in [
        ("active", true, false),
        ("paused", true, true),
        ("blocked", true, true),
        ("done", true, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        setup(&store, status, autonomous, ready, dir.path()).await;
        let provider = Arc::new(Script {
            calls: AtomicUsize::new(0),
            progress: false,
            churn: false,
            finish_after: None,
        });
        let runtime = Runtime::new(
            store.clone(),
            provider.clone(),
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime.resume("s").await.unwrap();
        finished(&store).await;
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "{status}/{autonomous}/{ready}"
        );
    }
}

#[tokio::test]
async fn denied_state_read_does_not_grant_autonomous_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
        finish_after: None,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            rules: vec![Rule {
                tool: "session_state".into(),
                path: "@session/state/**".into(),
                decision: Decision::Deny,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn changing_progress_does_not_refill_the_provider_allowance() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: true,
        finish_after: None,
    });
    // The leash is explicit here: the default has no provider-turn budget, so
    // an unlimited policy would churn forever instead of demonstrating the
    // refill rule.
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            // Below the flat cap on purpose: this test is about the allowance,
            // and a churning list is bounded by `MAX_FLAT_CONTINUATIONS` now.
            max_provider_turns: Some(5),
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 5);
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed"));
    assert!(events.iter().any(|event| event.kind == "message.synthetic"
        && event.data["text"]
            .as_str()
            .unwrap_or_default()
            .contains("provider turn allowance")));
}

#[tokio::test]
async fn a_churning_todo_list_is_bounded_instead_of_running_forever() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: true,
        finish_after: Some(60),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            max_provider_turns: None,
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    // Rewriting the same todo's words is not progress: the loop stops once the
    // flat cap is reached instead of churning until the list is emptied. Each
    // continuation here costs two provider turns (a todowrite, then the text
    // that ends the turn), so the cap of 24 shows up as one initial pair plus
    // 24 pairs.
    const FLAT_CAP: usize = 24;
    assert_eq!(provider.calls.load(Ordering::SeqCst), (FLAT_CAP + 1) * 2);
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "flat"),
        "the churning loop pauses as flat progress rather than running on"
    );
    assert!(events.iter().any(|event| event.kind == "message.synthetic"
        && event.data["text"]
            .as_str()
            .unwrap_or_default()
            .contains("without any todo changing state")));
    // The loop stops with the work still listed: that is the point of the cap —
    // the operator is asked, instead of a model that never closes the list being
    // re-prompted forever.
    assert!(
        !miao_engine::state::runnable_state(&store.state("s").await.unwrap())
            .unwrap()
            .is_empty()
    );
    runtime.shutdown().await;
}

/// Canned replies in sequence; an exhausted sequence falls back to a plain
/// text-only stop, the shape that used to strand the session mid-task.
struct Sequence {
    calls: AtomicUsize,
    steps: Vec<(bool, Value)>,
}
#[async_trait]
impl Provider for Sequence {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let (needs_tools, content) = self
            .steps
            .get(index)
            .map(|(needs_tools, content)| (*needs_tools, content.clone()))
            .unwrap_or((false, json!([{"type":"text","text":"waiting"}])));
        Ok(Reply {
            needs_tools,
            content,
            usage: json!({}),
        })
    }
}

#[tokio::test]
async fn runnable_todos_keep_draining_without_any_goal() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed_work(&store, true, dir.path()).await;
    let provider = Arc::new(Sequence {
        calls: AtomicUsize::new(0),
        steps: vec![
            (
                true,
                json!([{"type":"tool_use","id":"done-4","name":"todowrite","input":{"todos":[
                    {"id":"4","content":"CI","status":"completed","priority":"high"},
                    {"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]},
                    {"id":"7","content":"Audit","status":"pending","priority":"medium"}
                ]}}]),
            ),
            (
                false,
                json!([{"type":"text","text":"CI green; release next"}]),
            ),
            (
                true,
                json!([{"type":"tool_use","id":"done-5","name":"todowrite","input":{"todos":[
                    {"id":"4","content":"CI","status":"completed","priority":"high"},
                    {"id":"5","content":"Release","status":"completed","priority":"high","depends_on":["4"]},
                    {"id":"7","content":"Audit","status":"completed","priority":"medium"}
                ]}}]),
            ),
            (false, json!([{"type":"text","text":"all done"}])),
        ],
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
    let events = store.events("s", 0, 500).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "loop.continuation")
            .count(),
        1
    );
    assert!(
        miao_engine::state::runnable_state(&store.state("s").await.unwrap())
            .unwrap()
            .is_empty()
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn stalled_todos_pause_the_loop_without_any_goal() {
    let _env = NO_PROGRESS_ENV_LOCK.lock().await;
    std::env::set_var("MIAO_NO_PROGRESS_MIN_SECS", "0");
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed_work(&store, true, dir.path()).await;
    let provider = Arc::new(Sequence {
        calls: AtomicUsize::new(0),
        steps: Vec::new(),
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "no-progress"));
    runtime.shutdown().await;
}

/// One run dispatches tools over its whole life, so the no-progress guard has
/// to read tool dispatch per turn. Reading it per run let a single `bash` call
/// retire the guard for the remainder of that run: a real Session accumulated
/// 1975 continuations inside one run and paused for no-progress only once in
/// 3524 continuations, instead of stopping after two idling replies.
#[tokio::test]
async fn one_tool_call_does_not_retire_the_no_progress_guard_for_the_rest_of_the_run() {
    let _env = NO_PROGRESS_ENV_LOCK.lock().await;
    std::env::set_var("MIAO_NO_PROGRESS_MIN_SECS", "0");
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, &workspace).await;
    let provider = Arc::new(Sequence {
        calls: AtomicUsize::new(0),
        // A process tool: only a non-read dispatch marks the turn as work.
        steps: vec![(
            true,
            json!([{"type":"tool_use","id":"audit-run","name":"bash","input":{"command":"true"}}]),
        )],
    });
    // The leash keeps the retired-guard failure fast: it spends the whole turn
    // allowance and closes on that allowance instead of parking as
    // "no-progress".
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        Policy::new(Config {
            continuation_min_interval_ms: 0,
            mode: Mode::Workspace,
            allow_process: true,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            max_provider_turns: Some(12),
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "no-progress"),
        "an idle Session must pause as no-progress, not spend its allowance"
    );
    // A drained turn count is recorded as "turns", never as a spent budget
    // (#2870), and the allowance closes a drain with its own note: neither may
    // appear in a run that paused for no-progress.
    assert!(!events
        .iter()
        .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "turns"));
    assert!(!events.iter().any(|event| {
        event.data["text"]
            .as_str()
            .is_some_and(|text| text.contains("provider turn allowance for this prompt"))
    }));
    // The tool turn, two idling replies, and the reply that answers the pause.
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
    runtime.shutdown().await;
}

// Issue #2948: the pause used to bound only the run that raised it, and a
// background notice re-opened it, so one Session emitted 94 text-only "still
// waiting" replies while it was really waiting on the operator.
#[tokio::test]
async fn a_blocked_loop_survives_a_notification_storm() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
        finish_after: None,
    });
    let runtime = waiting_runtime(&store, provider.clone(), dir.path()).await;
    async fn me(store: &Store, runtime: &Runtime, run: usize, input: Option<Input>) -> Vec<String> {
        if let Some(input) = input {
            store.admit(input).await.unwrap();
        }
        runtime.resume("s").await.unwrap();
        finished_runs(store, run).await;
        let events = store.events("s", 0, 5000).await.unwrap();
        events
            .iter()
            .filter(|event| event.kind.starts_with("loop."))
            .map(|event| format!("{}:{}", event.kind, event.data["round"]))
            .collect()
    }
    let first = me(&store, &runtime, 1, None).await;
    let blocked = |events: &[String]| {
        events
            .iter()
            .filter(|event| event.starts_with("loop.blocked"))
            .count()
    };
    assert_eq!(blocked(&first), 1, "{first:?}");
    // The first notice is one round of grace: a finished job may genuinely be
    // the news the loop was waiting for.
    let second = me(&store, &runtime, 2, Some(notification(0))).await;
    for event in store.events("s", 0, 5000).await.unwrap() {
        if event.kind == "run.finished" || event.kind.starts_with("loop.") {
            eprintln!(
                "DBG {} {} reason={} round={}",
                event.seq, event.kind, event.data["reason"], event.data["round"]
            );
        }
        if event.kind == "input.promoted"
            && !event.data["input_id"]
                .as_str()
                .unwrap_or("")
                .starts_with("goal:")
        {
            eprintln!(
                "DBG {} input.promoted {}",
                event.seq, event.data["input_id"]
            );
        }
    }
    assert_eq!(blocked(&second), 2, "{second:?}");
    let continuations = |events: &[String]| {
        events
            .iter()
            .filter(|event| event.starts_with("loop.continuation"))
            .count()
    };
    assert!(continuations(&second) > continuations(&first), "{second:?}");
    // Past that round a notice feeds nothing: it must not restart the drain.
    let third = me(&store, &runtime, 3, Some(notification(1))).await;
    assert_eq!(
        continuations(&third),
        continuations(&second),
        "a notice after the grace round restarted the drain: {third:?}"
    );
    let fourth = me(&store, &runtime, 4, Some(notification(2))).await;
    assert_eq!(continuations(&fourth), continuations(&second), "{fourth:?}");
    let state = store.state("s").await.unwrap();
    assert_eq!(state["goal"]["value"]["status"], "blocked");
    assert!(state["goal"]["value"]["evidence"]
        .as_str()
        .is_some_and(|text| text.starts_with("loop: ")));
}

// The other half of the contract: a block is a gate, not an off switch, so the
// operator speaking re-opens it without any resume command.
#[tokio::test]
async fn an_operator_message_re_arms_a_blocked_loop() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
        finish_after: None,
    });
    let runtime = waiting_runtime(&store, provider.clone(), dir.path()).await;
    runtime.resume("s").await.unwrap();
    finished_runs(&store, 1).await;
    assert_eq!(
        store.state("s").await.unwrap()["goal"]["value"]["status"],
        "blocked"
    );
    let before = store
        .events("s", 0, 5000)
        .await
        .unwrap()
        .iter()
        .filter(|event| event.kind == "loop.continuation")
        .count();
    store.admit(operator(1)).await.unwrap();
    runtime.resume("s").await.unwrap();
    finished_runs(&store, 2).await;
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(
        events.iter().any(|event| event.kind == "loop.armed"),
        "{:?}",
        events
            .iter()
            .filter(|event| event.kind.starts_with("loop."))
            .collect::<Vec<_>>()
    );
    assert!(
        events
            .iter()
            .filter(|event| event.kind == "loop.continuation")
            .count()
            > before,
        "the re-armed loop keeps working"
    );
}

// An operator who parks a goal keeps it parked: only a goal they set back to
// active continues, never a background notice.
#[tokio::test]
async fn an_operator_pause_is_not_re_armed_by_a_notification() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "paused", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
        finish_after: None,
    });
    let runtime = waiting_runtime(&store, provider.clone(), dir.path()).await;
    runtime.resume("s").await.unwrap();
    finished_runs(&store, 1).await;
    store.admit(notification(9)).await.unwrap();
    runtime.resume("s").await.unwrap();
    finished_runs(&store, 2).await;
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(!events
        .iter()
        .any(|event| event.kind == "loop.continuation" || event.kind == "loop.armed"));
    assert_eq!(
        store.state("s").await.unwrap()["goal"]["value"]["status"],
        "paused"
    );
}
