use serde_json::json;

#[test]
fn cli_rejects_cross_route_bindings_and_raw_continuation_overrides_before_transport() {
    let dir = tempfile::tempdir().unwrap();
    for (provider, contract, reason) in [
        (
            "anthropic",
            json!({"model":"m","endpoint":"https://api.example/responses","authentication":"api","mode":"delta"}),
            "unsupported",
        ),
        (
            "openai-responses",
            json!({"model":"other","endpoint":"https://api.example/responses","authentication":"api","mode":"delta"}),
            "does not match",
        ),
        (
            "openai-responses",
            json!({"model":"m","endpoint":"https://api.example/responses","authentication":"api","mode":"delta","previous_response_id":"raw"}),
            "invalid Responses WebSocket",
        ),
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args(["serve", "--db"])
            .arg(dir.path().join(uuid::Uuid::new_v4().to_string()))
            .arg("--workspace")
            .arg(dir.path())
            .args([
                "--model",
                "m",
                "--provider",
                provider,
                "--endpoint",
                "https://api.example/responses",
                "--responses-websocket-contract",
            ])
            .arg(contract.to_string())
            .env("OPENAI_API_KEY", "fixture")
            .env("ANTHROPIC_API_KEY", "fixture")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(reason),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
