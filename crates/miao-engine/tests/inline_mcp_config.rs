//! The host can hand MCP servers over inline instead of writing a temporary
//! file. This pins that the engine actually reads that environment variable:
//! a malformed manifest has to fail startup with its own message, which is only
//! reachable from the inline branch.

use std::process::Command;

fn engine(dir: &std::path::Path, servers: &str) -> std::process::Output {
    // Attaching MCP at all needs the workspace authority a policy grants; the
    // point of these cases is what happens after that gate opens.
    let policy = dir.join("policy.json");
    std::fs::write(&policy, r#"{"mode":"workspace","allow_mcp":true}"#).unwrap();
    Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["acp", "--db"])
        .arg(dir.join("engine.db"))
        .args(["--workspace"])
        .arg(dir)
        .args(["--model", "m", "--provider", "openai-chat", "--policy"])
        .arg(&policy)
        .env("MIAO_ENGINE_MCP_SERVERS", servers)
        // The credential is resolved before any host configuration is read, so
        // a fixture key is what lets startup reach the MCP branch at all.
        .env("OPENAI_API_KEY", "fixture-only")
        .output()
        .unwrap()
}

#[test]
fn a_malformed_inline_mcp_manifest_fails_startup_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let output = engine(dir.path(), "{not json");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("invalid inline MCP host config"),
        "the engine did not read the inline manifest: {stderr}"
    );
    assert!(!output.status.success());
}

#[test]
fn an_oversized_inline_mcp_manifest_is_refused_like_the_file_source() {
    let dir = tempfile::tempdir().unwrap();
    let padded = "x".repeat(65536);
    let servers = format!(r#"[{{"name":"fixture","argv":["node"],"env":{{"PAD":"{padded}"}}}}]"#);
    let output = engine(dir.path(), &servers);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("MCP config exceeds 64 KiB"),
        "the inline manifest was not bounded: {stderr}"
    );
    assert!(!output.status.success());
}
