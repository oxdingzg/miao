use axum::{
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use miao_engine::{
    gemini::Gemini,
    model_routes,
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Delivery, Input, Message, ModelRequest},
    provider::{Anthropic, Provider, ProviderError},
    request_options::Options,
    runtime::Runtime,
    session_model::Binding,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

async fn finished(store: &Store, cursor: u64) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(event) = store
                .events("s", cursor, 1000)
                .await
                .unwrap()
                .iter()
                .find(|e| e.kind == "run.finished")
            {
                assert_eq!(event.data["reason"], "completed");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn manifest_variants_reach_the_wire_and_survive_reopen_and_fork() {
    let (send, mut requests) = mpsc::channel::<Value>(8);
    let router = Router::new().route("/chat", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer variant-fixture-secret");
            if body["reasoning_effort"] == "low" { assert_eq!(headers["x-low"], "true"); }
            else { assert!(!headers.contains_key("x-low")); }
            send.send(body).await.unwrap();
            ([("content-type", "text/event-stream")], format!("data: {}\n\ndata: [DONE]\n\n", json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let host = tempfile::tempdir().unwrap();
    let workspace = host.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let credentials = host.path().join("credentials.json");
    std::fs::write(
        &credentials,
        json!({"fixture":{"type":"api","key":"variant-fixture-secret"}}).to_string(),
    )
    .unwrap();
    let manifest = host.path().join("routes.json");
    std::fs::write(&manifest, json!([{
        "id":"account/chat", "primary":true, "default_variant":"low", "provider":"openai-chat", "model":"wire-model", "endpoint":endpoint,
        "credential":{"type":"legacy","path":credentials,"integration":"fixture"},
        "request":{"body":{"temperature":0.1}},
        "variants":[{"id":"high","body":{"reasoning_effort":"high"}},{"id":"low","body":{"reasoning_effort":"low"},"headers":{"x-low":"true"}}]
    }]).to_string()).unwrap();
    let primary: Arc<dyn Provider> = Arc::new(
        OpenAIChat::new(
            endpoint,
            "variant-fixture-secret".into(),
            "wire-model".into(),
        )
        .unwrap(),
    );
    let catalog = model_routes::load(&manifest, &workspace, primary)
        .await
        .unwrap();
    let public = serde_json::to_value(catalog.model_catalog()).unwrap();
    assert_eq!(public[0]["variants"], json!(["high", "low"]));
    assert_eq!(public[1]["variants"], json!(["high", "low"]));
    assert!(!public.to_string().contains("variant-fixture-secret"));
    assert!(!public.to_string().contains("temperature"));
    let path = host.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        catalog.clone(),
        Tools::new(&workspace).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "first".into(),
                prompt: "hello".into(),
                delivery: Delivery::Steer,
            },
            false,
        )
        .await
        .unwrap();
    let high = Binding {
        protocol: "openai-chat".into(),
        model: "wire-model".into(),
        route_id: Some("account/chat".into()),
        variant: Some("high".into()),
    };
    runtime.select_model("s", Some(high.clone())).await.unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store, 0).await;
    let body = requests.recv().await.unwrap();
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["temperature"], 0.1);
    assert_eq!(body["model"], "wire-model");
    store.fork("s", "child", None).await.unwrap();
    assert_eq!(
        store.model_selection("child").await.unwrap(),
        Some(high.clone())
    );
    runtime.shutdown().await;
    drop(runtime);
    drop(store);
    let store = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match Store::open(&path).await {
                Ok(store) => break store,
                Err(miao_engine::protocol::Error::Busy) => {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await
                }
                Err(error) => panic!("reopen failed: {error}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.model_selection("s").await.unwrap(),
        Some(high.clone())
    );
    let runtime = Runtime::new(
        store.clone(),
        catalog,
        Tools::new(&workspace).await.unwrap(),
    )
    .await
    .unwrap();
    for (id, selected, effort) in [
        (
            "second",
            Binding {
                variant: Some("low".into()),
                ..high.clone()
            },
            "low",
        ),
        (
            "default",
            Binding {
                route_id: None,
                ..high.clone()
            },
            "high",
        ),
    ] {
        runtime.select_model("s", Some(selected)).await.unwrap();
        let cursor = store.snapshot("s").await.unwrap()["cursor"]
            .as_u64()
            .unwrap();
        runtime
            .admit(
                Input {
                    session_id: "s".into(),
                    input_id: id.into(),
                    prompt: id.into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        finished(&store, cursor).await;
        let body = requests.recv().await.unwrap();
        assert_eq!(body["reasoning_effort"], effort);
        assert_eq!(body["temperature"], 0.1);
    }
    for invalid in [
        Binding {
            variant: Some("missing".into()),
            ..high.clone()
        },
        Binding {
            model: "forged-model".into(),
            ..high.clone()
        },
    ] {
        assert!(runtime.select_model("s", Some(invalid)).await.is_err());
    }
    assert_eq!(
        store.model_selection("s").await.unwrap(),
        Some(Binding {
            route_id: None,
            ..high
        })
    );
    for (id, selected) in [
        (
            "base-default",
            Some(Binding {
                protocol: "openai-chat".into(),
                model: "wire-model".into(),
                route_id: Some("account/chat".into()),
                variant: None,
            }),
        ),
        ("owner-default", None),
    ] {
        runtime.select_model("s", selected).await.unwrap();
        let cursor = store.snapshot("s").await.unwrap()["cursor"]
            .as_u64()
            .unwrap();
        runtime
            .admit(
                Input {
                    session_id: "s".into(),
                    input_id: id.into(),
                    prompt: id.into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        finished(&store, cursor).await;
        assert_eq!(requests.recv().await.unwrap()["reasoning_effort"], "low");
    }
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn all_native_adapters_apply_variant_body_and_headers_without_replacing_authority() {
    let (send, mut requests) = mpsc::channel::<(HeaderMap, Value)>(8);
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
    let providers: Vec<(Arc<dyn Provider>, Value)> = vec![
        (
            Arc::new(
                OpenAIChat::new(
                    format!("{endpoint}/chat"),
                    "fixture-key".into(),
                    "model".into(),
                )
                .unwrap(),
            ),
            json!({"reasoning_effort":"high"}),
        ),
        (
            Arc::new(
                OpenAIResponses::new(
                    format!("{endpoint}/responses"),
                    "fixture-key".into(),
                    "model".into(),
                )
                .unwrap(),
            ),
            json!({"reasoning":{"effort":"high"}}),
        ),
        (
            Arc::new(
                Anthropic::new(
                    format!("{endpoint}/messages"),
                    "fixture-key".into(),
                    "model".into(),
                )
                .unwrap(),
            ),
            json!({"thinking":{"type":"enabled","budget_tokens":1024}}),
        ),
        (
            Arc::new(
                Gemini::new(
                    format!("{endpoint}/v1beta"),
                    "fixture-key".into(),
                    "model".into(),
                )
                .unwrap(),
            ),
            json!({"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}}),
        ),
    ];
    for (provider, options) in providers {
        let options: Options =
            serde_json::from_value(json!({"body":options,"headers":{"x-variant-mode":"high"}}))
                .unwrap();
        let selected = provider.with_request_options(options.clone()).unwrap();
        assert_eq!(provider.identity(), selected.identity());
        let (progress, _receive) = mpsc::channel(16);
        let result = selected
            .stream(
                ModelRequest {
                    system: "fixed system".into(),
                    messages: vec![Message {
                        role: "user".into(),
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
        assert!(matches!(result, Err(ProviderError::Http(400))));
        let (headers, body) = requests.recv().await.unwrap();
        assert_eq!(headers["x-variant-mode"], "high");
        for (key, value) in options.body {
            if key == "generationConfig" {
                assert_eq!(body[&key]["thinkingConfig"], value["thinkingConfig"]);
                assert_eq!(body[&key]["candidateCount"], 1);
                assert_eq!(body[&key]["maxOutputTokens"], 8192);
            } else {
                assert_eq!(body[&key], value);
            }
        }
    }
    server.abort();
}

#[test]
fn generation_options_cannot_override_model_transcript_tools_or_credentials() {
    for key in [
        "model",
        "messages",
        "input",
        "system",
        "instructions",
        "tools",
        "stream",
        "stream_options",
        "n",
    ] {
        let options: Options = serde_json::from_value(json!({"body":{(key):"forged"}})).unwrap();
        assert!(options.validate().is_err(), "{key}");
    }
    for key in [
        "Authorization",
        "X-Api-Key",
        "X-Goog-Api-Key",
        "Host",
        "ChatGPT-Account-Id",
        "session-id",
    ] {
        let options: Options = serde_json::from_value(json!({"headers":{(key):"forged"}})).unwrap();
        assert!(options.validate().is_err(), "{key}");
    }
    let options: Options =
        serde_json::from_value(json!({"body":{"generationConfig":{"candidateCount":2}}})).unwrap();
    assert!(options.validate().is_err());
    let options: Options = serde_json::from_value(
        json!({"body":{"reasoning":{"effort":"high"}},"headers":{"x-variant":"a","X-Variant":"b"}}),
    )
    .unwrap();
    assert!(options.validate().is_err());
}

#[test]
fn variant_merge_keeps_base_parameters_and_overrides_header_case_insensitively() {
    let base: Options = serde_json::from_value(json!({"body":{"reasoning":{"summary":"auto","effort":"low"},"temperature":0.1},"headers":{"X-Variant":"base"}})).unwrap();
    let variant: Options = serde_json::from_value(
        json!({"body":{"reasoning":{"effort":"high"}},"headers":{"x-variant":"high"}}),
    )
    .unwrap();
    let selected = base.merged(&variant).unwrap();
    assert_eq!(
        selected.body["reasoning"],
        json!({"summary":"auto","effort":"high"})
    );
    assert_eq!(selected.body["temperature"], 0.1);
    assert_eq!(selected.headers.len(), 1);
    assert_eq!(selected.headers["x-variant"], "high");
}
