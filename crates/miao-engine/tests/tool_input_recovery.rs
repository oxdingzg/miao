mod common;
use miao_engine::{
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn fixture(backend: usize, calls: &[(&str, &str, &str)], text: Option<&str>) -> String {
    let events = match backend {
        0 => {
            let mut events =
                vec![json!({"type":"message_start","message":{"usage":{"input_tokens":1}}})];
            for (index, (id, name, arguments)) in calls.iter().enumerate() {
                events.extend([
                    json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":arguments}}),
                    json!({"type":"content_block_stop","index":index}),
                ]);
            }
            if let Some(text) = text {
                events.extend([
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":text}}),
                    json!({"type":"content_block_stop","index":0}),
                ]);
            }
            events.extend([
                json!({"type":"message_delta","delta":{"stop_reason":if calls.is_empty(){"end_turn"}else{"tool_use"}},"usage":{"output_tokens":1}}),
                json!({"type":"message_stop"}),
            ]);
            events
        }
        1 => {
            let delta = if let Some(text) = text {
                json!({"content":text})
            } else {
                json!({"tool_calls":calls.iter().enumerate().map(|(index,(id,name,arguments))|json!({"index":index,"id":id,"type":"function","function":{"name":name,"arguments":arguments}})).collect::<Vec<_>>()})
            };
            vec![
                json!({"choices":[{"index":0,"delta":delta,"finish_reason":if calls.is_empty(){"stop"}else{"tool_calls"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
            ]
        }
        _ => {
            let output = if let Some(text) = text {
                vec![
                    json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}),
                ]
            } else {
                calls.iter().map(|(id,name,arguments)|json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments,"status":"completed"})).collect()
            };
            vec![
                json!({"type":"response.created","response":{"id":"r"}}),
                json!({"type":"response.completed","response":{"status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":1}}}),
            ]
        }
    };
    let stream = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    if backend == 1 {
        format!("{stream}data: [DONE]\n\n")
    } else {
        stream
    }
}

async fn finished(store: &Store) -> Vec<miao_engine::protocol::Event> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn real_wire_correction_preserves_completed_write_and_durable_error_without_raw_arguments() {
    for backend in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let first = fixture(
            backend,
            &[
                (
                    "write",
                    "write_file",
                    "{\"path\":\"audit\",\"text\":\"once\",\"expected_sha256\":null}",
                ),
                (
                    "invalid-1",
                    "read_file",
                    "{\"path\":\"private-fixture-secret\",",
                ),
            ],
            None,
        );
        let second = fixture(backend, &[("invalid-2", "read_file", "{")], None);
        let third = fixture(
            backend,
            &[("corrected", "read_file", "{\"path\":\"audit\"}")],
            None,
        );
        let last = fixture(backend, &[], Some("RECOVERED"));
        let (url, mut requests, server) =
            common::endpoint(vec![(200, first), (200, second), (200, third), (200, last)]).await;
        let provider: Arc<dyn Provider> = match backend {
            0 => Arc::new(Anthropic::new(url, "fixture".into(), "model".into()).unwrap()),
            1 => Arc::new(OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap()),
            _ => Arc::new(OpenAIResponses::new(url, "fixture".into(), "model".into()).unwrap()),
        };
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::with_policy(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
            Policy::new(Config {
                mode: Mode::Workspace,
                rules: vec![Rule {
                    tool: "write_file".into(),
                    path: "**".into(),
                    decision: Decision::Allow,
                }],
                ..Config::default()
            })
            .unwrap(),
        )
        .await
        .unwrap();
        runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: "human".into(),
                    prompt: "write once then read".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let events = finished(&store).await;
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "completed"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "tool.input_error")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "tool.planned" && event.data["name"] == "write_file")
                .count(),
            1
        );
        assert_eq!(
            events.iter().filter(|event| event.kind == "usage").count(),
            4
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("audit")).unwrap(),
            "once"
        );
        let history = store.history("s").await.unwrap();
        assert_eq!(history[1].content[1]["input_error"], "invalid_json");
        assert!(history[1].content[1]["input"].is_null());
        assert!(!serde_json::to_string(&history)
            .unwrap()
            .contains("private-fixture-secret"));
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("private-fixture-secret"));
        assert_eq!(history.last().unwrap().content[0]["text"], "RECOVERED");
        server.await.unwrap();
        let mut captured = Vec::<Value>::new();
        while let Some(request) = requests.recv().await {
            captured.push(request);
        }
        assert_eq!(captured.len(), 4);
        assert!(captured
            .iter()
            .skip(1)
            .all(|request| !request.to_string().contains("private-fixture-secret")));
        assert!(captured[1]
            .to_string()
            .contains("This call was not executed"));
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn changing_invalid_calls_cannot_bypass_the_two_correction_allowance() {
    for backend in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let bodies = (0..3)
            .map(|index| {
                (
                    200,
                    fixture(
                        backend,
                        &[(
                            if index == 0 {
                                "bad-1"
                            } else if index == 1 {
                                "bad-2"
                            } else {
                                "bad-3"
                            },
                            "read_file",
                            "{",
                        )],
                        None,
                    ),
                )
            })
            .collect();
        let (url, mut requests, server) = common::endpoint(bodies).await;
        let provider: Arc<dyn Provider> = match backend {
            0 => Arc::new(Anthropic::new(url, "fixture".into(), "model".into()).unwrap()),
            1 => Arc::new(OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap()),
            _ => Arc::new(OpenAIResponses::new(url, "fixture".into(), "model".into()).unwrap()),
        };
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::new(
            store.clone(),
            provider,
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: "human".into(),
                    prompt: "read file".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let events = finished(&store).await;
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "failed"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "tool.input_error")
                .count(),
            3
        );
        assert!(events
            .iter()
            .any(|event| event.kind == "tool.input_recovery.stopped"));
        assert!(!events.iter().any(|event| event.kind == "tool.dispatched"));
        server.await.unwrap();
        let mut count = 0;
        while requests.recv().await.is_some() {
            count += 1;
        }
        assert_eq!(count, 3);
        runtime.shutdown().await;
    }
}

struct Ineligible {
    hosted: bool,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl Provider for Ineligible {
    async fn stream(
        &self,
        _: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<miao_engine::provider::Reply, miao_engine::provider::ProviderError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(miao_engine::provider::Reply {
            content: json!([{"type":"tool_use","id":"ineligible","name":if self.hosted{"read_file"}else{"unknown_local_tool"},"input":null,"input_error":"invalid_json","provider_executed":self.hosted}]),
            needs_tools: true,
            usage: json!({}),
        })
    }
}

#[tokio::test]
async fn provider_executed_and_unregistered_calls_are_never_corrected_or_dispatched() {
    for hosted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let provider = Arc::new(Ineligible {
            hosted,
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let runtime = Runtime::new(
            store.clone(),
            provider.clone(),
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: "human".into(),
                    prompt: "read file".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let events = finished(&store).await;
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "failed"
        );
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!events.iter().any(|event| event.kind == "tool.dispatched"
            || event.kind == "tool.input_recovery.continuation"));
        runtime.shutdown().await;
    }
}
