#![cfg(any(target_os = "macos", target_os = "linux"))]
mod common;
use serde_json::json;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn real_stdio_adapter_runs_sandboxed_tool_without_inheriting_provider_keys() {
    let first=[json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"run_command","arguments":serde_json::to_string(&json!({"argv":["/bin/sh","-c","printf '%s|%s' \"$OPENAI_API_KEY\" \"$ANTHROPIC_API_KEY\""]})).unwrap()}}]},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})].iter().map(|e|format!("data: {e}\n\n")).collect::<String>()+"data: [DONE]\n\n";
    let last = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]})
    );
    let (endpoint, _requests, server) = common::endpoint(vec![(200, first), (200, last)]).await;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let config = dir.path().join("policy.json");
    std::fs::write(&config,json!({"mode":"workspace","allow_process":true,"rules":[{"tool":"*","path":"**","decision":"allow"}]}).to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            workspace.to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            &endpoint,
            "--policy",
            config.to_str().unwrap(),
        ])
        .env("OPENAI_API_KEY", "parent-openai-fixture-key")
        .env("ANTHROPIC_API_KEY", "parent-anthropic-fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    input.write_all(format!("{}\n{}\n",json!({"id":1,"method":"subscribe","params":{"session_id":"s"}}),json!({"id":2,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"run"}}})).as_bytes()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut checked = false;
        while let Some(line) = output.next_line().await.unwrap() {
            let event: serde_json::Value = serde_json::from_str(&line).unwrap();
            if event["method"] == "event" && event["params"]["kind"] == "tool.completed" {
                assert_eq!(event["params"]["data"]["result"]["stdout"], "|");
                assert_eq!(event["params"]["data"]["result"]["exit_code"], 0);
                checked = true;
            }
            if event["method"] == "event" && event["params"]["kind"] == "run.finished" {
                assert_eq!(event["params"]["data"]["reason"], "completed");
                assert!(checked);
                break;
            }
            if event.get("error").is_some() {
                panic!("stdio request failed: {event}");
            }
        }
        assert!(checked);
    })
    .await
    .unwrap();
    input
        .write_all(format!("{}\n", json!({"id":3,"method":"shutdown"})).as_bytes())
        .await
        .unwrap();
    drop(input);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    server.await.unwrap();
}
