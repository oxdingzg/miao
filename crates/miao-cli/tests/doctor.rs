use std::process::Command;

#[test]
fn doctor_reports_version_routing_sandbox_and_dependencies() {
    let root = std::env::temp_dir().join(format!("miao-doctor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let config = root.join("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("miao.json"),
        r#"{"model":"fixture/model","sandbox":{"mode":"off"}}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_miao"))
        .args(["doctor", "--db"])
        .arg(root.join("engine.db"))
        .env("HOME", &root)
        .env("MIAO_CONFIG_DIR", &config)
        .env_remove("MIAO_CONFIG")
        .env_remove("MIAO_CONFIG_CONTENT")
        .env_remove("MIAO_SANDBOX")
        .current_dir(&root)
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let _ = std::fs::remove_dir_all(&root);
    assert!(output.status.success(), "{stderr}");
    assert!(stdout.starts_with("miao      "), "{stdout}");
    assert!(
        stdout.contains("routes    ") && stdout.contains("configured"),
        "routing has to be named: {stdout}"
    );
    assert!(
        stdout.contains("sandbox   disabled"),
        "the mode in effect has to show, not the platform default: {stdout}"
    );
    for dependency in ["git ", "pdftotext ", "pdftoppm "] {
        assert!(
            stdout.contains(&format!("{dependency}")),
            "a support report names each program it shells out to: {stdout}"
        );
    }
}
