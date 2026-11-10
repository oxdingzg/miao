//! The in-process engine must carry the same frames as the stdio adapter.
//!
//! `Connection::start_embedded` is the default transport, so both of its frame
//! families are load-bearing. When the progress arm goes missing, every token
//! waits for the turn's committed event and the transcript paints one finished
//! block instead of streaming. When the durable arm goes missing — the frame
//! wrapped twice, so it could not decode into an event and was dropped — the
//! transcript only refreshes when a timer re-projects, and an operator waits
//! minutes for content the engine already committed, until the next keystroke
//! forces a projection. No other test exercises either path: the pty suites all
//! spawn the scripted engine as a child, so these drive the real runtime
//! through a scripted SSE endpoint.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use miao_tui::transport::{Connection, EventRx, TransportEvent};
use serde_json::{json, Value};

#[tokio::test]
async fn the_in_process_engine_forwards_provider_deltas() {
    let (mut connection, mut events, session, server) =
        started("deltas", streaming_endpoint()).await;
    let client = connection.connect().await.expect("connect");
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

#[tokio::test]
async fn the_in_process_engine_forwards_durable_events() {
    let (mut connection, mut events, session, server) =
        started("events", streaming_endpoint()).await;
    let client = connection.connect().await.expect("connect");
    client
        .admit(
            json!({
                "session_id": session,
                "input_id": "inp_events_1",
                "prompt": "answer please",
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

    // The turn's durable facts, as the app sees them: the promoted input, the
    // committed answer, and the run boundary that retires it. A frame that
    // arrives doubly wrapped decodes into nothing, so this list stays empty
    // while the engine keeps committing — the freeze this test exists for.
    let mut kinds: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the in-process engine stopped answering");
        match event {
            Some(TransportEvent::Event(event)) => {
                assert_eq!(event.session_id, session, "an event for another Session");
                assert!(event.seq > 0, "a durable event carries its sequence");
                kinds.push(event.kind.clone());
                if event.kind == "run.finished" {
                    break;
                }
            }
            Some(TransportEvent::Resync(reason)) => panic!("undecodable frame: {reason}"),
            Some(TransportEvent::Failure(failure)) => panic!("engine failed: {failure:?}"),
            _ => {}
        }
    }
    for kind in ["input.promoted", "message.committed", "run.finished"] {
        assert!(
            kinds.iter().any(|seen| seen == kind),
            "the in-process engine must forward {kind}; saw {kinds:?}"
        );
    }
    let _ = server.join();
}

/// PERF-05: control outranks the rendering flood. A turn streams tens of
/// thousands of deltas; mid-flood the test asks the engine to cancel. The
/// control round trip is bounded while the flood pours, the run settles as
/// `interrupted` instead of riding the flood to completion, and nothing fails
/// the transport — a backlog must not cost the Session its stream.
#[tokio::test]
async fn a_cancel_lands_ahead_of_a_pouring_delta_flood() {
    let (mut connection, mut events, session, server) = started("flood", flood_endpoint()).await;
    let client = connection.connect().await.expect("connect");
    client
        .admit(
            json!({
                "session_id": session,
                "input_id": "inp_flood_1",
                "prompt": "flood please",
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

    // Five hundred deltas in, the flood is live and the egress is behind: the
    // reported backpressure mark sits at 256 frames, so a real backlog exists
    // when the control request cuts in.
    let cancel_mark = 500;
    let mut deltas = 0usize;
    let mut cancel_took = None;
    let mut settled = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the in-process engine stopped answering");
        match event {
            Some(TransportEvent::Progress(params)) if params["kind"] == "provider.delta" => {
                deltas += 1;
                if deltas == cancel_mark {
                    let began = std::time::Instant::now();
                    client.cancel(&session).await.expect("cancel mid-flood");
                    cancel_took = Some(began.elapsed());
                }
            }
            Some(TransportEvent::Event(event)) if event.kind == "run.finished" => {
                settled = event.data["reason"].as_str().map(str::to_string);
                break;
            }
            Some(TransportEvent::Resync(reason)) => panic!("undecodable frame: {reason}"),
            Some(TransportEvent::Failure(failure)) => panic!("engine failed: {failure:?}"),
            _ => {}
        }
    }
    let took = cancel_took.expect("the flood never reached the cancel mark");
    assert!(
        took < Duration::from_secs(5),
        "the cancel waited {took:?} behind the flood"
    );
    assert_eq!(
        settled.as_deref(),
        Some("interrupted"),
        "a flood the operator cancelled must settle the run as interrupted, not completed"
    );
    let _ = server.join();
}

/// Configure the in-process engine against a scripted SSE peer, open one
/// Session on it, and subscribe. Every test starts from the same place: the
/// scripted route is the only provider any of them can reach, and the caller
/// picks the peer's script.
async fn started(
    name: &str,
    peer: (String, std::thread::JoinHandle<()>),
) -> (Connection, EventRx, String, std::thread::JoinHandle<()>) {
    // `configure` refuses to start without a credential source, and the route
    // manifest names its own variable; neither value ever reaches the engine's
    // output.
    std::env::set_var("OPENAI_API_KEY", "PRIMARY_KEY_NEVER_PRINT");
    std::env::set_var("MIAO_TEST_ROUTE_KEY", "ROUTE_KEY_NEVER_PRINT");
    let (endpoint, server) = peer;
    let dir = std::env::temp_dir().join(format!(
        "miao-embedded-{name}-{}-{}",
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
    let (mut connection, events) =
        Connection::start_embedded(configured.runtime, Duration::from_secs(20))
            .expect("start the in-process engine");
    let client = connection.connect().await.expect("connect");
    let session = format!("ses_{}", "a".repeat(64));
    client.initialize(&session, name).await.expect("initialize");
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
    (connection, events, session, server)
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

/// A scripted OpenAI-chat SSE peer that floods: batches of one-byte content
/// deltas written back to back with only a pause between batches, so the turn
/// is still streaming long after the test has issued its control request. A
/// failed write is the engine hanging up — a cancelled run drops its provider
/// stream — and ends the flood quietly instead of failing the fixture thread.
fn flood_endpoint() -> (String, std::thread::JoinHandle<()>) {
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
            if socket.read_exact(&mut byte).is_err() {
                return;
            }
            request.push(byte[0]);
        }
        let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
        let Some(length) = headers.lines().find_map(|line| {
            line.strip_prefix("content-length: ")
                .and_then(|value| value.trim().parse::<usize>().ok())
        }) else {
            return;
        };
        let mut body = vec![0u8; length];
        if socket.read_exact(&mut body).is_err() {
            return;
        }
        if socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .is_err()
        {
            return;
        }
        let frame = "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"},\"finish_reason\":null}]}\n\n";
        // Sixty-four deltas a batch with a 2 ms pause between batches: fast
        // enough that the flood is the busy lane for the whole test, slow
        // enough that it is still pouring seconds from now, when the control
        // request has long landed. Sixty-four thousand deltas sits far past
        // the reported backpressure mark, and the run never reaches the
        // flood's end on its own.
        for _ in 0..1_000 {
            let mut batch = String::new();
            for _ in 0..64 {
                batch.push_str(frame);
            }
            if socket.write_all(batch.as_bytes()).is_err() {
                return;
            }
            let _ = socket.flush();
            std::thread::sleep(Duration::from_millis(2));
        }
        // Only a flood the engine never cancelled reaches this line; still
        // finish the protocol so the turn settles instead of hanging.
        let _ = socket.write_all(
            b"data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        );
    });
    (endpoint, server)
}

#[allow(dead_code)]
fn assert_no_secret(value: &Value) {
    assert!(!value.to_string().contains("ROUTE_KEY_NEVER_PRINT"));
}
