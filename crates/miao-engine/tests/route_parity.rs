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
    openai_responses::OpenAIResponses,
    protocol::{Message, ModelRequest},
    provider::{Anthropic, ProviderError},
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MANTLE_KEY: &str = "MIAO_TEST_MANTLE_TOKEN";
const AZURE_KEY: &str = "MIAO_TEST_AZURE_KEY";
const VERTEX_KEY: &str = "MIAO_TEST_VERTEX_TOKEN";

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
    // The engine's default provider is launched from the primary route
    // (`product-routes.ts` copies its protocol, model and endpoint into the
    // engine options), so the fixture mirrors that launch rather than inventing
    // a different owner.
    let owner = Arc::new(
        OpenAIResponses::new(
            base.clone(),
            "owner-key".into(),
            "openai.gpt-oss-120b".into(),
        )
        .unwrap(),
    );
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

/// Azure OpenAI's Chat wire carries the deployment in the path and the API
/// version in a query the product route declares, authenticated with `api-key`
/// rather than a bearer token.
#[tokio::test]
async fn azure_chat_wire_matches_the_product_route() {
    let (send, mut seen) = mpsc::channel(8);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let send = send.clone();
            async move {
                send.send((uri.to_string(), headers, body)).await.unwrap();
                (StatusCode::UNPROCESSABLE_ENTITY, "fixture")
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::env::set_var(AZURE_KEY, "azure-secret");
    let root = tempfile::tempdir().unwrap();
    let (file, workspace) = manifest(
        root.path(),
        json!([
            {
                "id": "azure/gpt-4.1",
                "provider": "azure",
                "model": "prod-chat",
                "endpoint": format!("{base}/openai/v1/chat/completions"),
                "primary": true,
                "auth": {"query": {"api-version": "v1"}},
                "variants": [],
                "credential": {"type": "environment", "key": AZURE_KEY}
            }
        ]),
    );
    // The product launches the engine from its primary route, so the owner is
    // the same protocol and model as that route.
    let owner =
        Arc::new(OpenAIChat::new(base.clone(), "owner-key".into(), "prod-chat".into()).unwrap());
    let catalog = load(&file, &workspace, owner).await.unwrap().0;
    let (progress, _receive) = mpsc::channel(16);
    assert!(matches!(
        catalog
            .for_route("azure/gpt-4.1")
            .unwrap()
            .stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Http(422))
    ));
    let (uri, headers, body) = seen.recv().await.unwrap();
    assert_eq!(uri, "/openai/v1/chat/completions?api-version=v1");
    assert_eq!(headers["api-key"], "azure-secret");
    assert!(!headers.contains_key("authorization"));
    assert_eq!(body["model"], "prod-chat");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    server.abort();
}

/// Claude on Vertex AI: the model names a `:rawPredict` path, so the body drops
/// `model` and carries the API version instead, authenticated with a bearer
/// token rather than `x-api-key`.
#[tokio::test]
async fn vertex_anthropic_wire_matches_the_product_route() {
    let (send, mut seen) = mpsc::channel(8);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let send = send.clone();
            async move {
                send.send((uri.to_string(), headers, body)).await.unwrap();
                (StatusCode::UNPROCESSABLE_ENTITY, "fixture")
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::env::set_var(VERTEX_KEY, "vertex-secret");
    let root = tempfile::tempdir().unwrap();
    let (file, workspace) = manifest(
        root.path(),
        json!([
            {
                "id": "google-vertex/claude-sonnet-4-5",
                "provider": "vertex-anthropic",
                "model": "claude-sonnet-4-5",
                "endpoint": format!(
                    "{base}/v1/projects/proj-alpha/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict"
                ),
                "primary": true,
                "auth": {},
                "variants": [],
                "credential": {"type": "environment", "key": VERTEX_KEY}
            }
        ]),
    );
    let owner = Arc::new(
        Anthropic::new(base.clone(), "owner-key".into(), "claude-sonnet-4-5".into()).unwrap(),
    );
    let catalog = load(&file, &workspace, owner).await.unwrap().0;
    let (progress, _receive) = mpsc::channel(16);
    assert!(matches!(
        catalog
            .for_route("google-vertex/claude-sonnet-4-5")
            .unwrap()
            .stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Http(422))
    ));
    let (uri, headers, body) = seen.recv().await.unwrap();
    assert_eq!(
        uri,
        "/v1/projects/proj-alpha/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict"
    );
    assert_eq!(headers["authorization"], "Bearer vertex-secret");
    assert!(!headers.contains_key("api-key"));
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(body["anthropic_version"], "vertex-2023-10-16");
    assert!(body.get("model").is_none());
    server.abort();
}
/// Azure's Responses wire: the same `api-key` auth and `api-version` query as
/// its chat wire, carrying the Responses body instead of `messages`.
#[tokio::test]
async fn azure_responses_wire_matches_the_product_route() {
    let (send, mut seen) = mpsc::channel(8);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let send = send.clone();
            async move {
                send.send((uri.to_string(), headers, body)).await.unwrap();
                (StatusCode::UNPROCESSABLE_ENTITY, "fixture")
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::env::set_var(AZURE_KEY, "azure-secret");
    let root = tempfile::tempdir().unwrap();
    let (file, workspace) = manifest(
        root.path(),
        json!([
            {
                "id": "azure/gpt-4.1",
                "provider": "openai-responses",
                "model": "prod-chat",
                "endpoint": format!("{base}/openai/v1/responses"),
                "primary": true,
                "auth": {"style": "api-key", "query": {"api-version": "v1"}},
                "variants": [],
                "credential": {"type": "environment", "key": AZURE_KEY}
            }
        ]),
    );
    let owner = Arc::new(
        OpenAIResponses::new(base.clone(), "owner-key".into(), "prod-chat".into()).unwrap(),
    );
    let catalog = load(&file, &workspace, owner).await.unwrap().0;
    let (progress, _receive) = mpsc::channel(16);
    assert!(matches!(
        catalog
            .for_route("azure/gpt-4.1")
            .unwrap()
            .stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Http(422))
    ));
    let (uri, headers, body) = seen.recv().await.unwrap();
    assert_eq!(uri, "/openai/v1/responses?api-version=v1");
    assert_eq!(headers["api-key"], "azure-secret");
    assert!(!headers.contains_key("authorization"));
    assert_eq!(body["model"], "prod-chat");
    assert!(body.get("input").is_some());
    assert!(body.get("messages").is_none());
    server.abort();
}
