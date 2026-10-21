use axum::{http::StatusCode, Json, Router};
use base64::Engine;
use miao_engine::{
    gemini::Gemini,
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Attachment, Delivery, Input, Message, ModelRequest},
    provider::{Anthropic, CountTokens, Provider, ProviderError},
    store::Store,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PDF: &[u8] = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n";

fn attachment(mime: &str, bytes: &[u8], name: &str) -> Attachment {
    serde_json::from_value(json!({"mime":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes),"metadata":{"name":name,"path":format!("/client/{name}")}})).unwrap()
}

fn request() -> ModelRequest {
    ModelRequest {
        system: String::new(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([
                {"type":"text","text":"inspect files"},
                {"type":"image","mime":"image/png","data":PNG,"metadata":{"name":"diagram.png"}},
                attachment("application/pdf", PDF, "manual.pdf").part(),
                attachment("text/markdown", "# 文件\nattached text".as_bytes(), "notes.md").part(),
            ]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    }
}

#[tokio::test]
async fn physical_adapters_lower_documents_and_normalize_declared_text_only_models() {
    let (send, mut seen) = mpsc::channel::<Value>(16);
    let router = Router::new().fallback(move |Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            send.send(body).await.unwrap();
            (StatusCode::BAD_REQUEST, "fixture")
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: Vec<(&str, Arc<dyn Provider>)> = vec![
        (
            "anthropic",
            Arc::new(Anthropic::new(endpoint.clone(), "key".into(), "model".into()).unwrap()),
        ),
        (
            "openai-chat",
            Arc::new(OpenAIChat::new(endpoint.clone(), "key".into(), "model".into()).unwrap()),
        ),
        (
            "openai-responses",
            Arc::new(OpenAIResponses::new(endpoint.clone(), "key".into(), "model".into()).unwrap()),
        ),
        (
            "gemini",
            Arc::new(Gemini::new(endpoint, "key".into(), "model".into()).unwrap()),
        ),
    ];
    for (protocol, provider) in providers {
        for input in [
            vec!["text".to_string(), "image".to_string(), "pdf".to_string()],
            vec!["text".to_string()],
        ] {
            let images = input.len() > 1;
            let selected = provider.with_input_modalities(input).unwrap();
            let original = request();
            let (progress, _receive) = mpsc::channel(16);
            assert!(matches!(
                selected
                    .stream(original.clone(), progress, CancellationToken::new())
                    .await,
                Err(ProviderError::Http(400))
            ));
            let body = seen.recv().await.unwrap();
            let encoded = body.to_string();
            assert!(encoded.contains("attached text"));
            assert_eq!(encoded.contains(PNG), images);
            let pdf_sent = images && protocol != "openai-chat";
            assert_eq!(
                encoded.contains(&base64::engine::general_purpose::STANDARD.encode(PDF)),
                pdf_sent
            );
            if !images {
                assert!(encoded.contains("model does not support image input"));
            }
            if !pdf_sent {
                assert!(encoded.contains("attachment not sent"));
                assert!(encoded.contains("manual.pdf"));
            }
            if pdf_sent {
                match protocol {
                    "anthropic" => {
                        assert_eq!(body["messages"][0]["content"][2]["type"], "document");
                        assert_eq!(
                            body["messages"][0]["content"][2]["source"]["media_type"],
                            "application/pdf"
                        );
                    }
                    "openai-responses" => {
                        assert_eq!(body["input"][2]["content"][0]["type"], "input_file");
                        assert_eq!(body["input"][2]["content"][0]["filename"], "manual.pdf");
                    }
                    "gemini" => assert_eq!(
                        body["contents"][0]["parts"][2]["inline_data"]["mime_type"],
                        "application/pdf"
                    ),
                    _ => unreachable!(),
                }
            }
            assert_eq!(original.messages[0].content[1]["data"], PNG);
            assert_eq!(original.messages[0].content[2]["type"], "file");
        }
    }
    server.abort();
}

#[tokio::test]
async fn advisory_counts_receive_the_same_normalized_media_shapes_as_generation() {
    let (send, mut seen) = mpsc::channel::<Value>(4);
    let router = Router::new().fallback(move |Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            send.send(body).await.unwrap();
            Json(json!({"input_tokens":42,"totalTokens":42}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: Vec<Arc<dyn Provider>> = vec![
        Arc::new(Anthropic::new(endpoint.clone(), "key".into(), "model".into()).unwrap()),
        Arc::new(Gemini::new(endpoint, "key".into(), "model".into()).unwrap()),
    ];
    for provider in providers {
        let selected = provider.with_input_modalities(vec!["text".into()]).unwrap();
        assert!(matches!(
            selected.count_tokens(&request()).await,
            CountTokens::Counted(42)
        ));
        let body = seen.recv().await.unwrap().to_string();
        assert!(!body.contains(PNG));
        assert!(!body.contains(&base64::engine::general_purpose::STANDARD.encode(PDF)));
        assert!(body.contains("attached text"));
    }
    server.abort();
}

#[tokio::test]
async fn durable_document_only_admission_reopens_forks_and_reconciles_exact_retries() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    let files = vec![
        attachment("application/pdf", PDF, "manual.pdf"),
        attachment("text/plain", "文本".as_bytes(), "notes.txt"),
    ];
    let input = Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "documents".into(),
        prompt: String::new(),
        delivery: Delivery::Steer,
    };
    store
        .admit_with(input.clone(), files.clone())
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    assert!(
        store
            .admit_with(input.clone(), files.clone())
            .await
            .unwrap()
            .duplicate
    );
    let mut changed = files.clone();
    changed[0]
        .metadata
        .as_mut()
        .unwrap()
        .insert("name".into(), json!("changed.pdf"));
    assert!(store.admit_with(input, changed).await.is_err());
    let parent = store.history("s").await.unwrap();
    assert_eq!(parent[0].content[1], files[0].part());
    assert_eq!(parent[0].content[2], files[1].part());
    store.fork("s", "child", None).await.unwrap();
    let child = store.history("child").await.unwrap();
    assert_eq!(child[0].content, parent[0].content);
    store.close().await.unwrap();
}

#[test]
fn document_validation_rejects_malformed_bytes_and_accepts_empty_utf8_files() {
    assert!(attachment("application/pdf", b"not a PDF", "bad.pdf")
        .validate()
        .is_err());
    assert!(attachment("text/plain", &[0xff], "bad.txt")
        .validate()
        .is_err());
    assert!(attachment("text/plain", b"", "empty.txt")
        .validate()
        .is_ok());
    let mut malformed = attachment("text/plain", b"valid", "text");
    malformed.data = "not base64=".into();
    assert!(malformed.validate().is_err());
}

#[tokio::test]
async fn host_route_modalities_apply_to_the_owner_default_and_explicit_route() {
    let (send, mut seen) = mpsc::channel::<Value>(4);
    let router = Router::new().fallback(move |Json(body): Json<Value>| {
        let send = send.clone();
        async move {
            send.send(body).await.unwrap();
            (StatusCode::BAD_REQUEST, "fixture")
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let credential = root.path().join("credentials.json");
    std::fs::write(
        &credential,
        json!({"fixture":{"type":"api","key":"fixture-key"}}).to_string(),
    )
    .unwrap();
    let manifest = root.path().join("routes.json");
    std::fs::write(&manifest,json!([{
        "id":"account/text-only","provider":"openai-chat","model":"model","endpoint":endpoint,"primary":true,"input_modalities":["text"],
        "credential":{"type":"legacy","path":credential,"integration":"fixture"}
    }]).to_string()).unwrap();
    let provider =
        Arc::new(OpenAIChat::new(endpoint, "fixture-key".into(), "model".into()).unwrap());
    let catalog = miao_engine::model_routes::load(&manifest, &workspace, provider)
        .await
        .unwrap()
        .0;
    for selected in [
        Arc::clone(&catalog),
        catalog.for_route("account/text-only").unwrap(),
    ] {
        let (progress, _receive) = mpsc::channel(16);
        assert!(matches!(
            selected
                .stream(request(), progress, CancellationToken::new())
                .await,
            Err(ProviderError::Http(400))
        ));
        let body = seen.recv().await.unwrap().to_string();
        assert!(!body.contains(PNG));
        assert!(body.contains("model does not support image input"));
        assert!(body.contains("attached text"));
    }
    server.abort();
}
