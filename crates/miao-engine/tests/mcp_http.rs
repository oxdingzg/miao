use axum::{
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Form, Json, Router,
};
use miao_engine::mcp::{Config, Registry};
use serde_json::{json, Value};
use std::collections::HashMap;
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
                    assert_eq!(request["params"]["_meta"]["tenant"], "metadata-only");
                    assert_eq!(request["params"]["_meta"]["path"], std::env::var("PATH").unwrap());
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
    let registry = Registry::connect(vec![serde_json::from_value::<Config>(json!({"name":"remote","url":endpoint,"headers":{"Authorization":"Bearer fixture-only","X-Workspace":"fixture"},"call_meta":{"tenant":"metadata-only","path":"{env:PATH}"}})).unwrap()],dir.path()).await.unwrap();
    let definitions = registry.definitions();
    assert_eq!(definitions.len(), 1);
    assert!(!serde_json::to_string(&definitions)
        .unwrap()
        .contains("fixture-only"));
    assert!(!serde_json::to_string(&definitions)
        .unwrap()
        .contains("metadata-only"));
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
        json!({"name":"remote","url":"http://127.0.0.1:1","authority_revision":"short"}),
        json!({"name":"remote","url":"https://example.test/mcp","authority_revision":"a".repeat(64)}),
        json!({"name":"remote","argv":["unwanted"],"authority_revision":"a".repeat(64)}),
        json!({"name":"remote","url":"http://127.0.0.1:1","argv":["unwanted"]}),
        json!({"name":"remote","url":"http://127.0.0.1:1","env":{"SECRET":"unwanted"}}),
        json!({"name":"remote","url":"http://user:password@127.0.0.1:1"}),
        json!({"name":"remote","url":"file:///tmp/server"}),
        json!({"name":"remote","url":"http://127.0.0.1:1/#fragment"}),
        json!({"name":"remote","url":"http://127.0.0.1:1","headers":{"Host":"unwanted"}}),
        json!({"name":"remote","url":"http://127.0.0.1:1","headers":{"Authorization":"line\r\nbreak"}}),
        json!({"name":"local","argv":["unwanted"],"headers":{"Authorization":"unwanted"}}),
        json!({"name":"remote","url":"http://127.0.0.1:1","call_meta":{"":"invalid"}}),
        json!({"name":"remote","url":"http://127.0.0.1:1","call_meta":{"tenant":"x".repeat(8193)}}),
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

