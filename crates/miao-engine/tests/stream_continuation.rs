use miao_engine::{
    openai_chat::OpenAIChat,
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};

async fn endpoint(
    bodies: Vec<(String, bool)>,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (send, receive) = mpsc::channel(32);
    let server = tokio::spawn(async move {
        for (body, broken) in bodies {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(stream.read_u8().await.unwrap());
            }
            let headers = String::from_utf8(headers).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap();
            let mut request = vec![0; length];
            stream.read_exact(&mut request).await.unwrap();
            send.send(serde_json::from_slice(&request).unwrap())
                .await
                .unwrap();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()+if broken{128}else{0}).as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
            // Closing below the advertised length exercises reqwest's actual
            // response-body transport rejection rather than a clean SSE EOF.
            stream.shutdown().await.unwrap();
        }
    });
    (url, receive, server)
}

fn fixture(backend: usize, mode: &str) -> String {
    let events = if backend == 0 {
        let mut events =
            vec![json!({"type":"message_start","message":{"usage":{"input_tokens":2}}})];
        if mode == "write" {
            events.extend([
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"write","name":"write_file","input":{"path":"audit","text":"once","expected_sha256":null}}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
                json!({"type":"message_stop"}),
            ]);
        } else if mode.starts_with("invalid-") {
            events.extend([
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":mode,"name":"read_file","input":{}}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
                json!({"type":"message_stop"}),
            ]);
        } else {
            events.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":if mode=="partial"{"PARTIAL"}else{"RECOVERED"}}}));
            if mode == "partial" {
                events.extend([
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"unfinished","name":"write_file","input":{}}}),
                    json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"do-not-retain\","}}),
                ]);
            } else {
                events.extend([
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                    json!({"type":"message_stop"}),
                ]);
            }
        }
        events
    } else {
        let delta = if mode == "write" {
            json!({"tool_calls":[{"index":0,"id":"write","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"audit\",\"text\":\"once\",\"expected_sha256\":null}"}}]})
        } else if mode.starts_with("invalid-") {
            json!({"tool_calls":[{"index":0,"id":mode,"type":"function","function":{"name":"read_file","arguments":"{"}}]})
        } else if mode == "partial" {
            json!({"content":"PARTIAL","tool_calls":[{"index":0,"id":"unfinished","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"do-not-retain\","}}]})
        } else {
            json!({"content":"RECOVERED"})
        };
        vec![
            json!({"choices":[{"index":0,"delta":delta,"finish_reason":if mode=="partial"{Value::Null}else{json!(if mode=="write" || mode.starts_with("invalid-"){"tool_calls"}else{"stop"})}}]}),
        ]
    };
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    if backend == 1 && mode != "partial" {
        format!("{body}data: [DONE]\n\n")
    } else {
        body
    }
}

async fn run(
    backend: usize,
    bodies: Vec<(String, bool)>,
) -> (
    tempfile::TempDir,
    Runtime,
    Store,
    mpsc::Receiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (url, requests, server) = endpoint(bodies).await;
    let provider: Arc<dyn Provider> = if backend == 0 {
        Arc::new(Anthropic::new(url, "fixture".into(), "model".into()).unwrap())
    } else {
        Arc::new(OpenAIChat::new(url, "fixture".into(), "model".into()).unwrap())
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
                session_id: "s".into(),
                input_id: "human".into(),
                prompt: "write once then answer".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
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
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (dir, runtime, store, requests, server)
}

#[tokio::test]
async fn real_transport_recovery_commits_partial_text_and_never_dispatches_unfinished_or_replays_completed_calls(
) {
    for backend in 0..2 {
        let (dir, runtime, store, mut requests, server) = run(
            backend,
            vec![
                (fixture(backend, "write"), false),
                (fixture(backend, "partial"), true),
                (fixture(backend, "answer"), false),
            ],
        )
        .await;
        let events = store.events("s", 0, 1000).await.unwrap();
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
                .filter(|event| event.kind == "tool.planned")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "provider.failed")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "provider.recovery.continuation")
                .count(),
            1
        );
        assert_eq!(
            events.iter().filter(|event| event.kind == "usage").count(),
            3
        );
        assert!(events.iter().any(
            |event| event.kind == "provider.interrupted" && event.data["unexecuted_calls"] == 1
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("audit")).unwrap(),
            "once"
        );
        let history = store.history("s").await.unwrap();
        assert!(history
            .iter()
            .any(|message| message.content[0]["text"] == "PARTIAL"));
        assert_eq!(history.last().unwrap().content[0]["text"], "RECOVERED");
        assert!(!serde_json::to_string(&history)
            .unwrap()
            .contains("do-not-retain"));
        server.await.unwrap();
        let mut captured = Vec::new();
        while let Some(request) = requests.recv().await {
            captured.push(request);
        }
        assert_eq!(captured.len(), 3);
        assert!(captured[2].to_string().contains("PARTIAL"));
        assert!(captured[2]
            .to_string()
            .contains("Previously completed tools remain completed"));
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn three_transport_interruptions_stop_without_refilling_the_allowance() {
    for backend in 0..2 {
        let (_dir, runtime, store, mut requests, server) = run(
            backend,
            (0..3)
                .map(|_| (fixture(backend, "partial"), true))
                .collect(),
        )
        .await;
        let events = store.events("s", 0, 1000).await.unwrap();
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
                .filter(|event| event.kind == "provider.recovery.continuation")
                .count(),
            2
        );
        assert!(events
            .iter()
            .any(|event| event.kind == "provider.recovery.stopped"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "usage" && event.data["partial"] == true)
                .count(),
            3
        );
        if backend == 1 {
            assert!(events
                .iter()
                .filter(|event| event.kind == "usage")
                .all(|event| event.data["usage"].is_null()));
        }
        assert!(!events.iter().any(|event| event.kind == "tool.planned"));
        server.await.unwrap();
        let mut count = 0;
        while requests.recv().await.is_some() {
            count += 1;
        }
        assert_eq!(count, 3);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn clean_eof_with_an_incomplete_message_remains_a_terminal_protocol_failure() {
    for backend in 0..2 {
        let (_dir, runtime, store, mut requests, server) =
            run(backend, vec![(fixture(backend, "partial"), false)]).await;
        let events = store.events("s", 0, 1000).await.unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "failed"
        );
        assert!(!events
            .iter()
            .any(|event| event.kind == "provider.recovery.continuation"));
        server.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn transport_internal_steers_do_not_refill_the_json_correction_budget() {
    for backend in 0..2 {
        let (_dir, runtime, store, mut requests, server) = run(
            backend,
            vec![
                (fixture(backend, "invalid-1"), false),
                (fixture(backend, "partial"), true),
                (fixture(backend, "invalid-2"), false),
                (fixture(backend, "invalid-3"), false),
            ],
        )
        .await;
        let events = store.events("s", 0, 1000).await.unwrap();
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
        assert!(events.iter().any(
            |event| event.kind == "tool.input_recovery.stopped" && event.data["attempts"] == 3
        ));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "provider.recovery.continuation")
                .count(),
            1
        );
        server.await.unwrap();
        let mut count = 0;
        while requests.recv().await.is_some() {
            count += 1;
        }
        assert_eq!(count, 4);
        runtime.shutdown().await;
    }
}
