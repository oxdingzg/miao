use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn stdio_ack_export_and_exact_retry_use_committed_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let admission =
        json!({"input":{"session_id":"s","input_id":"one","prompt":"hello"},"resume":false});
    let requests = [
        json!({"id":1,"method":"admit","params":admission}),
        json!({"id":2,"method":"admit","params":admission}),
        json!({"id":3,"method":"events","params":{"session_id":"s","after":0}}),
        json!({"id":4,"method":"cancel","params":{"session_id":"s"}}),
        json!({"id":5,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let result = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap()["result"].clone();
    assert_eq!(result(1)["duplicate"], false, "{replies:?}");
    assert_eq!(result(2)["duplicate"], true);
    assert_eq!(result(3).as_array().unwrap().len(), 1);
    assert_eq!(result(3)[0]["kind"], "input.admitted");
    assert_eq!(result(4)["accepted"], false);
}

#[test]
fn version_uses_root_manifest_and_no_provider_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .arg("--version")
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("miao-engine {}", env!("MIAO_ENGINE_VERSION"))
    );
}
