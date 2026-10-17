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
    client::request(
        &socket,
        serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"})
            .to_string(),
    )
    .await
    .unwrap();
    socket
}

#[tokio::test]
async fn get_returns_a_fresh_row_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(dir.path(), 3_600_000, "r1");
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
    let db = setup_db(dir.path(), 10_000, "r1");
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
        let socket = dir.path().join("credential.sock");
        client::request(&socket, serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"}).to_string()).await.unwrap();
        socket
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
    let db = setup_db(dir.path(), 10_000, "r1");
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
        let socket = dir.path().join("credential.sock");
        client::request(&socket, serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"}).to_string()).await.unwrap();
        socket
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
async fn release_joins_rotation_and_returns_the_newest_tokens_to_the_broker() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(dir.path(), 10_000, "r1");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (finish, response) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            assert!(header.len() < 8192);
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
        }
        let header = String::from_utf8(header).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|length| length.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        assert!(length < 8192);
        stream.read_exact(&mut vec![0; length]).unwrap();
        started.send(()).unwrap();
        response
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let body = r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let socket = dir.path().join("credential.sock");
    let daemon = Arc::new(
        Daemon::new(
            db.clone(),
            profile::Profile {
                issuer: url,
                ..profile::openai()
            },
            USER_AGENT.into(),
        )
        .with_margin_ms(60_000),
    );
    tokio::spawn(daemon.serve(tokio::net::UnixListener::bind(&socket).unwrap()));
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    client::request(
        &socket,
        serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"})
            .to_string(),
    )
    .await
    .unwrap();
    let refresh = tokio::spawn({
        let socket = socket.clone();
        async move { client::refresh(&socket, "cred_1", "openai").await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    let mut release = tokio::spawn({
        let socket = socket.clone();
        async move {
            client::request(&socket, serde_json::json!({"id":2,"op":"release","credential_id":"cred_1","integration":"openai"}).to_string()).await
        }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut release)
            .await
            .is_err()
    );
    finish.send(()).unwrap();
    refresh.await.unwrap().unwrap();
    assert_eq!(release.await.unwrap().unwrap()["ok"]["status"], "released");
    server.join().unwrap();
    let value = miao_credential::store::load(&db, "cred_1", "openai").unwrap();
    assert_eq!(value["access"], "a2");
    assert_eq!(value["refresh"], "r2");
    assert_eq!(value["metadata"]["accountID"], "acct");
    assert!(value["metadata"].get("miaoCredentialSocket").is_none());
    assert_eq!(value["methodID"], "chatgpt-browser");
    assert!(matches!(
        client::refresh(&socket, "cred_1", "openai").await,
        Err(miao_credential::Error::NotRefreshable)
    ));
    // A retry is harmless, and the real product writer's SQL is unblocked.
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(env!("CARGO_BIN_EXE_miao-credential"))
            .args([
                "release",
                "--socket",
                socket.to_str().unwrap(),
                "--credential-id",
                "cred_1",
                "--integration",
                "openai",
            ])
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("r2"));
    Connection::open(&db)
        .unwrap()
        .execute(
            "UPDATE credential SET label='Product owned' WHERE id='cred_1'",
            [],
        )
        .unwrap();
}

#[tokio::test]
async fn refresh_rejection_is_reported_as_refresh_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(dir.path(), 10_000, "r1");
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
        let socket = dir.path().join("credential.sock");
        client::request(&socket, serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"}).to_string()).await.unwrap();
        socket
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
    let db = setup_db(dir.path(), 3_600_000, "r1");
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

#[tokio::test]
async fn explicit_refresh_contacts_the_issuer_even_before_expiry() {
    let dir = tempfile::tempdir().unwrap();
    let db = setup_db(dir.path(), 3_600_000, "r1");
    let (url, counter) = token_server(Arc::new(vec![(
        200,
        r#"{"access_token":"a2","refresh_token":"r2","expires_in":7200}"#.into(),
    )]));
    let socket = dir.path().join("forced.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = Arc::new(
        Daemon::new(
            db.clone(),
            profile::Profile {
                issuer: url,
                ..profile::openai()
            },
            USER_AGENT.to_owned(),
        )
        .with_margin_ms(0),
    );
    tokio::spawn(daemon.serve(listener));
    client::request(
        &socket,
        serde_json::json!({"id":1,"op":"adopt","credential_id":"cred_1","integration":"openai"})
            .to_string(),
    )
    .await
    .unwrap();
    assert_eq!(
        client::get(&socket, "cred_1", "openai").await.unwrap()["access"],
        "a1"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    let result = client::request(
        &socket,
        serde_json::json!({"id":2,"op":"refresh","credential_id":"cred_1","integration":"openai"})
            .to_string(),
    )
    .await
    .unwrap();
    assert!(
        result["ok"]["expires"].as_u64().unwrap() > miao_credential::daemon::now_ms() + 3_600_000
    );
    assert!(!result.to_string().contains("a2"));
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let updated = client::get(&socket, "cred_1", "openai").await.unwrap();
    assert_eq!(updated["access"], "a2");
    assert_eq!(updated["refresh"], "r2");
    assert_eq!(updated["metadata"]["accountID"], "acct");
    client::request(
        &socket,
        serde_json::json!({"id":3,"op":"release","credential_id":"cred_1","integration":"openai"})
            .to_string(),
    )
    .await
    .unwrap();
    assert_eq!(
        miao_credential::store::load(&db, "cred_1", "openai").unwrap()["access"],
        "a2"
    );
}
