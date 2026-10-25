//! Route-level wire parity with the product's AI SDK plugins: each test drives
//! the engine through a product route manifest and asserts the five-tuple the
//! plugin would have put on the wire (URL, auth, host headers, protocol body).
use axum::{
    http::{HeaderMap, StatusCode, Uri},
    Json, Router,
};
use miao_engine::{
    model_routes::load,
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest},
    provider::ProviderError,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MANTLE_KEY: &str = "MIAO_TEST_MANTLE_TOKEN";

fn manifest(root: &std::path::Path, routes: Value) -> (PathBuf, PathBuf) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let file = root.join("routes.json");
    std::fs::write(&file, routes.to_string()).unwrap();
    (file, workspace)
}

fn request() -> ModelRequest {
    ModelRequest {
        system: "system".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hello"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    }
}

/// Bedrock Mantle carries the plugin's two wires over one bearer token: the
/// safeguard models stay on Chat Completions, everything else uses Responses.
#[tokio::test]
async fn bedrock_mantle_routes_send_the_wire_the_plugin_selects() {
    let (send, mut seen) = mpsc::channel(8);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let send = send.clone();
            async move {
                send.send((uri.to_string(), headers, body)).await.unwrap();
                // Not retryable, so each stream sends exactly one request.
                (StatusCode::UNPROCESSABLE_ENTITY, "fixture")
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::env::set_var(MANTLE_KEY, "mantle-secret");
    let root = tempfile::tempdir().unwrap();
    let (file, workspace) = manifest(
        root.path(),
        json!([
            {
                "id": "amazon-bedrock/openai.gpt-oss-120b",
                "provider": "openai-responses",
                "model": "openai.gpt-oss-120b",
                "endpoint": format!("{base}/v1/responses"),
                "primary": true,
                "auth": {},
                "variants": [],
                "credential": {"type": "environment", "key": MANTLE_KEY}
            },
            {
                "id": "amazon-bedrock/openai.gpt-oss-safeguard-20b",
                "provider": "openai-chat",
                "model": "openai.gpt-oss-safeguard-20b",
                "endpoint": format!("{base}/v1/chat/completions"),
                "primary": false,
                "auth": {},
                "variants": [],
                "credential": {"type": "environment", "key": MANTLE_KEY}
            }
        ]),
    );
    let owner = Arc::new(OpenAIChat::new(base.clone(), "owner-key".into(), "owner".into()).unwrap());
    let catalog = load(&file, &workspace, owner).await.unwrap().0;
    for (route, path, model, field) in [
        (
            "amazon-bedrock/openai.gpt-oss-120b",
            "/v1/responses",
            "openai.gpt-oss-120b",
            "input",
        ),
        (
            "amazon-bedrock/openai.gpt-oss-safeguard-20b",
            "/v1/chat/completions",
            "openai.gpt-oss-safeguard-20b",
            "messages",
        ),
    ] {
        let (progress, _receive) = mpsc::channel(16);
        assert!(matches!(
            catalog
                .for_route(route)
                .unwrap()
                .stream(request(), progress, CancellationToken::new())
                .await,
            Err(ProviderError::Http(422))
        ));
        let (uri, headers, body) = seen.recv().await.unwrap();
        assert_eq!(uri, path);
        assert_eq!(headers["authorization"], "Bearer mantle-secret");
        assert_eq!(headers.get_all("authorization").iter().count(), 1);
        assert!(!headers.contains_key("api-key"));
        assert!(!headers.contains_key("x-goog-api-key"));
        assert_eq!(body["model"], model);
        // The two wires differ by body shape, not just by path.
        assert!(body[field].is_array(), "{route} body lacks a {field} array");
        assert!(body["stream"].as_bool().unwrap_or(false));
    }
    std::env::remove_var(MANTLE_KEY);
    server.abort();
}
