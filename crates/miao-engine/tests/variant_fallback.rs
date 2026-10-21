use axum::{
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use miao_engine::{
    model_routes::load,
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest},
    provider::ProviderError,
    routing::Fallback,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

#[tokio::test]
async fn configured_default_and_explicit_variants_preserve_fallback_authority_and_options() {
    let (send, mut requests) = mpsc::channel(8);
    let router = Router::new().fallback(move |headers: HeaderMap, Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            let primary = body["model"] == "primary-model";
            send.send((headers, body)).await.unwrap();
            (
                if primary {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::BAD_REQUEST
                },
                "fixture",
            )
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let credential = root.path().join("key");
    std::fs::write(
        &credential,
        json!({"fixture":{"type":"api","key":"named-route-key"}}).to_string(),
    )
    .unwrap();
    let manifest = root.path().join("routes.json");
    std::fs::write(&manifest, serde_json::to_vec(&json!([{
        "id":"account/primary", "primary":true, "default_variant":"high", "input_modalities":["text"], "provider":"openai-chat", "model":"primary-model", "endpoint":endpoint,
        "credential":{"type":"legacy","path":credential,"integration":"fixture"},
        "variants":[{"id":"high","body":{"reasoning_effort":"high"},"headers":{"x-tier":"high"}}]
    }])).unwrap()).unwrap();
    let primary = Arc::new(
        OpenAIChat::new(
            endpoint.clone(),
            "primary-key".into(),
            "primary-model".into(),
        )
        .unwrap(),
    );
    let secondary = Arc::new(
        OpenAIChat::new(endpoint, "fallback-key".into(), "fallback-model".into()).unwrap(),
    );
    let fallback = Arc::new(Fallback::new(primary, secondary).unwrap());
    let catalog = load(&manifest, &workspace, fallback).await.unwrap().0;
    for selected in [
        Arc::clone(&catalog),
        catalog.for_route_variant(None, "high").unwrap(),
    ] {
        let (progress, _receive) = mpsc::channel(16);
        let result = selected
            .stream(
                ModelRequest {
                    system: "system".into(),
                    messages: vec![Message {
                        role: "user".into(),
                        content: json!([{"type":"text","text":"hello"},{"type":"image","mime":"image/png","data":PNG}]),
                        checkpoint: None,
                        recorded_at_ms: None,
                    }],
                    tools: vec![],
                },
                progress,
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(ProviderError::Routed { .. })));
        let (headers, body) = requests.recv().await.unwrap();
        assert_eq!(headers["authorization"], "Bearer primary-key");
        assert_eq!(headers["x-tier"], "high");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["model"], "primary-model");
        assert!(!body.to_string().contains(PNG));
        assert!(body
            .to_string()
            .contains("model does not support image input"));
        let (headers, body) = requests.recv().await.unwrap();
        assert_eq!(headers["authorization"], "Bearer fallback-key");
        assert!(!headers.contains_key("x-tier"));
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["model"], "fallback-model");
        assert!(body.to_string().contains(PNG));
    }
    server.abort();
}
