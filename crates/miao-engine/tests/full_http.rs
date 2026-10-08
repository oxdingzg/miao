mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Delivery, Input},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn sse(events: Vec<Value>, done: bool) -> String {
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn anthropic(block: Value, reason: &str) -> String {
    sse(
        vec![
            json!({"type":"message_start","message":{"usage":{"input_tokens":5}}}),
            json!({"type":"content_block_start","index":0,"content_block":block}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ],
        false,
    )
}

#[tokio::test]
async fn both_wire_adapters_drive_real_http_tool_dispatch_and_durable_continuation() {
    for protocol in ["anthropic", "openai-chat"] {
        let first = if protocol == "anthropic" {
            anthropic(
                json!({"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}),
                "tool_use",
            )
        } else {
            sse(
                vec![
                    json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"file\"}"}}]},"finish_reason":null}]}),
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
                ],
                true,
            )
        };
        let final_reply = if protocol == "anthropic" {
            anthropic(json!({"type":"text","text":"finished"}), "end_turn")
        } else {
            sse(
                vec![
                    json!({"choices":[{"index":0,"delta":{"content":"finished"},"finish_reason":null}]}),
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}),
                ],
                true,
            )
        };
        let (url, mut requests, server) =
            common::endpoint(vec![(200, first), (200, final_reply)]).await;
        let provider: Arc<dyn Provider> = if protocol == "anthropic" {
            Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap())
        } else {
            Arc::new(OpenAIChat::new(url, "fixture".into(), "fixture-model".into()).unwrap())
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file"), "hello from workspace").unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::new(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime
            .admit(
                Input {
                    session_id: "s".into(),
                    input_id: "one".into(),
                    prompt: "read file".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        server.await.unwrap();
        let first = requests.recv().await.unwrap();
        assert_eq!(first["tools"].as_array().unwrap().len(), 2);
        let second = requests.recv().await.unwrap();
        if protocol == "anthropic" {
            assert_eq!(second["messages"][2]["content"][0]["tool_use_id"], "call");
            assert!(second["messages"][2]["content"][0]["content"]
                .as_str()
                .unwrap()
                .contains("hello from workspace"));
        } else {
            assert_eq!(second["messages"][2]["tool_call_id"], "call");
            assert!(second["messages"][2]["content"]
                .as_str()
                .unwrap()
                .contains("hello from workspace"));
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let events = store.events("s", 0, 100).await.unwrap();
                if events
                    .iter()
                    .any(|e| e.kind == "run.finished" && e.data["reason"] == "completed")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let history = store.history("s").await.unwrap();
        assert_eq!(history.len(), 4);
        assert_eq!(history[3].content[0]["text"], "finished");
        assert_eq!(
            store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .filter(|e| e.kind == "tool.dispatched")
                .count(),
            1
        );
        runtime.shutdown().await;
    }
}
