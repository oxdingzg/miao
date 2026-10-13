//! Roadmap §2.13 acceptance, end to end through the runtime: once the measured
//! context crosses the configured limit the session compacts in one provider
//! call, commits exactly one checkpoint, reports progress, and the next turn
//! starts from the checkpoint instead of the raw history.
use async_trait::async_trait;
use miao_engine::{
    context_trigger::ContextLimits,
    events::Lifecycle,
    permission::{Config, Policy},
    protocol::{Delivery, Input, ModelRequest},
    provider::{CountTokens, Provider, ProviderError, Reply},
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

/// Reports a context already past the limit, records what it is asked to count,
/// and answers every summarizer pass with a fixed summary.
struct Fixture {
    summaries: AtomicUsize,
    counts: AtomicUsize,
}

#[async_trait]
impl Provider for Fixture {
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
        self.counts.fetch_add(1, Ordering::SeqCst);
        CountTokens::Counted(1_000)
    }
}

async fn drain(runtime: &Runtime, store: &Store, id: &str, finished: usize) {
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: id.into(),
                prompt: "work".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let done = store
                .events("s", 0, 500)
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

#[tokio::test]
async fn a_crossed_limit_compacts_in_one_call_and_the_next_turn_starts_from_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Fixture {
        summaries: AtomicUsize::new(0),
        counts: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    // A 1M window with an 0.8 ratio: 900k + 1k crosses the 800k limit.
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 1_000_000,
            ratio: 0.8,
            headroom: 0,
            per_pass: 1000,
            prune_chars: None,
            protect_turns: 2,
        }))
        .await;
    let mut progress = runtime.progress();

    drain(&runtime, &store, "one", 1).await;
    assert_eq!(
        provider.summaries.load(Ordering::SeqCst),
        1,
        "one provider call compacts the session"
    );
    assert!(
        provider.counts.load(Ordering::SeqCst) >= 1,
        "gate ② asked the provider's own endpoint"
    );

    // The checkpoint landed through the durable lifecycle and the next turn's
    // input is the summary, not the raw exchange.
    let kinds: Vec<String> = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect();
    for kind in [
        Lifecycle::PreCompact.name(),
        "history.compacted",
        Lifecycle::PostCompact.name(),
    ] {
        assert!(kinds.iter().any(|value| value == kind), "missing {kind}");
    }
    let selected = store.selected_history("s").await.unwrap();
    assert_eq!(selected.len(), 1, "the whole prefix moved behind the cut");
    let text = selected[0].content[0]["text"].as_str().unwrap();
    assert!(text.contains("<history-summary>"), "{text}");
    assert!(text.contains("SUMMARY-OF-EVERYTHING"), "{text}");

    // Progress is observable on the runtime's channel.
    let mut notices = Vec::new();
    while let Ok(notice) = progress.try_recv() {
        notices.push(notice);
    }
    let kinds: Vec<&str> = notices
        .iter()
        .filter_map(|notice| notice["kind"].as_str())
        .collect();
    for kind in ["compaction.started", "compaction.finished"] {
        assert!(kinds.contains(&kind), "missing {kind}: {kinds:?}");
    }

    // A second drain compacts again once the context crosses, so the mechanism
    // is not a one-shot.
    drain(&runtime, &store, "two", 2).await;
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 2);
    let compactions = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "history.compacted")
        .count();
    assert_eq!(compactions, 2, "one checkpoint per crossed turn");
}
