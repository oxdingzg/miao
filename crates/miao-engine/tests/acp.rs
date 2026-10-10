mod common;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command},
};

fn sse(events: Vec<Value>) -> String {
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    body
}

async fn send(stdin: &mut ChildStdin, value: Value) {
    stdin
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
}

async fn read_response(lines: &mut Lines<BufReader<ChildStdout>>, id: i64) -> Value {
    loop {
        let line = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
            .await
            .expect("ACP response within 15s")
            .unwrap()
            .expect("ACP stdout stayed open");
        let value: Value = serde_json::from_str(&line).unwrap();
        if value.get("id") == Some(&json!(id)) {
            return value;
        }
    }
}

/// The core ACP lifecycle against the real binary: initialize, a new session,
/// and a text turn streamed as `agent_message_chunk` until the prompt resolves.
#[tokio::test]
async fn drives_a_text_turn_over_acp() {
    let reply = sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"finished"},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
    ]);
    let (endpoint, _requests, _server) = common::endpoint(vec![(200, reply)]).await;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("engine.db");
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "acp",
            "--db",
            db.to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            &endpoint,
        ])
        .env("OPENAI_API_KEY", "fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();

    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}),
    )
    .await;
    let initialized = read_response(&mut stdout, 1).await;
    assert_eq!(initialized["result"]["protocolVersion"], 1);

    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":dir.path().to_str().unwrap(),"mcpServers":[]}}),
    )
    .await;
    let created = read_response(&mut stdout, 2).await;
    let session = created["result"]["sessionId"].as_str().unwrap().to_string();

    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"say hi"}]}}),
    )
    .await;

    let mut text = String::new();
    let stop = loop {
        let line = tokio::time::timeout(Duration::from_secs(15), stdout.next_line())
            .await
            .expect("prompt turn within 15s")
            .unwrap()
            .expect("ACP stdout stayed open");
        let value: Value = serde_json::from_str(&line).unwrap();
        if value.get("method") == Some(&json!("session/update")) {
            let update = &value["params"]["update"];
            if update["sessionUpdate"] == "agent_message_chunk" {
                text.push_str(update["content"]["text"].as_str().unwrap_or(""));
            }
        }
        if value.get("id") == Some(&json!(3)) {
            break value["result"]["stopReason"].as_str().map(str::to_string);
        }
    };
    assert!(text.contains("finished"), "streamed text: {text:?}");
    assert_eq!(stop.as_deref(), Some("end_turn"));
}
