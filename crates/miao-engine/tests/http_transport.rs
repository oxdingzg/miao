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
/// fixture provider, and return its `/rpc` URL plus the workspace guard.
async fn start(responses: Vec<(u16, String)>) -> (String, tempfile::TempDir) {
    let (endpoint, _requests, _server) = common::endpoint(responses).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "hello from workspace").unwrap();
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
    (format!("http://{address}/rpc"), dir)
}

async fn rpc(client: &reqwest::Client, url: &str, body: Value) -> Value {
    client
        .post(url)
        .bearer_auth(TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn rejects_missing_and_wrong_bearer_token() {
    let (url, _dir) = start(Vec::new()).await;
    let client = reqwest::Client::new();
    let body = json!({ "id": 1, "method": "events", "params": { "session_id": "s" } });
    let missing = client.post(&url).json(&body).send().await.unwrap();
    assert_eq!(missing.status(), 401);
    let wrong = client
        .post(&url)
        .bearer_auth("wrong")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
}

#[tokio::test]
async fn rejects_unknown_method_and_unknown_protocol() {
    let (url, _dir) = start(Vec::new()).await;
    let client = reqwest::Client::new();
    let unknown = client
        .post(&url)
        .bearer_auth(TOKEN)
        .json(&json!({ "id": 1, "method": "bogus", "params": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 400);
    let body: Value = unknown.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_request");

    let bad_protocol = client
        .post(&url)
        .bearer_auth(TOKEN)
        .header("miao-engine-protocol", "engine-http-9")
        .json(&json!({ "id": 1, "method": "events", "params": { "session_id": "s" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_protocol.status(), 400);
    let body: Value = bad_protocol.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unsupported_protocol");
}

/// A full tool turn (read_file -> final text) driven entirely over `POST /rpc`,
/// then the committed history read back through the same table.
#[tokio::test]
async fn serves_the_command_table_and_committed_history() {
    let first = sse(vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"file\"}"}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ]);
    let last = sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"finished"},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}),
    ]);
    let (url, _dir) = start(vec![(200, first), (200, last)]).await;
    let client = reqwest::Client::new();

    let admit = rpc(
        &client,
        &url,
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"read file"}}}),
    )
    .await;
    assert_eq!(admit["result"]["input_id"], "one");

    let mut kinds = Vec::new();
    for _ in 0..200 {
        let events = rpc(
            &client,
            &url,
            json!({"id":2,"method":"events","params":{"session_id":"s","after":0}}),
        )
        .await;
        kinds = events["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["kind"].as_str().unwrap().to_string())
            .collect();
        if kinds.iter().any(|kind| kind == "run.finished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(kinds.iter().any(|kind| kind == "run.finished"), "{kinds:?}");

    let history = rpc(
        &client,
        &url,
        json!({"id":3,"method":"history","params":{"session_id":"s","selected":true}}),
    )
    .await;
    let text = history["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "assistant")
        .flat_map(|message| message["content"].as_array().cloned().unwrap_or_default())
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str().map(str::to_string))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("finished"), "{text}");
}
