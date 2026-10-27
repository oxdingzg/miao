//! A model that drops its arguments sends `{}`. The call is rejected, but the
//! rejection has to name what is missing: a bare "invalid tool input" gives the
//! model nothing to correct, so it resends the same call.

mod common;

use miao_engine::{
    openai_chat::OpenAIChat,
    permission::{Config, Mode, Policy, Rule},
    protocol::{Delivery, Input},
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
            "delta": {"tool_calls": calls.iter().enumerate().map(|(index,(id,name,arguments))| json!({
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

async fn finished(store: &Store) -> Vec<miao_engine::protocol::Event> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("run finished")
}

#[tokio::test]
async fn an_empty_argument_object_is_settled_with_the_arguments_it_needs() {
    let dir = tempfile::tempdir().unwrap();
    let (url, mut requests, server) = common::endpoint(vec![
        (200, calls(&[("empty", "read_file", "{}")])),
        (200, text("DONE")),
    ])
    .await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap())
            as Arc<dyn Provider>,
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: miao_engine::permission::Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "human".into(),
                prompt: "read it".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let events = finished(&store).await;
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == "run.finished")
            .unwrap()
            .data["reason"],
        "completed"
    );
    let history = store.history("s").await.unwrap();
    let rejected = history
        .iter()
        .filter_map(|message| message.content.as_array())
        .flatten()
        .find(|block| block["type"] == "tool_result")
        .expect("settled tool result");
    assert!(
        rejected["content"]
            .as_str()
            .expect("result text")
            .contains("invalid tool input: read_file requires path"),
        "unexpected rejection: {}",
        rejected["content"]
    );
    // The model sees the same reason on its next turn, not a bare rejection.
    assert!(requests.recv().await.is_some());
    assert!(requests
        .recv()
        .await
        .unwrap()
        .to_string()
        .contains("invalid tool input: read_file requires path"));
    server.await.unwrap();
    runtime.shutdown().await;
}
