use axum::{extract::Json, http::HeaderMap, routing::post, Router};
use miao_engine::{
    credential::{Credential, Source},
    openai_responses::{OpenAIResponses, Profile},
    protocol::{Delivery, Input, ModelRequest},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc, sync::Mutex, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn completed(output: Value) -> String {
    [
        json!({"type":"response.created","response":{"id":"r"}}),
        json!({"type":"response.completed","response":{"status":"completed","output":output,"usage":{"input_tokens":100,"output_tokens":10}}}),
    ].iter().map(|event| format!("data: {event}\n\n")).collect()
}

fn answer() -> String {
    completed(
        json!([{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}]),
    )
}

// Exercise real HTTP framing, recording only the cache header and JSON body.
async fn peer(
    responses: Vec<(u16, String)>,
) -> (
    String,
    mpsc::Receiver<(Value, Option<String>)>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let replies = Arc::new(Mutex::new(VecDeque::from(responses)));
    let (capture, requests) = mpsc::channel(32);
    let app = Router::new().route(
        "/responses",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let capture = capture.clone();
            let response = replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected request");
            async move {
                capture
                    .send((
                        body,
                        headers
                            .get("session-id")
                            .map(|value| value.to_str().unwrap().to_owned()),
                    ))
                    .await
                    .unwrap();
                (
                    axum::http::StatusCode::from_u16(response.0).unwrap(),
                    [("content-type", "text/event-stream")],
                    response.1,
                )
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, requests, server)
}

async fn admit(runtime: &Runtime, session: &str, input: &str) {
    let after = runtime
        .store()
        .events(session, 0, 1000)
        .await
        .unwrap()
        .last()
        .map_or(0, |event| event.seq);
    runtime
        .admit(
            Input {
                session_id: session.into(),
                input_id: input.into(),
                prompt: "read file".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let events = runtime.store().events(session, after, 1000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                assert!(events.iter().any(
                    |event| event.kind == "run.finished" && event.data["reason"] == "completed"
                ));
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn subscription_affinity_survives_retries_tools_and_runtime_restarts() {
    let tool = completed(
        json!([{"type":"function_call","call_id":"call","name":"read_file","arguments":"{\"path\":\"file\"}"}]),
    );
    let (url, mut requests, server) = peer(vec![
        (503, "busy".into()),
        (200, tool),
        (200, answer()),
        (200, answer()),
    ])
    .await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(
        OpenAIResponses::with_source(
            url,
            Source::Static(Credential::token("fixture".into(), None)),
            "model".into(),
            Profile::Subscription,
        )
        .unwrap(),
    );
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    admit(&runtime, "session-one", "first").await;
    runtime.shutdown().await;
    drop(runtime);
    let runtime = Runtime::new(store, provider, Tools::new(dir.path()).await.unwrap())
        .await
        .unwrap();
    admit(&runtime, "session-one", "second").await;
    runtime.shutdown().await;
    let mut captured = Vec::new();
    for _ in 0..4 {
        captured.push(requests.recv().await.unwrap());
    }
    let key = captured[0].0["prompt_cache_key"].as_str().unwrap();
    assert_eq!(key.len(), 64);
    assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
    for (body, header) in &captured {
        assert_eq!(body["prompt_cache_key"], key);
        assert_eq!(header.as_deref(), Some(key));
        assert_eq!(body["instructions"], captured[0].0["instructions"]);
        assert_eq!(body["tools"], captured[0].0["tools"]);
    }
    assert_eq!(
        captured[0].0, captured[1].0,
        "retry must preserve the complete request"
    );
    assert!(captured[2].0["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "function_call_output"));
    server.abort();
}

#[tokio::test]
async fn shared_provider_isolates_concurrent_sessions_and_does_not_leak_into_unscoped_calls() {
    let (url, mut requests, server) = peer(vec![(200, answer()); 3]).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(
        OpenAIResponses::with_source(
            url,
            Source::Static(Credential::token("fixture".into(), None)),
            "model".into(),
            Profile::Subscription,
        )
        .unwrap(),
    );
    let runtime = Runtime::new(
        store,
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    tokio::join!(
        admit(&runtime, "session-one", "first"),
        admit(&runtime, "session-two", "other-input")
    );
    runtime.shutdown().await;
    let first = requests.recv().await.unwrap();
    let second = requests.recv().await.unwrap();
    assert!(first.0["prompt_cache_key"].is_string());
    assert!(second.0["prompt_cache_key"].is_string());
    assert_ne!(first.0["prompt_cache_key"], second.0["prompt_cache_key"]);
    assert_eq!(first.1.as_deref(), first.0["prompt_cache_key"].as_str());
    assert_eq!(second.1.as_deref(), second.0["prompt_cache_key"].as_str());
    let (send, _receive) = mpsc::channel(64);
    provider
        .stream(
            ModelRequest {
                system: "standalone".into(),
                messages: vec![],
                tools: vec![],
            },
            send,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let direct = requests.recv().await.unwrap();
    assert!(direct.0.get("prompt_cache_key").is_none());
    assert!(direct.1.is_none());
    server.abort();
}

#[tokio::test]
async fn api_profile_uses_a_body_key_without_subscription_headers() {
    let (url, mut requests, server) = peer(vec![(200, answer())]).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(OpenAIResponses::new(url, "fixture".into(), "model".into()).unwrap());
    let runtime = Runtime::new(store, provider, Tools::new(dir.path()).await.unwrap())
        .await
        .unwrap();
    admit(&runtime, "会话", "first").await;
    runtime.shutdown().await;
    let (body, header) = requests.recv().await.unwrap();
    assert_eq!(body["prompt_cache_key"].as_str().unwrap().len(), 64);
    assert!(header.is_none());
    server.abort();
}

#[tokio::test]
async fn fork_lineage_preserves_cache_hints_after_restart_without_joining_unrelated_sessions() {
    let (url, mut requests, server) = peer(vec![(200, answer()); 4]).await;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("engine.db");
    let store = Store::open(&db).await.unwrap();
    let provider = Arc::new(OpenAIResponses::new(url, "fixture".into(), "model".into()).unwrap());
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    admit(&runtime, "parent", "parent-input").await;
    runtime.shutdown().await;
    drop(runtime);
    store.fork("parent", "child", None).await.unwrap();
    // Dropping the handle only starts worker teardown; wait for the file lease
    // to be released before testing restart persistence.
    store.close().await.unwrap();
    let store = Store::open(&db).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    admit(&runtime, "child", "child-input").await;
    runtime.shutdown().await;
    drop(runtime);
    store.fork("child", "grandchild", None).await.unwrap();
    let runtime = Runtime::new(store, provider, Tools::new(dir.path()).await.unwrap())
        .await
        .unwrap();
    tokio::join!(
        admit(&runtime, "grandchild", "grandchild-input"),
        admit(&runtime, "unrelated", "unrelated-input")
    );
    runtime.shutdown().await;
    let parent = requests.recv().await.unwrap().0;
    let child = requests.recv().await.unwrap().0;
    assert_eq!(parent["prompt_cache_key"], child["prompt_cache_key"]);
    let prefix = parent["input"].as_array().unwrap();
    assert_eq!(&child["input"].as_array().unwrap()[..prefix.len()], prefix);
    let tail = [
        requests.recv().await.unwrap().0,
        requests.recv().await.unwrap().0,
    ];
    assert_eq!(
        tail.iter()
            .filter(|body| body["prompt_cache_key"] == parent["prompt_cache_key"])
            .count(),
        1
    );
    server.abort();
}
