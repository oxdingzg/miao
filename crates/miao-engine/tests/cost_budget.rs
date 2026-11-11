//! COST-02: cost, time, and turn budgets warn, stop, and leave admitted input
//! queued.
//!
//! A budget is stated per Session (the host policy, derived from the product's
//! `budget` section and the documented `cost.budget_usd`) or per Goal
//! (`goal.budget`). These tests drive the real run loop with a provider that
//! reports its own charges, so what is pinned is the boundary behaviour rather
//! than the arithmetic: four fifths spent warns once with the remaining amount,
//! the limit stops the drain at a provider-turn boundary, and nothing the
//! operator already admitted is dropped.

use async_trait::async_trait;
use miao_engine::{
    budget::Declaration,
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Event, Input, ModelRequest},
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

/// One scripted provider turn: the usage it reports and how long it pretends to
/// have taken. Every scripted turn asks for the same allowed tool, so the run
/// continues until a guard stops it; a run that ignores its budget falls off
/// the end of the script and gets a plain text reply, which ends the drain
/// instead of hanging the test.
#[derive(Clone)]
struct Turn {
    usage: Value,
    delay_ms: u64,
}

fn charged(input: u64, output: u64, amount: f64) -> Turn {
    Turn {
        usage: json!({
            "inputTokens": input,
            "outputTokens": output,
            "totalTokens": input + output,
            "billing": {"amount": amount, "currency": "USD", "source": "balance"},
        }),
        delay_ms: 0,
    }
}

fn uncharged(input: u64, output: u64) -> Turn {
    Turn {
        usage: json!({"inputTokens": input, "outputTokens": output, "totalTokens": input + output}),
        delay_ms: 0,
    }
}

struct Script {
    turns: Vec<Turn>,
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let step = self.calls.fetch_add(1, Ordering::SeqCst);
        let Some(turn) = self.turns.get(step).cloned() else {
            return Ok(Reply {
                needs_tools: false,
                content: json!([{"type":"text","text":"script exhausted"}]),
                usage: json!({}),
            });
        };
        if turn.delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(turn.delay_ms)).await;
        }
        Ok(Reply {
            needs_tools: true,
            content: json!([{"type":"tool_use","id":format!("read-{step}"),"name":"read_file","input":{"path":"fixture"}}]),
            usage: turn.usage,
        })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    store: Store,
    runtime: Runtime,
    provider: Arc<Script>,
}

fn declaration(value: Value) -> Declaration {
    serde_json::from_value(value).unwrap()
}

