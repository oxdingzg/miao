use super::OpenAIResponses;
use crate::{
    credential::{Credential, Source},
    protocol::{Message, ModelRequest, ToolDefinition},
    provider::Provider,
    responses_websocket::{Contract, Mode},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        self,
        handshake::server::{Request, Response},
    },
};
use tokio_util::sync::CancellationToken;

fn adapter(url: &str, mode: Mode) -> OpenAIResponses {
    OpenAIResponses::new(url.into(), "fixture".into(), "m".into())
        .unwrap()
        .with_websocket_contract(Contract {
            model: "m".into(),
            endpoint: url.into(),
            authentication: crate::responses_cache::Authentication::Api,
            mode,
            beta: true,
        })
        .unwrap()
}
fn message(role: &str, text: &str) -> Message {
    Message {
        role: role.into(),
        content: json!([{"type":"text","text":text}]),
        checkpoint: None,
        recorded_at_ms: None,
    }
}
fn request(history: &[Message], system: &str, tools: Vec<ToolDefinition>) -> ModelRequest {
    ModelRequest {
        system: system.into(),
        messages: history.to_vec(),
        tools,
    }
}
fn created(id: &str) -> Value {
    json!({"type":"response.created","response":{"id":id}})
}
fn completed(id: &str, text: &str) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":1}}})
}
async fn call(
    provider: &OpenAIResponses,
    session: &str,
    history: &mut Vec<Message>,
    text: &str,
    system: &str,
    tools: Vec<ToolDefinition>,
) -> crate::provider::Reply {
    history.push(message("user", text));
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = crate::cache_affinity::scoped(
        session.into(),
        provider.stream(
            request(history, system, tools),
            tx,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    drain.await.unwrap();
    history.push(Message {
        role: "assistant".into(),
        content: reply.content.clone(),
        checkpoint: None,
        recorded_at_ms: None,
    });
    reply
}
async fn peer(
    connections: usize,
    requests: usize,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel(64);
    let task = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        for connection in 0..connections {
            let (stream, _) = listener.accept().await.unwrap();
            let tx = tx.clone();
            workers.spawn(async move {
                let headers=std::sync::Arc::new(std::sync::Mutex::new(Value::Null));
                let captured=headers.clone();
                // Tungstenite fixes this callback's error type to its HTTP response.
                #[allow(clippy::result_large_err)]
                let mut ws=accept_hdr_async(stream,move|request:&Request,response:Response| {
                    *captured.lock().unwrap()=json!({"authorization":request.headers().get("authorization").unwrap().to_str().unwrap(),"beta":request.headers().get("openai-beta").unwrap().to_str().unwrap()});
                    Ok(response)
                }).await.unwrap();
                for index in 0..requests {
                    let packet=loop {
                        let next=ws.next().await.unwrap().unwrap();
                        if let tungstenite::Message::Text(text)=next {break text;}
                    };
                    let body:Value=serde_json::from_str(&packet).unwrap();
                    let header_value=headers.lock().unwrap().clone();
                    tx.send(json!({"connection":connection,"headers":header_value,"body":body})).await.unwrap();
                    let id=format!("c{connection}-r{index}");
                    ws.send(tungstenite::Message::Ping(vec![1,2].into())).await.unwrap();
                    ws.send(tungstenite::Message::Text(serde_json::to_string_pretty(&created(&id)).unwrap().into())).await.unwrap();
                    ws.send(tungstenite::Message::Text(completed(&id,&format!("reply-{index}")).to_string().into())).await.unwrap();
                }
            });
        }
        while let Some(result) = workers.join_next().await {
            result.unwrap();
        }
    });
    (url, rx, task)
}