#[tokio::test]
async fn http_oauth_refresh_exchanges_once_and_bearer_reaches_the_server() {
    let token_calls = Arc::new(AtomicUsize::new(0));
    let counter = token_calls.clone();
    let token_router = Router::new().route(
        "/token",
        post(move |Form(body): Form<HashMap<String, String>>| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(body["grant_type"], "refresh_token");
                assert_eq!(body["refresh_token"], "fixture-refresh-secret");
                assert_eq!(body["client_id"], "fixture-client");
                assert_eq!(body["scope"], "mcp read");
                Json(json!({
                    "access_token": "oauth-access-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": "rotated-never-reused"
                }))
            }
        }),
    );
    let token_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_endpoint = format!("http://{}/token", token_listener.local_addr().unwrap());
    let token_server = tokio::spawn(async move {
        axum::serve(token_listener, token_router).await.unwrap();
    });

    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let router = Router::new().route("/mcp", post(move |headers: HeaderMap, Json(request): Json<Value>| {
        let counter = counter.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer oauth-access-token");
            let Some(id) = request.get("id") else { return StatusCode::ACCEPTED.into_response(); };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"oauth-fixture","version":"1"}}),
                "tools/list" => json!({"tools":[{"name":"echo","description":"OAuth fixture","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}]}),
                "tools/call" => {
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
    let registry = Registry::connect(vec![serde_json::from_value::<Config>(json!({
        "name":"remote","url":endpoint,
        "oauth":{"token_endpoint":token_endpoint,"client_id":"fixture-client","refresh_token":"fixture-refresh-secret","scopes":["mcp","read"]}
    })).unwrap()], dir.path()).await.unwrap();
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);
    let definitions = registry.definitions();
    assert_eq!(definitions.len(), 1);
    let rendered = serde_json::to_string(&definitions).unwrap();
    assert!(!rendered.contains("oauth-access-token"));
    assert!(!rendered.contains("fixture-refresh-secret"));
    let result = registry
        .call(
            &definitions[0].name,
            json!({"text":"oauth roundtrip"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "oauth roundtrip");
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    registry.shutdown().await;
    server.abort();
    token_server.abort();
}

#[tokio::test]
async fn http_oauth_failures_stay_explicit_and_reach_no_server() {
    let refused = Arc::new(AtomicUsize::new(0));
    let counter = refused.clone();
    let router = Router::new().route("/mcp", post(move |Json(request): Json<Value>| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            let Some(id) = request.get("id") else { return StatusCode::ACCEPTED.into_response(); };
            Json(json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"1","capabilities":{},"serverInfo":{"name":"never","version":"1"}}})).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let caught = Arc::new(AtomicUsize::new(0));
    let trap_counter = caught.clone();
    let trap_router = Router::new().route(
        "/caught",
        post(move || {
            let counter = trap_counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }
        }),
    );
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trap_endpoint = format!("http://{}/caught", trap_listener.local_addr().unwrap());
    let trap_server = tokio::spawn(async move {
        axum::serve(trap_listener, trap_router).await.unwrap();
    });

    let rejected_router = Router::new().route("/token", post(|| async { StatusCode::BAD_REQUEST }));
    let rejected_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rejected_endpoint = format!("http://{}/token", rejected_listener.local_addr().unwrap());
    let rejected_server = tokio::spawn(async move {
        axum::serve(rejected_listener, rejected_router)
            .await
            .unwrap();
    });
    let redirect_router = Router::new().route(
        "/token",
        post(move || {
            let location = trap_endpoint.clone();
            async move {
                (
                    [(axum::http::header::LOCATION, location)],
                    StatusCode::FOUND,
                )
            }
        }),
    );
    let redirect_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_endpoint = format!("http://{}/token", redirect_listener.local_addr().unwrap());
    let redirect_server = tokio::spawn(async move {
        axum::serve(redirect_listener, redirect_router)
            .await
            .unwrap();
    });

    let dir = tempfile::tempdir().unwrap();
    for token_endpoint in [rejected_endpoint, redirect_endpoint] {
        let config: Config = serde_json::from_value(json!({
            "name":"remote","url":endpoint,
            "oauth":{"token_endpoint":token_endpoint,"client_id":"fixture-client","refresh_token":"fixture-refresh-secret"}
        })).unwrap();
        let Err(miao_engine::protocol::Error::Invalid(message)) =
            Registry::connect(vec![config], dir.path()).await
        else {
            panic!("expected the OAuth refresh to fail");
        };
        assert!(
            message.contains("MCP OAuth token refresh failed"),
            "{message}"
        );
    }
    assert_eq!(refused.load(Ordering::SeqCst), 0);
    assert_eq!(caught.load(Ordering::SeqCst), 0);
    server.abort();
    trap_server.abort();
    rejected_server.abort();
    redirect_server.abort();
}

#[tokio::test]
async fn http_oauth_configuration_conflicts_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let grant = json!({"client_id":"fixture-client","refresh_token":"fixture-refresh-secret","token_endpoint":"http://127.0.0.1:1/token"});
    let cases = vec![
        json!({"name":"remote","url":"http://127.0.0.1:1/mcp","argv":["unused"],"oauth":grant}),
        json!({"name":"remote","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer static"},"oauth":grant}),
        json!({"name":"remote","argv":["echo"],"oauth":grant}),
        json!({"name":"remote","url":"http://127.0.0.1:1/mcp","oauth":{"client_id":"c","refresh_token":"","token_endpoint":"http://127.0.0.1:1/token"}}),
        json!({"name":"remote","url":"http://127.0.0.1:1/mcp","oauth":{"client_id":"c","refresh_token":"r","token_endpoint":"http://user:pass@127.0.0.1:1/token"}}),
    ];
    for config in cases {
        let config: Config = serde_json::from_value(config).unwrap();
        assert!(Registry::connect(vec![config], dir.path()).await.is_err());
    }
}

struct GrantCaller(String);
#[async_trait::async_trait]
impl miao_engine::provider::Provider for GrantCaller {
    async fn stream(
        &self,
        request: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<miao_engine::provider::Reply, miao_engine::provider::ProviderError> {
        let needs_tools = request.messages.len() == 1;
        Ok(miao_engine::provider::Reply {
            content: if needs_tools {
                json!([{"type":"tool_use","id":"call","name":self.0,"input":{}}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools,
        })
    }
}

async fn grant_event(
    store: &miao_engine::store::Store,
    session: &str,
    kind: &str,
) -> miao_engine::protocol::Event {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(event) = store
                .events(session, 0, 200)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == kind)
            {
                return event;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn persistent_grants_survive_new_proxy_transport_and_miss_changed_registration_or_metadata() {
    use miao_engine::{permission::Policy, runtime::Runtime, store::Store, tools::Tools};
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let router = Router::new().route("/mcp", post(move |Json(request): Json<Value>| {
        let counter = counter.clone();
        async move {
            let Some(id) = request.get("id") else { return StatusCode::ACCEPTED.into_response(); };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"grant-fixture","version":"1"}}),
                "tools/list" => json!({"tools":[{"name":"echo","description":"grant fixture","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]}),
                "tools/call" => { counter.fetch_add(1,Ordering::SeqCst); json!({"content":[{"type":"text","text":"done"}]}) },
                _ => panic!("unexpected MCP method"),
            };
            Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
        }
    }));
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("engine.db");
    let mut endpoints = Vec::new();
    let mut servers = Vec::new();
    for (session, revision, metadata) in [
        ("grant", "a", "one"),
        ("restarted", "a", "one"),
        ("changed_registration", "b", "one"),
        ("changed_metadata", "a", "two"),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        assert!(!endpoints.contains(&endpoint));
        endpoints.push(endpoint.clone());
        let app = router.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let registry = Arc::new(Registry::connect(vec![serde_json::from_value::<Config>(json!({"name":"remote","url":endpoint,"authority_revision":revision.repeat(64),"call_meta":{"tenant":metadata}})).unwrap()],dir.path()).await.unwrap());
        let provider = Arc::new(GrantCaller(registry.definitions()[0].name.clone()));
        let store = Store::open(&database).await.unwrap();
        let runtime = Runtime::with_policy(
            store.clone(),
            provider,
            Tools::new(dir.path())
                .await
                .unwrap()
                .with_mcp(registry.clone()),
            Policy::new(miao_engine::permission::Config {
                mode: miao_engine::permission::Mode::Workspace,
                allow_mcp: true,
                ..Default::default()
            })
            .unwrap(),
        )
        .await
        .unwrap();
        runtime.initialize(session, "grant").await.unwrap();
        runtime
            .admit(
                miao_engine::protocol::Input {
                    session_id: session.into(),
                    input_id: session.into(),
                    prompt: "call".into(),
                    delivery: Default::default(),
                    command: None,
                    agent_references: Default::default(),
                },
                true,
            )
            .await
            .unwrap();
        if session == "grant" {
            let approval = grant_event(&store, session, "approval.requested").await;
            runtime
                .approve_persistent(
                    &runtime.controller(),
                    session,
                    miao_engine::approval::Response {
                        request_id: approval.data["request_id"].as_str().unwrap().into(),
                        decision: miao_engine::permission::Decision::Allow,
                        input_hash: approval.data["input_hash"].as_str().unwrap().into(),
                        policy_revision: approval.data["policy_revision"].as_str().unwrap().into(),
                        matcher: None,
                    },
                )
                .await
                .unwrap();
            grant_event(&store, session, "run.finished").await;
        }
        if session == "restarted" {
            grant_event(&store, session, "run.finished").await;
            let events = store.events(session, 0, 200).await.unwrap();
            assert!(events
                .iter()
                .any(|event| event.kind == "permission.grant.used"));
            assert!(!events
                .iter()
                .any(|event| event.kind == "approval.requested"));
        }
        if session.starts_with("changed_") {
            grant_event(&store, session, "approval.requested").await;
            runtime.cancel(session).await.unwrap();
        }
        runtime.shutdown().await;
        drop(runtime);
        registry.shutdown().await;
        store.close().await.unwrap();
        servers.push(server);
    }
    servers.into_iter().for_each(|server| server.abort());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
