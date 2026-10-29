//! Evidence for the CTX-03 recap: a review artifact that a person reads, built
//! without a provider call and without touching what the next request carries.
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
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
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Answers every turn, and counts the summary passes so a test can prove a
/// recap never asked for one.
struct Answer {
    turns: AtomicUsize,
    summaries: AtomicUsize,
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
            "A summary of the earlier turns."
        } else {
            self.turns.fetch_add(1, Ordering::SeqCst);
            "answered the prompt"
        };
        Ok(Reply {
            content: json!([{"type":"text","text":text}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

/// Writes one file on its first turn, then closes the drain.
struct Writer {
    turn: AtomicUsize,
}

#[async_trait]
impl Provider for Writer {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(Reply {
                content: json!([
                    {"type":"text","text":"creating the file"},
                    {"type":"tool_use","id":"w","name":"write_file",
                     "input":{"path":"made.txt","text":"x\n","expected_sha256":null}},
                ]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: false,
        process_network: false,
        sandbox: false,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn setup<P: Provider + 'static>(path: &Path, provider: Arc<P>) -> (Runtime, Store) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        provider,
        Tools::new(path).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    (runtime, store)
}

async fn answer_setup(path: &Path) -> (Runtime, Store, Arc<Answer>) {
    let provider = Arc::new(Answer {
        turns: AtomicUsize::new(0),
        summaries: AtomicUsize::new(0),
    });
    let (runtime, store) = setup(path, provider.clone()).await;
    (runtime, store, provider)
}

/// Admit one prompt and wait until the drain settled with at least
/// `messages` committed, so a later read cannot race the run.
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

async fn event_kinds(store: &Store) -> Vec<String> {
    store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect()
}

#[tokio::test]
async fn a_recap_reports_the_window_without_changing_the_provider_request() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = answer_setup(dir.path()).await;
    turn(&runtime, &store, "one", "the first ask", 2).await;
    turn(&runtime, &store, "two", "the second ask", 4).await;
    let before = serde_json::to_value(store.selected_history("s").await.unwrap()).unwrap();

    let recap = runtime.recap("s").await.unwrap();

    let text = recap["text"].as_str().unwrap();
    assert!(text.starts_with("## Session recap"), "{text}");
    assert!(text.contains("- messages: 4\n"), "{text}");
    assert!(text.contains("the second ask"), "{text}");
    assert!(
        text.contains("## Last reply\nanswered the prompt"),
        "{text}"
    );
    assert_eq!(recap["through_message_seq"], Value::Null);
    assert_eq!(recap["messages_after_checkpoint"], 4);
    assert_eq!(recap["total_messages"], 4);

    // A recap is a review artifact, not a context operation: the provider
    // request is byte-identical and no summary pass was ever asked for.
    assert_eq!(
        serde_json::to_value(store.selected_history("s").await.unwrap()).unwrap(),
        before
    );
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 0);
    let kinds = event_kinds(&store).await;
    assert!(kinds.iter().any(|kind| kind == "recap.created"));
    assert!(kinds.iter().all(|kind| kind != "history.compacted"));
    let recorded = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "recap.created")
        .unwrap();
    assert_eq!(recorded.data["text"], text);
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_recap_separates_the_compacted_prefix_from_the_live_window() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = answer_setup(dir.path()).await;
    turn(&runtime, &store, "one", "before the checkpoint", 2).await;
    runtime.request_compact("s").await.unwrap();
    turn(&runtime, &store, "two", "the compacting turn", 4).await;
    for _ in 0..200 {
        if store
            .pending_compaction_request("s")
            .await
            .unwrap()
            .is_none()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 1);
    turn(&runtime, &store, "three", "after the checkpoint", 6).await;

    let recap = runtime.recap("s").await.unwrap();
    let text = recap["text"].as_str().unwrap();
    let through = recap["through_message_seq"]
        .as_u64()
        .expect("the checkpoint is reported");
    assert!(
        text.contains("## Compacted history (through message"),
        "{text}"
    );
    assert!(text.contains("A summary of the earlier turns."), "{text}");
    assert!(
        text.contains(&format!("since the checkpoint at message {through}")),
        "{text}"
    );
    assert!(text.contains("after the checkpoint"), "{text}");
    // The prompt the summary replaced is gone from the recap's live sections,
    // but it is still in the transcript: compaction never erased it.
    assert!(!text.contains("before the checkpoint"), "{text}");
    assert!(store.history("s").await.unwrap().iter().any(|message| {
        serde_json::to_string(&message.content)
            .unwrap()
            .contains("before the checkpoint")
    }));
    assert_eq!(recap["messages_after_checkpoint"], 2);
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_recap_names_the_files_the_window_changed() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Arc::new(Writer {
        turn: AtomicUsize::new(0),
    });
    let (runtime, store) = setup(dir.path(), provider).await;
    turn(&runtime, &store, "one", "create it", 3).await;

    let recap = runtime.recap("s").await.unwrap();
    let text = recap["text"].as_str().unwrap();
    assert!(
        text.contains("## Tool activity\n- 1 calls, 0 failed"),
        "{text}"
    );
    assert!(text.contains("files changed: made.txt x1"), "{text}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_recap_of_an_unknown_session_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = answer_setup(dir.path()).await;
    turn(&runtime, &store, "one", "the ask", 2).await;
    assert!(runtime.recap("missing").await.is_err());
    runtime.shutdown().await;
}
