use miao_engine::{
    approval::now_ms,
    credential::{list_database, list_legacy, Credential, Error, Kind, Source},
};
use serde_json::json;

fn database(path: &std::path::Path, value: serde_json::Value) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO credential VALUES('cred_one','openai','default',?1)",
        [value.to_string()],
    )
    .unwrap();
}

#[tokio::test]
async fn readonly_database_binding_and_discovery_never_modify_or_serialize_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.db");
    database(&path, json!({"type":"key","key":"SECRET_FIXTURE_KEY"}));
    let before = std::fs::read(&path).unwrap();
    let source = Source::Database {
        path: path.clone(),
        id: "cred_one".into(),
        integration: "openai".into(),
    };
    let credential = source.load().await.unwrap();
    assert_eq!(credential.kind(), Kind::Key);
    assert!(!format!("{source:?} {credential:?}").contains("SECRET_FIXTURE_KEY"));
    let metadata = serde_json::to_value(list_database(&path).unwrap()).unwrap();
    assert_eq!(metadata[0]["id"], "cred_one");
    assert_eq!(metadata[0]["kind"], "key");
    assert!(!metadata.to_string().contains("SECRET_FIXTURE_KEY"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(matches!(
        Source::Database {
            path: path.clone(),
            id: "cred_one".into(),
            integration: "other".into()
        }
        .load()
        .await,
        Err(Error::Integration)
    ));
    let missing = dir.path().join("missing.db");
    assert!(list_database(&missing).is_err());
    assert!(!missing.exists());
}

#[tokio::test]
async fn oauth_expiry_and_legacy_schema_have_explicit_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    let value = json!({"openai":{"type":"oauth","access":"ACCESS_FIXTURE_SECRET","refresh":"REFRESH_FIXTURE_SECRET","expires":now_ms()-1,"accountId":"account"},"anthropic":{"type":"api","key":"KEY_FIXTURE_SECRET"}});
    std::fs::write(&file, value.to_string()).unwrap();
    let before = std::fs::read(&file).unwrap();
    assert!(matches!(
        Source::Legacy {
            path: file.clone(),
            integration: "openai".into()
        }
        .load()
        .await,
        Err(Error::Expired)
    ));
    assert_eq!(
        Source::Legacy {
            path: file.clone(),
            integration: "anthropic".into()
        }
        .load()
        .await
        .unwrap()
        .kind(),
        Kind::Key
    );
    let metadata = serde_json::to_value(list_legacy(&file).unwrap()).unwrap();
    assert!(metadata
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["kind"] == "oauth" && m["expired"] == true));
    for secret in [
        "ACCESS_FIXTURE_SECRET",
        "REFRESH_FIXTURE_SECRET",
        "KEY_FIXTURE_SECRET",
    ] {
        assert!(!metadata.to_string().contains(secret));
    }
    assert_eq!(std::fs::read(&file).unwrap(), before);
}

#[tokio::test]
async fn malformed_data_and_static_debug_do_not_echo_secret_material() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{SECRET_MALFORMED_INPUT").unwrap();
    let error = Source::Legacy {
        path: file,
        integration: "openai".into(),
    }
    .load()
    .await
    .unwrap_err();
    assert!(!error.to_string().contains("SECRET_MALFORMED_INPUT"));
    let source = Source::Static(Credential::token(
        "SECRET_ACCESS".into(),
        Some("SECRET_ACCOUNT".into()),
    ));
    assert!(!format!("{source:?}").contains("SECRET_ACCESS"));
    assert!(!format!("{source:?}").contains("SECRET_ACCOUNT"));
    assert!(matches!(
        Source::Static(Credential::key("bad\nheader".into()))
            .load()
            .await,
        Err(Error::Invalid)
    ));
}