#[tokio::test]
async fn exact_acknowledged_suffixes_are_sent_only_while_history_and_parameters_match() {
    let (url, mut packets, task) = peer(1, 5).await;
    let provider = adapter(&url, Mode::Delta);
    let mut history = vec![];
    call(&provider, "s", &mut history, "one", "rules", vec![]).await;
    call(&provider, "s", &mut history, "two", "rules", vec![]).await;
    history[0] = message("user", "rewritten");
    call(&provider, "s", &mut history, "three", "rules", vec![]).await;
    call(
        &provider,
        "s",
        &mut history,
        "four",
        "changed rules",
        vec![],
    )
    .await;
    call(
        &provider,
        "s",
        &mut history,
        "five",
        "changed rules",
        vec![ToolDefinition {
            name: "fixture".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object"}),
        }],
    )
    .await;
    let mut frames = vec![];
    for _ in 0..5 {
        frames.push(packets.recv().await.unwrap());
    }
    assert_eq!(frames[0]["headers"]["authorization"], "Bearer fixture");
    assert_eq!(
        frames[0]["headers"]["beta"],
        "responses_websockets=2026-02-06"
    );
    assert_eq!(frames[0]["body"]["type"], "response.create");
    assert_eq!(frames[0]["body"]["store"], false);
    assert!(frames[0]["body"].get("stream").is_none());
    assert_eq!(frames[1]["body"]["previous_response_id"], "c0-r0");
    assert_eq!(frames[1]["body"]["input"].as_array().unwrap().len(), 1);
    for frame in &frames[2..] {
        assert!(frame["body"].get("previous_response_id").is_none());
    }
    assert_eq!(frames[2]["body"]["input"].as_array().unwrap().len(), 5);
    task.await.unwrap();
}

#[tokio::test]
async fn sessions_and_credential_generations_do_not_share_a_chain_or_connection() {
    let (url, mut packets, task) = peer(2, 2).await;
    let provider = adapter(&url, Mode::Delta);
    let mut a = vec![];
    let mut b = vec![];
    tokio::join!(
        call(&provider, "a", &mut a, "alpha-one", "rules", vec![]),
        call(&provider, "b", &mut b, "beta-one", "rules", vec![])
    );
    tokio::join!(
        call(&provider, "a", &mut a, "alpha-two", "rules", vec![]),
        call(&provider, "b", &mut b, "beta-two", "rules", vec![])
    );
    let mut frames = vec![];
    for _ in 0..4 {
        frames.push(packets.recv().await.unwrap());
    }
    assert_ne!(frames[0]["connection"], frames[1]["connection"]);
    for text in ["alpha", "beta"] {
        let first = frames
            .iter()
            .find(|frame| frame["body"]["input"][0]["content"][0]["text"] == format!("{text}-one"))
            .unwrap();
        let next = frames
            .iter()
            .find(|frame| frame["body"]["input"][0]["content"][0]["text"] == format!("{text}-two"))
            .unwrap();
        assert_eq!(
            next["body"]["previous_response_id"],
            format!("c{}-r0", first["connection"].as_u64().unwrap())
        );
    }
    task.await.unwrap();
    let (url, mut packets, task) = peer(2, 1).await;
    let mut provider = adapter(&url, Mode::Delta);
    let mut history = vec![];
    call(&provider, "a", &mut history, "one", "rules", vec![]).await;
    provider.source = Source::Static(Credential::key("rotated".into()));
    call(&provider, "a", &mut history, "two", "rules", vec![]).await;
    let first = packets.recv().await.unwrap();
    let second = packets.recv().await.unwrap();
    assert_ne!(first["connection"], second["connection"]);
    assert_eq!(second["headers"]["authorization"], "Bearer rotated");
    assert!(second["body"].get("previous_response_id").is_none());
    task.await.unwrap();
}

#[tokio::test]
async fn full_mode_reuses_the_socket_without_using_response_ids() {
    let (url, mut packets, task) = peer(1, 2).await;
    let provider = adapter(&url, Mode::Full);
    let mut history = vec![];
    call(&provider, "s", &mut history, "one", "rules", vec![]).await;
    call(&provider, "s", &mut history, "two", "rules", vec![]).await;
    packets.recv().await.unwrap();
    let next = packets.recv().await.unwrap();
    assert!(next["body"].get("previous_response_id").is_none());
    assert_eq!(next["body"]["input"].as_array().unwrap().len(), 3);
    task.await.unwrap();
}

