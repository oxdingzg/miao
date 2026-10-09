#![cfg(any(target_os = "macos", target_os = "linux"))]
mod common;
use serde_json::json;
use std::process::Stdio;
use tokio::{io::AsyncWriteExt, process::Command};

#[tokio::test]
async fn engine_hard_exit_closes_lifeline_and_stops_ordinary_descendants() {
    let tool = json!({"argv":["/bin/sh","-c","(while :; do printf x >> heartbeat; sleep 0.02; done) & wait"],"timeout_ms":120000});
    let body=[json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"run_command","arguments":tool.to_string()}}]},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})].iter().map(|e|format!("data: {e}\n\n")).collect::<String>()+"data: [DONE]\n\n";
    let (endpoint, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let policy = dir.path().join("policy.json");
    std::fs::write(&policy,json!({"mode":"workspace","allow_process":true,"rules":[{"tool":"*","path":"**","decision":"allow"}]}).to_string()).unwrap();
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
            policy.to_str().unwrap(),
        ])
        .env("OPENAI_API_KEY", "fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(format!("{}\n",json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"execute"}}})).as_bytes()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !workspace.join("heartbeat").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    child.kill().await.unwrap();
    drop(input);
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let bytes = std::fs::metadata(workspace.join("heartbeat"))
        .unwrap()
        .len();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    assert_eq!(
        std::fs::metadata(workspace.join("heartbeat"))
            .unwrap()
            .len(),
        bytes
    );
    server.await.unwrap();
}
