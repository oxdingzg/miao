use miao_engine::{
    doctor::report,
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;
#[test]
fn diagnostics_without_database_require_no_credentials_or_provider() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .arg("doctor")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["database"].is_null());
    assert_eq!(report["platform"]["os"], std::env::consts::OS);
    let version = std::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        format!("miao-engine {}", report["version"].as_str().unwrap())
    );
}
#[tokio::test]
async fn readonly_inspection_during_ownership_does_not_reconcile_runs_or_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "private prompt is not diagnostic output".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.start_run("s", "r").await.unwrap();
    store
        .tool_dispatch(
            "s",
            "r",
            "r/call",
            "read_file",
            json!({"provider_id":"call","input":{"path":"file"}}),
        )
        .await
        .unwrap();
    let events = store.events("s", 0, 100).await.unwrap();
    let before = std::fs::read(&path).unwrap();
    let diagnostic = report(Some(&path)).unwrap();
    assert_eq!(diagnostic["database"]["integrity"]["ok"], true);
    assert_eq!(diagnostic["database"]["sessions"], 1);
    assert_eq!(diagnostic["database"]["runs"]["running"], 1);
    assert_eq!(diagnostic["database"]["tools"]["dispatched"], 1);
    assert_eq!(diagnostic["database"]["inputs"]["pending"], 1);
    assert!(!serde_json::to_string(&diagnostic)
        .unwrap()
        .contains("private prompt"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), events.len());
}
#[test]
fn diagnostic_rejects_unrelated_future_and_missing_databases_without_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.db");
    assert!(report(Some(&missing)).is_err());
    assert!(!missing.exists());
    let unrelated = dir.path().join("other.db");
    let conn = rusqlite::Connection::open(&unrelated).unwrap();
    conn.execute_batch("CREATE TABLE private(value TEXT);INSERT INTO private VALUES('secret')")
        .unwrap();
    drop(conn);
    let before = std::fs::read(&unrelated).unwrap();
    assert!(report(Some(&unrelated)).is_err());
    assert_eq!(before, std::fs::read(&unrelated).unwrap());
    let future = dir.path().join("future.db");
    let conn = rusqlite::Connection::open(&future).unwrap();
    conn.execute_batch("PRAGMA application_id=1296646469;PRAGMA user_version=7")
        .unwrap();
    drop(conn);
    assert!(report(Some(&future)).is_err());
}
