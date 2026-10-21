use axum::{
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use miao_engine::{
    model_routes::load,
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest},
    provider::{Provider, ProviderError},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn copilot_three_wires_load_device_token_and_derive_turn_headers() {
    let (send, mut seen) = mpsc::channel(16);
    let router = Router::new().fallback(move |headers: HeaderMap, Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            send.send((headers, body)).await.unwrap();
            (StatusCode::BAD_REQUEST, "fixture")
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    for wire in ["openai-chat", "openai-responses", "anthropic"] {
        let root = tempfile::tempdir().unwrap();
        let credential = root.path().join("auth.json");
        std::fs::write(&credential, json!({"github-copilot":{"type":"oauth","access":"","refresh":"device-token","expires":0}}).to_string()).unwrap();
        let manifest = root.path().join("routes.json");
        std::fs::write(&manifest, json!([{
            "id":"github-copilot/model","provider":wire,"model":"model","endpoint":endpoint,
            "credential":{"type":"legacy","path":credential,"integration":"github-copilot"},
            "auth":{"style":"copilot","headers":{"copilot-vision-request":"stale","anthropic-beta":"host-beta"}}
        }]).to_string()).unwrap();
        let owner: Arc<dyn Provider> =
            Arc::new(OpenAIChat::new(endpoint.clone(), "owner".into(), "model".into()).unwrap());
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let catalog = load(&manifest, &workspace, owner).await.unwrap().0;
        let selected = catalog.for_route("github-copilot/model").unwrap();
        for role in ["user", "assistant"] {
            let (progress, _receive) = mpsc::channel(16);
            let result = selected
                .stream(
                    ModelRequest {
                        system: "system".into(),
                        messages: vec![Message {
                            role: role.into(),
                            content: json!([{"type":"text","text":"hello"}]),
                            checkpoint: None,
                            recorded_at_ms: None,
                        }],
                        tools: vec![],
                    },
                    progress,
                    CancellationToken::new(),
                )
                .await;
            assert!(
                matches!(result, Err(ProviderError::Http(400))),
                "{wire} did not reach fixture"
            );
            let (headers, _body) = seen.recv().await.unwrap();
            assert_eq!(headers["authorization"], "Bearer device-token");
            assert_eq!(
                headers["x-initiator"],
                if role == "user" { "user" } else { "agent" }
            );
            assert!(!headers.contains_key("copilot-vision-request"));
            assert!(headers.contains_key("x-interaction-id"));
            assert_eq!(headers["openai-intent"], "conversation-edits");
            if wire == "anthropic" {
                assert_eq!(
                    headers["anthropic-beta"],
                    "host-beta,interleaved-thinking-2025-05-14"
                );
                assert!(!headers.contains_key("x-api-key"));
            }
        }
    }
    server.abort();
}
