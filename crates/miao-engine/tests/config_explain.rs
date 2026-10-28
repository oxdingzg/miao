use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn native_explanation_reads_stdin_preserves_precedence_and_redacts_overridden_values() {
    let root = tempfile::tempdir().unwrap();
    let global = root.path().join("global.json");
    let project = root.path().join("project.jsonc");
    std::fs::write(
        &global,
        r#"{"model":"global/model","apiKey":"global-private"}"#,
    )
    .unwrap();
    std::fs::write(
        &project,
        "// project\n{\"model\":\"project/model\",\"apiKey\":\"project-private\",}",
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["config", "explain", "--config-sources", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!([{"file":global},{"file":project}])
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("global-private"));
    assert!(!text.contains("project-private"));
    let value: Value = serde_json::from_str(&text).unwrap();
    let row = value["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["path"] == json!(["model"]))
        .unwrap();
    assert_eq!(row["value"], "project/model");
    assert_eq!(row["origin"], project.to_str().unwrap());
    assert_eq!(row["overridden"][0]["value"], "global/model");
    assert_eq!(row["overridden"][0]["origin"], global.to_str().unwrap());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    assert_eq!(
        std::fs::read_to_string(global).unwrap(),
        r#"{"model":"global/model","apiKey":"global-private"}"#
    );
}

#[test]
fn directory_discovery_and_source_errors_work_without_provider_configuration() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("miao.json");
    std::fs::write(&file, r#"{"model":"fixture/model"}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["config", "explain", "--config-dir"])
        .arg(root.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["sources"][0]["origin"], file.to_str().unwrap());
    std::fs::write(&file, "false").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["config", "explain", "--config-dir"])
        .arg(root.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains(file.to_str().unwrap()));
    assert!(error.contains("config root must be an object"));
}

#[test]
fn invalid_command_options_are_rejected() {
    for args in [
        vec!["config"],
        vec!["config", "explain"],
        vec![
            "config",
            "explain",
            "--config-sources",
            "[]",
            "--config-dir",
            ".",
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("Usage: miao-engine config explain"));
    }
}
