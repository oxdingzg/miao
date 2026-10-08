use miao_engine::{
    gemini::Gemini,
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest},
    provider::{Provider, ProviderError},
    routing::Fallback,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
async fn fixture(
    status: u16,
    responses: Vec<String>,
    truncate: bool,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/stream", listener.local_addr().unwrap());
    let (send, receive) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = vec![];
            let end = loop {
                let mut bytes = [0; 4096];
                let read = socket.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                data.extend_from_slice(&bytes[..read]);
                if let Some(at) = data.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let head = String::from_utf8(data[..end].to_vec()).unwrap();
            let size = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(size < 2 * 1024 * 1024);
            while data.len() < end + size {
                let mut bytes = [0; 4096];
                let read = socket.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                data.extend_from_slice(&bytes[..read]);
            }
            send.send(serde_json::from_slice::<Value>(&data[end..end + size]).unwrap())
                .await
                .unwrap();
            let head=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len()+if truncate{100}else{0});
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, receive, task)
}
fn request() -> ModelRequest {
    ModelRequest {
        system: "system".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"task"}]),
        }],
        tools: vec![],
    }
}
fn chat() -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}})
    )
}
fn pair(primary: String, secondary: String) -> Fallback {
    Fallback::new(
        Arc::new(OpenAIChat::new(primary, "fake-key".into(), "primary".into()).unwrap()),
        Arc::new(OpenAIChat::new(secondary, "fake-key".into(), "secondary".into()).unwrap()),
    )
    .unwrap()
}
#[tokio::test]
async fn rejected_primary_can_fallback_with_one_shared_retry_budget() {
    let (a, mut primary, at) = fixture(503, vec!["busy".into()], false).await;
    let (b, mut secondary, bt) = fixture(200, vec![chat()], false).await;
    let provider = pair(a, b);
    let (send, _receive) = mpsc::channel(32);
    let reply = provider
        .stream(request(), send, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.usage["routing"]["route"], "fallback");
    assert_eq!(reply.usage["routing"]["http_attempts"], 2);
    assert_eq!(reply.usage["reported"]["prompt_tokens"], 1);
    assert_eq!(primary.recv().await.unwrap()["model"], "primary");
    assert_eq!(secondary.recv().await.unwrap()["model"], "secondary");
    at.await.unwrap();
    bt.await.unwrap();
}
#[tokio::test]
async fn accepted_body_transport_semantic_and_auth_failures_do_not_switch_model() {
    let partial = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})
    );
    for (status, body, truncated) in [
        (200, partial.clone(), true),
        (200, partial, false),
        (401, "unauthorized".into(), false),
    ] {
        let (a, mut captured, task) = fixture(status, vec![body], truncated).await;
        let provider = pair(a, "http://127.0.0.1:1/unused".into());
        let (send, _receive) = mpsc::channel(32);
        let error = provider
            .stream(request(), send, CancellationToken::new())
            .await
            .unwrap_err();
        let ProviderError::Routed { selection, source } = error else {
            panic!("routing metadata missing");
        };
        assert_eq!(selection["route"], "primary");
        assert_eq!(selection["http_attempts"], 1);
        if truncated {
            assert!(matches!(*source, ProviderError::ResponseTransport));
        } else if status == 401 {
            assert!(matches!(*source, ProviderError::Http(401)));
        } else {
            assert!(matches!(*source, ProviderError::Stream(_)));
        }
        captured.recv().await.unwrap();
        task.await.unwrap();
        assert!(captured.recv().await.is_none());
    }
}
#[tokio::test]
async fn concurrent_turns_each_have_three_attempts_without_budget_leakage() {
    let (a, mut primary, at) = fixture(503, vec!["busy".into(); 2], false).await;
    let (b, mut secondary, bt) = fixture(503, vec!["busy".into(); 4], false).await;
    let provider = Arc::new(pair(a, b));
    let tasks = (0..2)
        .map(|_| {
            let provider = provider.clone();
            tokio::spawn(async move {
                let (send, _receive) = mpsc::channel(32);
                provider
                    .stream(request(), send, CancellationToken::new())
                    .await
            })
        })
        .collect::<Vec<_>>();
    for task in tasks {
        let error = task.await.unwrap().unwrap_err();
        let ProviderError::Routed { selection, source } = error else {
            panic!("routing metadata missing");
        };
        assert_eq!(selection["http_attempts"], 3);
        assert!(matches!(*source, ProviderError::Http(503)));
    }
    at.await.unwrap();
    bt.await.unwrap();
    let mut count = 0;
    while primary.recv().await.is_some() {
        count += 1;
    }
    assert_eq!(count, 2);
    let mut count = 0;
    while secondary.recv().await.is_some() {
        count += 1;
    }
    assert_eq!(count, 4);
}
#[tokio::test]
async fn opaque_fallback_reply_pins_the_next_turn_and_preserves_signatures() {
    let native = json!([{"functionCall":{"name":"read_file","args":{"path":"file"},"id":"wire"},"thoughtSignature":"SIGNATURE"}]);
    let body = format!(
        "data: {}\n\n",
        json!({"candidates":[{"content":{"parts":native},"finishReason":"STOP"}]})
    );
    let final_body = format!(
        "data: {}\n\n",
        json!({"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]})
    );
    let (a, mut primary, at) = fixture(503, vec!["busy".into()], false).await;
    let (b, mut secondary, bt) = fixture(200, vec![body, final_body], false).await;
    let provider = Fallback::new(
        Arc::new(Gemini::new(a, "fake-key".into(), "primary".into()).unwrap()),
        Arc::new(Gemini::new(b, "fake-key".into(), "secondary".into()).unwrap()),
    )
    .unwrap();
    let (send, _receive) = mpsc::channel(32);
    let first = provider
        .stream(request(), send, CancellationToken::new())
        .await
        .unwrap();
    let id = first
        .content
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "tool_use")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let mut next = request();
    next.messages.push(Message {
        role: "assistant".into(),
        content: first.content.clone(),
    });
    next.messages.push(Message {
        role: "user".into(),
        content: json!([{"type":"tool_result","tool_use_id":id,"content":"{}","is_error":false}]),
    });
    let (send, _receive) = mpsc::channel(32);
    let second = provider
        .stream(next, send, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(second.usage["routing"]["opaque_pinned"], true);
    assert_eq!(second.usage["routing"]["identity"]["model"], "secondary");
    assert_eq!(second.usage["routing"]["http_attempts"], 1);
    primary.recv().await.unwrap();
    secondary.recv().await.unwrap();
    let request = secondary.recv().await.unwrap();
    assert_eq!(request["contents"][1]["parts"], native);
    at.await.unwrap();
    bt.await.unwrap();
}
