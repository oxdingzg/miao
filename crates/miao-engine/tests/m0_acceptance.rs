#![cfg(any(target_os = "macos", target_os = "linux"))]
mod common;
use serde_json::{json, Value};
use std::{collections::BTreeSet, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

fn sse(events: Vec<Value>) -> String {
    events
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect::<String>()
        + "data: [DONE]\n\n"
}

/// M0 acceptance: the engine runs a full tool turn and durable continuation
/// headlessly (no TUI), the stdio JSONL notifications and `export` JSONL
/// describe the same committed ledger, and the frozen lifecycle vocabulary is
/// observable end to end.
#[tokio::test]
async fn headless_stdio_and_export_describe_the_same_ledger() {
    let first = sse(vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"file\"}"}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ]);
    let last = sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
    ]);
    let (endpoint, _requests, server) = common::endpoint(vec![(200, first), (200, last)]).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "hello from workspace").unwrap();
    let db = dir.path().join("engine.db");
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
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
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    input
        .write_all(
            format!(
                "{}\n{}\n",
                json!({"id":1,"method":"subscribe","params":{"session_id":"s"}}),
                json!({"id":2,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"read the file"}}})
            )
            .as_bytes(),
        )
        .await
        .unwrap();

    let mut kinds = Vec::new();
    let mut stdio_seqs = BTreeSet::new();
    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(line) = output.next_line().await.unwrap() {
            let notification: Value = serde_json::from_str(&line).unwrap();
            if notification.get("error").is_some() {
                panic!("stdio request failed: {notification}");
            }
            if notification["method"] != "event" {
                continue;
            }
            let params = &notification["params"];
            stdio_seqs.insert(params["seq"].as_u64().unwrap());
            let kind = params["kind"].as_str().unwrap().to_string();
            let done = kind == "stop" || kind == "stop_failure";
            kinds.push(kind);
            if done {
                break;
            }
        }
    })
    .await
    .unwrap();

    input
        .write_all(format!("{}\n", json!({"id":3,"method":"shutdown"})).as_bytes())
        .await
        .unwrap();
    drop(input);
    assert!(tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    server.await.unwrap();

    for expected in [
        "session_start",
        "user_prompt_submit",
        "instructions_loaded",
        "pre_tool_use",
        "post_tool_use",
        "stop",
    ] {
        assert!(
            kinds.iter().any(|kind| kind == expected),
            "missing lifecycle event {expected} in {kinds:?}"
        );
    }

    let export = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["export", "--db", db.to_str().unwrap(), "--session", "s"])
        .output()
        .await
        .unwrap();
    assert!(export.status.success(), "export failed");
    let exported = String::from_utf8(export.stdout).unwrap();
    let export_seqs = exported
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["seq"]
                .as_u64()
                .unwrap()
        })
        .collect::<BTreeSet<_>>();
    assert!(
        stdio_seqs.is_subset(&export_seqs),
        "stdio events {stdio_seqs:?} are not all present in export {export_seqs:?}"
    );
}
