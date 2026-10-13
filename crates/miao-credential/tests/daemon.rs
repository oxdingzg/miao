#![cfg(unix)]
//! End-to-end tests over the real unix socket with a real SQLite database and
//! a real (local) token endpoint: the same path a production turn takes.

use miao_credential::client;
use miao_credential::daemon::Daemon;
use miao_credential::profile;
use rusqlite::Connection;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const USER_AGENT: &str = "miao-credential/test";

/// Minimal HTTP responder: reads one request, answers with canned JSON.
/// Counts requests so tests can assert the critical region fired once.
fn token_server(responses: Arc<Vec<(u16, String)>>) -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let counter = Arc::new(AtomicUsize::new(0));
    let counter_clone = counter.clone();
    // A detached std thread: when a test's requests run out, the thread stays
    // parked in accept() and must not hold the tokio runtime open at shutdown.
    std::thread::spawn(move || {
        for response in responses.iter() {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let (status, body) = response;
            counter_clone.fetch_add(1, Ordering::SeqCst);
            let payload = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(payload.as_bytes());
            let _ = stream.flush();
        }
    });
    (format!("http://127.0.0.1:{port}"), counter)
}

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

async fn start_daemon(db: PathBuf, margin_ms: u64) -> PathBuf {
    let socket = db.parent().unwrap().join("credential.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = Arc::new(
        Daemon::new(db, profile::openai(), USER_AGENT.to_owned()).with_margin_ms(margin_ms),
    );
    tokio::spawn(daemon.serve(listener));
    // Give the accept loop a beat so a connect never races the bind.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    socket
}

#[tokio::test]
async fn get_returns_a_fresh_row_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(&dir.path(), 3_600_000, "r1");
    let socket = start_daemon(db.clone(), 60_000).await;

    let credential = client::get(&socket, "cred_1", "openai").await.unwrap();
    assert_eq!(credential["access"], "a1");
    // No refresh happened: the row is an hour from expiry.
    let stored = Connection::open(&db).unwrap();
    let value: String = stored
        .query_row("SELECT value FROM credential WHERE id='cred_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(value.contains("\"access\":\"a1\""));
}

#[tokio::test]
async fn get_refreshes_a_row_inside_the_margin() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(&dir.path(), 10_000, "r1");
    let (url, counter) = token_server(Arc::new(vec![(
        200,
        r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600,"id_token":"jwt"}"#.into(),
    )]));
    let profile = profile::Profile {
        issuer: url.clone(),
        ..profile::openai()
    };
    let socket = {
        let listener = tokio::net::UnixListener::bind(dir.path().join("credential.sock")).unwrap();
        let daemon = Arc::new(
            Daemon::new(db.clone(), profile, USER_AGENT.to_owned()).with_margin_ms(60_000),
        );
        tokio::spawn(daemon.serve(listener));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        dir.path().join("credential.sock")
    };

    let credential = client::get(&socket, "cred_1", "openai").await.unwrap();
    assert_eq!(credential["access"], "a2");

    let stored = Connection::open(&db).unwrap();
    let value: String = stored
        .query_row("SELECT value FROM credential WHERE id='cred_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&value).unwrap();
    assert_eq!(value["access"], "a2");
    assert_eq!(value["refresh"], "r2");
    // The rotation preserves what the daemon does not manage.
    assert_eq!(value["methodID"], "chatgpt-browser");
    assert_eq!(value["metadata"]["accountID"], "acct");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_refreshes_share_one_token_request() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(&dir.path(), 10_000, "r1");
    let (url, counter) = token_server(Arc::new(vec![
        (
            200,
            r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#.into(),
        ),
        (401, r#"{"error":"invalid_grant"}"#.into()),
    ]));
    let profile = profile::Profile {
        issuer: url.clone(),
        ..profile::openai()
    };
    let socket = {
        let listener = tokio::net::UnixListener::bind(dir.path().join("credential.sock")).unwrap();
        let daemon = Arc::new(
            Daemon::new(db.clone(), profile, USER_AGENT.to_owned()).with_margin_ms(60_000),
        );
        tokio::spawn(daemon.serve(listener));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        dir.path().join("credential.sock")
    };

    let first = client::refresh(&socket, "cred_1", "openai");
    let second = client::refresh(&socket, "cred_1", "openai");
    let (left, right) = tokio::join!(first, second);
    left.unwrap();
    right.unwrap();
    // One critical region, one token request: the second waiter re-read the
    // freshly stored row and returned without replaying the old refresh
    // token against the provider.
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn refresh_rejection_is_reported_as_refresh_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(&dir.path(), 10_000, "r1");
    let (url, counter) = token_server(Arc::new(vec![(401, r#"{"error":"invalid_grant"}"#.into())]));
    let profile = profile::Profile {
        issuer: url.clone(),
        ..profile::openai()
    };
    let socket = {
        let listener = tokio::net::UnixListener::bind(dir.path().join("credential.sock")).unwrap();
        let daemon = Arc::new(
            Daemon::new(db.clone(), profile, USER_AGENT.to_owned()).with_margin_ms(60_000),
        );
        tokio::spawn(daemon.serve(listener));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        dir.path().join("credential.sock")
    };

    let error = client::refresh(&socket, "cred_1", "openai")
        .await
        .unwrap_err();
    assert!(matches!(error, miao_credential::Error::RefreshRejected));
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    // The stored row is untouched after a rejected refresh.
    let stored = Connection::open(&db).unwrap();
    let value: String = stored
        .query_row("SELECT value FROM credential WHERE id='cred_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(value.contains("\"access\":\"a1\""));
}

#[tokio::test]
async fn integration_mismatch_and_missing_rows_map_to_wire_codes() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(&dir.path(), 3_600_000, "r1");
    let socket = start_daemon(db, 60_000).await;

    assert!(matches!(
        client::get(&socket, "cred_1", "anthropic").await,
        Err(miao_credential::Error::Integration)
    ));
    assert!(matches!(
        client::get(&socket, "cred_missing", "openai").await,
        Err(miao_credential::Error::Missing)
    ));

    let listing = client::discover(&socket).await.unwrap();
    assert_eq!(listing[0]["id"], "cred_1");
    assert_eq!(listing[0]["kind"], "oauth");
    // Discovery never carries secret material.
    assert!(listing[0].get("access").is_none());
}
