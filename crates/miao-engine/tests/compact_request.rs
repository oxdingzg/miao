use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Policy},
    protocol::{Delivery, Input, ModelRequest},
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

/// Answers a plain turn, and detects the summarizer pass by its body.
struct Answer {
    turns: AtomicUsize,
    summaries: AtomicUsize,
    refuse_summary: bool,
}

#[async_trait]
impl Provider for Answer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let summarizing = request.messages.iter().any(|message| {
            message.content.as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["type"] == "text"
                        && part["text"].as_str().is_some_and(|text| {
                            text.contains("Summarize this portion of the conversation")
                        })
                })
            })
        });
        let text = if summarizing {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            if self.refuse_summary {
                return Err(ProviderError::Transport);
            }
            "A summary of the earlier turns."
        } else {
            self.turns.fetch_add(1, Ordering::SeqCst);
            "answered"
        };
        Ok(Reply {
            content: json!([{"type":"text","text":text}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn setup(path: &std::path::Path) -> (Runtime, Store, Arc<Answer>) {
    setup_with(path, false).await
}

async fn setup_with(path: &std::path::Path, refuse_summary: bool) -> (Runtime, Store, Arc<Answer>) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Answer {
        turns: AtomicUsize::new(0),
        summaries: AtomicUsize::new(0),
        refuse_summary,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(path).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    (runtime, store, provider)
}

/// Run one turn and wait until its assistant reply is committed.
async fn turn(runtime: &Runtime, store: &Store, input_id: &str, prompt: &str) {
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: input_id.into(),
                prompt: prompt.into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    for _ in 0..100 {
        if !store.history("s").await.unwrap().is_empty()
            && store.active_run("s").await.unwrap().is_none()
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the turn never settled");
}

async fn settled_requests(store: &Store) -> Vec<Value> {
    store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "compaction.settled")
        .map(|event| event.data)
        .collect()
}

#[tokio::test]
async fn an_operator_request_compacts_at_the_next_boundary_without_configured_limits() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    // No context limits are configured, so the automatic trigger never fires.
    turn(&runtime, &store, "one", "first").await;
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 0);
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .all(|event| event.kind != "history.compacted"));

    assert_eq!(
        runtime.request_compact("s").await.unwrap(),
        json!({"accepted": true, "duplicate": false, "pending": true})
    );
    let request = store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .unwrap();

    // The request is honoured by the next drain's settled boundary even though
    // the budget gate would not have triggered.
    turn(&runtime, &store, "two", "second").await;
    for _ in 0..100 {
        if store
            .pending_compaction_request("s")
            .await
            .unwrap()
            .is_none()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(
        settled_requests(&store).await,
        vec![json!({"request_seq": request, "compacted": true})]
    );
    let compacted = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "history.compacted")
        .expect("the forced pass committed a checkpoint");
    assert_eq!(compacted.data["summary"], "A summary of the earlier turns.");
    // The checkpoint cuts the assistant boundary of the turn that honoured it.
    assert!(compacted.data["through_message_seq"].as_u64().is_some());
    assert!(store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_forced_pass_that_cannot_summarize_answers_the_request_once() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup_with(dir.path(), true).await;
    turn(&runtime, &store, "one", "first").await;
    assert_eq!(
        runtime.request_compact("s").await.unwrap(),
        json!({"accepted": true, "duplicate": false, "pending": true})
    );
    let request = store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .unwrap();
    turn(&runtime, &store, "two", "second").await;
    for _ in 0..100 {
        if store
            .pending_compaction_request("s")
            .await
            .unwrap()
            .is_none()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // A summarizer the provider keeps refusing cannot pin the Session: the one
    // attempt answers the request, and no checkpoint is committed.
    assert_eq!(
        settled_requests(&store).await,
        vec![json!({"request_seq": request, "compacted": false})]
    );
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 1);
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .all(|event| event.kind != "history.compacted"));
    assert!(store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .is_none());
    runtime.shutdown().await;
}
