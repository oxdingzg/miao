use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn run(
    workspace: &std::path::Path,
    manifest: &std::path::Path,
    input: &[Value],
) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["serve", "--db"])
        .arg(workspace.join("engine.db"))
        .arg("--workspace")
        .arg(workspace)
        .args([
            "--model",
            "default",
            "--provider",
            "openai-chat",
            "--model-routes-config",
        ])
        .arg(manifest)
        .env("OPENAI_API_KEY", "PRIMARY_NEVER_PRINT")
        .env("MIAO_TEST_ROUTE_KEY", "ROUTE_NEVER_PRINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in input {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn cli_registers_routes_and_catalog_exposes_only_selection_metadata() {
    let host = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manifest = host.path().join("routes.json");
    std::fs::write(
        &manifest,
        json!([{
            "id":"account-two/shared", "provider":"openai-chat", "model":"shared",
            "endpoint":"http://127.0.0.1:1/private-endpoint",
            "credential":{"type":"environment","key":"MIAO_TEST_ROUTE_KEY"}
        }])
        .to_string(),
    )
    .unwrap();
    let output = run(
        workspace.path(),
        &manifest,
        &[
            json!({"id":1,"method":"model_catalog"}),
            json!({"id":2,"method":"initialize","params":{"session_id":"s","title":"route"}}),
            json!({"id":3,"method":"select_model","params":{"session_id":"s","binding":{"route_id":"account-two/shared","protocol":"openai-chat","model":"shared"}}}),
            json!({"id":4,"method":"snapshot","params":{"session_id":"s"}}),
            json!({"id":5,"method":"shutdown"}),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("NEVER_PRINT"));
    assert!(!stdout.contains("private-endpoint"));
    let responses: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        responses[0]["result"],
        json!([
            {"route_id":null,"protocol":"openai-chat","model":"default"},
            {"route_id":"account-two/shared","protocol":"openai-chat","model":"shared"},
        ])
    );
    assert_eq!(responses[2]["result"]["changed"], true);
    assert_eq!(
        responses[3]["result"]["model_selection"]["route_id"],
        "account-two/shared"
    );
}

#[test]
fn product_sized_catalogs_are_complete_and_still_bounded() {
    let host = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manifest = host.path().join("routes.json");
    let entries = (0..100).map(|index| json!({
        "id":format!("product/model-{index}"),"provider":"openai-chat","model":format!("remote-{index}"),
        "endpoint":"http://127.0.0.1:1/chat/completions",
        "credential":{"type":"environment","key":"MIAO_TEST_ROUTE_KEY"}
    })).collect::<Vec<_>>();
    std::fs::write(&manifest, serde_json::to_vec(&entries).unwrap()).unwrap();
    let output = run(
        workspace.path(),
        &manifest,
        &[
            json!({"id":1,"method":"model_catalog"}),
            json!({"id":2,"method":"shutdown"}),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let first: Value = serde_json::from_str(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["result"].as_array().unwrap().len(), 101);
    let too_many = (0..=miao_engine::model_catalog::MAX_ROUTES)
        .map(|index| {
            json!({
                "id":format!("product/model-{index}"),"provider":"openai-chat","model":"remote",
                "credential":{"type":"environment","key":"MIAO_TEST_ROUTE_KEY"}
            })
        })
        .collect::<Vec<_>>();
    std::fs::write(&manifest, serde_json::to_vec(&too_many).unwrap()).unwrap();
    let output = run(workspace.path(), &manifest, &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("exceeds 1024 entries"));
}

#[test]
fn workspace_owned_oversized_and_unknown_manifests_are_refused() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join("routes.json");
    std::fs::write(&path, "[]").unwrap();
    let output = run(workspace.path(), &path, &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside model-writable workspace"));
    let host = tempfile::tempdir().unwrap();
    let path = host.path().join("routes.json");
    std::fs::write(&path, " ".repeat(1024 * 1024 + 1)).unwrap();
    let output = run(workspace.path(), &path, &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("exceeds 1 MiB"));
    std::fs::write(&path, json!([{"id":"x", "provider":"openai-chat", "model":"shared", "credential":{"type":"environment","key":"MIAO_TEST_ROUTE_KEY"},"unexpected":"secret"}]).to_string()).unwrap();
    let output = run(workspace.path(), &path, &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid Model routes host config"));
}
