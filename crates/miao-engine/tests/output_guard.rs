mod common;
use async_trait::async_trait;
use miao_engine::{
    gemini::Gemini,
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Delivery, Event, Input, ModelRequest},
    provider::{Anthropic, Provider, ProviderError, Reply},
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

const LOOPED: &str = "Let me run.\nLet me go.\nLet me do it.\nLet me execute.\n";

fn input(session: &str, prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

async fn events_until(store: &Store, session: &str, done: impl Fn(&[Event]) -> bool) -> Vec<Event> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events(session, 0, 2000).await.unwrap();
            if done(&events) {
                return events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn events_until_finished(store: &Store, session: &str) -> Vec<Event> {
    events_until(store, session, |events| {
        events.iter().any(|event| event.kind == "run.finished")
    })
    .await
}

/// A provider that stops itself the way the stream guard does: deltas already
/// published, then a non-retryable stop that still carries the partial reply.
struct Looping {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Provider for Looping {
    async fn stream(
        &self,
        _request: ModelRequest,
        progress: mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        progress
            .send(json!({"kind":"delta","delta":{"kind":"text.delta","text":"Start.\n"}}))
            .await
            .unwrap();
        Err(ProviderError::Repetitive {
            channel: "text",
            partial: Reply {
                content: json!([{"type":"text","text":format!("Start.\n{LOOPED}")}]),
                usage: json!({"inputTokens": 3, "outputTokens": 4}),
                needs_tools: false,
            },
        })
    }
}

/// The turn fails without a retry, what the user already saw stays durable, and
/// no tool call from the stopped reply is dispatched.
#[tokio::test]
async fn a_stopped_loop_fails_the_turn_without_retrying_or_dispatching() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "unchanged").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Looping {
            calls: calls.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("s", "go"), true).await.unwrap();
    // The engine journals `run.finished` before `stop_failure`, so the stopping
    // test waits for the explanation instead of the finish marker.
    let events = events_until(&store, "s", |events| {
        events.iter().any(|event| event.kind == "stop_failure")
    })
    .await;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a stopped loop is not retried"
    );
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "failed"));
    let stop = events
        .iter()
        .rev()
        .find(|event| event.kind == "stop_failure")
        .unwrap();
    assert!(
        stop.data["message"]
            .as_str()
            .is_some_and(|message| message.contains("stopped repetitive text output")),
        "unexpected stop message: {}",
        stop.data["message"]
    );
    let repetition = events
        .iter()
        .find(|event| event.kind == "output.repetition")
        .expect("output.repetition is recorded");
    assert_eq!(repetition.data["channel"], "text");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "provider.failed")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed")
            .count(),
        0
    );
    assert!(store
        .history("s")
        .await
        .unwrap()
        .iter()
        .any(|message| serde_json::to_string(&message.content)
            .unwrap()
            .contains("Let me run.")));
    runtime.shutdown().await;
}

/// The looping wire for each codec: 40 identical refrain deltas, then the
/// late tool call the guard must stop before. Every shape is parser-valid for
/// its own codec, because the parser runs before the guard observes deltas.
fn looping_frames(codec: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    let refrain = || LOOPED.to_owned();
    match codec {
        "anthropic" => {
            frames.push(json!({"type":"message_start","message":{"usage":{"input_tokens":1}}}));
            frames.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}));
            for _ in 0..40 {
                frames
                    .push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":refrain()}}));
            }
            frames.push(json!({"type":"content_block_stop","index":0}));
            frames.push(json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"late","name":"write","input":{}}}));
            frames.push(json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}));
            frames.push(json!({"type":"content_block_stop","index":1}));
            frames.push(json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}));
            frames.push(json!({"type":"message_stop"}));
        }
        "openai-responses" => {
            frames.push(json!({"type":"response.created","response":{"id":"r"}}));
            for _ in 0..40 {
                frames.push(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":refrain()}));
            }
            frames.push(json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"late","name":"write","arguments":"{}","status":"completed"}],"usage":{"input_tokens":1,"output_tokens":1}}}));
        }
        "gemini" => {
            for _ in 0..40 {
                frames.push(json!({"candidates":[{"content":{"parts":[{"text":refrain()}]}}]}));
            }
            frames.push(json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"write","args":{},"id":"late"}}]},"finishReason":"STOP"}]}));
        }
        _ => {
            for _ in 0..40 {
                frames.push(json!({"choices":[{"index":0,"delta":{"content":refrain()},"finish_reason":null}]}));
            }
            frames.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"late","type":"function","function":{"name":"write","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}));
        }
    }
    frames
}

