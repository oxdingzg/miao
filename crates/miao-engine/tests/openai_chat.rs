mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    protocol::{Message, ModelRequest, ToolDefinition},
    provider::{Provider, ProviderError},
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn request() -> ModelRequest {
    ModelRequest {
        system: String::new(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"read file"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![ToolDefinition {
            name: "read_file".into(),
            description: "Read".into(),
            input_schema: json!({"type":"object"}),
        }],
    }
}
fn frames(events: Vec<Value>, done: bool) -> String {
    let mut body: String = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn chunk(delta: Value, finish: Value) -> Value {
    json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}

#[tokio::test]
async fn text_stream_preserves_usage_after_finish_and_lowers_tool_history() {
    let body = frames(
        vec![
            chunk(json!({"role":"assistant","content":"你好"}), json!(null)),
            chunk(json!({}), json!("stop")),
            json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let mut input = request();
    input.messages.extend([Message{role:"assistant".into(),content:json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),checkpoint:None,recorded_at_ms:None},Message{role:"user".into(),content:json!([{"type":"tool_result","tool_use_id":"call","content":"contents","is_error":false}]),checkpoint:None,recorded_at_ms:None}]);
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "你好");
    assert_eq!(reply.usage["cacheReadInputTokens"], 8);
    let body = requests.recv().await.unwrap();
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"file\"}"
    );
    assert_eq!(body["messages"][2]["role"], "tool");
    assert_eq!(body["messages"][2]["tool_call_id"], "call");
    assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    server.await.unwrap();
}

#[tokio::test]
async fn fragmented_tool_input_is_only_published_after_valid_terminal() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"pa"}}]}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"function":{"arguments":"th\":\"file\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[0]["id"], "call");
    assert_eq!(reply.content[0]["input"]["path"], "file");
    server.await.unwrap();
}

/// A gateway that restarts its stream numbering for the second call must not
/// have its frames appended into the first: that produced one call whose id
/// was two ids and whose name was `write_filewrite_file`.
#[tokio::test]
async fn a_gateway_that_restarts_its_index_keeps_calls_separate() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"one\"}"}}]}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"two\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[0]["id"], "call_a");
    assert_eq!(reply.content[0]["input"]["path"], "one");
    assert_eq!(reply.content[1]["id"], "call_b");
    assert_eq!(reply.content[1]["input"]["path"], "two");
    server.await.unwrap();
}

/// A call preamble repeated on a later frame restates the identity; appending
/// it would double the name and break the arguments it precedes.
#[tokio::test]
async fn a_repeated_call_preamble_does_not_duplicate_the_name() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"pa"}}]}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"th\":\"file\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["id"], "call");
    assert_eq!(reply.content[0]["name"], "read_file");
    assert_eq!(reply.content[0]["input"]["path"], "file");
    server.await.unwrap();
}