impl Harness {
    async fn open(budget: Option<Declaration>, turns: Vec<Turn>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fixture"), "actual content").unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let provider = Arc::new(Script {
            turns,
            calls: AtomicUsize::new(0),
        });
        let runtime = Runtime::with_policy(
            store.clone(),
            provider.clone(),
            Tools::new(dir.path()).await.unwrap(),
            Policy::new(Config {
                budget,
                rules: vec![Rule {
                    tool: "read_file".into(),
                    path: "fixture".into(),
                    decision: Decision::Allow,
                }],
                ..Config::default()
            })
            .unwrap(),
        )
        .await
        .unwrap();
        Self {
            _dir: dir,
            store,
            runtime,
            provider,
        }
    }

    async fn admit(&self, input_id: &str, prompt: &str, delivery: Delivery, resume: bool) {
        self.runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: input_id.into(),
                    prompt: prompt.into(),
                    delivery,
                },
                resume,
            )
            .await
            .unwrap();
    }

    /// Admit one prompt, let it run to its end, and return the ledger.
    async fn run(&self, input_id: &str, prompt: &str) -> Vec<Event> {
        self.admit(input_id, prompt, Delivery::Steer, true).await;
        self.finished().await
    }

    async fn finished(&self) -> Vec<Event> {
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let events = self.store.events("s", 0, 1000).await.unwrap();
                if events.iter().any(|event| event.kind == "run.finished") {
                    break events;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    fn event<'a>(events: &'a [Event], kind: &str) -> &'a Event {
        events
            .iter()
            .find(|event| event.kind == kind)
            .unwrap_or_else(|| panic!("no {kind} in {events:?}"))
    }

    async fn transcript(&self) -> String {
        serde_json::to_string(&self.store.history("s").await.unwrap()).unwrap()
    }

    fn calls(&self) -> usize {
        self.provider.calls.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn a_session_cost_budget_stops_the_run_at_the_limit_it_was_given() {
    let harness = Harness::open(
        Some(declaration(json!({"cost_usd": 0.5}))),
        vec![charged(100, 10, 0.3), charged(100, 10, 0.3)],
    )
    .await;
    let events = harness.run("one", "keep reading the fixture").await;

    // Two charged turns reach the limit; a third would spend what nobody
    // authorised, so it is never requested.
    assert_eq!(harness.calls(), 2, "the budget bounds provider work");
    let transcript = harness.transcript().await;
    assert!(
        transcript.contains("Session cost budget of $0.50 is used up"),
        "{transcript}"
    );
    assert!(transcript.contains("durable inbox"), "{transcript}");
    assert!(
        transcript.contains("The model was left unchanged"),
        "{transcript}"
    );

    let stopped = Harness::event(&events, "budget.stopped");
    assert_eq!(stopped.data["axis"], json!("cost"));
    assert_eq!(stopped.data["scope"], json!("Session"));
    assert_eq!(stopped.data["level"], json!("exhausted"));
    assert_eq!(stopped.data["remaining"]["cost_usd"], json!(0.0));
    assert_eq!(stopped.data["spent"]["cost_usd"], json!(0.6));
    assert_eq!(
        Harness::event(&events, "run.finished").data["reason"],
        json!("completed"),
        "a spent budget pauses the drain; it is not a failure"
    );
    harness.runtime.shutdown().await;
}

#[tokio::test]
async fn a_budget_warns_once_at_four_fifths_with_what_is_left() {
    let harness = Harness::open(
        Some(declaration(json!({"tokens": 1000}))),
        (0..5).map(|_| uncharged(180, 20)).collect(),
    )
    .await;
    let events = harness.run("one", "keep reading the fixture").await;

    assert_eq!(harness.calls(), 5, "1000 tokens at 200 a turn");
    let transcript = harness.transcript().await;
    assert_eq!(
        transcript.matches("Budget warning:").count(),
        1,
        "the warning is a fact in the transcript, not a line every turn: {transcript}"
    );
    assert!(
        transcript.contains(
            "Session tokens budget is 80% used (800 tokens of 1000 tokens, 200 tokens left)"
        ),
        "{transcript}"
    );
    assert!(
        transcript.contains("Session tokens budget of 1000 tokens is used up"),
        "{transcript}"
    );
    let warning = Harness::event(&events, "budget.warning");
    assert_eq!(warning.data["remaining"]["tokens"], json!(200));
    // A token budget makes no money claim, so it says nothing about billing.
    assert!(!transcript.contains("lower bound"), "{transcript}");
    harness.runtime.shutdown().await;
}

#[tokio::test]
async fn a_goal_budget_binds_the_work_done_under_it() {
    // The Session's own limit is far away; the Goal states the tight one, so
    // what stops the run is the Goal's window and not the Session's total.
    let harness = Harness::open(
        Some(declaration(json!({"tokens": 100000}))),
        (0..3).map(|_| uncharged(180, 20)).collect(),
    )
    .await;
    harness
        .admit("one", "hold the line", Delivery::Steer, false)
        .await;
    harness
        .store
        .update_state(
            "s",
            "goal-op",
            Mutation::parse(
                "goal",
                json!({"objective":"hold the line","status":"active","budget":{"tokens":400}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    harness.runtime.resume("s").await.unwrap();
    let events = harness.finished().await;

    assert_eq!(harness.calls(), 2, "400 tokens at 200 a turn");
    let transcript = harness.transcript().await;
    assert!(
        transcript.contains("Goal tokens budget of 400 tokens is used up"),
        "{transcript}"
    );
    let stopped = Harness::event(&events, "budget.stopped");
    assert_eq!(stopped.data["scope"], json!("Goal"));
    assert_eq!(stopped.data["spent"]["tokens"], json!(400));
    harness.runtime.shutdown().await;
}

#[tokio::test]
async fn a_time_budget_stops_a_run_between_turns() {
    // The clock opens where the run does, so the first slow turn still fits and
    // the second one cannot: 250ms against a 400ms budget, then 500ms.
    let slow = Turn {
        usage: json!({"inputTokens": 10, "outputTokens": 1}),
        delay_ms: 250,
    };
    let harness = Harness::open(
        Some(declaration(json!({"wallclock_ms": 400}))),
        vec![slow.clone(), slow.clone(), slow],
    )
    .await;
    harness.run("one", "keep reading the fixture").await;

    assert_eq!(
        harness.calls(),
        2,
        "the second turn already outlived the budget"
    );
    let transcript = harness.transcript().await;
    assert!(
        transcript.contains("Session time budget of 0.4s is used up"),
        "{transcript}"
    );
    harness.runtime.shutdown().await;
}

#[tokio::test]
async fn a_turn_budget_stops_at_the_stated_turn_count() {
    let harness = Harness::open(
        Some(declaration(json!({"turns": 2}))),
        (0..3).map(|_| uncharged(10, 1)).collect(),
    )
    .await;
    harness.run("one", "keep reading the fixture").await;

    assert_eq!(harness.calls(), 2);
    let transcript = harness.transcript().await;
    assert!(
        transcript.contains("Session turns budget of 2 turns is used up"),
        "{transcript}"
    );
    harness.runtime.shutdown().await;
}

/// A turn with no provider-reported charge is not free: the money counted is a
/// lower bound, and the warning says so where the remaining amount is read.
#[tokio::test]
async fn a_cost_budget_discloses_a_turn_whose_charge_was_not_reported() {
    let harness = Harness::open(
        Some(declaration(json!({"cost_usd": 1.0}))),
        vec![charged(10, 1, 0.4), uncharged(10, 1), charged(10, 1, 0.4)],
    )
    .await;
    harness.run("one", "keep reading the fixture").await;

    let transcript = harness.transcript().await;
    assert!(
        transcript.contains("Session cost budget is 80% used"),
        "{transcript}"
    );
    assert!(transcript.contains("lower bound"), "{transcript}");
    assert!(
        transcript.contains("1 turn(s) carry no price at all"),
        "{transcript}"
    );
    harness.runtime.shutdown().await;
}

/// Input the operator already admitted is durable: a budget stop ends the run,
/// never the admission, so the next run picks it up.
#[tokio::test]
async fn a_budget_stop_leaves_admitted_input_queued() {
    let harness = Harness::open(
        Some(declaration(json!({"turns": 1}))),
        (0..2).map(|_| uncharged(10, 1)).collect(),
    )
    .await;
    harness
        .admit("one", "keep reading the fixture", Delivery::Steer, true)
        .await;
    harness
        .admit("two", "and then write the summary", Delivery::Queue, false)
        .await;
    harness.finished().await;

    assert_eq!(harness.calls(), 1);
    let pending = harness.store.pending_inputs("s", None, 10).await.unwrap();
    let queued = pending["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|input| input["id"].as_str() == Some("two"))
        .expect("the queued input is still admitted after the stop");
    assert_eq!(queued["prompt"], json!("and then write the summary"));
    let transcript = harness.transcript().await;
    assert!(
        !transcript.contains("and then write the summary"),
        "a queued input waits for the next run instead of being promoted into one that cannot afford it: {transcript}"
    );
    harness.runtime.shutdown().await;
}

/// Enforcement is not a route decision: a budget never switches the model, so a
/// stop cannot quietly move a Session onto (or off) a paid route.
#[tokio::test]
async fn a_budget_stop_leaves_the_model_selection_alone() {
    let harness = Harness::open(
        Some(declaration(json!({"turns": 1}))),
        (0..2).map(|_| uncharged(10, 1)).collect(),
    )
    .await;
    let events = harness.run("one", "keep reading the fixture").await;

    assert_eq!(harness.calls(), 1);
    assert_eq!(
        harness.store.model_selection("s").await.unwrap(),
        None,
        "no selection was invented to fit the budget"
    );
    assert!(
        !events
            .iter()
            .any(|event| event.kind == "session.model.selected"),
        "the budget gate never records a model change"
    );
    harness.runtime.shutdown().await;
}

/// The report the sidebar already reads carries what is left, so a client does
/// not have to replay the gate to paint the remaining amount.
#[tokio::test]
async fn the_usage_report_carries_the_remaining_amount() {
    let harness = Harness::open(
        Some(declaration(json!({"cost_usd": 1.0}))),
        vec![charged(100, 10, 0.4)],
    )
    .await;
    harness.run("one", "keep reading the fixture").await;
    let report = harness.store.usage_report("s").await.unwrap();
    let budget = &report["budget"]["session"];
    assert_eq!(budget["scope"], json!("Session"));
    assert_eq!(budget["level"], json!("within"));
    assert_eq!(budget["remaining"]["cost_usd"], json!(0.6));
    assert_eq!(budget["limit"]["cost_usd"], json!(1.0));
    harness.runtime.shutdown().await;
}
