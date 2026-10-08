use serde_json::json;
use std::process::Command;

#[test]
fn credential_listing_needs_no_provider_key_and_contains_only_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE credential(id TEXT,integration_id TEXT,label TEXT,value TEXT)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO credential VALUES('cred_one','openai','default',?1)",
        [json!({"type":"key","key":"NEVER_PRINT_THIS_SECRET"}).to_string()],
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args(["credentials", "--credential-db", path.to_str().unwrap()])
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("NEVER_PRINT_THIS_SECRET"));
    let metadata: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(metadata["id"], "cred_one");
    assert_eq!(metadata["kind"], "key");
}
