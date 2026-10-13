//! Roadmap §2.13 automatic context management: the usage-anchored trigger, the
//! single-pass summarizer, the run-owned checkpoint it commits, and the
//! breaker that stops a failing summarizer from spinning the engine.
use async_trait::async_trait;
use miao_engine::{
    context_trigger::Budget,
    events::Lifecycle,
    permission::{Config, Policy},
    protocol::{Delivery, Event, Input, ModelRequest},
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

/// A scripted provider: a normal turn reports the next context size it saw,
/// and the summarizer pass is recognized by the system instruction so the
/// fixture can answer (or refuse) it independently.
struct Fixture {
    summaries: AtomicUsize,
    context_tokens: u64,
    refusing: bool,
}

impl Fixture {
    fn new(context_tokens: u64, refusing: bool) -> Self {
        Self {
            summaries: AtomicUsize::new(0),
            context_tokens,
            refusing,
        }
    }
}

#[async_trait]
impl Provider for Fixture {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.system.contains("You summarize a coding session") {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            if self.refusing {
                return Err(ProviderError::Transport);
            }
            return Ok(Reply {
                content: json!([{"type":"text","text":"SUMMARY: edited files and left a todo"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"the answer"}]),
            usage: json!({"inputTokens": self.context_tokens, "outputTokens": 1000}),
            needs_tools: false,
        })
    }
}

fn input(session: &str, id: &str) -> Input {
    Input {
        session_id: session.into(),
        input_id: id.into(),
        prompt: "Work on the task".into(),
        delivery: Delivery::Steer,
    }
}

async fn setup(fixture: Fixture) -> (Runtime, Store, tempfile::TempDir, Arc<Fixture>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let fixture = Arc::new(fixture);
    let runtime = Runtime::with_policy(
        store.clone(),
        fixture.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    (runtime, store, dir, fixture)
}

/// Admit one prompt and wait for its drain to finish.
async fn drain(runtime: &Runtime, store: &Store, session: &str, id: &str, finished: usize) {
    runtime.admit(input(session, id), true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let done = store
                .events(session, 0, 500)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count();
            if done >= finished {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("drain finishes");
}

async fn kinds(store: &Store, session: &str) -> Vec<String> {
    store
        .events(session, 0, 500)
        .await
        .unwrap()
        .into_iter()
        .map(|event: Event| event.kind)
        .collect()
}

fn budget() -> Budget {
    Budget {
        window: Some(1_000_000),
        ratio: 0.5,
        headroom: 100_000,
    }
}

#[tokio::test]
async fn a_crossed_budget_commits_one_summary_checkpoint() {
    let (runtime, store, _dir, fixture) = setup(Fixture::new(990_000, false)).await;
    runtime.configure_compaction(budget(), 400);
    drain(&runtime, &store, "s", "one", 1).await;

    assert_eq!(fixture.summaries.load(Ordering::SeqCst), 1, "one summary pass");
    let seen = kinds(&store, "s").await;
    for kind in [
        Lifecycle::PreCompact.name(),
        "history.compacted",
        Lifecycle::PostCompact.name(),
    ] {
        assert!(
            seen.iter().any(|value| value.as_str() == kind),
            "missing {kind}"
        );
    }

    // The next turn's input is the checkpoint summary alone: the cut moved the
    // completed exchange behind the boundary.
    let history = store.selected_history("s").await.unwrap();
    let text = history[0].content[0]["text"].as_str().unwrap();
    assert!(text.contains("<history-summary>"), "{text}");
    assert!(text.contains("SUMMARY: edited files and left a todo"), "{text}");
}

#[tokio::test]
async fn a_small_context_never_triggers() {
    let (runtime, store, _dir, fixture) = setup(Fixture::new(10, false)).await;
    runtime.configure_compaction(budget(), 400);
    drain(&runtime, &store, "s", "one", 1).await;

    assert_eq!(fixture.summaries.load(Ordering::SeqCst), 0);
    assert!(!kinds(&store, "s")
        .await
        .iter()
        .any(|kind| kind.as_str() == "history.compacted"));
}

#[tokio::test]
async fn without_configuration_the_trigger_is_off() {
    let (runtime, store, _dir, fixture) = setup(Fixture::new(990_000, false)).await;
    drain(&runtime, &store, "s", "one", 1).await;

    assert_eq!(fixture.summaries.load(Ordering::SeqCst), 0);
    assert!(!kinds(&store, "s")
        .await
        .iter()
        .any(|kind| kind.as_str() == "history.compacted"));
}

#[tokio::test]
async fn a_failing_summarizer_trips_the_breaker_without_dropping_history() {
    let (runtime, store, _dir, fixture) = setup(Fixture::new(990_000, true)).await;
    runtime.configure_compaction(budget(), 400);
    for (index, id) in ["one", "two", "three"].iter().enumerate() {
        drain(&runtime, &store, "s", id, index + 1).await;
    }
    let seen = kinds(&store, "s").await;
    assert_eq!(
        fixture.summaries.load(Ordering::SeqCst),
        3,
        "each refused attempt is one pass"
    );
    assert_eq!(
        seen.iter()
            .filter(|kind| kind.as_str() == "compaction.failed")
            .count(),
        3
    );
    assert!(!seen.iter().any(|kind| kind == "history.compacted"));
    // The refused summaries cost no history: every drain still completed.
    assert_eq!(seen.iter()
        .filter(|kind| kind.as_str() == "run.finished")
        .count(), 3);
    assert!(!store.selected_history("s").await.unwrap().is_empty());

    // The streak tripped the breaker: a fourth drain makes no attempt.
    drain(&runtime, &store, "s", "four", 4).await;
    assert_eq!(fixture.summaries.load(Ordering::SeqCst), 3);
}
