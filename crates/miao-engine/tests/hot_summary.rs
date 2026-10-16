mod common;
use miao_engine::{
    context_trigger::ContextLimits,
    credential::{Credential, Source},
    gemini::Gemini,
    openai_chat::OpenAIChat,
    openai_responses::{OpenAIResponses, Profile},
    protocol::{Delivery, Input, Message, ModelRequest, ToolDefinition},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

fn responses(output: Value, input: u64) -> String {
    [
        json!({"type":"response.created","response":{"id":"r"}}),
        json!({"type":"response.completed","response":{"status":"completed","output":output,"usage":{"input_tokens":input,"output_tokens":5,"input_tokens_details":{"cached_tokens":0}}}}),
    ].iter().map(|event|format!("data: {event}\n\n")).collect()
}
fn answer(text: &str, input: u64) -> String {
    responses(
        json!([{"type":"message","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}]),
        input,
    )
}
fn request() -> ModelRequest {
    ModelRequest {
        system: "stable system".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"question"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![ToolDefinition {
            name: "write_file".into(),
            description: "write".into(),
            input_schema: json!({"type":"object","properties":{}}),
        }],
    }
}

#[tokio::test]
async fn tool_free_wire_preserves_every_existing_tool_definition_and_prompt() {
    let gemini = format!(
        "data: {}\n\n",
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":"summary"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}})
    );
    let chat = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}})
    );
    for protocol in [
        "anthropic",
        "openai-chat",
        "openai-responses",
        "subscription-responses",
        "gemini",
    ] {
        let frames = match protocol {
            "anthropic" => [
                json!({"type":"message_start","message":{"id":"a","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"summary"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
                json!({"type":"message_stop"}),
            ].iter().map(|event|format!("data: {event}\n\n")).collect(),
            "openai-chat" => chat.clone(),
            "gemini" => gemini.clone(),
            _ => answer("summary", 1),
        };
        let (url, mut captures, server) =
            common::endpoint(vec![(200, frames.clone()), (200, frames)]).await;
        let provider: Arc<dyn Provider> = match protocol {
            "anthropic" => Arc::new(Anthropic::new(url, "key".into(), "m".into()).unwrap()),
            "openai-chat" => Arc::new(OpenAIChat::new(url, "key".into(), "m".into()).unwrap()),
            "gemini" => Arc::new(Gemini::new(url, "key".into(), "m".into()).unwrap()),
            "subscription-responses" => Arc::new(
                OpenAIResponses::with_source(
                    url,
                    Source::Static(Credential::token("token".into(), None)),
                    "m".into(),
                    Profile::Subscription,
                )
                .unwrap(),
            ),
            _ => Arc::new(OpenAIResponses::new(url, "key".into(), "m".into()).unwrap()),
        };
        assert!(provider.supports_tool_free_stream());
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let progress = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        provider
            .stream(request(), tx.clone(), CancellationToken::new())
            .await
            .unwrap();
        let reply = provider
            .stream_without_tools(request(), tx, CancellationToken::new())
            .await
            .unwrap();
        assert!(!reply.needs_tools);
        progress.await.unwrap();
        let mut original = captures.recv().await.unwrap();
        let mut summary = captures.recv().await.unwrap();
        let mode = if protocol == "gemini" {
            original["toolConfig"]["functionCallingConfig"]["mode"] = json!("NONE");
            summary["toolConfig"]["functionCallingConfig"]["mode"].clone()
        } else {
            summary
                .as_object_mut()
                .unwrap()
                .remove("tool_choice")
                .unwrap()
        };
        assert_eq!(
            mode,
            match protocol {
                "anthropic" => json!({"type":"none"}),
                "gemini" => json!("NONE"),
                _ => json!("none"),
            }
        );
        assert_eq!(
            summary, original,
            "only protocol tool selection may change for {protocol}"
        );
        server.abort();
    }
}

async fn run_compaction(reject_prefix: bool) {
    let malicious = responses(
        json!([{"type":"function_call","call_id":"bad","name":"write_file","arguments":"{\"path\":\"must-not-exist\",\"content\":\"bad\"}"}]),
        1210,
    );
    let mut frames = vec![
        answer("answer", 1200),
        if reject_prefix {
            malicious
        } else {
            answer("prefix summary", 1210)
        },
    ];
    if reject_prefix {
        frames.push(answer("cold summary", 100));
    }
    let (url, mut requests, server) =
        common::endpoint(frames.into_iter().map(|frame| (200, frame)).collect()).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(OpenAIResponses::new(url, "key".into(), "m".into()).unwrap());
    let runtime = Runtime::new(
        store.clone(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_context_limits(Some(ContextLimits {
            window: 2048,
            ratio: 0.4,
            headroom: 512,
            per_pass: 64,
            prune_chars: None,
            prune_total_chars: None,
            protect_turns: 2,
        }))
        .await;
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "first".into(),
                prompt: "complete the task".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    let first = requests.recv().await.unwrap();
    let prefix = requests.recv().await.unwrap();
    assert_eq!(prefix["tool_choice"], "none");
    assert_eq!(prefix["instructions"], first["instructions"]);
    assert_eq!(prefix["tools"], first["tools"]);
    let old = first["input"].as_array().unwrap();
    let new = prefix["input"].as_array().unwrap();
    assert_eq!(&new[..old.len()], old);
    assert_eq!(
        new.len(),
        old.len() + 2,
        "append the settled answer and retention instruction only"
    );
    assert_eq!(prefix["prompt_cache_key"], first["prompt_cache_key"]);
    let events = store.events("s", 0, 1000).await.unwrap();
    assert!(events.iter().any(|event| event.kind == "history.compacted"));
    assert!(!dir.path().join("must-not-exist").exists());
    let usage = events
        .iter()
        .filter(|event| event.kind == "role.provider.completed")
        .collect::<Vec<_>>();
    assert_eq!(usage.len(), if reject_prefix { 2 } else { 1 });
    assert!(usage
        .iter()
        .all(|event| event.data["usage"]["inputTokens"].is_number()));
    let selected = store.selected_history("s").await.unwrap();
    let summary = selected[0].content.to_string();
    if reject_prefix {
        let cold = requests.recv().await.unwrap();
        assert_eq!(cold["tools"], json!([]));
        assert_ne!(cold["instructions"], first["instructions"]);
        assert!(summary.contains("cold summary"));
        assert_eq!(usage[0].data["accepted"], false);
    } else {
        assert!(summary.contains("prefix summary"));
    }
    server.abort();
}

#[tokio::test]
async fn runtime_compacts_with_the_exact_warm_prefix_and_accounts_for_auxiliary_usage() {
    tokio::time::timeout(Duration::from_secs(20), run_compaction(false))
        .await
        .unwrap();
}

#[tokio::test]
async fn an_adapter_ignoring_tool_choice_cannot_execute_tools_and_falls_back_to_cold_summary() {
    tokio::time::timeout(Duration::from_secs(20), run_compaction(true))
        .await
        .unwrap();
}
