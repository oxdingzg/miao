mod common;

use miao_engine::{
    protocol::{Message, ModelRequest},
    provider::{Anthropic, Frame, Provider, ProviderError, SseDecoder},
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

fn text_stream() -> String {
    [json!({"type":"message_start","message":{"usage":{"input_tokens":7}}}),
     json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
     json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}),
     json!({"type":"content_block_stop","index":0}),
     json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}),
     json!({"type":"message_stop"})]
     .iter().map(|v|format!("data: {v}\r\n\r\n")).collect()
}

async fn endpoint(
    responses: Vec<(u16, String)>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let task = tokio::spawn(async move {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            requests.fetch_add(1, Ordering::SeqCst);
            let mut request = Vec::new();
            let mut byte = [0; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let headers = String::from_utf8(request).unwrap();
            let length = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|v| v.parse::<usize>().ok())
                })
                .unwrap();
            let mut request = vec![0; length];
            stream.read_exact(&mut request).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(request["stream"], true);
            assert_eq!(request["tools"][0]["name"], "read_file");
            for message in request["messages"].as_array().unwrap() {
                assert_eq!(
                    message
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    vec!["content", "role"],
                    "internal commit/checkpoint metadata must not enter provider messages"
                );
            }
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(3) {
                stream.write_all(chunk).await.unwrap();
            }
        }
    });
    (url, count, task)
}

fn history() -> ModelRequest {
    ModelRequest {
        system: String::new(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hi"}]),
            checkpoint: Some("internal-checkpoint".into()),
            recorded_at_ms: Some(1_700_000_000_123),
        }],
        tools: vec![miao_engine::protocol::ToolDefinition {
            name: "read_file".into(),
            description: "Read a file".into(),
            input_schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
        }],
    }
}

#[test]
fn sse_framing_handles_bytewise_utf8_crlf_and_multiline_json() {
    let mut decoder = SseDecoder::default();
    let mut values = Vec::new();
    for byte in "event: text\r\ndata: {\r\ndata: \"text\":\"你好\"}\r\n\r\n".as_bytes() {
        values.extend(decoder.push(&[*byte]).unwrap());
    }
    assert_eq!(values, vec![Frame::Json(json!({"text":"你好"}))]);
    assert!(decoder.push(&vec![b'x'; 1024 * 1024 + 1]).is_err());
}

