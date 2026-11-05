use std::process::Command;

#[test]
fn debug_config_names_a_dropped_key_and_keeps_the_read_successful() {
    let root = std::env::temp_dir().join(format!("miao-debug-config-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let config = root.join("miao.json");
    std::fs::write(
        &config,
        r#"{"model":"fixture/model","provvider":{"timeout":1}}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_miao"))
        .args(["debug", "config"])
        .env("MIAO_CONFIG_DIR", &root)
        .env_remove("MIAO_CONFIG")
        .env_remove("MIAO_CONFIG_CONTENT")
        .current_dir(&root)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&root);
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        output.status.success(),
        "an unknown key must not fail the read: {stderr}"
    );
    assert!(
        stdout.contains(&format!("config   {}", config.display())),
        "the source the engine reads has to be named: {stdout}"
    );
    assert!(
        stdout.contains("model = \"fixture/model\""),
        "the resolved value has to survive into the report: {stdout}"
    );
    assert!(
        stdout.contains("warning  unknown top-level key `provvider`")
            && stdout.contains("did you mean `provider`?"),
        "the dropped key needs its closest known key: {stdout}"
    );
}
