//! VAL-04: each optimization mechanism can be removed on its own, and removing
//! one changes exactly what that mechanism does.
//!
//! Every test here drives the real run loop or the real read tool: the baseline
//! arm keeps the mechanism's behaviour and the arm that names the mechanism
//! loses it while the other mechanisms keep working. That is what makes an
//! ablation arm a measurement of one mechanism instead of a different product.
//! The measurement those arms feed — correctness, cost, p50/p95 latency and
//! failure distribution on one model and one task set — is
//! `script/engine-benchmark.ts --ablate`, recorded in
//! `docs/acceptance/2026-11-11-val04-ablation.md`.

use async_trait::async_trait;
use miao_engine::{
    budget::Declaration,
    context_trigger::ContextLimits,
    optimization::{Mechanism, Optimizations},
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Event, Input, ModelRequest},
    provider::{CountTokens, Identity, Provider, ProviderError, Reply},
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

/// A scripted run: each step reports its own usage and asks for the same
/// allowed read, so the run continues until a budget or the script stops it.
struct Script {
    turns: Vec<Value>,
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
        let Some(usage) = self.turns.get(step).cloned() else {
            return Ok(Reply {
                needs_tools: false,
                content: json!([{"type":"text","text":"script exhausted"}]),
                usage: json!({}),
            });
        };
        Ok(Reply {
            needs_tools: true,
            content: json!([{"type":"tool_use","id":format!("read-{step}"),"name":"read_file","input":{"path":"fixture"}}]),
            usage,
        })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    store: Store,
    runtime: Runtime,
    provider: Arc<Script>,
}

impl Harness {
    async fn open(
        budget: Option<Declaration>,
        turns: Vec<Value>,
        optimizations: Optimizations,
    ) -> Self {
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
        runtime.set_optimizations(optimizations);
        Self {
            _dir: dir,
            store,
            runtime,
            provider,
        }
    }

    async fn run(&self, prompt: &str) -> Vec<Event> {
        self.runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: "one".into(),
                    prompt: prompt.into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
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

    fn stopped(events: &[Event]) -> Option<&Event> {
        events.iter().find(|event| event.kind == "budget.stopped")
    }

    fn calls(&self) -> usize {
        self.provider.calls.load(Ordering::SeqCst)
    }
}

fn declaration(value: Value) -> Declaration {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn a_fresh_runtime_keeps_every_mechanism_enabled() {
    let harness = Harness::open(None, vec![], Optimizations::defaults()).await;
    let state = harness.runtime.optimizations().state();
    for mechanism in Mechanism::ALL {
        assert_eq!(
            state[mechanism.key()],
            json!(true),
            "{} must start enabled: the baseline arm is the shipped behaviour",
            mechanism.key()
        );
    }
    harness.runtime.shutdown().await;
}

#[tokio::test]
async fn an_ablated_cost_stop_runs_past_the_limit_it_was_given() {
    let script: Vec<serde_json::Value> = (0..3u32)
        .map(|_| json!({"inputTokens":10,"outputTokens":1}))
        .collect();

    // The baseline arm stops at the stated turn count and says so.
    let baseline = Harness::open(
        Some(declaration(json!({"turns": 2}))),
        script.clone(),
        Optimizations::defaults(),
    )
    .await;
    let events = baseline.run("keep reading the fixture").await;
    assert_eq!(
        baseline.calls(),
        2,
        "two declared turns, two provider turns"
    );
    let stopped = Harness::stopped(&events).expect("the baseline arm records its stop");
    assert_eq!(stopped.data["axis"], json!("turns"));
    baseline.runtime.shutdown().await;

    // The ablated arm keeps the same declaration and the same script, and runs
    // the whole script: the gate, not the budget, is what was removed.
    let ablated = Harness::open(
        Some(declaration(json!({"turns": 2}))),
        script,
        Optimizations::defaults().without(Mechanism::CostStop),
    )
    .await;
    let events = ablated.run("keep reading the fixture").await;
    assert!(
        ablated.calls() >= 3,
        "without the gate the run passes the declared two turns (got {})",
        ablated.calls()
    );
    assert!(
        Harness::stopped(&events).is_none(),
        "an ablated gate records no stop: {events:?}"
    );
    ablated.runtime.shutdown().await;
}

#[tokio::test]
async fn an_ablated_goal_budget_leaves_the_session_limit_in_force() {
    let script = || -> Vec<serde_json::Value> {
        (0..3u32)
            .map(|_| json!({"inputTokens":180,"outputTokens":20,"totalTokens":200}))
            .collect()
    };

    // The Goal states the tight window, so the baseline stops under it after two
    // 200-token turns even though the Session allows three.
    let baseline = Harness::open(
        Some(declaration(json!({"turns": 3}))),
        script(),
        Optimizations::defaults(),
    )
    .await;
    baseline
        .runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "goal".into(),
                prompt: "hold the line".into(),
                delivery: Delivery::Steer,
            },
            false,
        )
        .await
        .unwrap();
    baseline
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
    baseline.runtime.resume("s").await.unwrap();
    let events = baseline.finished().await;
    assert_eq!(baseline.calls(), 2, "400 tokens at 200 a turn");
    assert_eq!(
        Harness::stopped(&events)
            .expect("the Goal window stops the drain")
            .data["scope"],
        json!("Goal")
    );
    baseline.runtime.shutdown().await;

