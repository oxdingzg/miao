mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Attachment, Delivery, Error, Input},
    provider::{Anthropic, Provider},
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
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "what is this".into(),
        delivery: Delivery::Steer,
    }
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
                }],
            )
            .await,
        Err(Error::Invalid(_))
    ));
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
        .prepare("load_skill", json!({"name":"missing"}))
        .await
        .is_err());
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
