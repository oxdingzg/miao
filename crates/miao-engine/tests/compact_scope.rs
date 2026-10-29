//! Evidence for CTX-03's directed compaction: an operator names the range to
//! summarize and what the summary must keep, and the engine either honours it
//! exactly or refuses with a reason. Nothing is clamped silently.
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Policy},
    protocol::{CompactScope, Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Answers every turn, and keeps the exact text of every summarizer pass so a
/// test can prove which range the summary covered and what it was asked to keep.
struct Answer {
    turns: AtomicUsize,
    summaries: Mutex<Vec<String>>,
}

#[async_trait]
impl Provider for Answer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let summarizing = request.messages.iter().find_map(|message| {
            message
                .content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .find(|text| text.contains("Summarize this portion of the conversation"))
                .map(str::to_owned)
        });
        if let Some(instruction) = summarizing {
            self.summaries.lock().unwrap().push(instruction);
            return Ok(Reply {
                content: json!([{"type":"text","text":"A summary of the earlier turns."}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        self.turns.fetch_add(1, Ordering::SeqCst);
        Ok(Reply {
            content: json!([{"type":"text","text":"answered the prompt"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn setup(path: &Path) -> (Runtime, Store, Arc<Answer>) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Answer {
        turns: AtomicUsize::new(0),
        summaries: Mutex::new(Vec::new()),
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

async fn turn(runtime: &Runtime, store: &Store, id: &str, prompt: &str, messages: usize) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: id.into(),
                prompt: prompt.into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    for _ in 0..200 {
        if store.active_run("s").await.unwrap().is_none()
            && store.history("s").await.unwrap().len() >= messages
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the turn never settled");
}

/// Assistant message rows are committed through `message.committed`, so the row
/// seq is that event's seq.
async fn assistant_seqs(store: &Store) -> Vec<u64> {
    store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "message.committed" && event.data["role"] == "assistant")
        .map(|event| event.seq)
        .collect()
}

/// A promoted prompt is projected straight into the message table at the seq of
/// its `input.promoted` event, which is therefore the user message's seq.
async fn user_seqs(store: &Store) -> Vec<u64> {
    store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "input.promoted")
        .map(|event| event.seq)
        .collect()
}

async fn events_of(store: &Store, kind: &str) -> Vec<Value> {
    store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == kind)
        .map(|event| event.data)
        .collect()
}

async fn answered(store: &Store) {
    for _ in 0..200 {
        if store
            .pending_compaction_request("s")
            .await
            .unwrap()
            .is_none()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the compaction request was never answered");
}

#[tokio::test]
async fn a_directed_cut_summarizes_only_the_range_it_names() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    turn(&runtime, &store, "one", "first ask", 2).await;
    turn(&runtime, &store, "two", "second ask", 4).await;
    turn(&runtime, &store, "three", "third ask", 6).await;
    let assistants = assistant_seqs(&store).await;
    let cut = assistants[1];

    runtime
        .request_compact_with(
            "s",
            CompactScope {
                through: Some(cut),
                focus: None,
            },
        )
        .await
        .unwrap();
    turn(&runtime, &store, "four", "fourth ask", 8).await;
    answered(&store).await;

    let compacted = events_of(&store, "history.compacted").await;
    assert_eq!(compacted.len(), 1, "{compacted:?}");
    assert_eq!(compacted[0]["through_message_seq"], cut);

    // The summarized range stops where the operator said: the summarizer never
    // saw the third or fourth ask, which stay in the prefix verbatim.
    let prompts = provider.summaries.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1, "{prompts:?}");
    assert!(prompts[0].contains("second ask"), "{}", prompts[0]);
    assert!(!prompts[0].contains("third ask"), "{}", prompts[0]);

    let selected = serde_json::to_string(&store.selected_history("s").await.unwrap()).unwrap();
    assert!(selected.contains("<history-summary>"), "{selected}");
    assert!(selected.contains("third ask"), "{selected}");
    assert!(selected.contains("fourth ask"), "{selected}");
    assert!(!selected.contains("first ask"), "{selected}");
    assert!(!selected.contains("second ask"), "{selected}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_cut_that_is_not_a_closed_assistant_boundary_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    turn(&runtime, &store, "one", "first ask", 2).await;
    turn(&runtime, &store, "two", "second ask", 4).await;
    let users = user_seqs(&store).await;

    runtime
        .request_compact_with(
            "s",
            CompactScope {
                through: Some(users[0]),
                focus: None,
            },
        )
        .await
        .unwrap();
    let request = store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .unwrap()
        .seq;
    turn(&runtime, &store, "three", "third ask", 6).await;
    answered(&store).await;

    // The named range was read exactly: the summarizer saw the first ask and
    // nothing after it.
    let prompts = provider.summaries.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1, "{prompts:?}");
    assert!(prompts[0].contains("first ask"), "{}", prompts[0]);
    assert!(!prompts[0].contains("second ask"), "{}", prompts[0]);

    // A cut inside a provider turn cannot be a checkpoint, and the engine
    // refuses instead of moving the cut to the nearest legal boundary.
    assert!(events_of(&store, "history.compacted").await.is_empty());
    assert_eq!(
        events_of(&store, "compaction.settled").await,
        vec![json!({"request_seq": request, "compacted": false})]
    );
    let selected = serde_json::to_string(&store.selected_history("s").await.unwrap()).unwrap();
    assert!(!selected.contains("<history-summary>"), "{selected}");
    assert!(selected.contains("second ask"), "{selected}");
    assert!(selected.contains("third ask"), "{selected}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_retention_target_reaches_the_summarizer() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    turn(&runtime, &store, "one", "first ask", 2).await;

    runtime
        .request_compact_with(
            "s",
            CompactScope {
                through: None,
                focus: Some("keep the file list and the failing test names".into()),
            },
        )
        .await
        .unwrap();
    turn(&runtime, &store, "two", "second ask", 4).await;
    answered(&store).await;

    let prompts = provider.summaries.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1, "{prompts:?}");
    assert!(
        prompts[0].contains("Retention target: keep the file list and the failing test names"),
        "{}",
        prompts[0]
    );
    assert_eq!(
        events_of(&store, "history.compacted").await[0]["summary"],
        "A summary of the earlier turns."
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_scope_that_cannot_be_honoured_exactly_is_refused_at_request_time() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path()).await;
    turn(&runtime, &store, "one", "first ask", 2).await;

    for focus in [
        "   ".to_owned(),
        "x".repeat(miao_engine::store::MAX_COMPACTION_FOCUS_CHARS + 1),
    ] {
        assert!(matches!(
            runtime
                .request_compact_with(
                    "s",
                    CompactScope {
                        through: None,
                        focus: Some(focus),
                    },
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .is_none());

    // Both cuts below name real assistant messages, so neither request is
    // refused for its scope; the second differs from the first and therefore
    // conflicts instead of silently replacing it.
    let assistants = assistant_seqs(&store).await;
    runtime
        .request_compact_with(
            "s",
            CompactScope {
                through: Some(assistants[0]),
                focus: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        runtime
            .request_compact_with(
                "s",
                CompactScope {
                    through: Some(assistants[0]),
                    focus: Some("keep something else".into()),
                },
            )
            .await,
        Err(Error::Conflict)
    ));
    runtime.shutdown().await;
}