/// The gateway serving MiMo lifts small calls out of the model's own
/// `<tool_call>` text but leaves a large argument object there, emitting the
/// call with empty arguments. The reply still contains them.
#[tokio::test]
async fn arguments_written_as_tool_call_text_are_read_back() {
    let body = frames(
        vec![
            chunk(
                json!({"content":"Writing it.\n<tool_call>\n<function=write_file>\n<parameter=path>src/main.rs</parameter>\n<parameter=content>fn main() {}</parameter>\n<parameter=input>{\"nested\":[1,2]}</parameter>\n</function>\n</tool_call>"}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"write_file","arguments":""}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[1]["type"], "tool_use");
    assert_eq!(
        reply.content[1]["input"],
        json!({"path":"src/main.rs","content":"fn main() {}","input":{"nested":[1,2]}})
    );
    server.await.unwrap();
}

/// Only the block naming this call may supply its arguments; borrowing another
/// function's block would execute a call the model never made.
#[tokio::test]
async fn tool_call_text_for_another_function_is_not_borrowed() {
    let body = frames(
        vec![
            chunk(
                json!({"content":"<tool_call><function=write_file><parameter=path>a</parameter></function></tool_call>"}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":""}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.content[1]["input"].is_null());
    assert_eq!(reply.content[1]["input_error"], "invalid_json");
    server.await.unwrap();
}

#[tokio::test]
async fn a_stream_cut_before_done_continues_from_what_arrived() {
    // A gateway that closes the response without `[DONE]` has still streamed
    // the reply; the turn continues from that partial instead of being lost.
    let body = frames(
        vec![chunk(json!({"content":"partial"}), json!("stop"))],
        false,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let result = provider
        .stream(request(), progress, CancellationToken::new())
        .await;
    match result {
        Err(ProviderError::ContinuableTransport { partial, .. }) => {
            assert_eq!(partial.content[0]["text"], "partial");
        }
        other => panic!("expected a continuable partial, got {other:?}"),
    }
    server.await.unwrap();
    assert!(requests.recv().await.is_some());
    assert!(requests.recv().await.is_none());
}

#[tokio::test]
async fn refusal_and_invalid_shapes_never_complete_or_retry() {
    let bodies = [
        frames(vec![chunk(json!({"refusal":"no"}), json!("stop"))], true),
        frames(
            vec![chunk(
                json!({"tool_calls":[{"id":"call","function":{"name":"read_file","arguments":"{}"}}]}),
                json!("tool_calls"),
            )],
            true,
        ),
        frames(
            vec![chunk(json!({"reasoning_content":"opaque"}), json!("stop"))],
            true,
        ),
    ];
    for body in bodies {
        let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
        let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
        let (progress, _receive) = mpsc::channel(64);
        let result = provider
            .stream(request(), progress, CancellationToken::new())
            .await;
        assert!(
            matches!(result, Err(ProviderError::Stream(_))),
            "{result:?}"
        );
        server.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
    }
}

#[tokio::test]
async fn non_object_tool_arguments_are_reported_without_replaying_the_provider() {
    let body = frames(
        vec![chunk(
            json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"[]"}}]}),
            json!("tool_calls"),
        )],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(
        reply.content,
        json!([{"type":"tool_use","id":"call","name":"read_file","input":null,"input_error":"invalid_json"}])
    );
    server.await.unwrap();
    assert!(requests.recv().await.is_some());
    assert!(requests.recv().await.is_none());
}

/// Some gateways close the stream with `[DONE]` and never send a finish
/// reason. The stream is complete, so the turn commits instead of failing
/// after its content was already streamed.
#[tokio::test]
async fn done_without_a_finish_reason_completes_the_reply() {
    let body = frames(
        vec![chunk(
            json!({"role":"assistant","content":"done thinking"}),
            json!(null),
        )],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "done thinking");
    assert!(!reply.needs_tools);
    server.await.unwrap();
}

#[tokio::test]
async fn done_without_a_finish_reason_keeps_the_tool_call_it_carried() {
    let body = frames(
        vec![chunk(
            json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"{\"path\":\"file\"}"}}]}),
            json!(null),
        )],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[0]["name"], "read_file");
    assert_eq!(reply.content[0]["input"]["path"], "file");
    server.await.unwrap();
}

