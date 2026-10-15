mod common;

use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Client {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Client {
    async fn start(root: &Path, endpoint: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .arg("acp")
            .arg("--db")
            .arg(root.join("engine.db"))
            .arg("--workspace")
            .arg(root)
            .args([
                "--provider",
                "openai-chat",
                "--model",
                "fixture",
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
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut client = Self {
            child,
            input,
            output,
        };
        client.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}})).await;
        let (reply, _) = client.response(1).await;
        assert_eq!(reply["result"]["protocolVersion"], 1);
        client
    }

    async fn send(&mut self, value: Value) {
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
        self.input.flush().await.unwrap();
    }

    async fn response(&mut self, id: i64) -> (Value, String) {
        let mut text = String::new();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(15), self.output.next_line())
                .await
                .expect("ACP response within 15s")
                .unwrap()
                .expect("ACP connection stayed open");
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["method"] == "session/update" {
                let update = &value["params"]["update"];
                if update["sessionUpdate"] == "agent_message_chunk" {
                    text.push_str(update["content"]["text"].as_str().unwrap_or_default());
                }
            }
            if value["id"] == id {
                return (value, text);
            }
        }
    }

    async fn new_session(&mut self) -> String {
        self.send(json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}))
            .await;
        let (reply, _) = self.response(2).await;
        reply["result"]["sessionId"].as_str().unwrap().to_owned()
    }

    async fn prompt(&mut self, id: i64, session: &str, text: &str) {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":text}]}})).await;
    }

    async fn terminate(&mut self) {
        self.child.kill().await.unwrap();
        self.child.wait().await.unwrap();
    }
}

fn text_reply(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}})
    )
}

#[tokio::test]
async fn reconnect_resumes_the_same_session_without_replaying_old_output() {
    let (endpoint, mut requests, server) = common::endpoint(vec![
        (200, text_reply("first answer")),
        (200, text_reply("second answer")),
    ])
    .await;
    let root = tempfile::tempdir().unwrap();
    let mut first = Client::start(root.path(), &endpoint).await;
    let session = first.new_session().await;
    first.prompt(3, &session, "first prompt").await;
    let (reply, text) = first.response(3).await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(text, "first answer");
    first.terminate().await;

    let mut second = Client::start(root.path(), &endpoint).await;
    second.send(json!({"jsonrpc":"2.0","id":4,"method":"session/resume","params":{"sessionId":session}})).await;
    let (resumed, replayed) = second.response(4).await;
    assert_eq!(resumed["result"], json!({}));
    assert!(
        replayed.is_empty(),
        "resume must not replay previous assistant output"
    );
    second.prompt(5, &session, "second prompt").await;
    let (reply, text) = second.response(5).await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(text, "second answer");
    let _ = requests.recv().await.unwrap();
    let continuation = requests.recv().await.unwrap();
    let messages = continuation["messages"].to_string();
    assert!(messages.contains("first prompt"));
    assert!(messages.contains("first answer"));
    assert!(messages.contains("second prompt"));
    second.terminate().await;
    server.await.unwrap();
}

#[tokio::test]
async fn provider_failure_settles_and_the_session_accepts_a_later_prompt() {
    let (endpoint, _requests, server) = common::endpoint(vec![
        (
            400,
            json!({"error":{"message":"fixture rejection"}}).to_string(),
        ),
        (200, text_reply("recovered")),
    ])
    .await;
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), &endpoint).await;
    let session = client.new_session().await;
    client.prompt(3, &session, "fail this turn").await;
    let (failed, text) = client.response(3).await;
    assert!(
        failed["error"].is_object(),
        "provider failure must be reported: {failed}"
    );
    assert!(text.is_empty());
    client.prompt(4, &session, "recover this turn").await;
    let (reply, text) = client.response(4).await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(text, "recovered");
    client.terminate().await;
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_settles_a_stalled_provider_and_allows_continuation() {
    // A handshake, not a sleep, proves the first request reached the provider.
    // Keep that response incomplete until the client observes cancellation.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (ready, received) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut ready = Some(ready);
        let mut released = Some(released);
        for index in 0..2 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                assert!(headers.len() < 65_536);
                stream.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
            }
            let headers = String::from_utf8(headers).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            if index == 0 {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100\r\n\r\n").await.unwrap();
                ready.take().unwrap().send(()).unwrap();
                released.take().unwrap().await.unwrap();
                continue;
            }
            let reply = text_reply("after cancellation");
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
        }
    });
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), &endpoint).await;
    let session = client.new_session().await;
    client.prompt(3, &session, "wait on provider").await;
    tokio::time::timeout(Duration::from_secs(15), received)
        .await
        .unwrap()
        .unwrap();
    client
        .send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}))
        .await;
    let (reply, _) = client.response(3).await;
    assert_eq!(reply["result"]["stopReason"], "cancelled");
    release.send(()).unwrap();
    client
        .prompt(4, &session, "continue after cancellation")
        .await;
    let (reply, text) = client.response(4).await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(text, "after cancellation");
    client.terminate().await;
    server.await.unwrap();
}
