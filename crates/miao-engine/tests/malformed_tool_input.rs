//! TOOL-06 pins. A model can name a tool the engine does not register, send
//! arguments whose types disagree with the advertised schema, stream an
//! argument payload past the byte budget, or repeat a call that fails every
//! time. Each settles bounded: a corrective result the model can act on, or a
//! paused drain the operator can continue — and an oversized stream never
//! executes anything it carried.

mod common;

use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Delivery, Event, Input},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn chat(events: Vec<Value>) -> String {
    let stream = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    format!("{stream}data: [DONE]\n\n")
}

fn calls(calls: &[(&str, &str, &str)]) -> String {
    chat(vec![json!({
        "choices": [{
            "index": 0,
            "delta": {"tool_calls": calls.iter().enumerate().map(|(index, (id, name, arguments))| json!({
                "index": index, "id": id, "type": "function",
                "function": {"name": name, "arguments": arguments},
            })).collect::<Vec<_>>()},
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    })])
}

fn text(reply: &str) -> String {
    chat(vec![json!({
        "choices": [{"index": 0, "delta": {"content": reply}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    })])
}

fn input(prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "human".into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

async fn runtime(url: &str, dir: &std::path::Path) -> Runtime {
    Runtime::new(
        Store::open(dir.join("engine.db")).await.unwrap(),
        Arc::new(OpenAIChat::new(url.to_owned(), "fixture".into(), "model".into()).unwrap())
            as Arc<dyn Provider>,
        Tools::new(dir).await.unwrap(),
    )
    .await
    .unwrap()
}

async fn finished(store: &Store) -> Vec<Event> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let events = store.events("s", 0, 2000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("run finished")
}

async fn settled_result(store: &Store) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let result = store
                .history("s")
                .await
                .unwrap()
                .iter()
                .filter_map(|message| message.content.as_array())
                .flatten()
                .find(|block| block["type"] == "tool_result")
                .cloned();
            if let Some(result) = result {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("settled tool result")
}

#[tokio::test]
async fn an_unknown_tool_with_valid_arguments_is_named_in_the_settled_result() {
    let dir = tempfile::tempdir().unwrap();
    let (url, mut requests, server) = common::endpoint(vec![
        (
            200,
            calls(&[("u1", "totally_unknown", r#"{"path":"file"}"#)]),
        ),
        (200, text("DONE")),
    ])
    .await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = runtime(&url, dir.path()).await;
    runtime.admit(input("use it"), true).await.unwrap();
    let events = finished(&store).await;
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == "run.finished")
            .unwrap()
            .data["reason"],
        "completed"
    );
    assert!(!events.iter().any(|event| event.kind == "tool.dispatched"));
    let result = settled_result(&store).await;
    assert!(
        result["content"]
            .as_str()
            .expect("result text")
            .contains("Unknown tool: totally_unknown"),
        "unexpected rejection: {}",
        result["content"]
    );
    // The model sees the same reason on its next turn, not a bare rejection.
    requests.recv().await.unwrap();
    assert!(requests
        .recv()
        .await
        .unwrap()
        .to_string()
        .contains("Unknown tool: totally_unknown"));
    server.await.unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn wrong_typed_arguments_settle_a_result_that_names_the_expected_type() {
    let dir = tempfile::tempdir().unwrap();
    let (url, mut requests, server) = common::endpoint(vec![
        (200, calls(&[("w1", "read_file", r#"{"path":123}"#)])),
        (200, text("DONE")),
    ])
    .await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = runtime(&url, dir.path()).await;
    runtime.admit(input("read it"), true).await.unwrap();
    let events = finished(&store).await;
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == "run.finished")
            .unwrap()
            .data["reason"],
        "completed"
    );
    assert!(!events.iter().any(|event| event.kind == "tool.dispatched"));
    let result = settled_result(&store).await;
    assert!(
        result["content"]
            .as_str()
            .expect("result text")
            .contains("invalid tool input: read_file expects path as a string"),
        "unexpected rejection: {}",
        result["content"]
    );
    requests.recv().await.unwrap();
    assert!(requests
        .recv()
        .await
        .unwrap()
        .to_string()
        .contains("expects path as a string"));
    server.await.unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn oversized_tool_arguments_pause_the_drain_with_a_visible_reason() {
    std::env::set_var("MIAO_TOOL_INPUT_MAX_BYTES", "256");
    let dir = tempfile::tempdir().unwrap();
    let arguments = format!(r#"{{"path":"{}"}}"#, "a".repeat(4096));
    let (url, mut requests, server) =
        common::endpoint(vec![(200, calls(&[("big-1", "read_file", &arguments)]))]).await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = runtime(&url, dir.path()).await;
    runtime.admit(input("read it"), true).await.unwrap();
    let events = finished(&store).await;
    // Pausing, not failing: the Session stays usable and the transcript says why.
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == "run.finished")
            .unwrap()
            .data["reason"],
        "completed"
    );
    assert!(!events.iter().any(|event| event.kind == "stop_failure"));
    assert!(events.iter().any(|event| event.kind == "provider.failed"));
    assert!(events
        .iter()
        .any(|event| event.kind == "tool.input_oversize"));
    assert!(events.iter().any(|event| event.kind == "message.synthetic"));
    // The stream died mid-call, so nothing was settled, and the failure is not
    // retried: the same request would exceed the budget again.
    assert!(!store
        .history("s")
        .await
        .unwrap()
        .iter()
        .filter_map(|message| message.content.as_array())
        .flatten()
        .any(|block| block["type"] == "tool_result"));
    server.await.unwrap();
    let mut count = 0;
    while requests.recv().await.is_some() {
        count += 1;
    }
    assert_eq!(count, 1);
    runtime.shutdown().await;
}

#[tokio::test]
async fn repeated_failing_identical_calls_hit_the_same_refusal_bound() {
    let dir = tempfile::tempdir().unwrap();
    let bodies = (0..9)
        .map(|index| {
            (
                200,
                chat(vec![json!({
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [{"index": 0, "id": format!("r{index}"), "type": "function",
                            "function": {"name": "read_file", "arguments": r#"{"path":123}"#}}]},
                        "finish_reason": "tool_calls",
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                })]),
            )
        })
        .collect();
    let (url, mut requests, server) = common::endpoint(bodies).await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = runtime(&url, dir.path()).await;
    runtime.admit(input("read it"), true).await.unwrap();
    let events = finished(&store).await;
    // Five failing executions count like five successful ones: the sixth
    // identical call is refused, and a model that re-issues it anyway ends
    // the run instead of buying another provider turn.
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == "run.finished")
            .unwrap()
            .data["reason"],
        "failed"
    );
    let completed = events
        .iter()
        .filter(|event| event.kind == "tool.completed")
        .count();
    assert_eq!(completed, 9);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed"
                && event.data["result"]["error"]
                    .as_str()
                    .is_some_and(|text| text.contains("expects path as a string")))
            .count(),
        5
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed"
                && event.data["result"]["error"]
                    .as_str()
                    .is_some_and(|text| text.contains("Refusing to run read_file again")))
            .count(),
        4
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "loop.detected")
            .count(),
        1
    );
    let stopped = events
        .iter()
        .find(|event| event.kind == "loop.stopped")
        .unwrap();
    assert_eq!(stopped.data["reason"], "refused-tool-call");
    assert_eq!(stopped.data["refusals"], 4);
    server.await.unwrap();
    let mut count = 0;
    while requests.recv().await.is_some() {
        count += 1;
    }
    assert_eq!(count, 9);
    runtime.shutdown().await;
}