#[tokio::test]
async fn an_unsupported_finish_reason_names_the_reason() {
    let body = frames(
        vec![chunk(json!({"content":"partial"}), json!("content_filter"))],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let error = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, ProviderError::Stream(message) if message.contains("content_filter")),
        "unexpected error: {error:?}"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn unsupported_history_is_rejected_before_any_network_request() {
    let mut request = request();
    request.messages.push(Message {
        role: "assistant".into(),
        content: json!([{"type":"thinking","signature":"opaque"}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let provider = OpenAIChat::new(
        "http://127.0.0.1:1/unused".into(),
        "fixture".into(),
        "model".into(),
    )
    .unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(request, progress, CancellationToken::new())
            .await,
        Err(ProviderError::Stream(_))
    ));
}

#[tokio::test]
async fn reasoning_content_round_trips_and_lowers_back_verbatim() {
    let first = frames(
        vec![
            chunk(
                json!({"role":"assistant","reasoning_content":"先看"}),
                json!(null),
            ),
            chunk(json!({"reasoning_content":" 文件。"}), json!(null)),
            chunk(json!({"content":"done"}), json!(null)),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let second = frames(
        vec![
            chunk(json!({"content":"ok"}), json!(null)),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, first), (200, second)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        reply.content,
        json!([
            {"type":"reasoning","text":"先看 文件。"},
            {"type":"text","text":"done"}
        ])
    );
    let mut follow = request();
    follow.messages.push(Message {
        role: "assistant".into(),
        content: reply.content.clone(),
        checkpoint: None,
        recorded_at_ms: None,
    });
    follow.messages.push(Message {
        role: "user".into(),
        content: json!([{"type":"text","text":"continue"}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(follow, progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(requests.recv().await.is_some());
    let body = requests.recv().await.unwrap();
    assert_eq!(body["messages"][1]["reasoning_content"], "先看 文件。");
    assert_eq!(body["messages"][1]["content"], "done");
    // Reasoning rides on the provider field, never as a native part.
    assert!(!body.to_string().contains("\"reasoning\""));
    server.await.unwrap();
}

#[tokio::test]
async fn deepseek_replays_an_empty_reasoning_field_on_an_unreasoned_turn() {
    let body = frames(
        vec![
            chunk(json!({"content":"ok"}), json!(null)),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "deepseek-flash".into()).unwrap();
    let mut input = request();
    input.messages.extend([
        Message {
            role: "assistant".into(),
            // A tool-only turn from a model that emitted no reasoning at all.
            content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
            checkpoint: None,
            recorded_at_ms: None,
        },
        Message {
            role: "user".into(),
            content: json!([{"type":"tool_result","tool_use_id":"call","content":"contents","is_error":false}]),
            checkpoint: None,
            recorded_at_ms: None,
        },
    ]);
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    let body = requests.recv().await.unwrap();
    // DeepSeek rejects the whole request when the field is missing, so the turn
    // carries it back empty rather than omitting it.
    assert_eq!(body["messages"][1]["reasoning_content"], "");
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["name"],
        "read_file"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn other_routes_gain_no_reasoning_field() {
    let body = frames(
        vec![
            chunk(json!({"content":"ok"}), json!(null)),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let mut input = request();
    input.messages.push(Message {
        role: "assistant".into(),
        content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
        checkpoint: None,
        recorded_at_ms: None,
    });
    let (progress, _receive) = mpsc::channel(64);
    provider
        .stream(input, progress, CancellationToken::new())
        .await
        .unwrap();
    let body = requests.recv().await.unwrap();
    // Only families that require the field see it; every other gateway keeps
    // the request body it had before.
    assert!(body["messages"][1].get("reasoning_content").is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn opaque_reasoning_and_legacy_delta_fields_are_rejected() {
    for (field, value) in [
        ("reasoning_opaque", json!("signature")),
        ("audio", json!({"id":"audio"})),
        (
            "function_call",
            json!({"name":"read_file","arguments":"{}"}),
        ),
    ] {
        let mut delta = serde_json::Map::new();
        delta.insert(field.to_string(), value);
        let body = frames(vec![chunk(Value::Object(delta), json!(null))], true);
        let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
        let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
        let (progress, _receive) = mpsc::channel(64);
        let result = provider
            .stream(request(), progress, CancellationToken::new())
            .await;
        assert!(
            matches!(result, Err(ProviderError::Stream(ref message)) if message.contains("unsupported")),
            "{field}: {}",
            result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default()
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn length_truncation_continues_without_publishing_partial_calls() {
    let truncated_calls = frames(
        vec![
            chunk(json!({"reasoning_content":"thinking"}), json!(null)),
            chunk(json!({"content":"partial"}), json!(null)),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"fi"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("length")),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, truncated_calls)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let error = match provider
        .stream(request(), progress, CancellationToken::new())
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("a truncated reply must not complete"),
    };
    match error {
        ProviderError::ContinuableTransport {
            partial,
            unexecuted_calls,
        } => {
            assert_eq!(unexecuted_calls, 1);
            assert_eq!(
                partial.content,
                json!([
                    {"type":"reasoning","text":"thinking"},
                    {"type":"text","text":"partial"}
                ])
            );
            assert!(!partial.needs_tools);
        }
        other => panic!("expected a bounded continuation, got {other}"),
    }
    assert!(requests.recv().await.is_some());
    server.await.unwrap();
}

#[tokio::test]
async fn length_truncation_with_nothing_salvageable_is_a_transport_failure() {
    let body = frames(vec![chunk(json!({}), json!("length"))], true);
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        provider
            .stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::ResponseTransport)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn oauth_bearer_credentials_reach_chat_bridges_but_not_api_key_routes() {
    use miao_engine::credential::Source;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.json");
    std::fs::write(
        &path,
        json!({"google":{
            "type":"oauth", "access":"oauth-fixture", "refresh":"refresh-fixture",
            "expires":u64::MAX
        }})
        .to_string(),
    )
    .unwrap();
    let body = frames(vec![chunk(json!({"content":"done"}), json!("stop"))], true);
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let source = Source::Legacy {
        path,
        integration: "google".into(),
    };
    let bearer = OpenAIChat::with_source(url.clone(), source.clone(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = bearer
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "done");
    assert_eq!(requests.recv().await.unwrap()["model"], "model");
    server.await.unwrap();
    let key = OpenAIChat::with_azure(url, source, "model".into(), "2024-10-21").unwrap();
    let (progress, _receive) = mpsc::channel(64);
    assert!(matches!(
        key.stream(request(), progress, CancellationToken::new())
            .await,
        Err(ProviderError::AuthProfile)
    ));
}

#[tokio::test]
async fn gateway_rate_limit_is_a_provider_rejection_not_an_invalid_stream() {
    let body = frames(
        vec![
            json!({"error":{"type":"gateway_error","status":429,"message":"The service is rate limiting requests. Retry after 2 seconds."}}),
        ],
        true,
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let error = match provider
        .stream(request(), progress, CancellationToken::new())
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("a rejected request must not complete"),
    };
    assert!(matches!(error, ProviderError::Rejected(_)));
    assert!(error.to_string().contains("HTTP 429"));
    assert!(!error.to_string().contains("invalid provider stream"));
    assert!(requests.recv().await.is_some());
    server.await.unwrap();
}

/// `n` is 1, so the first choice is the answer. The TypeScript protocol reads
/// `choices[0]` the same way and models no `index` at all, so a gateway that
/// omits or renumbers the index — or duplicates the choice — is not a
/// malformed reply.
#[tokio::test]
async fn a_choice_index_and_extra_choices_are_not_fatal() {
    let body = frames(
        vec![
            json!({"choices":[{"delta":{"role":"assistant","content":"first"}}]}),
            json!({"choices":[
                {"index":3,"delta":{"content":" second"},"finish_reason":null},
                {"index":4,"delta":{"content":" duplicate"}}
            ]}),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "first second");
    server.await.unwrap();
}

/// Some gateways flush one more frame after the terminal one. Its text belongs
/// to the same reply, so it is appended instead of failing a turn that already
/// streamed.
#[tokio::test]
async fn content_after_the_terminal_frame_is_kept() {
    let body = frames(
        vec![
            chunk(json!({"content":"answer"}), json!("stop")),
            chunk(json!({"content":" tail"}), json!(null)),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "answer tail");
    server.await.unwrap();
}

/// A gateway that repeats the terminal reason names the same stop again; the
/// newest reason wins, exactly as the TypeScript protocol reads it.
#[tokio::test]
async fn a_repeated_finish_reason_does_not_fail_the_turn() {
    let body = frames(
        vec![
            chunk(json!({"content":"answer"}), json!("stop")),
            chunk(json!({"content":""}), json!("stop")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "answer");
    server.await.unwrap();
}

/// An invalid frame names its own shape: the durable failure record keeps the
/// message but not the response bytes, so the excerpt is the only evidence a
/// later investigation gets.
#[tokio::test]
async fn an_invalid_frame_names_the_frame_it_rejected() {
    let body = frames(vec![json!({"choices":{"0":{}}})], true);
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let error = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, ProviderError::Stream(message) if message.contains("invalid Chat Completions frame") && message.contains("choices")),
        "unexpected error: {error:?}"
    );
    server.await.unwrap();
}

/// Some gateways close with a usage-only frame that has no `choices` key at
/// all. It adds nothing to a reply that already streamed, and failing the turn
/// there would throw away an answer the user can already see.
#[tokio::test]
async fn a_usage_only_frame_without_choices_is_not_fatal() {
    let body = frames(
        vec![
            chunk(json!({"content":"answer"}), json!("stop")),
            json!({"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.content[0]["text"], "answer");
    server.await.unwrap();
}

/// The opencode-go gateway opens a streamed call with a fully null-filled
/// placeholder frame: `"type":null`, `"id":null`, `"name":null`, empty
/// arguments. Reading the explicit null as a non-function type rejected the
/// whole reply, and tracking the placeholder as a call would leave an
/// identity-less call that failed the turn at `finish`.
#[tokio::test]
async fn a_null_filled_tool_call_placeholder_does_not_fail_the_reply() {
    let body = frames(
        vec![
            chunk(
                json!({
                    "content":"",
                    "reasoning_content":null,
                    "role":null,
                    "tool_calls":[{"function":{"arguments":"","name":null},"id":null,"index":0,"type":null}]
                }),
                json!(null),
            ),
            chunk(json!({"content":"ok"}), json!(null)),
            chunk(json!({}), json!("stop")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(!reply.needs_tools);
    assert_eq!(reply.content[0]["text"], "ok");
    assert!(reply
        .content
        .as_array()
        .is_some_and(|parts| parts.iter().all(|part| part["type"] != "tool_use")));
    server.await.unwrap();
}

/// A real call whose first frame carries `"type":null` must still begin; only
/// the frame that names nothing at all is a placeholder.
#[tokio::test]
async fn a_null_type_still_starts_a_named_call() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call_1","type":null,"function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    assert_eq!(reply.content[0]["id"], "call_1");
    assert_eq!(reply.content[0]["input"]["path"], "a");
    server.await.unwrap();
}

/// A gateway that replays a frame repeats the call id. Keeping the first call
/// matches the TypeScript stream, which accumulates by index and never fails a
/// finished reply over a repeated identity.
#[tokio::test]
async fn a_replayed_call_id_keeps_one_call_and_finishes() {
    let body = frames(
        vec![
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]}),
                json!(null),
            ),
            chunk(
                json!({"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]}),
                json!(null),
            ),
            chunk(json!({}), json!("tool_calls")),
        ],
        true,
    );
    let (url, _requests, server) = common::endpoint(vec![(200, body)]).await;
    let provider = OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap();
    let (progress, _receive) = mpsc::channel(64);
    let reply = provider
        .stream(request(), progress, CancellationToken::new())
        .await
        .unwrap();
    assert!(reply.needs_tools);
    let calls = reply
        .content
        .as_array()
        .expect("content")
        .iter()
        .filter(|part| part["type"] == "tool_use")
        .count();
    assert_eq!(calls, 1, "the repeated identity keeps one call");
    server.await.unwrap();
}
