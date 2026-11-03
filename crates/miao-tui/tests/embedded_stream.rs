//! The in-process engine must stream provider deltas to the TUI.
//!
//! `Connection::start_embedded` carries the same frames as the stdio adapter:
//! when its progress arm goes missing, every token waits for the turn's
//! committed event and the transcript paints one finished block instead of
//! streaming. No other test exercises that path — the pty suites all spawn the
//! scripted engine as a child — so this one drives the real runtime through a
//! scripted SSE endpoint.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use miao_tui::transport::{Connection, TransportEvent};
use serde_json::{json, Value};

#[tokio::test]
async fn the_in_process_engine_forwards_provider_deltas() {
    // `configure` refuses to start without a credential source, and the route
    // manifest names its own variable; neither value ever reaches the engine's
    // output.
    std::env::set_var("OPENAI_API_KEY", "PRIMARY_KEY_NEVER_PRINT");
    std::env::set_var("MIAO_TEST_ROUTE_KEY", "ROUTE_KEY_NEVER_PRINT");
    let (endpoint, server) = streaming_endpoint();
    let dir = std::env::temp_dir().join(format!(
        "miao-embedded-stream-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("ws")).expect("workspace");
    let db = dir.join("engine.db");
    let manifest = dir.join("routes.json");
    std::fs::write(
        &manifest,
        json!([{
            "id": "fixture/route",
            "provider": "openai-chat",
            "model": "fixture",
            "endpoint": endpoint,
            "credential": {"type": "environment", "key": "MIAO_TEST_ROUTE_KEY"}
        }])
        .to_string(),
    )
    .expect("routes manifest");

    let argv = vec![
        "serve".to_string(),
        "--db".to_string(),
        db.display().to_string(),
        "--workspace".to_string(),
        dir.join("ws").display().to_string(),
        "--model".to_string(),
        "fixture".to_string(),
        "--provider".to_string(),
        "openai-chat".to_string(),
        "--model-routes-config".to_string(),
        manifest.display().to_string(),
    ];
    let configured = miao_engine::cli::configure(&argv)
        .await
        .expect("configure the in-process engine");
    let (mut connection, mut events) =
        Connection::start_embedded(configured.runtime, Duration::from_secs(20))
            .expect("start the in-process engine");
    let client = connection.connect().await.expect("connect");
    let session = format!("ses_{}", "a".repeat(64));
    client
        .initialize(&session, "stream")
        .await
        .expect("initialize");
    client
        .request(
            "select_model",
            json!({
                "session_id": session,
                "binding": {
                    "route_id": "fixture/route",
                    "protocol": "openai-chat",
                    "model": "fixture",
                }
            }),
        )
        .await
        .expect("select the scripted route");
    client.subscribe(&session, 0).await.expect("subscribe");
    client
        .admit(
            json!({
                "session_id": session,
                "input_id": "inp_stream_1",
                "prompt": "stream please",
            }),
            false,
            Vec::new(),
        )
        .await
        .expect("admit");
    client
        .request("resume", json!({ "session_id": session }))
        .await
        .expect("resume");

    // Two deltas, in the order the provider sent them. A turn that only
    // delivers its committed message never fills this list.
    let mut deltas: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline && deltas.len() < 2 {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the in-process engine stopped answering");
        match event {
            Some(TransportEvent::Progress(params)) if params["kind"] == "provider.delta" => {
                let delta = &params["data"]["delta"];
                if delta["kind"] == "text.delta" {
                    deltas.push(delta["text"].as_str().unwrap_or_default().to_string());
                }
            }
            Some(TransportEvent::Failure(failure)) => panic!("engine failed: {failure:?}"),
            _ => {}
        }
    }
    assert_eq!(
        deltas,
        vec!["流式".to_string(), "输出".to_string()],
        "the in-process engine must forward every streamed delta, not only the committed message"
    );
    let _ = server.join();
}

/// A scripted OpenAI-chat SSE peer: two content deltas, a stop, and `[DONE]`,
/// written in small pieces so a reader cannot mistake one write for one event.
fn streaming_endpoint() -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind the fixture endpoint");
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().expect("fixture address")
    );
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("accept the engine request");
        let _ = socket.set_read_timeout(Some(Duration::from_secs(20)));
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            assert!(
                socket.read_exact(&mut byte).is_ok(),
                "request headers closed"
            );
            request.push(byte[0]);
        }
        let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length: ")
                    .and_then(|value| value.trim().parse().ok())
            })
            .expect("content-length");
        let mut body = vec![0u8; length];
        socket.read_exact(&mut body).expect("request body");
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .expect("response headers");
        let frame = |text: &str| {
            format!(
                "data: {{\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{text}\"}},\"finish_reason\":null}}]}}\n\n"
            )
        };
        for text in ["流式", "输出"] {
            let payload = frame(text);
            for piece in payload.as_bytes().chunks(7) {
                socket.write_all(piece).expect("delta write");
                socket.flush().expect("delta flush");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        socket
            .write_all(
                b"data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            )
            .expect("stop frame");
        socket.flush().expect("stop flush");
    });
    (endpoint, server)
}

#[allow(dead_code)]
fn assert_no_secret(value: &Value) {
    assert!(!value.to_string().contains("ROUTE_KEY_NEVER_PRINT"));
}
