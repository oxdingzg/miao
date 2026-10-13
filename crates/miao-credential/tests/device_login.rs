#![cfg(unix)]
use base64::Engine;
use miao_credential::{client, daemon::Daemon, profile};
use rusqlite::Connection;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::Arc;

// Local HTTP fixture verifies all three paths, complete form bodies and
// server-side device secrets. No external account or real token is involved.
fn endpoint() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"chatgpt_account_id":"account"}"#);
        let authorized = json!({"access_token":"access", "refresh_token":"refresh", "expires_in":3600, "id_token":format!("fixture.{claims}.signature")}).to_string();
        let fixtures = [
            (
                "/api/accounts/deviceauth/usercode",
                r#"{"device_auth_id":"device-secret","user_code":"ABCD","interval":"1"}"#,
            ),
            (
                "/api/accounts/deviceauth/token",
                r#"{"authorization_code":"authorized","code_verifier":"verifier"}"#,
            ),
            ("/oauth/token", authorized.as_str()),
        ];
        for (path, body) in fixtures {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(boundary) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..boundary]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= boundary + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            assert!(request.starts_with(&format!("POST {path} ")));
            if path.ends_with("deviceauth/token") {
                assert!(request.contains("device-secret"));
            }
            if path == "/oauth/token" {
                assert!(request.contains("grant_type=authorization_code"));
                assert!(request.contains("code_verifier=verifier"));
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn device_flow_stays_in_daemon_and_persists_account_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("credential.db");
    Connection::open(&db).unwrap().execute("CREATE TABLE credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)", []).unwrap();
    let socket = dir.path().join("credential.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = Arc::new(Daemon::new(
        db.clone(),
        profile::Profile {
            issuer: endpoint(),
            ..profile::openai()
        },
        "miao/test".into(),
    ));
    let task = tokio::spawn(daemon.serve(listener));
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let started = client::request(
            &socket,
            json!({"id":1,"op":"login_start","credential_id":"cred_device","label":"Device"})
                .to_string(),
        )
        .await
        .unwrap();
        assert_eq!(started["ok"]["user_code"], "ABCD");
        assert!(!started.to_string().contains("device-secret"));
        let handle = started["ok"]["handle"].as_str().unwrap();
        let completed = client::request(
            &socket,
            json!({"id":2,"op":"login_poll","handle":handle}).to_string(),
        )
        .await
        .unwrap();
        assert_eq!(completed["ok"]["status"], "complete");
        assert!(!completed.to_string().contains("refresh"));
        let stored = client::get(&socket, "cred_device", "openai").await.unwrap();
        assert_eq!(stored["metadata"]["accountID"], "account");
        assert_eq!(stored["methodID"], "chatgpt-headless");
        assert_eq!(stored["access"], "access");
        let reused = client::request(
            &socket,
            json!({"id":3,"op":"login_poll","handle":handle}).to_string(),
        )
        .await
        .unwrap();
        assert_eq!(reused["error"]["code"], "login_rejected");
    })
    .await;
    task.abort();
    result.unwrap();
}

#[tokio::test]
async fn second_daemon_cannot_own_the_same_database_through_another_socket() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    Connection::open(&db).unwrap();
    let first = Arc::new(Daemon::new(db.clone(), profile::openai(), "test".into()));
    let a = tokio::net::UnixListener::bind(dir.path().join("a")).unwrap();
    let task = tokio::spawn(first.serve(a));
    // Discovery roundtrip establishes that the first daemon acquired its lease.
    client::request(
        &dir.path().join("a"),
        json!({"id":1,"op":"discover"}).to_string(),
    )
    .await
    .unwrap();
    let second = Arc::new(Daemon::new(db, profile::openai(), "test".into()));
    let b = tokio::net::UnixListener::bind(dir.path().join("b")).unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), second.serve(b))
        .await
        .unwrap();
    assert!(result.is_err());
    task.abort();
}
