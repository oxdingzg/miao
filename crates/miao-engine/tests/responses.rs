mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Delivery, Input, Message, ModelRequest},
    provider::{Anthropic, Provider, ProviderError},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn stream(output: Value, status: &str) -> String {
    [json!({"type":"response.created","response":{"id":"response","status":"in_progress"}}),
     json!({"type":"response.completed","response":{"id":"response","status":status,"output":output,"usage":{"input_tokens":5,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}}})]
     .iter().map(|e|format!("data: {e}\n\n")).collect()
}
fn request() -> ModelRequest {
    ModelRequest {
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hello"}]),
        }],
        tools: vec![],
    }
}

#[tokio::test]
async fn responses_runtime_preserves_opaque_reasoning_and_function_outputs() {
    let reasoning =
        json!({"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"opaque-fixture"});
    let first = stream(
        json!([reasoning,{"type":"function_call","id":"fc_1","call_id":"call","name":"read_file","arguments":"{\"path\":\"file\"}"}]),
        "completed",
    );
    let last = stream(
        json!([{"type":"message","id":"msg","role":"assistant","content":[{"type":"output_text","text":"finished","annotations":[]}]}]),
        "completed",
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, first), (200, last)]).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(OpenAIResponses::new(url, "fixture".into(), "fixture-model".into()).unwrap()),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "read".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    server.await.unwrap();
    let first = requests.recv().await.unwrap();
    assert_eq!(first["store"], false);
    assert_eq!(first["include"][0], "reasoning.encrypted_content");
    assert_eq!(first["tools"][0]["name"], "read_file");
    let next = requests.recv().await.unwrap();
    assert_eq!(next["input"][1], reasoning);
    assert_eq!(next["input"][2]["call_id"], "call");
    assert_eq!(next["input"][3]["type"], "function_call_output");
    assert!(next["input"][3]["output"]
        .as_str()
        .unwrap()
        .contains("contents"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
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
    assert_eq!(
        store.history("s").await.unwrap()[1].content[0]["item"],
        reasoning
    );
    assert_eq!(
        store.history("s").await.unwrap()[3].content[0]["text"],
        "finished"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn incomplete_arguments_refusal_hosted_actions_and_truncation_fail_closed() {
    let cases = [
        stream(
            json!([{"type":"function_call","call_id":"call","name":"read_file","arguments":"{"}]),
            "completed",
        ),
        stream(
            json!([{"type":"web_search_call","id":"hosted"}]),
            "completed",
        ),
        stream(
            json!([{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no"}]}]),
            "completed",
        ),
        stream(json!([]), "incomplete"),
        format!(
            "data: {}\n\n",
            json!({"type":"response.created","response":{"id":"partial"}})
        ),
    ];
    for body in cases {
        let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
        let provider = OpenAIResponses::new(url, "fixture".into(), "fixture-model".into()).unwrap();
        let (progress, _receive) = mpsc::channel(64);
        assert!(matches!(
            provider
                .stream(request(), progress, CancellationToken::new())
                .await,
            Err(ProviderError::Stream(_))
        ));
        server.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
    }
}

#[tokio::test]
async fn opaque_history_cannot_silently_cross_protocol_or_model() {
    let mut input = request();
    input.messages.push(Message{role:"assistant".into(),content:json!([{"type":"provider_opaque","provider":"openai-responses","model":"old-model","item":{"type":"reasoning","encrypted_content":"secret-fixture"}}])});
    let providers: Vec<Arc<dyn Provider>> = vec![
        Arc::new(
            OpenAIResponses::new(
                "http://127.0.0.1:1/unused".into(),
                "fixture".into(),
                "new-model".into(),
            )
            .unwrap(),
        ),
        Arc::new(
            OpenAIChat::new(
                "http://127.0.0.1:1/unused".into(),
                "fixture".into(),
                "old-model".into(),
            )
            .unwrap(),
        ),
        Arc::new(
            Anthropic::new(
                "http://127.0.0.1:1/unused".into(),
                "fixture".into(),
                "old-model".into(),
            )
            .unwrap(),
        ),
    ];
    for provider in providers {
        let (progress, _receive) = mpsc::channel(64);
        assert!(matches!(
            provider
                .stream(input.clone(), progress, CancellationToken::new())
                .await,
            Err(ProviderError::Stream(_))
        ));
    }
}
