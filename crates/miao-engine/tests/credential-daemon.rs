//! The engine's daemon credential source, end to end: a real daemon over a
//! real unix socket, with the token endpoint served locally.
#![cfg(unix)]

use miao_credential::client;
use miao_credential::daemon::Daemon;
use miao_credential::profile;
use miao_engine::credential::Source;
use rusqlite::Connection;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

fn setup_db(dir: &std::path::Path, expires_in_ms: u64, refresh: &str) -> PathBuf {
    let path = dir.join("miao.db");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT)",
            [],
        )
        .unwrap();
    let expires = miao_credential::daemon::now_ms() + expires_in_ms;
    connection
        .execute(
            "INSERT INTO credential VALUES ('cred_1','openai','Work', ?1)",
            rusqlite::params![format!(
                r#"{{"type":"oauth","access":"a1","refresh":"{refresh}","expires":{expires},"methodID":"chatgpt-browser","metadata":{{"accountID":"acct"}}}}"#
            )],
        )
        .unwrap();
    path
}

fn token_server(body: &'static str) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let payload = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(payload.as_bytes());
        let _ = stream.flush();
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn daemon_source_loads_and_rotates_inside_the_margin() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(dir.path(), 10_000, "r1");
    let issuer = token_server(
        r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600,"id_token":"jwt"}"#,
    );
    let profile = profile::Profile {
        issuer: issuer.clone(),
        ..profile::openai()
    };

    let socket = dir.path().join("credential.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = Arc::new(
        Daemon::new(db.clone(), profile, "miao-engine/test".into()).with_margin_ms(60_000),
    );
    tokio::spawn(daemon.serve(listener));
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    // The engine path: Source::Daemon::load once per provider turn.
    let source = Source::Daemon {
        socket: socket.clone(),
        id: "cred_1".into(),
        integration: "openai".into(),
    };
    let _credential = source.load().await.unwrap();
    // The daemon refreshed inside the margin before handing the value over:
    // the stored row already carries the rotated tokens.
    let stored = Connection::open(&db).unwrap();
    let value: String = stored
        .query_row("SELECT value FROM credential WHERE id='cred_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(value.contains("\"access\":\"a2\""), "{value}");
    assert!(value.contains("\"refresh\":\"r2\""), "{value}");
    // A second turn re-reads the same fresh row without another token request
    // (the local endpoint accepts exactly one connection).
    source.load().await.unwrap();

    // Key-style sources still work beside it: an api-key row stays read-only.
    let connection = Connection::open(&db).unwrap();
    connection
        .execute(
            "INSERT INTO credential VALUES ('cred_key','openai','Key','{\"type\":\"key\",\"key\":\"sk-1\"}')",
            [],
        )
        .unwrap();
    drop(connection);
    let source = Source::Database {
        path: db.clone(),
        id: "cred_key".into(),
        integration: "openai".into(),
    };
    let credential = source.load().await.unwrap();
    let _ = credential;
    let _ = client::discover(&socket).await.unwrap();
}
