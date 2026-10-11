use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    net::TcpListener,
    process::{ChildStdin, ChildStdout, Command},
};

async fn rpc(
    input: &mut ChildStdin,
    output: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = if method == "shutdown" {
        json!({"id":id,"method":method})
    } else {
        json!({"id":id,"method":method,"params":params})
    };
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    input.flush().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let line = output
                .next_line()
                .await
                .unwrap()
                .expect("native transport closed before receipt");
            let response: Value = serde_json::from_str(&line).unwrap();
            if response["id"] == id {
                assert!(response.get("error").is_none(), "{response}");
                return response["result"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|error| panic!("RPC {id} {method} timed out: {error}"))
}

async fn fixture(mode: usize) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            observed.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    match socket.read_u8().await {
                        Ok(byte) => header.push(byte),
                        Err(_) => return,
                    }
                }
                // Consume the request before closing a healthy response. On
                // Windows, unread request bytes can turn close into a TCP reset.
                let length = String::from_utf8(header)
                    .unwrap()
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap();
                assert!(length < 1024 * 1024);
                let mut body = vec![0; length];
                if socket.read_exact(&mut body).await.is_err() {
                    return;
                }
                if mode != 0 && socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.is_err(){return;}
                if mode == 2 {
                    loop {
                        if socket
                            .write_all(b"data: {\"type\":\"ping\"}\n\n")
                            .await
                            .is_err()
                        {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                if mode == 3 {
                    if socket
                        .write_all(
                            b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{}}}\n\n",
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let body=[
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"HEALTHY"}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                        json!({"type":"message_stop"}),
                    ].iter().map(|event|format!("data: {event}\n\n")).collect::<String>();
                    let _ = socket.write_all(body.as_bytes()).await;
                    return;
                }
                // A dropped HTTP attempt must close its socket; drain request
                // bytes first rather than mistaking its body for cancellation.
                let mut buffer = [0; 1024];
                while socket.read(&mut buffer).await.is_ok_and(|count| count > 0) {}
            });
        }
    });
    (format!("http://{address}/messages"), calls, server)
}

#[tokio::test]
async fn actual_native_process_bounds_headers_silence_and_pings_without_refilling_retry_budget() {
    for mode in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let (endpoint, calls, server) = fixture(mode).await;
        let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args([
                "serve",
                "--db",
                dir.path().join("engine.db").to_str().unwrap(),
                "--workspace",
                dir.path().to_str().unwrap(),
                "--model",
                "fixture",
                "--endpoint",
                &endpoint,
            ])
            .env("ANTHROPIC_API_KEY", "fixture-key")
            .env("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", "100")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        rpc(
            &mut input,
            &mut output,
            1,
            "admit",
            json!({"input":{"session_id":"s","input_id":"human","prompt":"answer"},"resume":true}),
        )
        .await;
        let events = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let events = rpc(
                    &mut input,
                    &mut output,
                    2,
                    "events",
                    json!({"session_id":"s","after":0}),
                )
                .await;
                if events
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["kind"] == "run.finished")
                {
                    return events;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let terminal = events
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["kind"] == "run.finished")
            .unwrap();
        assert_eq!(
            terminal["data"]["reason"],
            if mode == 3 { "completed" } else { "failed" },
            "{events}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if mode == 3 { 1 } else { 3 },
            "{events}"
        );
        assert!(!events
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "tool.planned"));
        rpc(&mut input, &mut output, 3, "shutdown", json!({})).await;
        drop(input);
        assert!(child.wait().await.unwrap().success());
        server.abort();
    }
}

#[tokio::test]
async fn disabled_first_event_deadline_preserves_external_interruption_and_closes_upstream() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, calls, server) = fixture(1).await;
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
            "--endpoint",
            &endpoint,
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .env("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    rpc(
        &mut input,
        &mut output,
        1,
        "admit",
        json!({"input":{"session_id":"s","input_id":"human","prompt":"wait"},"resume":true}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let events = rpc(
        &mut input,
        &mut output,
        2,
        "events",
        json!({"session_id":"s","after":0}),
    )
    .await;
    assert!(!events
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["kind"] == "run.finished"));
    assert_eq!(
        rpc(
            &mut input,
            &mut output,
            3,
            "cancel",
            json!({"session_id":"s"})
        )
        .await["accepted"],
        true
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    rpc(&mut input, &mut output, 4, "shutdown", json!({})).await;
    drop(input);
    assert!(child.wait().await.unwrap().success());
    server.abort();
}
