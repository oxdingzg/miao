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
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hi"}]),
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
    assert_eq!(reply.usage["input_tokens"], 7);
    assert_eq!(reply.usage["output_tokens"], 2);
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