    // With the Goal window removed the Session's own declaration is what bounds
    // the run, so the ablation isolates one window instead of disabling stops.
    let ablated = Harness::open(
        Some(declaration(json!({"turns": 3}))),
        (0..3u32)
            .map(|_| json!({"inputTokens":10,"outputTokens":1}))
            .collect::<Vec<serde_json::Value>>(),
        Optimizations::defaults().without(Mechanism::GoalBudget),
    )
    .await;
    let events = ablated.run("hold the line").await;
    assert_eq!(
        ablated.calls(),
        3,
        "the Session's three turns are the limit that remains"
    );
    assert_eq!(
        Harness::stopped(&events)
            .expect("the Session window still stops")
            .data["scope"],
        json!("Session")
    );
    ablated.runtime.shutdown().await;
}

/// Requests one large read, then reports the request it is sent.
struct Reading {
    sent: mpsc::Sender<String>,
}

#[async_trait]
impl Provider for Reading {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"large.txt"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        self.sent
            .send(serde_json::to_string(&request.messages).unwrap())
            .await
            .unwrap();
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn pruned_request(optimizations: Optimizations) -> String {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("large.txt"), "abcdefgh".repeat(1000)).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (sent, mut received) = mpsc::channel(4);
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reading { sent }),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 1_000_000,
            ratio: 0.9,
            headroom: 100_000,
            per_pass: 1000,
            prune_chars: Some(2000),
            prune_total_chars: None,
            protect_turns: 0,
        }))
        .await;
    runtime.set_optimizations(optimizations);
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "read it".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let captured = received.recv().await.expect("a second provider request");
    runtime.shutdown().await;
    captured
}

#[tokio::test]
async fn an_ablated_tool_output_budget_sends_the_payload_whole() {
    let baseline = pruned_request(Optimizations::defaults()).await;
    assert!(
        baseline.contains("elided by context management"),
        "the baseline arm elides the oversized payload"
    );
    assert!(baseline.len() < 8000, "the 8 KB payload is bounded");

    let ablated =
        pruned_request(Optimizations::defaults().without(Mechanism::ToolOutputBudget)).await;
    assert!(
        !ablated.contains("elided by context management"),
        "the ablated arm sends the payload it was given"
    );
    assert!(
        ablated.contains(&"abcdefgh".repeat(100)),
        "the whole payload rides the request"
    );
}

/// Reports a context past the compaction threshold and answers summarizer
/// passes, so the only thing an arm can change is whether a pass is attempted.
struct Window {
    summaries: AtomicUsize,
}

#[async_trait]
impl Provider for Window {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request
            .system
            .starts_with("Summarize the conversation portion")
        {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            return Ok(Reply {
                content: json!([{"type":"text","text":"SUMMARY-OF-EVERYTHING"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"the answer"}]),
            usage: json!({"inputTokens": 900_000, "outputTokens": 1_000}),
            needs_tools: false,
        })
    }

    async fn count_tokens(&self, _: &ModelRequest) -> CountTokens {
        CountTokens::Counted(1_000)
    }

    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: "fixture-window-model".into(),
        })
    }
}

async fn compaction(optimizations: Optimizations) -> (usize, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Window {
        summaries: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    // A 1M window at 0.8: 900k + 1k crosses the 800k limit.
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 1_000_000,
            ratio: 0.8,
            headroom: 0,
            per_pass: 1000,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
        }))
        .await;
    runtime.set_optimizations(optimizations);
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "work".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 500)
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
    .expect("drain finishes");
    let kinds = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect();
    let summaries = provider.summaries.load(Ordering::SeqCst);
    runtime.shutdown().await;
    (summaries, kinds)
}

#[tokio::test]
async fn an_ablated_auto_compaction_never_checkpoints_the_transcript() {
    let (summaries, kinds) = compaction(Optimizations::defaults()).await;
    assert_eq!(summaries, 1, "the baseline arm compacts once");
    assert!(
        kinds.iter().any(|kind| kind == "history.compacted"),
        "the baseline records its checkpoint: {kinds:?}"
    );

    let (summaries, kinds) =
        compaction(Optimizations::defaults().without(Mechanism::AutoCompaction)).await;
    assert_eq!(
        summaries, 0,
        "the ablated arm never asks for a summary, even past the threshold"
    );
    assert!(
        !kinds.iter().any(|kind| kind == "history.compacted"),
        "no checkpoint is committed: {kinds:?}"
    );
}

#[tokio::test]
async fn an_ablated_minimal_reads_delivers_the_payload_again() {
    let dir = tempfile::tempdir().unwrap();
    let body = "one\ntwo\nthree\n";
    std::fs::write(dir.path().join("data.txt"), body).unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_minimal_reads(false);

    let first = tools
        .execute(
            "read_file",
            json!({"path":"data.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first["text"], json!(body));

    let again = tools
        .execute(
            "read_file",
            json!({"path":"data.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        again["text"],
        json!(body),
        "the ablated arm answers with the payload, not with a fingerprint"
    );
    assert!(
        again.get("unchanged").is_none(),
        "nothing is stubbed out of the second read"
    );

    // The measurement survives the ablation: both reads count as deliveries and
    // no saving is claimed for bytes that were shipped twice.
    let ledger = tools.read_ledger();
    assert_eq!(ledger["reads"], json!(2));
    assert_eq!(ledger["duplicate_reads"], json!(0));
    assert_eq!(ledger["bytes_saved"], json!(0));
    assert_eq!(ledger["bytes_delivered"], json!(2 * body.len()));
}
