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
        (
            4,
            json!({"content":r#"{"sandbox":null}"#}),
            "inline config".to_owned(),
            "sandbox",
        ),
        (
            5,
            json!({"content":r#"{"lsp":null}"#}),
            "inline config".to_owned(),
            "lsp",
        ),
        (
            6,
            json!({"content":r#"{"sandbox":{"network":null}}"#}),
            "inline config".to_owned(),
            "sandbox.network",
        ),
        (
            7,
            json!({"content":r#"{"lsp":{"test":{"command":["test"],"disabled":"yes"}}}"#}),
            "inline config".to_owned(),
            "lsp.test.disabled",
        ),
        (
            8,
            json!({"content":r#"{"lsp":{"test":{"command":["test"],"disabled":null}}}"#}),
            "inline config".to_owned(),
            "lsp.test.disabled",
        ),
        (
            9,
            json!({"content":r#"{"lsp":{"test":{"command":["test"],"initialization":42}}}"#}),
            "inline config".to_owned(),
            "lsp.test.initialization",
        ),
        (
            10,
            json!({"content":r#"{"lsp":{"test":{"command":["test"],"initialization":null}}}"#}),
            "inline config".to_owned(),
            "lsp.test.initialization",
        ),
        (
            11,
            json!({"content":r#"{"lsp":{"test":{"command":["test"],"initialization":[]}}}"#}),
            "inline config".to_owned(),
            "lsp.test.initialization",
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
        // Rust's boxed string errors use Debug formatting, escaping Windows paths.
        assert!(
            error.contains(&origin) || error.contains(&origin.escape_debug().to_string()),
            "{error}"
        );
        assert!(error.contains(detail), "{error}");
    }
}
