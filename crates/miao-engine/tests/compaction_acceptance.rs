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
    main_messages: std::sync::Mutex<Vec<Vec<(String, String)>>>,
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
        self.main_messages.lock().unwrap().push(
            request
                .messages
                .iter()
                .map(|message| {
                    (
                        message.role.clone(),
                        message.content[0]["text"].as_str().unwrap_or("").to_owned(),
                    )
                })
                .collect(),
        );
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
                agent_references: Default::default(),
                command: None,
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
        main_messages: std::sync::Mutex::new(Vec::new()),
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
            prune_total_chars: None,
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

#[tokio::test]
async fn the_first_request_after_a_checkpoint_carries_the_restore_budget_note() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Fixture {
        summaries: AtomicUsize::new(0),
        counts: AtomicUsize::new(0),
        main_messages: std::sync::Mutex::new(Vec::new()),
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
            ratio: 0.8,
            headroom: 0,
            per_pass: 1000,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
        }))
        .await;

    drain(&runtime, &store, "one", 1).await;
    let before = provider.main_messages.lock().unwrap().len();
    drain(&runtime, &store, "two", 2).await;

    let requests = provider.main_messages.lock().unwrap();
    assert!(requests.len() > before, "the second drain sent a request");
    let request = &requests[before];
    let is_note =
        |entry: &(String, String)| entry.1.starts_with("The conversation was just compacted");
    let note_index = request
        .iter()
        .position(&is_note)
        .expect("the restore budget note rides the first request after the checkpoint");
    assert_eq!(
        request.iter().filter(|entry| is_note(entry)).count(),
        1,
        "the note is request-scoped, not durable"
    );
    assert_eq!(
        note_index,
        request.len() - 2,
        "the closing user prompt stays last"
    );
    assert_eq!(request.last().unwrap().1, "work");
    assert_eq!(
        request[note_index].1,
        "The conversation was just compacted into a summary, so earlier details may be missing. \
         You have a restore budget of about 50,000 tokens: re-read the files you need to continue \
         correctly (at most 5 files, about 5,000 tokens each) before answering, \
         and skip anything the summary already covers."
    );
}

struct ToolContinuation {
    store: Store,
    turns: AtomicUsize,
    summaries: std::sync::Mutex<Vec<String>>,
}

#[async_trait]
impl Provider for ToolContinuation {
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
            self.summaries
                .lock()
                .unwrap()
                .push(serde_json::to_string(&request.messages).unwrap());
            return Ok(Reply {
                content: json!([{"type":"text","text":"saved completed work"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        let turn = self.turns.fetch_add(1, Ordering::SeqCst);
        if turn == 1 {
            self.store
                .admit(Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: "steer".into(),
                    prompt: "NEWER-PROMPT".into(),
                    delivery: Delivery::Steer,
                })
                .await
                .unwrap();
        }
        if turn % 2 == 1 {
            assert!(
                request
                    .messages
                    .iter()
                    .any(|message| message.content.to_string().contains("FILE-CONTENT")),
                "tool results must reach the continuation"
            );
        }
        Ok(Reply {
            content: if turn.is_multiple_of(2) {
                json!([{"type":"tool_use","id":format!("read-{turn}"),"name":"read_file","input":{"path":"file"}}])
            } else {
                json!([{"type":"text","text":format!("completed-{turn}")}])
            },
            usage: json!({"inputTokens":900_000,"outputTokens":1000}),
            needs_tools: turn.is_multiple_of(2),
        })
    }
}

#[tokio::test]
async fn tool_continuations_compact_only_closed_answers_before_promoting_steers() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "FILE-CONTENT").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(ToolContinuation {
        store: store.clone(),
        turns: AtomicUsize::new(0),
        summaries: std::sync::Mutex::new(Vec::new()),
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 4000,
            ratio: 0.25,
            headroom: 500,
            per_pass: 100,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
        }))
        .await;
    let mut progress = runtime.progress();
    drain(&runtime, &store, "one", 1).await;
    assert_eq!(provider.turns.load(Ordering::SeqCst), 4);
    let summaries = provider.summaries.lock().unwrap().clone();
    assert_eq!(
        summaries.len(),
        2,
        "no summary requests for open tool continuations"
    );
    assert!(summaries[0].contains("FILE-CONTENT"));
    assert!(summaries[0].contains("completed-1"));
    assert!(
        !summaries[0].contains("NEWER-PROMPT"),
        "newer prompts must not be summarized ahead of the cut"
    );
    assert!(summaries[1].contains("NEWER-PROMPT"));
    assert!(summaries[1].contains("completed-3"));
    let events = store.events("s", 0, 1000).await.unwrap();
    let cuts: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "history.compacted")
        .collect();
    assert_eq!(
        cuts.len(),
        2,
        "multiple checkpoints in the same run must not conflict"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "run.started")
            .count(),
        1
    );
    assert!(
        cuts[0].data["through_message_seq"].as_u64() < cuts[1].data["through_message_seq"].as_u64()
    );
    while let Ok(notice) = progress.try_recv() {
        assert_ne!(notice["kind"], "compaction.failed", "{notice}");
    }
    assert_eq!(store.selected_history("s").await.unwrap().len(), 1);
}
