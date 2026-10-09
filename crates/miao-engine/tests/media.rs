mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Attachment, Delivery, Error, Input},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

// A 1x1 PNG, base64 without a data: prefix.
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn sse(events: Vec<Value>, done: bool) -> String {
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn anthropic_text(text: &str) -> String {
    sse(
        vec![
            json!({"type":"message_start","message":{"usage":{"input_tokens":5}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":text}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ],
        false,
    )
}
fn chat_text(text: &str) -> String {
    sse(
        vec![
            json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}),
        ],
        true,
    )
}
fn input() -> Input {
    Input {
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "what is this".into(),
        delivery: Delivery::Steer,
    }
}

#[tokio::test]
async fn anthropic_and_chat_encode_image_attachments_and_commit_them() {
    for protocol in ["anthropic", "openai-chat"] {
        let reply = if protocol == "anthropic" {
            anthropic_text("ok")
        } else {
            chat_text("ok")
        };
        let (url, mut requests, server) = common::endpoint(vec![(200, reply)]).await;
        let provider: Arc<dyn Provider> = if protocol == "anthropic" {
            Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap())
        } else {
            Arc::new(OpenAIChat::new(url, "fixture".into(), "fixture-model".into()).unwrap())
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
        runtime
            .admit_with(
                input(),
                vec![Attachment {
                    mime: "image/png".into(),
                    data: PNG.into(),
                }],
                true,
            )
            .await
            .unwrap();

        // The promoted user message carries the canonical image part.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if store
                    .history("s")
                    .await
                    .unwrap()
                    .first()
                    .is_some_and(|message| message.content[1]["type"] == "image")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let history = store.history("s").await.unwrap();
        assert_eq!(history[0].content[0]["type"], "text");
        assert_eq!(history[0].content[1]["mime"], "image/png");
        assert_eq!(history[0].content[1]["data"], PNG);

        // The provider receives the image in its own wire format.
        let request = tokio::time::timeout(std::time::Duration::from_secs(5), requests.recv())
            .await
            .unwrap()
            .unwrap();
        if protocol == "anthropic" {
            let blocks = request["messages"][0]["content"].as_array().unwrap();
            assert_eq!(blocks[0]["type"], "text");
            assert_eq!(blocks[1]["type"], "image");
            assert_eq!(blocks[1]["source"]["type"], "base64");
            assert_eq!(blocks[1]["source"]["media_type"], "image/png");
            assert_eq!(blocks[1]["source"]["data"], PNG);
        } else {
            let message = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "user")
                .unwrap();
            let content = message["content"].as_array().unwrap();
            assert_eq!(content[0]["type"], "text");
            assert_eq!(content[1]["type"], "image_url");
            assert!(content[1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,"));
        }
        runtime.shutdown().await;
        server.await.unwrap();
    }
}

#[tokio::test]
async fn attachment_is_part_of_the_admission_identity_and_validated() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_with(
            input(),
            vec![Attachment {
                mime: "image/png".into(),
                data: PNG.into(),
            }],
        )
        .await
        .unwrap();
    // An exact retry with the same media reconciles.
    let retry = store
        .admit_with(
            input(),
            vec![Attachment {
                mime: "image/png".into(),
                data: PNG.into(),
            }],
        )
        .await
        .unwrap();
    assert!(retry.duplicate);
    // A retry with different media conflicts instead of mutating the prompt.
    assert!(matches!(
        store
            .admit_with(
                input(),
                vec![Attachment {
                    mime: "image/jpeg".into(),
                    data: PNG.into(),
                }],
            )
            .await,
        Err(Error::Conflict)
    ));
    // An unsupported media type is rejected before admission.
    assert!(matches!(
        store
            .admit_with(
                Input {
                    input_id: "two".into(),
                    ..input()
                },
                vec![Attachment {
                    mime: "application/pdf".into(),
                    data: PNG.into(),
                }],
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
