mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest, ToolDefinition},
    provider::{Provider, ProviderError},
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn request() -> ModelRequest {
    ModelRequest {
        system: String::new(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"read file"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![ToolDefinition {
            name: "read_file".into(),
            description: "Read".into(),
            input_schema: json!({"type":"object"}),
        }],
    }
}
fn frames(events: Vec<Value>, done: bool) -> String {
    let mut body: String = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn chunk(delta: Value, finish: Value) -> Value {
    json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}

#[tokio::test]
async fn text_stream_preserves_usage_after_finish_and_lowers_tool_history() {
    let body = frames(
        vec![
            chunk(json!({"role":"assistant","content":"你好"}), json!(null)),
            chunk(json!({}), json!("stop")),
            json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let mut input = request();
    input.messages.extend([Message{role:"assistant".into(),content:json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),checkpoint:None,recorded_at_ms:None},Message{role:"user".into(),content:json!([{"type":"tool_result","tool_use_id":"call","content":"contents","is_error":false}]),checkpoint:None,recorded_at_ms:None}]);
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "你好");
    assert_eq!(reply.usage["prompt_tokens_details"]["cached_tokens"], 8);
    let body = requests.recv().await.unwrap();
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"file\"}"
    );
    assert_eq!(body["messages"][2]["role"], "tool");
    assert_eq!(body["messages"][2]["tool_call_id"], "call");
    assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    server.await.unwrap();
}

#[tokio::test]
async fn fragmented_tool_input_is_only_published_after_valid_terminal() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"pa"}}]}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"function":{"arguments":"th\":\"file\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[0]["id"], "call");
    assert_eq!(reply.content[0]["input"]["path"], "file");
    server.await.unwrap();
}

#[tokio::test]
async fn truncation_refusal_length_and_partial_tools_never_complete_or_retry() {
    let bodies = [
        frames(
            vec![chunk(json!({"content":"partial"}), json!("stop"))],
            false,
        ),
        frames(vec![chunk(json!({"refusal":"no"}), json!("stop"))], true),
        frames(
            vec![chunk(json!({"content":"truncated"}), json!("length"))],
            true,
        ),
        frames(
            vec![chunk(
                json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"{"}}]}),
                json!("tool_calls"),
            )],
            true,
        ),
        frames(
            vec![chunk(json!({"reasoning_content":"opaque"}), json!("stop"))],
            true,
        ),
    ];
    for body in bodies {
        let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
        let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
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
async fn unsupported_history_is_rejected_before_any_network_request() {
    let mut request = request();
    request.messages.push(Message {
        role: "assistant".into(),
        content: json!([{"type":"thinking","signature":"opaque"}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let provider = OpenAIChat::new(
        "http://127.0.0.1:1/unused".into(),
        "fixture".into(),
        "model".into(),
    )
    .unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(request, progress, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
}
