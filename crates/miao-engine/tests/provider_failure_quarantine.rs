use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Event, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Rejects the first call with an invalid-request HTTP status, then answers
/// `ok`, so one provider drives the terminal failure and the recovery prompt.
struct InvalidThenOk {
    calls: AtomicUsize,
    status: u16,
}

#[async_trait]
impl Provider for InvalidThenOk {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(ProviderError::Http(self.status));
        }
        Ok(Reply {
            content: json!([{"type": "text", "text": "ok"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

/// The first turn commits a real tool roundtrip, the second is rejected: the
/// failure then sits after committed work, so nothing may be quarantined.
struct ToolThenInvalid {
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for ToolThenInvalid {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => Ok(Reply {
                content: json!([{"type": "tool_use", "id": "call", "name": "write_file", "input": {"path": "note.txt", "text": "hi", "expected_sha256": null}}]),
                usage: json!({}),
                needs_tools: true,
            }),
            1 => Err(ProviderError::Http(400)),
            _ => Ok(Reply {
                content: json!([{"type": "text", "text": "ok"}]),
                usage: json!({}),
                needs_tools: false,
            }),
        }
    }
}

async fn harness(provider: Arc<impl Provider + 'static>) -> (Runtime, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    (runtime, store)
}

async fn admit(runtime: &Runtime, id: &str, prompt: &str) {
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
}

async fn wait_for_runs(store: &Store, runs: usize) -> Vec<Event> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if events
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= runs
            {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

fn rejected_message(events: &[Event]) -> bool {
    events
        .iter()
        .any(|event| event.kind == "provider.failure.quarantined")
}

/// A first-turn invalid-request rejection quarantines the promoted input so
/// the session recovers on the next plain prompt: the poison-pill failure that
/// used to brick a session until /clear.
#[tokio::test]
async fn invalid_first_request_quarantines_and_the_session_recovers() {
    let provider = Arc::new(InvalidThenOk {
        calls: AtomicUsize::new(0),
        status: 400,
    });
    let (runtime, store) = harness(provider.clone()).await;
    admit(&runtime, "one", "describe this image").await;
    let events = wait_for_runs(&store, 1).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "failed"));
    let stop = events
        .iter()
        .rev()
        .find(|event| event.kind == "stop_failure")
        .unwrap();
    assert_eq!(
        stop.data["message"],
        json!("invalid request: provider HTTP 400")
    );
    assert!(rejected_message(&events));

    // Provider history no longer carries the rejected message, but the
    // transcript keeps it visible next to the failure record.
    let selected = store.selected_history("s").await.unwrap();
    assert!(selected
        .iter()
        .all(|message| !serde_json::to_string(&message.content)
            .unwrap()
            .contains("describe this image")));
    assert!(store
        .history("s")
        .await
        .unwrap()
        .iter()
        .any(|message| serde_json::to_string(&message.content)
            .unwrap()
            .contains("describe this image")));

    // The follow-up plain prompt completes: the failure must not poison the
    // session for every later turn.
    admit(&runtime, "two", "怎么回事？").await;
    let events = wait_for_runs(&store, 2).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}

/// Quota-style statuses are not the input's fault: the message stays selected
/// so a later attempt sees the same context, and nothing is quarantined.
#[tokio::test]
async fn quota_failures_do_not_quarantine() {
    let provider = Arc::new(InvalidThenOk {
        calls: AtomicUsize::new(0),
        status: 429,
    });
    let (runtime, store) = harness(provider.clone()).await;
    admit(&runtime, "one", "describe this image").await;
    let events = wait_for_runs(&store, 1).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "failed"));
    assert!(!rejected_message(&events));
    let selected = store.selected_history("s").await.unwrap();
    assert!(selected
        .iter()
        .any(|message| serde_json::to_string(&message.content)
            .unwrap()
            .contains("describe this image")));

    admit(&runtime, "two", "怎么回事？").await;
    let events = wait_for_runs(&store, 2).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}

/// A rejection after the run committed tool work leaves history untouched:
/// partial work must survive, only the first-turn input is quarantined.
#[tokio::test]
async fn mid_run_failures_keep_committed_history() {
    let provider = Arc::new(ToolThenInvalid {
        calls: AtomicUsize::new(0),
    });
    let (runtime, store) = harness(provider.clone()).await;
    admit(&runtime, "one", "write the note").await;
    let events = wait_for_runs(&store, 1).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "failed"));
    assert!(!rejected_message(&events));
    let selected = store.selected_history("s").await.unwrap();
    let rendered = selected
        .iter()
        .map(|message| serde_json::to_string(&message.content).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains("write the note"));
    assert!(rendered.contains("note.txt"));
    assert!(rendered.contains("tool_result"));

    admit(&runtime, "two", "怎么回事？").await;
    let events = wait_for_runs(&store, 2).await;
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed"));
}