fn wire_body(codec: &str, frames: Vec<Value>) -> String {
    // Gemini's real wire frames SSE with CRLF; the other codecs use LF.
    let terminator = if codec == "gemini" {
        "\r\n\r\n"
    } else {
        "\n\n"
    };
    let mut body = frames
        .iter()
        .map(|frame| format!("data: {frame}{terminator}"))
        .collect::<String>();
    if codec == "openai-chat" {
        body.push_str("data: [DONE]\n\n");
    }
    body
}

/// The same replay through every streaming codec's real SSE parser: the guard
/// recognizes a prose loop mid-stream regardless of wire shape, stops before a
/// late tool call, and the request is not sent a second time.
#[tokio::test]
async fn the_guard_stops_a_looping_provider_stream_before_a_late_tool_call() {
    for codec in ["anthropic", "openai-chat", "openai-responses", "gemini"] {
        let (endpoint, mut requests, _server) =
            common::endpoint(vec![(200, wire_body(codec, looping_frames(codec)))]).await;
        let provider: Arc<dyn Provider> = match codec {
            "anthropic" => {
                Arc::new(Anthropic::new(endpoint, "fixture".into(), "model".into()).unwrap())
            }
            "openai-responses" => {
                Arc::new(OpenAIResponses::new(endpoint, "fixture".into(), "model".into()).unwrap())
            }
            "gemini" => {
                Arc::new(Gemini::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap())
            }
            _ => Arc::new(
                OpenAIChat::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap(),
            ),
        };
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::new(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime.admit(input("s", "go"), true).await.unwrap();
        let events = events_until_finished(&store, "s").await;

        assert!(
            events
                .iter()
                .any(|event| event.kind == "run.finished" && event.data["reason"] == "failed"),
            "the turn fails on {codec}"
        );
        let repetition = events
            .iter()
            .find(|event| event.kind == "output.repetition")
            .unwrap_or_else(|| panic!("output.repetition is recorded on {codec}"));
        assert_eq!(repetition.data["channel"], "text");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "tool.completed")
                .count(),
            0,
            "the late tool call never dispatches on {codec}"
        );
        assert!(
            requests.try_recv().is_ok(),
            "one provider request on {codec}"
        );
        assert!(
            requests.try_recv().is_err(),
            "the stopped stream is not retried on {codec}"
        );
        runtime.shutdown().await;
    }
}

/// The provider-facing history neutralizes an earlier loop, while the durable
/// transcript keeps the text the operator saw.
struct LoopThenAnswer {
    calls: AtomicUsize,
    seen: Arc<tokio::sync::Mutex<Vec<Value>>>,
}

#[async_trait]
impl Provider for LoopThenAnswer {
    async fn stream(
        &self,
        request: ModelRequest,
        _progress: mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(ProviderError::Repetitive {
                channel: "text",
                partial: Reply {
                    content: json!([{"type":"text","text":LOOPED.repeat(20)}]),
                    usage: Value::Null,
                    needs_tools: false,
                },
            });
        }
        *self.seen.lock().await = request
            .messages
            .iter()
            .map(|message| message.content.clone())
            .collect();
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: Value::Null,
            needs_tools: false,
        })
    }
}

#[tokio::test]
async fn an_earlier_loop_is_neutralized_in_the_provider_request_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(LoopThenAnswer {
            calls: AtomicUsize::new(0),
            seen: seen.clone(),
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("s", "go"), true).await.unwrap();
    events_until_finished(&store, "s").await;
    runtime
        .admit(
            Input {
                input_id: "second".into(),
                prompt: "continue".into(),
                ..input("s", "continue")
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if !seen.lock().await.is_empty() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let sent = seen.lock().await.clone();
    let rendered = serde_json::to_string(&sent).unwrap();
    assert!(
        rendered.contains("Removed from model context"),
        "the request carries the neutralized note"
    );
    assert!(
        !rendered.contains("Let me run."),
        "the refrain is not resent"
    );
    assert!(
        serde_json::to_string(&store.history("s").await.unwrap())
            .unwrap()
            .contains("Let me run."),
        "the durable transcript keeps the original text"
    );
    runtime.shutdown().await;
}
