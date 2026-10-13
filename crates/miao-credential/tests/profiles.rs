#![cfg(unix)]
use miao_credential::{client, daemon::Daemon, profile};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn endpoint(fixtures: Vec<(&'static str, Value)>) -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    std::thread::spawn(move || {
        for (path, reply) in fixtures {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = header
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            assert!(request
                .lines()
                .next()
                .unwrap()
                .contains(&format!(" {path} ")));
            if request.starts_with("POST") {
                assert!(request
                    .to_lowercase()
                    .contains("content-type: application/json"));
                let body: Value =
                    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                assert!(body.get("client_id").is_some());
                if path.contains("token") {
                    assert!(
                        body.get("device_code").is_some() || body.get("refresh_token").is_some()
                    );
                }
            }
            if path.starts_with("/api/") {
                assert!(request
                    .to_lowercase()
                    .contains("authorization: bearer console-access"));
            }
            received.fetch_add(1, Ordering::SeqCst);
            let reply = reply.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).unwrap();
        }
    });
    (format!("http://{address}"), calls)
}

fn database(dir: &std::path::Path) -> std::path::PathBuf {
    let db = dir.join("db");
    Connection::open(&db).unwrap().execute("CREATE TABLE credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)",[]).unwrap();
    db
}

async fn login(socket: &std::path::Path, integration: &str) {
    let start = client::request(socket,json!({"id":1,"op":"login_start","integration":integration,"credential_id":"cred_profile","label":"Profile"}).to_string()).await.unwrap();
    assert!(start.get("ok").is_some(), "{start}");
    let handle = start["ok"]["handle"].as_str().unwrap();
    let wait = start["ok"]["interval_ms"].as_u64().unwrap();
    loop {
        let reply = client::request(
            socket,
            json!({"id":2,"op":"login_poll","handle":handle}).to_string(),
        )
        .await
        .unwrap();
        assert!(reply.get("ok").is_some(), "{reply}");
        if reply["ok"]["status"] == "complete" {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    }
}

#[tokio::test]
async fn console_uses_json_flow_and_preserves_sorted_org_metadata_on_refresh() {
    let (issuer, calls) = endpoint(vec![
        (
            "/auth/device/code",
            json!({"device_code":"console-device","user_code":"code","verification_uri_complete":"/verify","expires_in":900,"interval":1}),
        ),
        (
            "/auth/device/token",
            json!({"access_token":"console-access","refresh_token":"console-refresh","expires_in":3600}),
        ),
        (
            "/api/user",
            json!({"id":"account","email":"fixture@example.invalid"}),
        ),
        (
            "/api/orgs",
            json!([{"id":"z","name":"Zulu"},{"id":"a","name":"Alpha"}]),
        ),
        (
            "/auth/device/token",
            json!({"access_token":"rotated","refresh_token":"new-refresh","expires_in":3600}),
        ),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let db = database(dir.path());
    let socket = dir.path().join("s");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    // One daemon can serve multiple integrations without giving up its DB lease.
    let daemon = Arc::new(
        Daemon::new(db.clone(), profile::openai(), "test".into())
            .with_profile(profile::console(issuer.clone(), "fixture-client".into())),
    );
    let task = tokio::spawn(daemon.serve(listener));
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        login(&socket, "opencode"),
    )
    .await
    .unwrap();
    let value = client::get(&socket, "cred_profile", "opencode")
        .await
        .unwrap();
    assert_eq!(value["metadata"]["orgID"], "a");
    assert_eq!(value["metadata"]["server"], issuer);
    // Make expiry imminent without bypassing the owner guard.
    let mut due = value.clone();
    due["expires"] = 1.into();
    miao_credential::store::store_refreshed(&db, "cred_profile", "opencode", due).unwrap();
    let refreshed = client::get(&socket, "cred_profile", "opencode")
        .await
        .unwrap();
    assert_eq!(refreshed["access"], "rotated");
    assert_eq!(refreshed["metadata"]["orgName"], "Alpha");
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    task.abort();
}

#[tokio::test]
async fn copilot_device_token_is_non_expiring_and_never_calls_a_refresh_endpoint() {
    let (issuer, calls) = endpoint(vec![
        (
            "/login/device/code",
            json!({"device_code":"github-device","user_code":"code","verification_uri":"https://github.com/login/device","expires_in":900,"interval":1}),
        ),
        (
            "/login/oauth/access_token",
            json!({"access_token":"fixture-gh"}),
        ),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let db = database(dir.path());
    let socket = dir.path().join("s");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = Arc::new(Daemon::new(db, profile::copilot(issuer), "test".into()));
    let task = tokio::spawn(daemon.serve(listener));
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        login(&socket, "github-copilot"),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        let value = client::get(&socket, "cred_profile", "github-copilot")
            .await
            .unwrap();
        assert_eq!(value["expires"], 0);
        assert_eq!(value["methodID"], "github-copilot-device");
    }
    assert_eq!(
        client::discover(&socket).await.unwrap()[0]["expired"],
        false
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    task.abort();
}
