use miao_engine::{
    catalog,
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;
use std::process::Command;

#[tokio::test]
async fn catalog_reads_live_storage_without_projecting_history_or_adopting_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize("s", "Retained title", "/workspace")
        .await
        .unwrap();
    store
        .message(
            "s",
            "user",
            json!([{"type":"text","text":"x".repeat(4 * 1024 * 1024)}]),
        )
        .await
        .unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "pending".into(),
            prompt: "stay pending".into(),
            delivery: Delivery::Queue,
            agent_references: Default::default(),
            command: None,
        })
        .await
        .unwrap();
    let before = store.events("s", 0, 100).await.unwrap().len();
    let result = catalog::read(&path, &["s".into(), "missing".into()], true)
        .await
        .unwrap();
    assert_eq!(result[0]["snapshot"]["title"], "Retained title");
    assert!(result[0]["snapshot"].get("messages").is_none());
    assert!(result[0]["snapshot"].get("pending").is_none());
    assert!(result[0]["usage"].is_object());
    assert!(result[1]["error"].is_string());
    assert!(serde_json::to_vec(&result).unwrap().len() < 10_000);
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), before);
    assert_eq!(
        store.pending_inputs("s", None, 10).await.unwrap()["inputs"][0]["id"],
        "pending"
    );

    // A reader coexists with the live writer but cannot create or mutate data.
    let reader = Store::open_reader(&path).await.unwrap();
    assert!(reader.ensure("forbidden").await.is_err());
    reader.close().await.unwrap();
    assert_eq!(
        store.snapshot("s").await.unwrap()["title"],
        "Retained title"
    );

    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "catalog",
            "--db",
            path.to_str().unwrap(),
            "--sessions",
            "[\"s\"]",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cli: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli[0]["snapshot"]["title"], "Retained title");
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), before);
    store.close().await.unwrap();
}

#[tokio::test]
async fn catalog_never_creates_a_missing_database_or_migrates_an_unrelated_one() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.db");
    assert!(catalog::read(&missing, &["s".into()], false).await.is_err());
    assert!(!missing.exists());
    let unrelated = dir.path().join("unrelated.db");
    let conn = rusqlite::Connection::open(&unrelated).unwrap();
    conn.execute_batch("CREATE TABLE existing(id TEXT); PRAGMA user_version=9999;")
        .unwrap();
    assert!(catalog::read(&unrelated, &["s".into()], false)
        .await
        .is_err());
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        9999
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='engine_session'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn old_catalog_metadata_survives_unavailable_usage_without_a_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "PRAGMA application_id=1296646469;
        CREATE TABLE engine_session(id TEXT PRIMARY KEY,title TEXT);
        INSERT INTO engine_session VALUES('old','Preserved title');
        CREATE TABLE engine_event(session_id TEXT,seq INTEGER,kind TEXT,data TEXT);
        CREATE TABLE engine_lineage(session_id TEXT,parent_session_id TEXT);",
    )
    .unwrap();
    let result = catalog::read(&path, &["old".into()], true).await.unwrap();
    assert_eq!(result[0]["snapshot"]["title"], "Preserved title");
    assert_eq!(
        result[0]["snapshot"]["created_at_ms"],
        serde_json::Value::Null
    );
    assert!(result[0]["usage_error"].is_string());
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('engine_session')",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        0
    );
}