async fn http_request(stream: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
    let mut bytes = vec![];
    loop {
        let mut byte = [0];
        stream.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
        assert!(bytes.len() < 32768);
    }
    let header = String::from_utf8(bytes).unwrap();
    let size = header
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; size];
    stream.read_exact(&mut body).await.unwrap();
    (header, body)
}
async fn http_reply(stream: &mut tokio::net::TcpStream) {
    let body = format!(
        "data: {}\n\ndata: {}\n\n",
        created("http"),
        completed("http", "fallback")
    );
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn rejected_upgrade_falls_back_to_the_original_full_http_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (header, _) = http_request(&mut stream).await;
        assert!(header.starts_with("GET "));
        stream
            .write_all(
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        drop(stream);
        let (mut stream, _) = listener.accept().await.unwrap();
        let (header, body) = http_request(&mut stream).await;
        assert!(header.starts_with("POST "));
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        http_reply(&mut stream).await;
    });
    let budget = crate::provider::Budget::new();
    let reply = crate::provider::scoped(budget.clone(), 3, async {
        Ok(call(
            &adapter(&url, Mode::Delta),
            "s",
            &mut vec![],
            "one",
            "rules",
            vec![],
        )
        .await)
    })
    .await
    .unwrap();
    assert_eq!(budget.used(), 2);
    assert_eq!(reply.content[0]["text"], "fallback");
    server.await.unwrap();
}

#[tokio::test]
async fn an_explicit_first_frame_chain_rejection_rebuilds_full_history_over_http() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.next().await.unwrap().unwrap();
        ws.send(tungstenite::Message::Text(created("r").to_string().into()))
            .await
            .unwrap();
        ws.send(tungstenite::Message::Text(
            completed("r", "first").to_string().into(),
        ))
        .await
        .unwrap();
        let next: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(next["previous_response_id"], "r");
        ws.send(tungstenite::Message::Text(
            json!({"type":"error","error":{"code":"previous_response_not_found"}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        let (_, body) = http_request(&mut stream).await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["input"].as_array().unwrap().len(), 3);
        assert!(body.get("previous_response_id").is_none());
        http_reply(&mut stream).await;
    });
    let provider = adapter(&url, Mode::Delta);
    let mut history = vec![];
    call(&provider, "s", &mut history, "one", "rules", vec![]).await;
    assert_eq!(
        call(&provider, "s", &mut history, "two", "rules", vec![])
            .await
            .content[0]["text"],
        "fallback"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancelling_after_output_discards_the_connection_and_its_chain() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
        first.next().await.unwrap().unwrap();
        first
            .send(tungstenite::Message::Text(
                created("cancelled").to_string().into(),
            ))
            .await
            .unwrap();
        first.send(tungstenite::Message::Text(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}).to_string().into())).await.unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let mut next = tokio_tungstenite::accept_async(stream).await.unwrap();
        let input: Value =
            serde_json::from_str(&next.next().await.unwrap().unwrap().into_text().unwrap())
                .unwrap();
        assert!(input.get("previous_response_id").is_none());
        next.send(tungstenite::Message::Text(
            created("fresh").to_string().into(),
        ))
        .await
        .unwrap();
        next.send(tungstenite::Message::Text(
            completed("fresh", "fresh").to_string().into(),
        ))
        .await
        .unwrap();
    });
    let provider = adapter(&url, Mode::Delta);
    let first = provider.clone();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let (tx, mut rx) = mpsc::channel(16);
    let running = tokio::spawn(async move {
        crate::cache_affinity::scoped(
            "s".into(),
            first.stream(
                request(&[message("user", "first")], "rules", vec![]),
                tx,
                token,
            ),
        )
        .await
    });
    while let Some(event) = rx.recv().await {
        if event["raw"]["type"] == "response.output_text.delta" {
            break;
        }
    }
    cancel.cancel();
    assert!(matches!(
        running.await.unwrap(),
        Err(crate::provider::ProviderError::Interrupted)
    ));
    assert_eq!(
        call(&provider, "s", &mut vec![], "next", "rules", vec![])
            .await
            .content[0]["text"],
        "fresh"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn interrupted_tool_arguments_never_trigger_an_ambiguous_http_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.next().await.unwrap().unwrap();
        for frame in [
            created("partial"),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c","name":"read_file"}}),
            json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{"}),
        ] {
            ws.send(tungstenite::Message::Text(frame.to_string().into()))
                .await
                .unwrap();
        }
        ws.close(None).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
    });
    let provider = adapter(&url, Mode::Delta);
    let (tx, mut rx) = mpsc::channel(32);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let result = crate::cache_affinity::scoped(
        "s".into(),
        provider.stream(
            request(&[message("user", "one")], "rules", vec![]),
            tx,
            CancellationToken::new(),
        ),
    )
    .await;
    assert!(matches!(
        result,
        Err(crate::provider::ProviderError::ContinuableTransport {
            unexecuted_calls: 1,
            ..
        })
    ));
    drain.await.unwrap();
    server.await.unwrap();
}

