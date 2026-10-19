use aws_sdk_bedrockruntime::{
    config::{Credentials, Region},
    Client, Config,
};
use axum::{
    body::Body,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
    Router,
};
use miao_engine::{
    bedrock::Bedrock,
    credential::Source,
    protocol::{Message, ModelRequest, ToolDefinition},
    provider::{Provider, ProviderError},
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Captured = (HeaderMap, String, Value);
async fn fixture(
    bytes: Vec<u8>,
) -> (
    Bedrock,
    mpsc::Receiver<Captured>,
    tokio::task::JoinHandle<()>,
    String,
) {
    let (send, seen) = mpsc::channel(16);
    let router = Router::new().fallback(
        move |headers: HeaderMap, uri: Uri, body: axum::Json<Value>| {
            let send = send.clone();
            let bytes = bytes.clone();
            async move {
                send.send((headers, uri.path().to_string(), body.0))
                    .await
                    .unwrap();
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/vnd.amazon.eventstream")
                    .body(Body::from(bytes))
                    .unwrap()
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let config = Config::builder()
        .behavior_version_latest()
        .region(Region::new("us-east-1"))
        .credentials_provider(Credentials::new(
            "FIXTURE_AKID",
            "FIXTURE_SECRET",
            Some("FIXTURE_SESSION".into()),
            None,
            "fixture",
        ))
        .endpoint_url(&endpoint)
        .retry_config(aws_smithy_types::retry::RetryConfig::disabled())
        .build();
    (
        Bedrock::with_chain(
            Some(endpoint.clone()),
            "model".into(),
            "us-east-1".into(),
            None,
        )
        .unwrap()
        .with_client(Client::from_conf(config)),
        seen,
        server,
        endpoint,
    )
}
fn frame(kind: &str, payload: Value) -> Vec<u8> {
    let mut headers = Vec::new();
    for (name, value) in [
        (":message-type", "event"),
        (":event-type", kind),
        (":content-type", "application/json"),
    ] {
        headers.push(name.len() as u8);
        headers.extend(name.as_bytes());
        headers.push(7);
        headers.extend((value.len() as u16).to_be_bytes());
        headers.extend(value.as_bytes());
    }
    let payload = serde_json::to_vec(&payload).unwrap();
    let total = 16 + headers.len() + payload.len();
    let mut bytes = Vec::new();
    bytes.extend((total as u32).to_be_bytes());
    bytes.extend((headers.len() as u32).to_be_bytes());
    bytes.extend(crc32fast::hash(&bytes).to_be_bytes());
    bytes.extend(headers);
    bytes.extend(payload);
    bytes.extend(crc32fast::hash(&bytes).to_be_bytes());
    bytes
}
fn text_stream() -> Vec<u8> {
    [frame("messageStart",json!({"role":"assistant"})),
    frame("contentBlockDelta",json!({"contentBlockIndex":0,"delta":{"text":"hello"}})),
    frame("contentBlockStop",json!({"contentBlockIndex":0})),
    frame("messageStop",json!({"stopReason":"end_turn"})),
    frame("metadata",json!({"usage":{"inputTokens":10,"outputTokens":2,"totalTokens":12,"cacheReadInputTokens":4,"cacheWriteInputTokens":1},"metrics":{"latencyMs":1}}))].concat()
}
fn request() -> ModelRequest {
    ModelRequest {
        system: "system".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"hi"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    }
}
#[tokio::test]
async fn real_sdk_sigv4_eventstream_text_and_inclusive_usage() {
    let (provider, mut seen, server, _endpoint) = fixture(text_stream()).await;
    let provider = provider.with_prompt_cache(true).with_request_options(serde_json::from_value(json!({"body":{"inferenceConfig":{"maxTokens":99,"temperature":0.2},"additionalModelRequestFields":{"thinking":{"type":"enabled","budget_tokens":64}}},"headers":{"x-generation":"declared"}})).unwrap()).unwrap();
    let (progress, mut notices) = mpsc::channel(16);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content, json!([{"type":"text","text":"hello"}]));
    assert!(!reply.needs_tools);
    assert_eq!(reply.usage["inputTokens"], 10);
    assert_eq!(reply.usage["nonCachedInputTokens"], 5);
    assert_eq!(reply.usage["outputTokens"], 2);
    assert_eq!(reply.usage["totalTokens"], 12);
    let (headers, path, body) = seen.recv().await.unwrap();
    assert!(headers["authorization"]
        .to_str()
        .unwrap()
        .starts_with("AWS4-HMAC-SHA256 Credential=FIXTURE_AKID/"));
    assert_eq!(headers["x-amz-security-token"], "FIXTURE_SESSION");
    assert_eq!(path, "/model/model/converse-stream");
    assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
    assert_eq!(headers["x-generation"], "declared");
    assert_eq!(body["inferenceConfig"]["maxTokens"], 99);
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"]["budget_tokens"],
        64
    );
    assert_eq!(body["system"][1]["cachePoint"]["type"], "default");
    assert_eq!(
        body["messages"][0]["content"][1]["cachePoint"]["type"],
        "default"
    );
    assert_eq!(
        notices.recv().await.unwrap()["delta"],
        json!({"kind":"text.delta","index":0,"text":"hello"})
    );
    server.abort();
}
#[tokio::test]
async fn bearer_is_reloaded_per_turn_and_model_selection_preserves_auth() {
    let (_fixture, mut seen, server, endpoint) = fixture(text_stream()).await;
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("auth.json");
    let provider = Bedrock::with_bearer_source(
        Some(endpoint),
        "model".into(),
        "us-east-1".into(),
        Source::Legacy {
            path: file.clone(),
            integration: "fixture".into(),
        },
    )
    .unwrap();
    // Use the exact same endpoint with a dedicated SDK client; credentials are
    // deliberately absent, so a bearer request cannot accidentally use SigV4.
    for token in ["FIRST_TOKEN", "SECOND_TOKEN"] {
        std::fs::write(
            &file,
            json!({"fixture":{"type":"key","key":token}}).to_string(),
        )
        .unwrap();
        let (progress, _receive) = mpsc::channel(16);
        let selected = provider.for_model("selected-model").unwrap();
        selected
            .stream(request(), progress, CancellationToken::new())
            .await
            .unwrap();
        let (headers, path, _) = seen.recv().await.unwrap();
        assert_eq!(headers["authorization"], format!("Bearer {token}"));
        assert!(!headers.contains_key("x-amz-security-token"));
        assert_eq!(path, "/model/selected-model/converse-stream");
    }
    server.abort();
}

#[tokio::test]
async fn crc_corruption_and_missing_terminal_never_complete_a_reply() {
    let mut corrupted = text_stream();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 1;
    for bytes in [
        corrupted,
        frame("messageStart", json!({"role":"assistant"})),
    ] {
        let (provider, _seen, server, _endpoint) = fixture(bytes).await;
        let (progress, _receive) = mpsc::channel(16);
        assert!(provider
            .stream(request(), progress, CancellationToken::new())
            .await
            .is_err());
        server.abort();
    }
}
#[tokio::test]
async fn fragmented_tool_input_and_signed_reasoning_roundtrip() {
    let bytes=[frame("messageStart",json!({"role":"assistant"})),
        frame("contentBlockDelta",json!({"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"reason"}}})),
        frame("contentBlockDelta",json!({"contentBlockIndex":0,"delta":{"reasoningContent":{"signature":"opaque-signature"}}})),
        frame("contentBlockStop",json!({"contentBlockIndex":0})),
        frame("contentBlockStart",json!({"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"call-1","name":"read_file"}}})),
        frame("contentBlockDelta",json!({"contentBlockIndex":1,"delta":{"toolUse":{"input":"{\"path\":"}}})),
        frame("contentBlockDelta",json!({"contentBlockIndex":1,"delta":{"toolUse":{"input":"\"a\"}"}}})),
        frame("contentBlockStop",json!({"contentBlockIndex":1})),
        frame("messageStop",json!({"stopReason":"tool_use"}))].concat();
    let (provider, mut seen, server, _endpoint) = fixture(bytes).await;
    let mut input = request();
    input.tools.push(ToolDefinition {
        name: "read_file".into(),
        description: "Read file".into(),
        input_schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
    });
    let (progress, _receive) = mpsc::channel(16);
    let reply = provider
        .stream(input.clone(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[1]["input"], json!({"path":"a"}));
    assert_eq!(reply.content[0]["item"]["signature"], "opaque-signature");
    seen.recv().await.unwrap();
    input.messages.push(Message {
        role: "assistant".into(),
        content: reply.content,
        checkpoint: None,
        recorded_at_ms: None,
    });
    input.messages.push(Message {
        role: "user".into(),
        content: json!([{"type":"tool_result","tool_use_id":"call-1","content":"result"}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let (progress, _receive) = mpsc::channel(16);
    provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    let (_, _, body) = seen.recv().await.unwrap();
    assert_eq!(
        body["messages"][1]["content"][0]["reasoningContent"]["reasoningText"]["signature"],
        "opaque-signature"
    );
    assert_eq!(
        body["messages"][2]["content"][0]["toolResult"]["content"][0]["text"],
        "result"
    );
    server.abort();
}
#[tokio::test]
async fn already_cancelled_request_has_no_dispatch() {
    let (provider, mut seen, server, _endpoint) = fixture(text_stream()).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (progress, _receive) = mpsc::channel(16);
    assert!(matches!(
        provider.stream(request(), progress, cancel).await,
        Err(ProviderError::Interrupted)
    ));
    assert!(seen.try_recv().is_err());
    server.abort();
}

#[tokio::test]
async fn shared_profile_chain_resolves_without_global_environment_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let credentials = directory.path().join("credentials");
    let config = directory.path().join("config");
    std::fs::write(&credentials,"[fixture]\naws_access_key_id=PROFILE_AKID\naws_secret_access_key=PROFILE_SECRET\naws_session_token=PROFILE_SESSION\n").unwrap();
    std::fs::write(&config, "[profile fixture]\nregion=us-east-2\n").unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "bedrock_profile_child", "--nocapture"])
            .env("MIAO_BEDROCK_PROFILE_CHILD", "1")
            .env("AWS_SHARED_CREDENTIALS_FILE", &credentials)
            .env("AWS_CONFIG_FILE", &config)
            .env("AWS_EC2_METADATA_DISABLED", "true")
            .env_remove("AWS_ACCESS_KEY_ID")
            .env_remove("AWS_SECRET_ACCESS_KEY")
            .env_remove("AWS_SESSION_TOKEN")
            .env_remove("AWS_BEARER_TOKEN_BEDROCK")
            .env_remove("AWS_BEARER_TOKEN")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
}

#[tokio::test]
async fn bedrock_profile_child() {
    if std::env::var("MIAO_BEDROCK_PROFILE_CHILD").ok().as_deref() != Some("1") {
        return;
    }
    let (_provider, mut seen, server, endpoint) = fixture(text_stream()).await;
    let provider = Bedrock::with_chain(
        Some(endpoint),
        "model".into(),
        "us-east-2".into(),
        Some("fixture".into()),
    )
    .unwrap();
    let (progress, _receive) = mpsc::channel(16);
    provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    let (headers, _, _) = seen.recv().await.unwrap();
    assert!(headers["authorization"]
        .to_str()
        .unwrap()
        .starts_with("AWS4-HMAC-SHA256 Credential=PROFILE_AKID/"));
    assert_eq!(headers["x-amz-security-token"], "PROFILE_SESSION");
    assert!(provider
        .protected_resources()
        .iter()
        .any(|path| Some(path.as_os_str())
            == std::env::var_os("AWS_SHARED_CREDENTIALS_FILE").as_deref()));
    let config = tempfile::tempdir().unwrap();
    let manifest = config.path().join("routes.json");
    std::fs::write(&manifest,json!([{"id":"aws/model","provider":"amazon-bedrock","model":"model","credential":{"type":"aws","region":"us-east-2","profile":"fixture"}}]).to_string()).unwrap();
    let credentials =
        std::path::PathBuf::from(std::env::var_os("AWS_SHARED_CREDENTIALS_FILE").unwrap());
    let result = miao_engine::model_routes::load(
        &manifest,
        credentials.parent().unwrap(),
        std::sync::Arc::new(provider),
    )
    .await;
    let error = result
        .err()
        .expect("workspace-owned AWS config must be rejected");
    assert!(error
        .to_string()
        .contains("AWS credential resources must be outside workspace"));
    server.abort();
}

#[tokio::test]
async fn media_bytes_survive_real_sdk_serialization_in_user_and_tool_parts() {
    let (provider, mut seen, server, _endpoint) = fixture(text_stream()).await;
    let png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    let pdf = "JVBERi0xLjcK";
    let mut input = request();
    input.messages[0].content = json!([{"type":"image","mime":"image/png","data":png},{"type":"file","mime":"application/pdf","data":pdf}]);
    input.messages.push(Message {
        role: "assistant".into(),
        content: json!([{"type":"tool_use","id":"previous","name":"read_file","input":{}}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    input.messages.push(Message{role:"user".into(),content:json!([{"type":"tool_result","tool_use_id":"previous","content":[{"type":"file","mime":"application/pdf","data":pdf},{"type":"image","mime":"image/png","data":png}]}]),checkpoint:None,recorded_at_ms:None});
    let (progress, _receive) = mpsc::channel(16);
    provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    let (_, _, body) = seen.recv().await.unwrap();
    assert_eq!(
        body["messages"][0]["content"][0]["image"]["source"]["bytes"],
        png
    );
    assert_eq!(
        body["messages"][0]["content"][1]["document"]["source"]["bytes"],
        pdf
    );
    assert_eq!(
        body["messages"][2]["content"][0]["toolResult"]["content"][0]["document"]["source"]
            ["bytes"],
        pdf
    );
    assert_eq!(
        body["messages"][2]["content"][0]["toolResult"]["content"][1]["image"]["source"]["bytes"],
        png
    );
    server.abort();
}
