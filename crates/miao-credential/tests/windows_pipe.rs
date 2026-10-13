#![cfg(windows)]
use miao_credential::{client, daemon::Daemon, profile};
use rusqlite::Connection;
use serde_json::json;
use std::{sync::Arc, time::Duration};

async fn ready(pipe: &std::path::Path) {
    for _ in 0..50 {
        if client::discover(pipe).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("named pipe daemon did not become ready");
}

#[tokio::test]
async fn pipe_uses_the_same_protocol_and_ownership_guards_as_unix() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let sql = Connection::open(&db).unwrap();
    sql.execute("CREATE TABLE credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)",[]).unwrap();
    let future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 3600000;
    sql.execute("INSERT INTO credential VALUES('cred_pipe','openai','Pipe',?1,1,1)", [json!({"type":"oauth","methodID":"chatgpt-headless","access":"fixture","refresh":"fixture-refresh","expires":future}).to_string()]).unwrap();
    let pipe = std::path::PathBuf::from(format!(
        r"\\.\pipe\miao-credential-test-{}",
        uuid::Uuid::new_v4()
    ));
    let daemon = Arc::new(Daemon::new(db.clone(), profile::openai(), "test".into()));
    let name = pipe.clone();
    let task = tokio::spawn(async move { daemon.bind_and_serve(&name).await });
    ready(&pipe).await;
    let reply = client::request(
        &pipe,
        json!({"id":1,"op":"adopt","credential_id":"cred_pipe","integration":"openai"}).to_string(),
    )
    .await
    .unwrap();
    assert!(reply.get("ok").is_some(), "{reply}");
    let value = client::get(&pipe, "cred_pipe", "openai").await.unwrap();
    assert_eq!(value["access"], "fixture");
    assert_eq!(
        value["metadata"]["miaoCredentialSocket"],
        pipe.to_str().unwrap()
    );
    assert!(sql
        .execute("DELETE FROM credential WHERE id='cred_pipe'", [])
        .is_err());
    assert!(matches!(
        client::get(&pipe, "cred_pipe", "other").await,
        Err(miao_credential::Error::Integration)
    ));
    let second = Arc::new(Daemon::new(db, profile::openai(), "test".into()));
    let other = std::path::PathBuf::from(format!(
        r"\\.\pipe\miao-credential-test-{}",
        uuid::Uuid::new_v4()
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(1), second.bind_and_serve(&other))
            .await
            .unwrap()
            .is_err()
    );
    task.abort();
}
