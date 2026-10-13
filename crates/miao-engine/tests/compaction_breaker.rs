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
        if request.system.starts_with("Summarize the conversation portion") {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            return Err(ProviderError::Transport);
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
        .filter(|message| message["role"] == "assistant")
        .last()
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
