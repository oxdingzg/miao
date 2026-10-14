//! Roadmap §2.13 gate ④: oversized tool output is elided from the outgoing
//! request, and only from there.
use async_trait::async_trait;
use miao_engine::{
    context_trigger::ContextLimits,
    permission::{Config, Policy},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Requests one large read, then reports every message payload it is sent.
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

async fn drained(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 200)
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
}

async fn run(prune_chars: Option<usize>) -> (String, Store) {
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
            prune_chars,
            protect_turns: 0,
        }))
        .await;
    runtime
        .admit(
            Input {
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
    drained(&store).await;
    (captured, store)
}

#[tokio::test]
async fn oversized_tool_output_is_elided_from_the_request_only() {
    let (captured, store) = run(Some(2000)).await;
    assert!(
        captured.contains("elided by context management"),
        "the outgoing request carries the elision mark"
    );
    assert!(
        captured.len() < 8000,
        "the 8 KB payload is bounded: {}",
        captured.len()
    );

    // A settled tool reports the window it ran in, which is what makes
    // per-turn overlap and the critical path measurable from events.
    let completed = store
        .events("s", 0, 400)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "tool.completed")
        .expect("a tool settled");
    assert!(
        completed.data["elapsed_ms"].as_u64().is_some(),
        "{}",
        completed.data
    );

    // Stored history keeps the whole payload.
    let stored = store.snapshot("s").await.unwrap().to_string();
    assert!(!stored.contains("elided by context management"));
    assert!(stored.contains(&"abcdefgh".repeat(100)), "history intact");

    // The mark names the handle that restores the elided middle on demand.
    let request: Value = serde_json::from_str(&captured).unwrap();
    let content = request
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().cloned().unwrap_or_default())
        .find(|part| part["type"] == "tool_result")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        content.contains(r#"recall {"tool_use_id":"call"}"#),
        "the elision mark carries the recovery handle: {content}"
    );
    let restored = store
        .recall(
            "s",
            miao_engine::recall::Query {
                query: String::new(),
                limit: 10,
                before_message_seq: None,
                tool_use_id: Some("call".into()),
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(restored["truncated"], false, "{restored}");
    assert_eq!(
        restored["total_bytes"],
        restored["text"].as_str().unwrap().len()
    );
    assert!(
        restored["text"]
            .as_str()
            .unwrap()
            .contains(&"abcdefgh".repeat(100)),
        "the elided middle comes back by handle"
    );
}

#[tokio::test]
async fn without_a_prune_budget_the_request_is_untouched() {
    let (captured, _store) = run(None).await;
    assert!(!captured.contains("elided by context management"));
    assert!(captured.contains(&"abcdefgh".repeat(100)));
}
