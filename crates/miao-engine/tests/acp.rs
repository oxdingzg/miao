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

/// An engine approval is surfaced as `session/request_permission`; the client's
/// grant resolves it and the tool runs, ending the turn normally.
#[tokio::test]
async fn routes_an_approval_through_request_permission() {
    let first = sse(vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"file\"}"}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ]);
    let last = sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
    ]);
    let (endpoint, _requests, _server) = common::endpoint(vec![(200, first), (200, last)]).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let policy = dir.path().join("policy.json");
    std::fs::write(
        &policy,
        r#"{"rules":[{"tool":"read_file","path":"file","decision":"ask"}]}"#,
    )
    .unwrap();
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
            "--policy",
            policy.to_str().unwrap(),
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
    read_response(&mut stdout, 1).await;
    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":dir.path().to_str().unwrap(),"mcpServers":[]}}),
    )
    .await;
    let created = read_response(&mut stdout, 2).await;
    let session = created["result"]["sessionId"].as_str().unwrap().to_string();
    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"read file"}]}}),
    )
    .await;

    let mut text = String::new();
    let mut asked = false;
    let mut tool_call = false;
    let mut tool_done = false;
    let stop = loop {
        let line = tokio::time::timeout(Duration::from_secs(15), stdout.next_line())
            .await
            .expect("approval turn within 15s")
            .unwrap()
            .expect("ACP stdout stayed open");
        let value: Value = serde_json::from_str(&line).unwrap();
        match value.get("method").and_then(Value::as_str) {
            Some("session/request_permission") => {
                asked = true;
                send(
                    &mut stdin,
                    json!({
                        "jsonrpc": "2.0",
                        "id": value["id"].clone(),
                        "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } },
                    }),
                )
                .await;
            }
            Some("session/update") => {
                let update = &value["params"]["update"];
                match update["sessionUpdate"].as_str() {
                    Some("agent_message_chunk") => {
                        text.push_str(update["content"]["text"].as_str().unwrap_or(""));
                    }
                    Some("tool_call") => {
                        assert_eq!(update["toolCallId"], "call");
                        assert_eq!(update["kind"], "read");
                        tool_call = true;
                    }
                    Some("tool_call_update") if update["status"] == "completed" => {
                        tool_done = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if value.get("id") == Some(&json!(3)) {
            break value["result"]["stopReason"].as_str().map(str::to_string);
        }
    };
    assert!(asked, "expected session/request_permission");
    assert!(tool_call, "expected a tool_call notification");
    assert!(tool_done, "expected a completed tool_call_update");
    assert!(text.contains("done"), "streamed text: {text:?}");
    assert_eq!(stop.as_deref(), Some("end_turn"));
}