#[tokio::test]
async fn real_http_adapter_decodes_stream_and_usage() {
    let (url, count, server) = endpoint(vec![(200, text_stream())]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "你好");
    assert_eq!(reply.usage["inputTokens"], 7);
    assert_eq!(reply.usage["outputTokens"], 2);
    assert!(!reply.needs_tools);
    server.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retries_http_capacity_but_never_a_truncated_200_stream() {
    let (url, count, server) = endpoint(vec![(503, String::new()), (200, text_stream())]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    let body = text_stream().replace("data: {\"type\":\"message_stop\"}\r\n\r\n", "");
    let (url, count, server) = endpoint(vec![(200, body)]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(history(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
    server.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_tool_input_is_not_dispatched_or_retried() {
    let body=[json!({"type":"message_start","message":{"usage":{}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"read_file","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}),
        json!({"type":"content_block_stop","index":0})].iter().map(|v|format!("data: {v}\n\n")).collect();
    let (url, count, server) = endpoint(vec![(200, body)]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(history(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
    server.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancel_interrupts_connection_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = Anthropic::new(
        format!("http://{}/v1/messages", listener.local_addr().unwrap()),
        "fixture-key".into(),
        "fixture-model".into(),
    )
    .unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        provider.stream(history(), progress, token).await,
        Err(ProviderError::Interrupted)
    ));
}

#[tokio::test]
async fn small_sse_frames_cannot_bypass_the_per_tool_argument_budget() {
    let mut events = vec![
        json!({"type":"message_start","message":{"usage":{}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bounded","name":"write_file","input":{}}}),
    ];
    events.extend((0..3).map(|_| json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"private-argument".repeat(28_000)}})));
    let body = events
        .iter()
        .map(|event| format!("data: {event}\r\n\r\n"))
        .collect();
    let (url, count, server) = endpoint(vec![(200, body)]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let result = provider
        .stream(history(), progress, CancellationToken::new())
        .await;
    assert!(
        matches!(result, Err(ProviderError::Stream(ref message)) if message == "tool input exceeds byte budget")
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.await.unwrap();
}

fn thinking_frames() -> Vec<serde_json::Value> {
    vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":7}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先看"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"文件。"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"好的"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}),
        json!({"type":"message_stop"}),
    ]
}

#[tokio::test]
async fn anthropic_thinking_round_trips_as_reasoning_with_its_signature() {
    let bodies = thinking_frames()
        .iter()
        .map(|value| format!("data: {value}\r\n\r\n"))
        .collect::<String>();
    let (url, mut requests, server) =
        common::endpoint(vec![(200, bodies), (200, text_stream())]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        reply.content,
        json!([
            {"type":"reasoning","text":"先看文件。","signature":"sig"},
            {"type":"text","text":"好的"}
        ])
    );
    let mut follow = history();
    follow.messages.push(Message {
        role: "assistant".into(),
        content: reply.content.clone(),
        checkpoint: None,
        recorded_at_ms: None,
    });
    follow.messages.push(Message {
        role: "user".into(),
        content: json!([{"type":"text","text":"continue"}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(follow, progress, CancellationToken::new())
        .await
        .unwrap();
    requests.recv().await.unwrap();
    let second = requests.recv().await.unwrap();
    // The canonical part returns as the signed block the provider expects.
    assert_eq!(
        second["messages"][1]["content"][0],
        json!({"type":"thinking","thinking":"先看文件。","signature":"sig"})
    );
    assert_eq!(
        second["messages"][1]["content"][1],
        json!({"type":"text","text":"好的"})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn anthropic_rejects_redacted_thinking_and_allows_reasoning_only_turns() {
    let redacted = [json!({"type":"message_start","message":{"usage":{}}}), json!({"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}), json!({"type":"message_stop"})]
        .iter()
        .map(|value| format!("data: {value}\r\n\r\n"))
        .collect::<String>();
    let (url, _, server) = endpoint(vec![(200, redacted)]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(history(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
    server.await.unwrap();

    let reasoning_only = [json!({"type":"message_start","message":{"usage":{}}}), json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}), json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"only"}}), json!({"type":"content_block_stop","index":0}), json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}), json!({"type":"message_stop"})]
        .iter()
        .map(|value| format!("data: {value}\r\n\r\n"))
        .collect::<String>();
    let (url, _, server) = endpoint(vec![(200, reasoning_only)]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content, json!([{"type":"reasoning","text":"only"}]));
    assert!(!reply.needs_tools);
    server.await.unwrap();
}

#[tokio::test]
async fn anthropic_prompt_cache_marks_the_stable_prefix_and_honours_max_tokens() {
    let (url, mut requests, server) = common::endpoint(vec![(200, text_stream())]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into())
        .unwrap()
        .with_max_tokens(64_000)
        .with_prompt_cache(true);
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    let body = requests.recv().await.unwrap();
    assert_eq!(body["max_tokens"], 64_000);
    assert_eq!(
        body["system"],
        json!([{"type":"text","text":"","cache_control":{"type":"ephemeral"}}])
    );
    assert_eq!(
        body["tools"][0]["cache_control"],
        json!({"type":"ephemeral"})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn anthropic_defaults_keep_the_plain_system_prompt_uncached() {
    let (url, mut requests, server) = common::endpoint(vec![(200, text_stream())]).await;
    let provider = Anthropic::new(url, "fixture-key".into(), "fixture-model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(history(), progress, CancellationToken::new())
        .await
        .unwrap();
    let body = requests.recv().await.unwrap();
    assert_eq!(body["max_tokens"], 4096);
    assert_eq!(body["system"], json!(""));
    assert!(body["tools"][0].get("cache_control").is_none());
    server.await.unwrap();
}
