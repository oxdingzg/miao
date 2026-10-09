use miao_engine::{
    credential::{Credential, Source},
    gemini::Gemini,
    protocol::{Delivery, Input, Message, ModelRequest},
    provider::{Provider, ProviderError},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
fn sse(events: Vec<Value>) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\r\n\r\n"))
        .collect()
}
async fn fixture(
    responses: Vec<String>,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v1beta/models/gemini-fixture:streamGenerateContent",
        listener.local_addr().unwrap()
    );
    let (send, receive) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = vec![];
            let header_end = loop {
                let mut bytes = [0; 4096];
                let read = socket.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                input.extend_from_slice(&bytes[..read]);
                assert!(input.len() < 2 * 1024 * 1024);
                if let Some(end) = input.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 2 * 1024 * 1024);
            while input.len() < header_end + length {
                let mut bytes = [0; 4096];
                let read = socket.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                input.extend_from_slice(&bytes[..read]);
            }
            let body: Value =
                serde_json::from_slice(&input[header_end..header_end + length]).unwrap();
            send.send(json!({"headers":headers,"body":body}))
                .await
                .unwrap();
            let header=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
            if socket.write_all(header.as_bytes()).await.is_err() {
                continue;
            }
            for bytes in response.as_bytes().chunks(4) {
                if socket.write_all(bytes).await.is_err() {
                    break;
                }
            }
        }
    });
    (url, receive, task)
}
fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest {
        system: "test system".into(),
        messages,
        tools: vec![],
    }
}
fn user() -> Message {
    Message {
        role: "user".into(),
        content: json!([{"type":"text","text":"请求"}]),
        checkpoint: None,
    }
}
async fn completed(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn real_http_runtime_preserves_parallel_native_parts_signatures_and_tool_responses() {
    let native = json!([{"text":"先读取"},{"text":"thought summary","thought":true},{"functionCall":{"name":"read_file","args":{"path":"answer.txt"},"id":"server-read"},"thoughtSignature":"ENCRYPTED_SIGNATURE"},{"functionCall":{"name":"list_files","args":{"path":"."},"id":"server-list"}}]);
    let first = sse(vec![
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":native}}]}),
        json!({"candidates":[{"finishReason":"STOP"}]}),
        json!({"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":14,"totalTokenCount":44}}),
    ]);
    let second = sse(vec![
        json!({"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":9}}),
    ]);
    let (url, mut captured, task) = fixture(vec![first, second]).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("answer.txt"), "FROM_DISK").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Gemini::new(url, "fake-key".into(), "gemini-fixture".into()).unwrap()),
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
    completed(&store).await;
    runtime.shutdown().await;
    let first = captured.recv().await.unwrap();
    let second = captured.recv().await.unwrap();
    task.await.unwrap();
    assert!(first["headers"]
        .as_str()
        .unwrap()
        .to_ascii_lowercase()
        .contains("x-goog-api-key: fake-key"));
    assert!(first["headers"].as_str().unwrap().contains("alt=sse"));
    assert!(first["body"]["systemInstruction"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("coding assistant"));
    assert!(first["body"]["tools"][0]["functionDeclarations"][0]
        .get("parametersJsonSchema")
        .is_some());
    let contents = second["body"]["contents"].as_array().unwrap();
    assert_eq!(contents[1]["parts"], native);
    let results = contents[2]["parts"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["functionResponse"]["id"], "server-read");
    assert_eq!(
        results[0]["functionResponse"]["response"]["result"]["text"],
        "FROM_DISK"
    );
    assert_eq!(results[1]["functionResponse"]["id"], "server-list");
    let history = store.history("s").await.unwrap();
    let opaque = history
        .iter()
        .flat_map(|message| message.content.as_array().unwrap())
        .find(|block| block["type"] == "provider_opaque")
        .unwrap();
    assert_eq!(opaque["payload"]["parts"], native);
    assert_ne!(opaque["payload"]["calls"][0]["id"], "server-read");
    let usage = store
        .events("s", 0, 100)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "usage")
        .collect::<Vec<_>>();
    assert_eq!(usage[0].data["usage"]["totalTokenCount"], 44);
}
#[tokio::test]
async fn malformed_truncated_blocked_and_duplicate_calls_never_become_replies() {
    let call = json!({"functionCall":{"name":"read_file","args":{"path":"answer.txt"},"id":"same"},"thoughtSignature":"sig"});
    for event in [
        json!({"candidates":[{"content":{"parts":[call.clone()]}}]}),
        json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":"incomplete"}}]},"finishReason":"STOP"}]}),
        json!({"candidates":[{"content":{"parts":[call.clone(),call.clone()]},"finishReason":"STOP"}]}),
        json!({"candidates":[{"content":{"parts":[{"text":"blocked"}]},"finishReason":"SAFETY"}]}),
        json!({"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"x"}}]},"finishReason":"STOP"}]}),
        json!({"candidates":[{"index":0},{"index":1}]}),
    ] {
        let (url, mut captured, task) = fixture(vec![sse(vec![event])]).await;
        let provider = Gemini::new(url, "fake-key".into(), "gemini-fixture".into()).unwrap();
        let (send, _receive) = mpsc::channel(32);
        assert!(matches!(
            provider
                .stream(request(vec![user()]), send, CancellationToken::new())
                .await,
            Err(ProviderError::Stream(_))
        ));
        assert!(captured.recv().await.is_some());
        task.await.unwrap();
        assert!(captured.recv().await.is_none());
    }
}
#[tokio::test]
async fn opaque_history_cannot_switch_model_protocol_or_mutate_call_mapping() {
    let native = json!([{"functionCall":{"name":"read_file","args":{"path":"answer.txt"}},"thoughtSignature":"sig"}]);
    let (url, mut captured, task) = fixture(vec![sse(vec![
        json!({"candidates":[{"content":{"parts":native},"finishReason":"STOP"}]}),
    ])])
    .await;
    let provider = Gemini::new(url.clone(), "fake-key".into(), "gemini-fixture".into()).unwrap();
    let (send, _receive) = mpsc::channel(32);
    let reply = provider
        .stream(request(vec![user()]), send, CancellationToken::new())
        .await
        .unwrap();
    captured.recv().await.unwrap();
    task.await.unwrap();
    let id = reply
        .content
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "tool_use")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let history = vec![
        user(),
        Message {
            role: "assistant".into(),
            content: reply.content.clone(),
            checkpoint: None,
        },
        Message {
            role: "user".into(),
            content: json!([{"type":"tool_result","tool_use_id":id,"content":"{}","is_error":false}]),
            checkpoint: None,
        },
    ];
    let other = Gemini::new(url.clone(), "fake-key".into(), "different-model".into()).unwrap();
    let (send, _receive) = mpsc::channel(32);
    assert!(matches!(
        other
            .stream(request(history.clone()), send, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
    for field in ["protocol", "mapping"] {
        let mut history = history.clone();
        if field == "protocol" {
            history[1].content[0]["protocol"] = json!("different-protocol");
        } else {
            history[1].content[0]["payload"]["calls"][0]["input"] = json!({"path":"wrong"});
        }
        let (send, _receive) = mpsc::channel(32);
        assert!(matches!(
            provider
                .stream(request(history), send, CancellationToken::new())
                .await,
            Err(ProviderError::Stream(_))
        ));
    }
}
#[tokio::test]
async fn api_key_profile_rejects_oauth_and_cancel_remains_interruptible() {
    let provider = Gemini::with_source(
        "http://127.0.0.1:1/stream".into(),
        Source::Static(Credential::token("secret-token".into(), None)),
        "gemini-fixture".into(),
    )
    .unwrap();
    let (send, _receive) = mpsc::channel(32);
    assert!(matches!(
        provider
            .stream(request(vec![user()]), send, CancellationToken::new())
            .await,
        Err(ProviderError::AuthProfile)
    ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = Gemini::new(
        format!("http://{}/stream", listener.local_addr().unwrap()),
        "fake-key".into(),
        "gemini-fixture".into(),
    )
    .unwrap();
    let token = CancellationToken::new();
    let cancel = token.clone();
    let (send, _receive) = mpsc::channel(32);
    let task =
        tokio::spawn(async move { provider.stream(request(vec![user()]), send, cancel).await });
    let (_socket, _) = listener.accept().await.unwrap();
    token.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Err(ProviderError::Interrupted)
    ));
}
#[test]
fn endpoint_and_model_identity_reject_ambiguous_configuration() {
    for (endpoint, model) in [
        ("http://127.0.0.1/stream?alt=json", "model"),
        ("http://user:password@127.0.0.1/stream", "model"),
        ("http://127.0.0.1/stream", "../escape"),
    ] {
        assert!(Gemini::new(endpoint.into(), "fake-key".into(), model.into()).is_err());
    }
}
