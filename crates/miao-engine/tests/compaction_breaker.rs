//! Roadmap §2.13 gate ⑤: after three refused summaries the automatic trigger
//! stays off, and only an explicit `compact` restarts it.
use async_trait::async_trait;
use miao_engine::{
    context_trigger::ContextLimits,
    host::Host,
    permission::{Config, Policy},
    protocol::{Command, Delivery, Input, ModelRequest},
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

/// Every normal turn reports a context that already crosses the limit; every
/// summarizer pass is refused.
struct Refusing {
    summaries: AtomicUsize,
}

#[async_trait]
impl Provider for Refusing {
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
            return Err(ProviderError::Transport(
                "the summarising provider is unreachable".into(),
            ));
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"the answer"}]),
            usage: json!({"inputTokens": 990_000, "outputTokens": 1_000}),
            needs_tools: false,
        })
    }
}

async fn drain(runtime: &Runtime, store: &Store, id: &str, finished: usize) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: id.into(),
                prompt: "Work on the task".into(),
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

/// The last assistant boundary the explicit compact must cut through.
async fn boundary(store: &Store) -> u64 {
    let snapshot = store.snapshot("s").await.unwrap();
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|message| message["role"] == "assistant")
        .unwrap()["seq"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn an_explicit_compact_restarts_the_tripped_breaker() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Refusing {
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
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 1_000_000,
            ratio: 0.5,
            headroom: 100_000,
            per_pass: 1000,
            fold_ratio: 0.0,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
            prefix_scope: Default::default(),
            retention: None,
        }))
        .await;

    for (index, id) in ["one", "two", "three"].iter().enumerate() {
        drain(&runtime, &store, id, index + 1).await;
    }
    assert_eq!(
        provider.summaries.load(Ordering::SeqCst),
        3,
        "each refused drain attempts one summary"
    );

    // The streak tripped the breaker: the next drain makes no attempt.
    drain(&runtime, &store, "four", 4).await;
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 3);

    // An explicit operator compact commits a checkpoint and is the reset.
    let mut host = Host::new(runtime.clone());
    host.dispatch(Command::Compact {
        session_id: "s".into(),
        compaction_id: "manual-1".into(),
        through_message_seq: boundary(&store).await,
        summary: "manual checkpoint".into(),
    })
    .await
    .unwrap();

    drain(&runtime, &store, "five", 5).await;
    assert_eq!(
        provider.summaries.load(Ordering::SeqCst),
        4,
        "the explicit compact restarted the trigger"
    );
}

/// Refuses the summarizer only for the Session named in the history, so one
/// Session's failing summarizer can be told apart from another's.
struct RefusesOneSession {
    attempts: AtomicUsize,
}

#[async_trait]
impl Provider for RefusesOneSession {
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
            self.attempts.fetch_add(1, Ordering::SeqCst);
            let body = request
                .messages
                .iter()
                .map(|message| message.content.to_string())
                .collect::<String>();
            if body.contains("SESSION:alpha") {
                return Err(ProviderError::Transport(
                    "the summarising provider is unreachable".into(),
                ));
            }
            return Ok(Reply {
                content: json!([{"type":"text","text":"SUMMARY-OF-BETA"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"the answer"}]),
            usage: json!({"inputTokens": 990_000, "outputTokens": 1_000}),
            needs_tools: false,
        })
    }
}

async fn drain_session(runtime: &Runtime, store: &Store, session: &str, id: &str, finished: usize) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: session.into(),
                input_id: id.into(),
                prompt: format!("SESSION:{session} work on the task"),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
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

// One engine serves every Session in a Location, so a breaker shared across the
// process let one Session's refused summarizer switch automatic compaction off
// for all the others.
#[tokio::test]
async fn a_tripped_breaker_stays_with_the_session_whose_summarizer_failed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(RefusesOneSession {
        attempts: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 1_000_000,
            ratio: 0.5,
            headroom: 100_000,
            per_pass: 1000,
            fold_ratio: 0.0,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
            prefix_scope: Default::default(),
            retention: None,
        }))
        .await;

    for (index, id) in ["one", "two", "three"].iter().enumerate() {
        let prefix = format!("alpha-{id}");
        drain_session(&runtime, &store, "alpha", &prefix, index + 1).await;
    }
    assert_eq!(
        provider.attempts.load(Ordering::SeqCst),
        3,
        "three refusals trip the alpha breaker"
    );

    drain_session(&runtime, &store, "beta", "beta-one", 1).await;
    assert_eq!(
        provider.attempts.load(Ordering::SeqCst),
        4,
        "the other session still attempts its own summary"
    );
    let beta = store.events("beta", 0, 500).await.unwrap();
    assert!(
        beta.iter().any(|event| event.kind == "history.compacted"),
        "the other session still compacts: {:?}",
        beta.iter()
            .map(|event| event.kind.clone())
            .collect::<Vec<_>>()
    );
}
