use serde_json::json;
use std::process::{Command, Stdio};

#[test]
fn invalid_product_documents_stop_the_native_entry_with_source_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let file = root.path().join("miao.json");
    std::fs::write(&file, "[]").unwrap();
    for (index, source, origin, detail) in [
        (
            0,
            json!({"content":"null"}),
            "inline config".to_owned(),
            "config root must be an object",
        ),
        (
            1,
            json!({"content":"{ bad"}),
            "inline config".to_owned(),
            "line 1",
        ),
        (
            2,
            json!({"file":file}),
            file.display().to_string(),
            "config root must be an object",
        ),
        (
            3,
            json!({"dir":root.path()}),
            file.display().to_string(),
            "config root must be an object",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args([
                "serve",
                "--provider",
                "openai-chat",
                "--model",
                "fixture",
                "--endpoint",
                "http://127.0.0.1:9",
            ])
            .arg("--workspace")
            .arg(&workspace)
            .arg("--db")
            .arg(root.path().join(format!("engine-{index}.db")))
            .arg("--config-sources")
            .arg(json!([source]).to_string())
            .env("OPENAI_API_KEY", "offline-fixture-only")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "invalid product configuration was accepted"
        );
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains(&origin), "{error}");
        assert!(error.contains(detail), "{error}");
    }
}
