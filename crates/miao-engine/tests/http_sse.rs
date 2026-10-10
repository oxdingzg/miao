mod common;
use miao_engine::{
    openai_chat::OpenAIChat, provider::Provider, runtime::Runtime, store::Store, tools::Tools,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

const TOKEN: &str = "test-token";

fn sse(events: Vec<Value>) -> String {
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    body
}

/// Start an in-process engine behind the HTTP transport with a deterministic
/// fixture provider, and return its base URL plus the workspace guard.
async fn start(responses: Vec<(u16, String)>) -> (String, tempfile::TempDir) {
    let (endpoint, _requests, _server) = common::endpoint(responses).await;
    let dir = tempfile::tempdir().unwrap();
    let provider: Arc<dyn Provider> =
        Arc::new(OpenAIChat::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap());
    let runtime = Runtime::new(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(miao_engine::http::serve(
        runtime.clone(),
        listener,
        TOKEN.into(),
    ));
    (format!("http://{address}"), dir)
}

#[tokio::test]
async fn events_requires_bearer() {
    let (base, _dir) = start(Vec::new()).await;
    let response = reqwest::Client::new()
        .get(format!("{base}/events"))
        .query(&[("session_id", "s")])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
}

/// A committed run streamed over SSE: the frames carry a strictly increasing and
/// unique durable `seq`, and the full turn is observable.
#[tokio::test]
async fn streams_committed_events_with_a_durable_cursor() {
    let reply = sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
    ]);
    let (base, _dir) = start(vec![(200, reply)]).await;
    let client = reqwest::Client::new();

    let mut stream = client
        .get(format!("{base}/events"))
        .bearer_auth(TOKEN)
        .query(&[("session_id", "s"), ("after", "0")])
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), 200);

    client
        .post(format!("{base}/rpc"))
        .bearer_auth(TOKEN)
        .json(&json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"hi"}}}))
        .send()
        .await
        .unwrap();

    let mut buffer = String::new();
    let mut seqs: Vec<u64> = Vec::new();
    let mut finished = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !finished && tokio::time::Instant::now() < deadline {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.chunk())
            .await
            .expect("SSE frame within 5s")
            .unwrap();
        let Some(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..end + 2).collect();
            let mut id = None;
            let mut data = None;
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("id: ") {
                    id = value.parse::<u64>().ok();
                }
                if let Some(value) = line.strip_prefix("data: ") {
                    data = Some(value.to_string());
                }
            }
            if let Some(id) = id {
                seqs.push(id);
            }
            if let Some(data) = data {
                let value: Value = serde_json::from_str(&data).unwrap();
                if value["kind"] == "run.finished" {
                    finished = true;
                }
            }
        }
    }
    assert!(finished, "did not receive run.finished over SSE");
    assert!(!seqs.is_empty(), "expected committed event frames");
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted, seqs,
        "durable seq cursors must be strictly increasing and unique"
    );
}
