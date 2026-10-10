use miao_engine::{
    approval::now_ms,
    credential::{Credential, Source},
    openai_responses::{OpenAIResponses, Profile},
    protocol::{Message, ModelRequest},
    provider::{Provider, ProviderError},
};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

fn request() -> ModelRequest {
    ModelRequest {
        system: "fixture instructions".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hello"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    }
}
fn value(access: &str, account: &str) -> String {
    json!({"type":"oauth","access":access,"refresh":"never_written_back","expires":now_ms()+60_000,"metadata":{"accountID":account}}).to_string()
}

#[tokio::test]
async fn subscription_profile_rereads_rotated_snapshot_and_maps_account_headers_without_writeback()
{
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credentials.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO credential VALUES('id','openai','default',?1)",
        [value("first_token", "first_account")],
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for (token, account) in [
            ("first_token", "first_account"),
            ("second_token", "second_account"),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
            }
            let headers = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(headers.contains(&format!("authorization: bearer {token}")));
            assert!(headers.contains(&format!("chatgpt-account-id: {account}")));
            assert!(headers.contains("originator: miao"));
            assert!(headers.contains("user-agent: miao-engine/"));
            let length = headers
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length: ")
                        .and_then(|v| v.parse::<usize>().ok())
                })
                .unwrap();
            let mut bytes = vec![0; length];
            socket.read_exact(&mut bytes).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["store"], false);
            assert_eq!(body["instructions"], "fixture instructions");
            assert!(!body.to_string().contains(token));
            let body=[json!({"type":"response.created","response":{"id":"r"}}),json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{}}})].iter().map(|e|format!("data: {e}\n\n")).collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let source = Source::Database {
        path: path.clone(),
        id: "id".into(),
        integration: "openai".into(),
    };
    let provider =
        OpenAIResponses::with_source(endpoint, source, "fixture".into(), Profile::Subscription)
            .unwrap();
    for index in 0..2 {
        if index == 1 {
            conn.execute(
                "UPDATE credential SET value=?1 WHERE id='id'",
                [value("second_token", "second_account")],
            )
            .unwrap();
        }
        let before: String = conn
            .query_row("SELECT value FROM credential WHERE id='id'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let (send, _receive) = mpsc::channel(64);
        provider
            .stream(request(), send, CancellationToken::new())
            .await
            .unwrap();
        let after: String = conn
            .query_row("SELECT value FROM credential WHERE id='id'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(before, after);
    }
    server.await.unwrap();
}

#[tokio::test]
async fn wrong_authentication_profile_is_rejected_before_network() {
    let provider = OpenAIResponses::with_source(
        "http://127.0.0.1:1/unused".into(),
        Source::Static(Credential::key("fixture".into())),
        "fixture".into(),
        Profile::Subscription,
    )
    .unwrap();
    let (send, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(request(), send, CancellationToken::new())
            .await,
        Err(ProviderError::AuthProfile)
    ));
    let provider = OpenAIResponses::with_source(
        "http://127.0.0.1:1/unused".into(),
        Source::Static(Credential::token("fixture".into(), None)),
        "fixture".into(),
        Profile::Api,
    )
    .unwrap();
    let (send, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(request(), send, CancellationToken::new())
            .await,
        Err(ProviderError::AuthProfile)
    ));
}
