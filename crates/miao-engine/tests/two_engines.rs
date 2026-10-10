use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
    task::JoinHandle,
};

const SESSION: &str = "same-session";
const WAIT: Duration = Duration::from_secs(15);

struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<ChildStdout>>,
    next: u64,
    events: Vec<Value>,
}
impl Engine {
    fn start(db: &Path, workspace: &Path, endpoint: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args(["serve", "--db"])
            .arg(db)
            .arg("--workspace")
            .arg(workspace)
            .args([
                "--model",
                "fixture",
                "--provider",
                "openai-responses",
                "--endpoint",
                endpoint,
            ])
            .env("OPENAI_API_KEY", "fixture")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Self {
            stdin: child.stdin.take().unwrap(),
            lines: BufReader::new(child.stdout.take().unwrap()).lines(),
            child,
            next: 1,
            events: Vec::new(),
        }
    }
    async fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        // The engine's stdio envelope is not JSON-RPC: unknown fields such as
        // `jsonrpc` are rejected. Keep this exactly as the product host client.
        let message = if method == "shutdown" {
            json!({"id":id,"method":method})
        } else {
            json!({"id":id,"method":method,"params":params})
        };
        let line = format!("{message}\n");
        tokio::time::timeout(WAIT, self.stdin.write_all(line.as_bytes()))
            .await
            .unwrap()
            .unwrap();
        self.stdin.flush().await.unwrap();
        id
    }
    async fn frame(&mut self) -> Value {
        let line = tokio::time::timeout(WAIT, self.lines.next_line())
            .await
            .expect("engine frame timed out")
            .unwrap()
            .expect("engine closed");
        let message: Value = serde_json::from_str(&line).unwrap();
        assert!(
            message.get("error").is_none(),
            "engine protocol error: {message}"
        );
        if message["method"] == "event" {
            self.events.push(message["params"].clone());
        }
        message
    }
    async fn reply(&mut self, id: u64) -> Value {
        loop {
            let message = self.frame().await;
            if message["id"].as_u64() == Some(id) {
                return message["result"].clone();
            }
        }
    }
    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        self.reply(id).await
    }
    async fn finished_after(&mut self, after: u64) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                if let Some(event) = self.events.iter().find(|event| {
                    event["kind"] == "run.finished" && event["seq"].as_u64().unwrap() > after
                }) {
                    assert_eq!(event["data"]["reason"], "completed", "{event}");
                    return event.clone();
                }
                self.frame().await;
            }
        })
        .await
        .expect("new run.finished timed out")
    }
    async fn ledger(&mut self) -> Vec<Value> {
        let mut after = 0;
        let mut result = Vec::new();
        loop {
            let page = self
                .request("events", json!({"session_id":SESSION,"after":after}))
                .await;
            let page = page.as_array().expect("events array");
            if page.is_empty() {
                return result;
            }
            after = page.last().unwrap()["seq"].as_u64().unwrap();
            result.extend(page.iter().cloned());
            assert!(result.len() < 2000, "unexpected unbounded event stream");
        }
    }
    async fn stop(&mut self) {
        self.request("shutdown", json!({})).await;
        assert!(tokio::time::timeout(WAIT, self.child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }
}

// A single protocol-client harness attaches two independent engine processes.
// Use identical Session/input IDs: isolation must be by engine, not just Session.
struct Client {
    engines: [Engine; 2],
}
impl Client {
    fn start(dir: &Path, workspace: &Path, endpoints: [&str; 2]) -> Self {
        Self {
            engines: [
                Engine::start(&dir.join("a.db"), workspace, endpoints[0]),
                Engine::start(&dir.join("b.db"), workspace, endpoints[1]),
            ],
        }
    }
}
fn admit(id: &str, prompt: &str, resume: bool) -> Value {
    json!({"input":{"session_id":SESSION,"input_id":id,"prompt":prompt},"resume":resume})
}
fn sse(output: Value) -> String {
    [
        json!({"type":"response.created","response":{"id":"fixture","status":"in_progress"}}),
        json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":1}}}),
    ].iter().map(|event| format!("data: {event}\n\n")).collect()
}
fn text() -> String {
    sse(
        json!([{"type":"message","id":"m","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}]),
    )
}
fn read_file() -> String {
    sse(
        json!([{"type":"function_call","id":"fc","call_id":"read","name":"read_file","arguments":"{\"path\":\"file.txt\"}"}]),
    )
}

// Unlike the generic 5s fixture, this peer can wait while clients exercise
// replay and recovery. Each accepted request has its own bounded deadline.
async fn fixture(responses: Vec<String>) -> (String, mpsc::Receiver<Value>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (capture, requests) = mpsc::channel(16);
    let task = tokio::spawn(async move {
        for body in responses {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            tokio::time::timeout(WAIT, async {
                let mut headers = Vec::new();
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    assert!(headers.len() < 65536);
                    stream.read_exact(&mut byte).await.unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap();
                let length = headers.lines().find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("content-length: ")?.parse::<usize>().ok()
                }).unwrap();
                assert!(length < 1024 * 1024);
                let mut request = vec![0; length];
                stream.read_exact(&mut request).await.unwrap();
                capture.send(serde_json::from_slice(&request).unwrap()).await.unwrap();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                stream.write_all(body.as_bytes()).await.unwrap();
            }).await.unwrap();
        }
    });
    (url, requests, task)
}
fn visible(snapshot: &Value) -> Vec<Value> {
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| json!({"role":message["role"],"content":message["content"]}))
        .collect()
}

#[tokio::test]
async fn two_engine_attach_preserves_tools_snapshots_ack_retry_and_replay() {
    let (url_a, mut calls_a, server_a) = fixture(vec![read_file(), text(), text()]).await;
    let (url_b, mut calls_b, server_b) = fixture(vec![read_file(), text()]).await;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("ws");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("file.txt"), "shared fixture content").unwrap();
    let mut client = Client::start(dir.path(), &workspace, [&url_a, &url_b]);
    for engine in &mut client.engines {
        engine
            .request("subscribe", json!({"session_id":SESSION,"after":0}))
            .await;
        engine
            .request("admit", admit("same-input", "read the file", true))
            .await;
        engine.finished_after(0).await;
    }
    let snapshot_a = client.engines[0]
        .request("snapshot", json!({"session_id":SESSION}))
        .await;
    let snapshot_b = client.engines[1]
        .request("snapshot", json!({"session_id":SESSION}))
        .await;
    assert_eq!(visible(&snapshot_a), visible(&snapshot_b));
    assert_eq!(snapshot_a["mode"], snapshot_b["mode"]);
    assert_eq!(snapshot_a["context"], snapshot_b["context"]);
    assert_eq!(snapshot_a["messages"].as_array().unwrap().len(), 4);
    let catalog_a = calls_a.recv().await.unwrap()["tools"].clone();
    let catalog_b = calls_b.recv().await.unwrap()["tools"].clone();
    assert_eq!(catalog_a, catalog_b);
    for (engine, snapshot) in client.engines.iter_mut().zip([&snapshot_a, &snapshot_b]) {
        let ledger = engine.ledger().await;
        assert_eq!(ledger.last().unwrap()["seq"], snapshot["cursor"]);
        assert!(ledger.iter().any(|event| event["kind"] == "tool.completed"
            && event["data"]["is_error"] == false
            && event["data"]["result"]["text"] == "shared fixture content"));
        assert!(engine
            .events
            .iter()
            .all(|event| event["session_id"] == SESSION));
    }

    // Explicitly discard an ack after durable admission, then retry the exact
    // same input. Do not confuse this with re-submitting a previously run input.
    let pending = admit("lost-ack", "next turn", false);
    let id = client.engines[0].send("admit", pending.clone()).await;
    let committed_ack = client.engines[0].reply(id).await;
    assert_eq!(committed_ack["duplicate"], false);
    let committed_seq = committed_ack["admitted_seq"].clone();
    drop(committed_ack); // simulate an application losing a committed ack
    let retry = client.engines[0].request("admit", pending).await;
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["admitted_seq"], committed_seq);
    let pending_snapshot = client.engines[0]
        .request("snapshot", json!({"session_id":SESSION}))
        .await;
    assert_eq!(pending_snapshot["pending"].as_array().unwrap().len(), 1);
    assert!(client.engines[1]
        .request("snapshot", json!({"session_id":SESSION}))
        .await["pending"]
        .as_array()
        .unwrap()
        .is_empty());

    // Force multiple pages and a replay/live handoff. The queue-model and page
    // tests must not silently accept duplicate cursors by deduplicating them.
    client.engines[0]
        .request("unsubscribe", json!({"session_id":SESSION}))
        .await;
    for index in 0..105 {
        client.engines[0].request("update_state", json!({"session_id":SESSION,"operation_id":format!("state-{index}"),"tool":"todowrite","input":{"todos":[]}})).await;
    }
    let replay = client.engines[0].ledger().await;
    assert!(replay.len() > 100);
    let watermark = replay.last().unwrap()["seq"].as_u64().unwrap();
    client.engines[0].events.clear();
    client.engines[0]
        .request("subscribe", json!({"session_id":SESSION,"after":0}))
        .await;
    tokio::time::timeout(WAIT, async {
        while client.engines[0]
            .events
            .last()
            .and_then(|event| event["seq"].as_u64())
            != Some(watermark)
        {
            client.engines[0].frame().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(client.engines[0].events, replay);
    client.engines[0]
        .request("resume", json!({"session_id":SESSION}))
        .await;
    client.engines[0].finished_after(watermark).await;
    let complete = client.engines[0].ledger().await;
    assert_eq!(client.engines[0].events, complete);
    assert!(complete
        .windows(2)
        .all(|pair| pair[1]["seq"].as_u64().unwrap() == pair[0]["seq"].as_u64().unwrap() + 1));
    let history = client.engines[0]
        .request("history", json!({"session_id":SESSION}))
        .await;
    assert_eq!(
        history
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user" && m["content"][0]["type"] == "text")
            .count(),
        2
    );
    let unchanged_b = client.engines[1]
        .request("snapshot", json!({"session_id":SESSION}))
        .await;
    assert_eq!(visible(&unchanged_b), visible(&snapshot_b));
    assert_eq!(unchanged_b["state"], snapshot_b["state"]);
    assert_eq!(unchanged_b["cursor"], snapshot_b["cursor"]);
    for engine in &mut client.engines {
        engine.stop().await;
    }
    server_a.await.unwrap();
    server_b.await.unwrap();
}

#[tokio::test]
async fn unread_subscriber_does_not_block_peer_engine_or_durable_completion() {
    let (url_a, _calls_a, server_a) = fixture(vec![text()]).await;
    let (url_b, _calls_b, server_b) = fixture(vec![text()]).await;
    let dir = tempfile::tempdir().unwrap();
    let mut client = Client::start(dir.path(), dir.path(), [&url_a, &url_b]);
    client.engines[0]
        .request("subscribe", json!({"session_id":SESSION}))
        .await;
    // Promoting this input produces a large committed notification that exceeds
    // a normal stdout pipe buffer. Leave that connection unread while B works.
    client.engines[0]
        .request("admit", admit("slow", &"x".repeat(192 * 1024), false))
        .await;
    let resume = client.engines[0]
        .send("resume", json!({"session_id":SESSION}))
        .await;
    client.engines[1]
        .request("subscribe", json!({"session_id":SESSION}))
        .await;
    client.engines[1]
        .request("admit", admit("fast", "fast peer", true))
        .await;
    client.engines[1].finished_after(0).await;
    let connection =
        Connection::open_with_flags(dir.path().join("a.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let complete: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM engine_event WHERE kind='run.finished')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if complete {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("durable run blocked by unread subscriber");
    // Resume draining the same connection and recover the entire ledger.
    client.engines[0].reply(resume).await;
    client.engines[0].finished_after(0).await;
    let durable = client.engines[0].ledger().await;
    // Stop hooks can commit after run.finished. Compare through the captured
    // ledger watermark, rather than racing their publication on slower hosts.
    let watermark = durable.last().unwrap()["seq"].as_u64().unwrap();
    while client.engines[0].events.last().unwrap()["seq"]
        .as_u64()
        .unwrap()
        < watermark
    {
        client.engines[0].frame().await;
    }
    assert_eq!(client.engines[0].events, durable);
    assert_eq!(
        client.engines[1]
            .request("history", json!({"session_id":SESSION}))
            .await[0]["content"][0]["text"],
        "fast peer"
    );
    for engine in &mut client.engines {
        engine.stop().await;
    }
    server_a.await.unwrap();
    server_b.await.unwrap();
}
