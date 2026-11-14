mod common;
use async_trait::async_trait;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Attachment, Delivery, Error, Input, ModelRequest},
    provider::{Anthropic, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

// A 1x1 PNG, base64 without a data: prefix.
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn sse(events: Vec<Value>, done: bool) -> String {
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn anthropic_text(text: &str) -> String {
    sse(
        vec![
            json!({"type":"message_start","message":{"usage":{"input_tokens":5}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":text}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ],
        false,
    )
}
fn chat_text(text: &str) -> String {
    sse(
        vec![
            json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}),
        ],
        true,
    )
}
fn input() -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "what is this".into(),
        delivery: Delivery::Steer,
    }
}

fn pdf_attachment(name: &str, payload: &str) -> Attachment {
    use base64::Engine;
    let mut bytes = b"%PDF-1.4\n".to_vec();
    bytes.extend_from_slice(payload.as_bytes());
    Attachment {
        mime: "application/pdf".into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        metadata: Some(json!({"name": name}).as_object().cloned().unwrap()),
    }
}

async fn wait_runs(store: &Store, session: &str, expected: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let finished = store
                .events(session, 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count();
            if finished >= expected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("runs did not finish");
}

fn workspace_copies(workspace: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(workspace.join(".miao").join("attachments"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

#[tokio::test]
async fn anthropic_and_chat_encode_image_attachments_and_commit_them() {
    for protocol in ["anthropic", "openai-chat"] {
        let reply = if protocol == "anthropic" {
            anthropic_text("ok")
        } else {
            chat_text("ok")
        };
        let (url, mut requests, server) = common::endpoint(vec![(200, reply)]).await;
        let provider: Arc<dyn Provider> = if protocol == "anthropic" {
            Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap())
        } else {
            Arc::new(OpenAIChat::new(url, "fixture".into(), "fixture-model".into()).unwrap())
        };
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::new(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime
            .admit_with(
                input(),
                vec![Attachment {
                    mime: "image/png".into(),
                    data: PNG.into(),
                    metadata: None,
                }],
                true,
            )
            .await
            .unwrap();

        // The promoted user message carries the canonical image part.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if store
                    .history("s")
                    .await
                    .unwrap()
                    .first()
                    .is_some_and(|message| message.content[1]["type"] == "image")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let history = store.history("s").await.unwrap();
        assert_eq!(history[0].content[0]["type"], "text");
        assert_eq!(history[0].content[1]["mime"], "image/png");
        assert_eq!(history[0].content[1]["data"], PNG);

        // The provider receives the image in its own wire format.
        let request = tokio::time::timeout(std::time::Duration::from_secs(5), requests.recv())
            .await
            .unwrap()
            .unwrap();
        if protocol == "anthropic" {
            let blocks = request["messages"][0]["content"].as_array().unwrap();
            assert_eq!(blocks[0]["type"], "text");
            assert_eq!(blocks[1]["type"], "image");
            assert_eq!(blocks[1]["source"]["type"], "base64");
            assert_eq!(blocks[1]["source"]["media_type"], "image/png");
            assert_eq!(blocks[1]["source"]["data"], PNG);
        } else {
            let message = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "user")
                .unwrap();
            let content = message["content"].as_array().unwrap();
            assert_eq!(content[0]["type"], "text");
            assert_eq!(content[1]["type"], "image_url");
            assert!(content[1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,"));
        }
        runtime.shutdown().await;
        server.await.unwrap();
    }
}

#[tokio::test]
async fn attachment_is_part_of_the_admission_identity_and_validated() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_with(
            input(),
            vec![Attachment {
                mime: "image/png".into(),
                data: PNG.into(),
                metadata: None,
            }],
        )
        .await
        .unwrap();
    // An exact retry with the same media reconciles.
    let retry = store
        .admit_with(
            input(),
            vec![Attachment {
                mime: "image/png".into(),
                data: PNG.into(),
                metadata: None,
            }],
        )
        .await
        .unwrap();
    assert!(retry.duplicate);
    // A retry with different media conflicts instead of mutating the prompt.
    assert!(matches!(
        store
            .admit_with(
                input(),
                vec![Attachment {
                    mime: "image/jpeg".into(),
                    data: PNG.into(),
                    metadata: None,
                }],
            )
            .await,
        Err(Error::Conflict)
    ));
    // An unsupported media type is rejected before admission.
    assert!(matches!(
        store
            .admit_with(
                Input {
                    input_id: "two".into(),
                    ..input()
                },
                vec![Attachment {
                    mime: "application/pdf".into(),
                    data: PNG.into(),
                    metadata: None,
                }],
            )
            .await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn image_only_input_keeps_metadata_in_promotion_history_and_retry_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    let metadata = json!({"name":"diagram.png","path":"/client/diagram.png","source":{"start":0,"end":7,"text":"diagram"}});
    let image: Attachment =
        serde_json::from_value(json!({"mime":"image/png","data":PNG,"metadata":metadata})).unwrap();
    let prompt = Input {
        prompt: String::new(),
        ..input()
    };
    store
        .admit_with(prompt.clone(), vec![image.clone()])
        .await
        .unwrap();
    let promoted = store.promote("s", true).await.unwrap();
    assert_eq!(promoted[0].data["attachments"][0]["metadata"], metadata);
    store.close().await.unwrap();
    let reopened = Store::open(&path).await.unwrap();
    let history = reopened.history("s").await.unwrap();
    assert_eq!(history[0].content[1]["metadata"], metadata);
    assert_eq!(history[0].content[1]["data"], PNG);
    assert!(
        reopened
            .admit_with(prompt.clone(), vec![image.clone()])
            .await
            .unwrap()
            .duplicate
    );
    let changed: Attachment = serde_json::from_value(
        json!({"mime":"image/png","data":PNG,"metadata":{"name":"different.png"}}),
    )
    .unwrap();
    assert!(matches!(
        reopened.admit_with(prompt, vec![changed]).await,
        Err(Error::Conflict)
    ));
    let oversized: Attachment = serde_json::from_value(
        json!({"mime":"image/png","data":PNG,"metadata":{"name":"x".repeat(64 * 1024)}}),
    )
    .unwrap();
    assert!(matches!(oversized.validate(), Err(Error::Invalid(_))));
}

#[tokio::test]
async fn capable_models_get_pdf_bytes_materialized_into_the_workspace_and_recover_them() {
    use base64::Engine;
    let (url, mut requests, server) = common::endpoint(vec![
        (200, anthropic_text("one")),
        (200, anthropic_text("two")),
    ])
    .await;
    let provider: Arc<dyn Provider> =
        Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let attachment = pdf_attachment("spec.pdf", "media acceptance fixture");
    runtime
        .admit_with(input(), vec![attachment.clone()], true)
        .await
        .unwrap();
    wait_runs(&store, "s", 1).await;

    let copies = workspace_copies(dir.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert!(copies[0].starts_with(dir.path()));
    assert!(copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("-spec.pdf"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&attachment.data)
        .unwrap();
    assert_eq!(std::fs::read(&copies[0]).unwrap(), bytes);

    // The capable provider still receives the inline document part.
    let request = requests.recv().await.unwrap();
    let blocks = request["messages"][0]["content"].as_array().unwrap();
    let document = blocks
        .iter()
        .find(|block| block["type"] == "document")
        .unwrap();
    assert_eq!(document["source"]["media_type"], "application/pdf");
    assert_eq!(document["source"]["data"], attachment.data);

    let history = store.history("s").await.unwrap();
    assert_eq!(history[0].content[1]["mime"], "application/pdf");
    assert_eq!(history[0].content[1]["data"], attachment.data);
    assert_eq!(history[0].content[1]["metadata"]["name"], "spec.pdf");
    if let Some(path) = history[0].content[1]["metadata"]["path"].as_str() {
        assert!(std::path::Path::new(path).starts_with(dir.path()));
    }

    // Losing the workspace copy loses nothing durable: the next turn rebuilds it.
    std::fs::remove_dir_all(dir.path().join(".miao").join("attachments")).unwrap();
    runtime
        .admit_with(
            Input {
                input_id: "two".into(),
                ..input()
            },
            vec![attachment.clone()],
            true,
        )
        .await
        .unwrap();
    wait_runs(&store, "s", 2).await;
    let copies = workspace_copies(dir.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert_eq!(std::fs::read(&copies[0]).unwrap(), bytes);
    let request = requests.recv().await.unwrap();
    assert!(request.to_string().contains(&attachment.data));
    runtime.shutdown().await;
    server.await.unwrap();
}

#[tokio::test]
async fn capability_mismatch_refuses_media_consistently_and_keeps_bytes_recoverable() {
    use base64::Engine;
    let (url, mut requests, server) =
        common::endpoint(vec![(200, anthropic_text("declined"))]).await;
    let limited: Arc<dyn Provider> = Anthropic::new(url, "fixture".into(), "fixture-model".into())
        .unwrap()
        .with_input_modalities(vec!["text".into()])
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store_path = dir.path().join("engine.db");
    let store = Store::open(&store_path).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        limited,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let image: Attachment = serde_json::from_value(
        json!({"mime":"image/png","data":PNG,"metadata":{"name":"diagram.png"}}),
    )
    .unwrap();
    let pdf = pdf_attachment("spec.pdf", "recovery fixture");
    runtime
        .admit_with(input(), vec![image.clone(), pdf.clone()], true)
        .await
        .unwrap();
    wait_runs(&store, "s", 1).await;

    let wire = requests.recv().await.unwrap().to_string();
    assert!(
        wire.contains(
            "[image attachment omitted: model does not support image input: diagram.png]"
        ),
        "{wire}"
    );
    assert!(
        wire.contains("cannot receive application/pdf directly"),
        "{wire}"
    );
    assert!(wire.contains("read the file with tools"), "{wire}");
    assert!(!wire.contains(&pdf.data), "{wire}");
    assert!(!wire.contains(PNG), "{wire}");

    // The refusal tells the model to read the file with tools, so the bytes
    // still reach the confined workspace even on refusal.
    let copies = workspace_copies(dir.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&pdf.data)
        .unwrap();
    assert_eq!(std::fs::read(&copies[0]).unwrap(), bytes);

    let history = store.history("s").await.unwrap();
    assert_eq!(history[0].content[1]["data"], PNG);
    assert_eq!(history[0].content[2]["mime"], "application/pdf");
    assert_eq!(history[0].content[2]["data"], pdf.data);
    runtime.shutdown().await;
    server.await.unwrap();
    // The retired Runtime still owns a Store connection until it drops, and
    // reopening the same SQLite path BUSYs while it lives; drop both handles
    // before the recovery phase.
    drop(runtime);
    drop(store);

    // A capable runtime over the same durable session sends both media again.
    let (url, mut requests, server) =
        common::endpoint(vec![(200, anthropic_text("recovered"))]).await;
    let capable: Arc<dyn Provider> =
        Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap());
    let reopened = common::open_recovered(&store_path).await;
    let runtime = Runtime::new(
        reopened.clone(),
        capable,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit_with(
            Input {
                input_id: "two".into(),
                ..input()
            },
            vec![image.clone(), pdf.clone()],
            true,
        )
        .await
        .unwrap();
    wait_runs(&reopened, "s", 2).await;
    let blocks = requests.recv().await.unwrap()["messages"][0]["content"]
        .as_array()
        .unwrap()
        .to_vec();
    let image_block = blocks
        .iter()
        .find(|block| block["type"] == "image")
        .unwrap();
    assert_eq!(image_block["source"]["data"], PNG);
    let document = blocks
        .iter()
        .find(|block| block["type"] == "document")
        .unwrap();
    assert_eq!(document["source"]["data"], pdf.data);
    runtime.shutdown().await;
    server.await.unwrap();
}

#[tokio::test]
async fn unsupported_media_is_rejected_before_any_durable_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let zip: Attachment =
        serde_json::from_value(json!({"mime":"application/zip","data":"QQ=="})).unwrap();
    assert!(matches!(
        store.admit_with(input(), vec![zip]).await,
        Err(Error::Invalid(message)) if message == "unsupported attachment media type"
    ));
    let mislabelled: Attachment =
        serde_json::from_value(json!({"mime":"application/pdf","data":PNG})).unwrap();
    assert!(matches!(
        store.admit_with(input(), vec![mislabelled]).await,
        Err(Error::Invalid(message)) if message == "PDF attachment has no PDF header"
    ));
    let oversized: Attachment =
        serde_json::from_value(json!({"mime":"image/png","data":"A".repeat(8 * 1024 * 1024 + 1)}))
            .unwrap();
    assert!(matches!(
        store.admit_with(input(), vec![oversized]).await,
        Err(Error::Invalid(message)) if message == "attachment data must be 1..8 MiB"
    ));
    let binary_text: Attachment =
        serde_json::from_value(json!({"mime":"text/plain","data":"//4="})).unwrap();
    assert!(matches!(
        store.admit_with(input(), vec![binary_text]).await,
        Err(Error::Invalid(message)) if message == "text attachment must be UTF-8"
    ));
    let image: Attachment = serde_json::from_value(json!({"mime":"image/png","data":PNG})).unwrap();
    assert!(matches!(
        store.admit_with(input(), vec![image.clone(); 9]).await,
        Err(Error::Invalid(message)) if message == "attachment count limit"
    ));

    assert!(store.events("s", 0, 100).await.unwrap().is_empty());
    assert!(store.history("s").await.unwrap().is_empty());

    // The same durable identity still admits once the media is valid.
    let admission = store.admit_with(input(), vec![image]).await.unwrap();
    assert!(!admission.duplicate);
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
}

struct Waiting;

#[async_trait]
impl Provider for Waiting {
    async fn stream(
        &self,
        _: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Reply, ProviderError> {
        cancel.cancelled().await;
        Ok(Reply {
            content: json!([]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

#[tokio::test]
async fn cancelling_a_media_turn_leaves_durable_attachments_and_the_workspace_copy_intact() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Waiting),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let attachment = pdf_attachment("spec.pdf", "cancel fixture");
    runtime
        .admit_with(input(), vec![attachment.clone()], true)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            // materialize_files runs while the provider request is built, just
            // before stream; waiting for the copy makes the cancel land
            // mid-turn by construction instead of racing the drain.
            let materialized = std::fs::read_dir(dir.path().join(".miao").join("attachments"))
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
            if materialized {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while store.active_run("s").await.unwrap().is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let copies = workspace_copies(dir.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&attachment.data)
        .unwrap();
    assert_eq!(std::fs::read(&copies[0]).unwrap(), bytes);

    let history = store.history("s").await.unwrap();
    assert_eq!(history[0].content[1]["mime"], "application/pdf");
    assert_eq!(history[0].content[1]["data"], attachment.data);

    // The cancelled identity still reconciles an exact retry.
    let retry = store
        .admit_with(input(), vec![attachment.clone()])
        .await
        .unwrap();
    assert!(retry.duplicate);
    runtime.shutdown().await;
}

#[tokio::test]
async fn large_admission_frames_survive_stdio_and_oversized_frames_are_refused_in_place() {
    use base64::Engine;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let dir = tempfile::tempdir().unwrap();
    let payload = format!("%PDF-1.4\n{}", "m".repeat(900 * 1024));
    let data = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
    assert!(data.len() > 1024 * 1024);
    let mut process = tokio::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
            "--endpoint",
            "http://127.0.0.1:1",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = process.stdin.take().unwrap();
    let mut stdout = tokio::io::BufReader::new(process.stdout.take().unwrap());

    let admit = json!({
        "id":1,
        "method":"admit",
        "params":{
            "input":{"session_id":"s","input_id":"one","prompt":"carry"},
            "resume":true,
            "attachments":[
                {"mime":"application/pdf","data":data,"metadata":{"name":"big.pdf"}}
            ],
        },
    });
    stdin
        .write_all(format!("{admit}\n").as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).await.unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["id"], 1);
    assert!(reply.get("error").is_none(), "{reply}");

    // A legal frame beyond 1 MiB is preserved end-to-end, bytes intact.
    let promoted = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            stdin
                .write_all(
                    b"{\"id\":2,\"method\":\"events\",\"params\":{\"session_id\":\"s\",\"after\":0}}\n",
                )
                .await
                .unwrap();
            stdin.flush().await.unwrap();
            let mut line = String::new();
            stdout.read_line(&mut line).await.unwrap();
            let reply: Value = serde_json::from_str(line.trim()).unwrap();
            if reply["result"]
                .as_array()
                .is_some_and(|events| {
                    events
                        .iter()
                        .any(|event| event["kind"] == "input.promoted")
                })
            {
                return reply;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let event = promoted["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["kind"] == "input.promoted")
        .unwrap();
    assert_eq!(event["data"]["attachments"][0]["mime"], "application/pdf");
    assert_eq!(
        event["data"]["attachments"][0]["data"].as_str(),
        Some(data.as_str())
    );

    // An oversized frame is refused with the id read from its head.
    let oversized = format!(
        "{{\"id\":\"big\",\"method\":\"admit\",\"params\":{{\"pad\":\"{}\"}}}}\n",
        "a".repeat(16 * 1024 * 1024 + 1024)
    );
    stdin.write_all(oversized.as_bytes()).await.unwrap();
    stdin.flush().await.unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).await.unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["id"], "big");
    assert_eq!(reply["error"]["code"], "request_too_large");

    // The engine keeps serving after refusing the frame.
    stdin
        .write_all(
            b"{\"id\":3,\"method\":\"events\",\"params\":{\"session_id\":\"s\",\"after\":0}}\n",
        )
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).await.unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["id"], 3);
    assert!(reply.get("result").is_some(), "{reply}");

    stdin
        .write_all(b"{\"id\":4,\"method\":\"shutdown\"}\n")
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    drop(stdin);
    let output = process.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn tool_reply(protocol: &str, name: &str, input: Value) -> String {
    match protocol {
        "anthropic" => sse(
            vec![
                json!({"type":"message_start","message":{"usage":{"input_tokens":5}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":format!("call_{name}"),"name":name,"input":input}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}),
                json!({"type":"message_stop"}),
            ],
            false,
        ),
        "openai-chat" => sse(
            vec![
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call_{name}"),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
            ],
            true,
        ),
        "responses" => sse(
            vec![
                json!({"type":"response.created","response":{"id":"one","status":"in_progress"}}),
                json!({"type":"response.completed","response":{"id":"one","status":"completed","output":[{"type":"function_call","id":"fc","call_id":format!("call_{name}"),"name":name,"arguments":input.to_string()}],"usage":{"input_tokens":5,"output_tokens":3}}}),
            ],
            false,
        ),
        "gemini" => sse(
            vec![
                json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"name":name,"args":input}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}),
            ],
            false,
        ),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn local_image_tool_attaches_pixels_to_all_provider_protocols() {
    use base64::Engine;
    for protocol in ["anthropic", "openai-chat", "responses", "gemini"] {
        let final_reply = match protocol {
            "anthropic" => anthropic_text("ok"),
            "openai-chat" => chat_text("ok"),
            "responses" => sse(
                vec![
                    json!({"type":"response.created","response":{"id":"two","status":"in_progress"}}),
                    json!({"type":"response.completed","response":{"id":"two","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":5,"output_tokens":3}}}),
                ],
                false,
            ),
            "gemini" => sse(
                vec![
                    json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}),
                ],
                false,
            ),
            _ => unreachable!(),
        };
        let (url, mut requests, server) = common::endpoint(vec![
            (
                200,
                tool_reply(protocol, "read_image", json!({"path":"frame.png"})),
            ),
            (200, final_reply),
        ])
        .await;
        let provider: Arc<dyn Provider> = match protocol {
            "anthropic" => {
                Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap())
            }
            "openai-chat" => {
                Arc::new(OpenAIChat::new(url, "fixture".into(), "fixture-model".into()).unwrap())
            }
            "responses" => Arc::new(
                miao_engine::openai_responses::OpenAIResponses::new(
                    url,
                    "fixture".into(),
                    "fixture-model".into(),
                )
                .unwrap(),
            ),
            "gemini" => Arc::new(
                miao_engine::gemini::Gemini::new(url, "fixture".into(), "fixture-model".into())
                    .unwrap(),
            ),
            _ => unreachable!(),
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("frame.png"),
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap(),
        )
        .unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::new(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime.admit(input(), true).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if store
                    .events("s", 0, 100)
                    .await
                    .unwrap()
                    .iter()
                    .any(|event| event.kind == "run.finished")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let history = store.history("s").await.unwrap();
        assert!(
            history.len() >= 4,
            "{protocol}: {history:?}; events: {:?}",
            store.events("s", 0, 100).await.unwrap()
        );
        requests.recv().await.unwrap();
        let request = requests.recv().await.unwrap();
        assert_eq!(
            history[2].content[0]["type"], "tool_result",
            "{protocol}: {history:?}"
        );
        assert!(!history[2].content[0]["content"]
            .as_str()
            .unwrap()
            .contains(PNG));
        assert_eq!(history[2].content[1]["type"], "image");
        assert_eq!(history[2].content[1]["data"], PNG);
        // The actual provider wire request contains pixels, not a base64 text receipt.
        let wire = request.to_string();
        assert!(wire.contains(PNG), "{protocol}: {request}");
        assert!(
            wire.contains(match protocol {
                "anthropic" => "media_type",
                "openai-chat" => "image_url",
                "responses" => "input_image",
                "gemini" => "inline_data",
                _ => unreachable!(),
            }),
            "{protocol}: {request}"
        );
        assert_eq!(history.last().unwrap().content[0]["text"], "ok");
        let receipt = store
            .events("s", 0, 100)
            .await
            .unwrap()
            .into_iter()
            .find(|event| event.kind == "tool.completed")
            .unwrap();
        assert_eq!(receipt.data["result"]["image_attached"], true);
        assert!(!receipt.data.to_string().contains(PNG));
        runtime.shutdown().await;
        server.await.unwrap();
    }
}

#[tokio::test]
async fn image_reader_bounds_files_and_rejects_non_images() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    std::fs::write(dir.path().join("fake.png"), "plain text").unwrap();
    assert!(tools
        .execute(
            "read_image",
            json!({"path":"fake.png"}),
            tokio_util::sync::CancellationToken::new()
        )
        .await
        .is_err());
    std::fs::File::create(dir.path().join("large.png"))
        .unwrap()
        .set_len(4 * 1024 * 1024 + 1)
        .unwrap();
    assert!(tools
        .execute(
            "read_image",
            json!({"path":"large.png"}),
            tokio_util::sync::CancellationToken::new()
        )
        .await
        .is_err());
    assert!(tools
        .prepare("read_image", json!({"path":"../outside.png"}))
        .await
        .is_err());
    let skill = tools
        .execute(
            "load_skill",
            json!({"name":"media-observe"}),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(skill["content"].as_str().unwrap().contains("ffmpeg"));
    assert_eq!(skill["tool_mapping"]["read_images"], "read_image");
    assert!(tools
        .execute(
            "load_skill",
            json!({"name":"missing"}),
            tokio_util::sync::CancellationToken::new()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn project_skills_load_by_name_and_list_sampled_files() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let skills = dir.path().join("skills/demo");
    std::fs::create_dir_all(skills.join("scripts")).unwrap();
    std::fs::write(
        skills.join("SKILL.md"),
        "---\nname: demo\ndescription: demo skill\n---\n# Demo\n\nRun scripts/run.sh.\n",
    )
    .unwrap();
    std::fs::write(skills.join("scripts/run.sh"), "echo demo\n").unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_skill_directories(vec![miao_engine::context::SkillDirectory {
            path: skills.to_string_lossy().into_owned(),
        }])
        .unwrap();
    let skill = tools
        .execute(
            "load_skill",
            json!({"name":"demo"}),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(skill["name"], "demo");
    assert_eq!(skill["content"], "# Demo\n\nRun scripts/run.sh.\n");
    assert_eq!(skill["files"], json!(["scripts/run.sh"]));
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires ffmpeg; run explicitly on a build host"]
async fn actual_video_skill_bash_frame_and_provider_pixels_workflow() {
    use base64::Engine;
    use miao_engine::permission::{Config, Decision, Mode, Policy, Rule};
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let generated = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x90:d=1",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(workspace.join("source.mp4"))
        .status()
        .unwrap();
    assert!(generated.success());
    let (url,mut requests,server) = common::endpoint(vec![
        (200,tool_reply("anthropic","load_skill",json!({"name":"media-observe"}))),
        (200,tool_reply("anthropic","bash",json!({"command":"ffmpeg -hide_banner -loglevel error -y -ss 0 -i source.mp4 -frames:v 1 frame.png"}))),
        (200,tool_reply("anthropic","read_image",json!({"path":"frame.png"}))),
        (200,anthropic_text("observed")),
    ]).await;
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Anthropic::new(url, "fixture".into(), "fixture-model".into()).unwrap()),
        Tools::new(&workspace)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let history = store.history("s").await.unwrap();
    assert_eq!(
        history.last().unwrap().content[0]["text"],
        "observed",
        "{history:?}"
    );
    let pixels = base64::engine::general_purpose::STANDARD
        .encode(std::fs::read(workspace.join("frame.png")).unwrap());
    let mut wire = Vec::new();
    for _ in 0..4 {
        wire.push(requests.recv().await.unwrap());
    }
    assert!(wire[0].to_string().contains("media-observe"));
    assert!(!wire[0].to_string().contains("Timestamped contact sheet"));
    assert!(wire[1].to_string().contains("ffmpeg"));
    assert!(wire[3].to_string().contains(&pixels));
    runtime.shutdown().await;
    server.await.unwrap();
}
