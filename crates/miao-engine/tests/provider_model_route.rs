use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest},
    provider::Provider,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

type Requests = Arc<Mutex<Vec<(String, String)>>>;

#[tokio::test]
async fn selected_model_changes_the_real_request_without_mutating_the_shared_route() {
    let requests = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let router = Router::new().route("/chat/completions", post(
        |State(requests): State<Requests>, headers: HeaderMap, Json(body): Json<Value>| async move {
            let model = body["model"].as_str().unwrap().to_owned();
            let authorization = headers["authorization"].to_str().unwrap().to_owned();
            requests.lock().await.push((model.clone(), authorization));
            (
                [("content-type", "text/event-stream")],
                format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":"fixture","model":model,"choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":"stop"}]})),
            )
        }
    )).with_state(requests.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let shared = OpenAIChat::new(endpoint, "fixture-only".into(), "default-model".into()).unwrap();
    for invalid in ["".to_owned(), "invalid\nmodel".to_owned(), "x".repeat(513)] {
        assert!(shared.for_model(&invalid).is_none());
    }
    let selected = shared.for_model("selected-model").unwrap();
    assert_eq!(selected.identity().unwrap().model, "selected-model");
    assert_eq!(shared.identity().unwrap().model, "default-model");
    assert_eq!(selected.protected_resources(), shared.protected_resources());
    for provider in [selected.as_ref(), &shared as &dyn Provider] {
        let (progress, _received) = mpsc::channel(16);
        let reply = provider
            .stream(
                ModelRequest {
                    system: "system".into(),
                    messages: vec![Message {
                        role: "user".into(),
                        content: json!([{"type":"text","text":"request"}]),
                        checkpoint: None,
                        recorded_at_ms: None,
                    }],
                    tools: vec![],
                },
                progress,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(provider.reply_identity(&reply), provider.identity());
    }
    assert_eq!(
        requests.lock().await.as_slice(),
        &[
            ("selected-model".into(), "Bearer fixture-only".into()),
            ("default-model".into(), "Bearer fixture-only".into()),
        ]
    );
    server.abort();
}