#[test]
fn a_websocket_capability_cannot_cross_model_endpoint_query_or_authentication() {
    let policy=Contract::from_wire(r#"{"model":"m","endpoint":"https://api.example/responses?deployment=a","authentication":"api","mode":"delta"}"#).unwrap();
    for (model, url) in [
        ("other", "https://api.example/responses?deployment=a"),
        ("m", "https://api.example/responses?deployment=b"),
    ] {
        assert!(
            OpenAIResponses::new(url.into(), "fixture".into(), model.into())
                .unwrap()
                .with_websocket_contract(policy.clone())
                .is_err()
        );
    }
    assert!(policy
        .validate("m", &reqwest::Url::parse(&policy.endpoint).unwrap(), true)
        .is_err());
    assert!(Contract::from_wire(r#"{"model":"m","endpoint":"https://api.example/responses","authentication":"api","mode":"delta","previous_response_id":"override"}"#).is_err());
}

#[tokio::test]
async fn context_epochs_force_full_history_and_ws_receipts_hash_the_sent_frame() {
    let (url, mut packets, task) = peer(1, 2).await;
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(dir.path().join("engine.db"))
        .await
        .unwrap();
    store.ensure("s").await.unwrap();
    let provider = adapter(&url, Mode::Delta);
    let mut history = vec![];
    for epoch in [1, 2] {
        let scope = crate::runtime_profile::Scope {
            store: store.clone(),
            session: "s".into(),
            run: "run".into(),
            step: epoch as usize,
            context_epoch: epoch,
            agent: json!({"name":"fixture"}),
            permissions: json!({"config":{}}),
        };
        crate::runtime_profile::scoped(
            scope,
            call(&provider, "s", &mut history, "next", "rules", vec![]),
        )
        .await;
    }
    let first = packets.recv().await.unwrap();
    let second = packets.recv().await.unwrap();
    assert!(second["body"].get("previous_response_id").is_none());
    assert_eq!(second["body"]["input"].as_array().unwrap().len(), 3);
    let events = store.events("s", 0, 100).await.unwrap();
    let receipts: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "provider.request")
        .collect();
    assert_eq!(receipts.len(), 2);
    for (receipt, packet) in receipts.iter().zip([first, second]) {
        assert_eq!(
            receipt.data["request_body_sha256"],
            crate::permission::digest(serde_json::to_string(&packet["body"]).unwrap().as_bytes())
        );
    }
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("Bearer fixture"));
    task.await.unwrap();
}

#[tokio::test]
async fn completed_tool_calls_continue_with_only_the_matching_function_output() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.next().await.unwrap().unwrap();
        ws.send(tungstenite::Message::Text(
            created("tool-r").to_string().into(),
        ))
        .await
        .unwrap();
        ws.send(tungstenite::Message::Text(json!({"type":"response.completed","response":{"id":"tool-r","status":"completed","output":[{"type":"function_call","id":"fc","call_id":"c","name":"read_file","status":"completed","arguments":"{\"path\":\"x\"}"}],"usage":{"input_tokens":10,"output_tokens":1}}}).to_string().into())).await.unwrap();
        let next: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(next["previous_response_id"], "tool-r");
        assert_eq!(
            next["input"],
            json!([{"type":"function_call_output","call_id":"c","output":"file data"}])
        );
        ws.send(tungstenite::Message::Text(
            created("final-r").to_string().into(),
        ))
        .await
        .unwrap();
        ws.send(tungstenite::Message::Text(
            completed("final-r", "done").to_string().into(),
        ))
        .await
        .unwrap();
    });
    let provider = adapter(&url, Mode::Delta);
    let mut history = vec![];
    let tools = vec![ToolDefinition {
        name: "read_file".into(),
        description: "read".into(),
        input_schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
    }];
    assert!(
        call(
            &provider,
            "s",
            &mut history,
            "read x",
            "rules",
            tools.clone()
        )
        .await
        .needs_tools
    );
    history.push(Message {role:"user".into(),content:json!([{"type":"tool_result","tool_use_id":"c","content":"file data","is_error":false}]),checkpoint:None,recorded_at_ms:None});
    let (tx, mut rx) = mpsc::channel(32);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = crate::cache_affinity::scoped(
        "s".into(),
        provider.stream(
            request(&history, "rules", tools),
            tx,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert!(!reply.needs_tools);
    assert_eq!(reply.content[0]["text"], "done");
    drain.await.unwrap();
    server.await.unwrap();
}
