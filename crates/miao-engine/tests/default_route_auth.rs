use axum::{
    http::{HeaderMap, StatusCode, Uri},
    Json, Router,
};
use miao_engine::{
    gemini::Gemini,
    model_routes::load,
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Message, ModelRequest},
    provider::{Anthropic, CountTokens, Provider, ProviderError},
    routing::Fallback,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn manifest(root: &Path, protocol: &str, endpoint: &str, auth: Value) -> (PathBuf, PathBuf) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let credential = root.join("credential.json");
    std::fs::write(
        &credential,
        json!({"fixture":{"type":"api","key":"named-key"}}).to_string(),
    )
    .unwrap();
    let file = root.join("routes.json");
    std::fs::write(&file,json!([{
        "id":"account/model","provider":protocol,"model":"model","endpoint":endpoint,"primary":true,"auth":auth,
        "variants":[{"id":"high","headers":{"x-host-identity":"variant"}}],
        "credential":{"type":"legacy","path":credential,"integration":"fixture"}
    }]).to_string()).unwrap();
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

#[tokio::test]
async fn owner_default_inherits_manifest_auth_without_replacing_transport_identity() {
    let (send, mut seen) = mpsc::channel(16);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let send = send.clone();
            async move {
                send.send((uri.to_string(), headers, body)).await.unwrap();
                (StatusCode::BAD_REQUEST, "fixture")
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let owner = format!("{base}/owner");
    let providers: Vec<(&str, Arc<dyn Provider>)> = vec![
        (
            "openai-chat",
            Arc::new(OpenAIChat::new(owner.clone(), "owner-key".into(), "model".into()).unwrap()),
        ),
        (
            "anthropic",
            Arc::new(Anthropic::new(owner.clone(), "owner-key".into(), "model".into()).unwrap()),
        ),
        (
            "openai-responses",
            Arc::new(
                OpenAIResponses::new(owner.clone(), "owner-key".into(), "model".into()).unwrap(),
            ),
        ),
        (
            "gemini",
            Arc::new(Gemini::new(owner, "owner-key".into(), "model".into()).unwrap()),
        ),
    ];
    for (protocol, provider) in providers {
        let root = tempfile::tempdir().unwrap();
        let (file, workspace) = manifest(
            root.path(),
            protocol,
            &format!("{base}/named"),
            json!({"headers":{"X-Host-Identity":"declared"}}),
        );
        let original = provider.identity();
        let catalog = load(&file, &workspace, provider).await.unwrap().0;
        assert_eq!(catalog.identity(), original);
        for (selected, path, key, identity) in [
            (Arc::clone(&catalog), "/owner", "owner-key", "declared"),
            (
                catalog.for_route("account/model").unwrap(),
                "/named",
                "named-key",
                "declared",
            ),
            (
                catalog.for_route_variant(None, "high").unwrap(),
                "/owner",
                "owner-key",
                "variant",
            ),
            (
                catalog
                    .for_route_variant(Some("account/model"), "high")
                    .unwrap(),
                "/named",
                "named-key",
                "variant",
            ),
        ] {
            let (progress, _receive) = mpsc::channel(16);
            assert!(matches!(
                selected
                    .stream(request(), progress, CancellationToken::new())
                    .await,
                Err(ProviderError::Http(400))
            ));
            let (uri, headers, _body) = seen.recv().await.unwrap();
            assert!(uri.starts_with(path));
            assert_eq!(
                headers
                    .get("x-host-identity")
                    .map(|value| value.to_str().unwrap()),
                Some(identity)
            );
            assert_eq!(headers.get_all("x-host-identity").iter().count(), 1);
            let field = match protocol {
                "anthropic" => "x-api-key",
                "gemini" => "x-goog-api-key",
                _ => "authorization",
            };
            assert_eq!(
                headers[field].to_str().unwrap(),
                if field == "authorization" {
                    format!("Bearer {key}")
                } else {
                    key.to_string()
                }
            );
        }
    }
    server.abort();
}

#[tokio::test]
async fn default_auth_style_and_encoded_query_leave_fallback_endpoint_credentials_and_defaults_intact(
) {
    let (send, mut seen) = mpsc::channel(4);
    let router = Router::new().fallback(
        move |uri: Uri, headers: HeaderMap, Json(_body): Json<Value>| {
            let send = send.clone();
            async move {
                let primary = uri.path() == "/owner";
                send.send((uri.to_string(), headers)).await.unwrap();
                (
                    if primary {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::BAD_REQUEST
                    },
                    "fixture",
                )
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let (file, workspace) = manifest(
        root.path(),
        "openai-chat",
        &format!("{base}/named"),
        json!({"style":"api-key","headers":{"x-host-identity":"primary"},"query":{"api-version":"v1 & injected=value"}}),
    );
    let primary = Arc::new(
        OpenAIChat::new(format!("{base}/owner"), "owner-key".into(), "model".into()).unwrap(),
    );
    let secondary = Arc::new(
        OpenAIChat::new(
            format!("{base}/secondary"),
            "secondary-key".into(),
            "fallback-model".into(),
        )
        .unwrap(),
    );
    let catalog = load(
        &file,
        &workspace,
        Arc::new(Fallback::new(primary, secondary).unwrap()),
    )
    .await
    .unwrap()
    .0;
    let (progress, _receive) = mpsc::channel(16);
    assert!(matches!(
        catalog
            .stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::Routed { .. })
    ));
    let (uri, headers) = seen.recv().await.unwrap();
    let uri = reqwest::Url::parse(&format!("http://localhost{uri}")).unwrap();
    assert_eq!(uri.path(), "/owner");
    assert_eq!(
        uri.query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>(),
        vec![("api-version".to_string(), "v1 & injected=value".to_string())]
    );
    assert_eq!(headers["api-key"], "owner-key");
    assert!(!headers.contains_key("authorization"));
    assert_eq!(headers["x-host-identity"], "primary");
    let (uri, headers) = seen.recv().await.unwrap();
    assert_eq!(uri, "/secondary");
    assert_eq!(headers["authorization"], "Bearer secondary-key");
    assert!(!headers.contains_key("api-key"));
    assert!(!headers.contains_key("x-host-identity"));
    server.abort();
}

#[tokio::test]
async fn count_requests_keep_the_same_host_route_headers() {
    let (send, mut seen) = mpsc::channel(4);
    let router = Router::new().fallback(move |headers: HeaderMap, Json(_body): Json<Value>| {
        let send = send.clone();
        async move {
            send.send(headers).await.unwrap();
            Json(json!({"input_tokens":17,"totalTokens":17}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: Vec<(&str, Arc<dyn Provider>)> = vec![
        (
            "anthropic",
            Arc::new(Anthropic::new(endpoint.clone(), "owner-key".into(), "model".into()).unwrap()),
        ),
        (
            "gemini",
            Arc::new(Gemini::new(endpoint.clone(), "owner-key".into(), "model".into()).unwrap()),
        ),
    ];
    for (protocol, provider) in providers {
        let root = tempfile::tempdir().unwrap();
        let (file, workspace) = manifest(
            root.path(),
            protocol,
            &endpoint,
            json!({"headers":{"x-host-identity":"count"}}),
        );
        let catalog = load(&file, &workspace, provider).await.unwrap().0;
        assert!(matches!(
            catalog.count_tokens(&request()).await,
            CountTokens::Counted(17)
        ));
        assert_eq!(seen.recv().await.unwrap()["x-host-identity"], "count");
    }
    server.abort();
}

#[tokio::test]
async fn invalid_or_credential_overriding_host_auth_is_rejected_before_wire_dispatch() {
    let root = tempfile::tempdir().unwrap();
    for auth in [
        json!({"headers":{"Authorization":"override"}}),
        json!({"headers":{"x-api-key":"override"}}),
        json!({"headers":{"Host":"override"}}),
        json!({"headers":{"X-Name":"one","x-name":"two"}}),
        json!({"style":"unknown"}),
        json!({"query":{"api-version":"invalid\u{0}value"}}),
    ] {
        let endpoint = "http://127.0.0.1:1";
        let (file, workspace) = manifest(root.path(), "openai-chat", endpoint, auth);
        let provider =
            Arc::new(OpenAIChat::new(endpoint.into(), "owner-key".into(), "model".into()).unwrap());
        assert!(load(&file, &workspace, provider).await.is_err());
    }
}
