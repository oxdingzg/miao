use axum::{
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use miao_engine::mcp::{Config, Registry};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn http_initialization_catalog_call_and_host_headers_roundtrip() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let router = Router::new().route("/mcp", post(move |headers: HeaderMap, Json(request): Json<Value>| {
        let counter = counter.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer fixture-only");
            assert_eq!(headers["x-workspace"], "fixture");
            let Some(id) = request.get("id") else { return StatusCode::ACCEPTED.into_response(); };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"http-fixture","version":"1"}}),
                "tools/list" => {
                    assert_eq!(headers["mcp-session-id"], "fixture-session");
                    json!({"tools":[{"name":"echo","description":"HTTP fixture","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}]})
                },
                "tools/call" => {
                    assert_eq!(headers["mcp-session-id"], "fixture-session");
                    counter.fetch_add(1, Ordering::SeqCst);
                    json!({"content":[{"type":"text","text":request["params"]["arguments"]["text"]}]})
                },
                _ => panic!("unexpected MCP method"),
            };
            let mut response = Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response();
            response.headers_mut().insert("mcp-session-id", "fixture-session".parse().unwrap());
            response
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::connect(vec![serde_json::from_value::<Config>(json!({"name":"remote","url":endpoint,"headers":{"Authorization":"Bearer fixture-only","X-Workspace":"fixture"}})).unwrap()],dir.path()).await.unwrap();
    let definitions = registry.definitions();
    assert_eq!(definitions.len(), 1);
    assert!(!serde_json::to_string(&definitions)
        .unwrap()
        .contains("fixture-only"));
    let result = registry
        .call(
            &definitions[0].name,
            json!({"text":"real HTTP roundtrip"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "real HTTP roundtrip");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    registry.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn http_configuration_rejects_ambiguous_authority_and_unsafe_headers() {
    let dir = tempfile::tempdir().unwrap();
    for config in [
        json!({"name":"remote","url":"http://127.0.0.1:1","argv":["unwanted"]}),
        json!({"name":"remote","url":"http://127.0.0.1:1","env":{"SECRET":"unwanted"}}),
        json!({"name":"remote","url":"http://user:password@127.0.0.1:1"}),
        json!({"name":"remote","url":"file:///tmp/server"}),
        json!({"name":"remote","url":"http://127.0.0.1:1/#fragment"}),
        json!({"name":"remote","url":"http://127.0.0.1:1","headers":{"Host":"unwanted"}}),
        json!({"name":"remote","url":"http://127.0.0.1:1","headers":{"Authorization":"line\r\nbreak"}}),
        json!({"name":"local","argv":["unwanted"],"headers":{"Authorization":"unwanted"}}),
    ] {
        assert!(
            Registry::connect(vec![serde_json::from_value(config).unwrap()], dir.path())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn http_redirect_never_forwards_host_credentials() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = format!("http://{}/trap", trap_listener.local_addr().unwrap());
    let trap = Router::new().route(
        "/trap",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                StatusCode::BAD_REQUEST
            }
        }),
    );
    let trap_task = tokio::spawn(async move {
        axum::serve(trap_listener, trap).await.unwrap();
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/mcp",
        post(move |headers: HeaderMap| {
            let destination = destination.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer fixture-only");
                (StatusCode::TEMPORARY_REDIRECT, [("location", destination)])
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let result=Registry::connect(vec![serde_json::from_value(json!({"name":"remote","url":endpoint,"headers":{"Authorization":"Bearer fixture-only"}})).unwrap()],dir.path()).await;
    assert!(result.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    server.abort();
    trap_task.abort();
}
