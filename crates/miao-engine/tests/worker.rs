use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    question::Answer,
    runtime::Runtime,
    store::Store,
    tools::{ToolError, Tools},
    worker::Registry,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

async fn send(write: &mut (impl AsyncWriteExt + Unpin), message: &Value) {
    let mut line = serde_json::to_vec(message).unwrap();
    line.push(b'\n');
    write.write_all(&line).await.unwrap();
    write.flush().await.unwrap();
}
async fn recv(read: &mut (impl AsyncBufReadExt + Unpin)) -> Option<Value> {
    let mut line = String::new();
    if read.read_line(&mut line).await.unwrap() == 0 {
        return None;
    }
    serde_json::from_str(line.trim()).ok()
}

/// A fake worker implementing the ADR-12 revision-2 protocol.
async fn fake_worker(stream: DuplexStream) {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    while let Some(message) = recv(&mut read).await {
        let id = message.get("id").cloned();
        match message["method"].as_str().unwrap_or_default() {
            "hello" => {
                send(
                    &mut write,
                    &json!({"id":id,"result":{"protocol":2,"operations":["tool.list","tool.call","shutdown"]}}),
                )
                .await
            }
            "tool.list" => {
                send(
                    &mut write,
                    &json!({"id":id,"result":{"tools":[{
                        "name":"echo",
                        "description":"Echo a string",
                        "input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}
                    }]}}),
                )
                .await
            }
            "tool.call" => {
                let text = message["params"]["input"]["text"].clone();
                if text == "fail" {
                    send(&mut write, &json!({"id":id,"error":{"code":"fixture_error"}})).await;
                    continue;
                }
                if text == "ask" {
                    // Protocol 2: request an interactive permission decision
                    // mid-call, then surface the operator's answer.
                    send(
                        &mut write,
                        &json!({"id":9001,"method":"ask","params":{"permission":"network","patterns":["api.example.com"],"metadata":{"tool":"echo"}}}),
                    )
                    .await;
                    loop {
                        let frame = recv(&mut read).await.unwrap();
                        if frame.get("id").and_then(Value::as_u64) == Some(9001) {
                            let approved = frame
                                .get("result")
                                .and_then(|result| result.get("approved"))
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            send(
                                &mut write,
                                &json!({"id":id,"result":{"result":{"asked":true,"approved":approved}}}),
                            )
                            .await;
                            break;
                        }
                    }
                    continue;
                }
                send(&mut write, &json!({"id":id,"result":{"result":{"echoed":text}}})).await
            }
            _ => {}
        }
    }
}

async fn registry(workspace: &std::path::Path) -> Arc<Registry> {
    let (client, server) = tokio::io::duplex(1 << 16);
    let (client_read, client_write) = tokio::io::split(client);
    tokio::spawn(fake_worker(server));
    Arc::new(
        Registry::connect_io(client_read, client_write, workspace)
            .await
            .unwrap(),
    )
}

#[tokio::test]
async fn worker_lists_and_calls_a_tool() {
    let workspace = tempfile::tempdir().unwrap();
    let registry = registry(workspace.path()).await;
    let names: Vec<String> = registry
        .definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert_eq!(names, vec!["worker__echo"]);
    assert_eq!(
        registry.resource("worker__echo").as_deref(),
        Some("@worker/echo")
    );
    let output = registry
        .call(
            "worker__echo",
            json!({"text":"hi"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output["echoed"], "hi");
    // Input that does not satisfy the tool schema is rejected.
    assert!(registry
        .call("worker__echo", json!({}), CancellationToken::new())
        .await
        .is_err());
    assert!(registry
        .call(
            "worker__echo",
            json!({"text":"fail"}),
            CancellationToken::new()
        )
        .await
        .is_err());
    assert!(
        !registry.definitions().is_empty(),
        "a valid tool error is not a transport failure"
    );
    let next = registry
        .call(
            "worker__echo",
            json!({"text":"again"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(next["echoed"], "again");
}

struct Caller;
#[async_trait]
impl Provider for Caller {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"c","name":"worker__echo","input":{"text":"hi"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_mcp: true,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

#[tokio::test]
async fn worker_call_passes_runtime_authorization() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_worker(registry(&workspace).await);
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Caller), tools, policy())
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "call".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history("s").await.unwrap();
                return serde_json::from_str::<Value>(
                    history[2].content[0]["content"].as_str().unwrap(),
                )
                .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    assert_eq!(result["echoed"], "hi", "{result}");
}

#[derive(Clone, Copy)]
enum Fault {
    NoReads,
    Oversized,
    Truncated,
}

async fn faulty_registry(
    workspace: &std::path::Path,
    fault: Fault,
) -> (Arc<Registry>, tokio::task::JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(128);
    let task = tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(server);
        let mut read = BufReader::new(read);
        let hello = recv(&mut read).await.unwrap();
        send(&mut write, &json!({"id":hello["id"],"result":{"protocol":2,"operations":["tool.list","tool.call","shutdown"]}})).await;
        let list = recv(&mut read).await.unwrap();
        send(&mut write, &json!({"id":list["id"],"result":{"tools":[{"name":"echo","description":"fixture","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}]}})).await;
        match fault {
            Fault::NoReads => {
                // Keep the transport open but stop reading. A sufficiently large
                // call blocks write_all; cancellation must cover that phase.
                std::future::pending::<()>().await;
                drop((read, write));
            }
            Fault::Oversized => {
                recv(&mut read).await.unwrap();
                // No newline: an unbounded read_line would wait and accumulate
                // past the advertised limit rather than reject immediately.
                let _ = write.write_all(&vec![b'x'; 256 * 1024 + 1]).await;
                std::future::pending::<()>().await;
                drop((read, write));
            }
            Fault::Truncated => {
                recv(&mut read).await.unwrap();
                write.write_all(b"{\"id\":3,\"result\":").await.unwrap();
            }
        }
    });
    let (read, write) = tokio::io::split(client);
    let registry = Arc::new(Registry::connect_io(read, write, workspace).await.unwrap());
    (registry, task)
}

#[tokio::test]
async fn oversized_unterminated_frame_is_rejected_before_allocation_grows() {
    let workspace = tempfile::tempdir().unwrap();
    let (registry, peer) = faulty_registry(workspace.path(), Fault::Oversized).await;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        registry.call(
            "worker__echo",
            json!({"text":"hi"}),
            CancellationToken::new(),
        ),
    )
    .await;
    peer.abort();
    assert!(result
        .expect("oversized frame must fail without waiting for newline")
        .is_err());
    assert!(
        registry.definitions().is_empty(),
        "failed worker remains advertised"
    );
}

#[tokio::test]
async fn cancellation_interrupts_a_call_blocked_on_outbound_write() {
    let workspace = tempfile::tempdir().unwrap();
    let (registry, peer) = faulty_registry(workspace.path(), Fault::NoReads).await;
    let cancel = CancellationToken::new();
    let call = registry.call(
        "worker__echo",
        json!({"text":"x".repeat(128 * 1024)}),
        cancel.clone(),
    );
    tokio::pin!(call);
    tokio::select! {
        result = &mut call => panic!("call should be blocked, not {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {},
    }
    cancel.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut call).await;
    peer.abort();
    assert!(matches!(
        result.expect("blocked write ignored cancellation"),
        Err(ToolError::Interrupted)
    ));
    assert!(registry.definitions().is_empty());
}

#[tokio::test(start_paused = true)]
async fn timeout_degrades_worker_without_leaving_a_reusable_partial_transport() {
    let workspace = tempfile::tempdir().unwrap();
    let (registry, peer) = faulty_registry(workspace.path(), Fault::NoReads).await;
    let result = registry
        .call(
            "worker__echo",
            json!({"text":"hi"}),
            CancellationToken::new(),
        )
        .await;
    peer.abort();
    assert!(result.is_err());
    assert!(registry.definitions().is_empty());
    assert!(registry.resource("worker__echo").is_none());
    assert!(registry
        .call(
            "worker__echo",
            json!({"text":"hi"}),
            CancellationToken::new()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn truncated_frame_degrades_the_worker() {
    let workspace = tempfile::tempdir().unwrap();
    let (registry, peer) = faulty_registry(workspace.path(), Fault::Truncated).await;
    assert!(registry
        .call(
            "worker__echo",
            json!({"text":"hi"}),
            CancellationToken::new()
        )
        .await
        .is_err());
    peer.await.unwrap();
    assert!(registry.definitions().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_stalled_spawned_worker_reaps_its_process() {
    let workspace = tempfile::tempdir().unwrap();
    let hello =
        json!({"id":1,"result":{"protocol":2,"operations":["tool.list","tool.call","shutdown"]}});
    let catalog = json!({"id":2,"result":{"tools":[{"name":"echo","description":"fixture","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}]}});
    let script = format!("printf '%s\n' \"$$\" > pid.txt; read hello; printf '%s\n' '{}'; read list; printf '%s\n' '{}'; exec sleep 60", hello, catalog);
    let registry = Registry::connect(
        miao_engine::worker::Config {
            argv: vec!["sh".into(), "-c".into(), script],
            env: Default::default(),
        },
        workspace.path(),
    )
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(workspace.path().join("pid.txt"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let cancel = CancellationToken::new();
    let call = registry.call(
        "worker__echo",
        json!({"text":"x".repeat(128*1024)}),
        cancel.clone(),
    );
    tokio::pin!(call);
    tokio::select! {
        result = &mut call => panic!("call should block, not {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {},
    }
    cancel.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), &mut call)
        .await
        .expect("spawned worker did not stop");
    assert!(matches!(result, Err(ToolError::Interrupted)));
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "worker process remains alive"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert!(registry.definitions().is_empty());
}

#[tokio::test]
async fn missing_optional_worker_does_not_prevent_engine_admission() {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let config = dir.path().join("worker.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&json!({"argv":[dir.path().join("missing-worker").to_str().unwrap()]}))
            .unwrap(),
    )
    .unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .arg("serve")
        .arg("--db")
        .arg(dir.path().join("engine.db"))
        .arg("--workspace")
        .arg(&workspace)
        .args(["--model", "fixture", "--provider", "openai-responses"])
        .arg("--worker-config")
        .arg(config)
        .env("OPENAI_API_KEY", "fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let lines = format!(
        "{}\n{}\n",
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"admit only"},"resume":false}}),
        json!({"id":2,"method":"shutdown"})
    );
    input.write_all(lines.as_bytes()).await.unwrap();
    drop(input);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let reply: Value = serde_json::from_str(
            &output
                .next_line()
                .await
                .unwrap()
                .expect("engine exited before admission"),
        )
        .unwrap();
        assert_eq!(reply["id"], 1, "{reply}");
        assert_eq!(reply["result"]["pending"], true, "{reply}");
        assert!(child.wait().await.unwrap().success());
        let mut errors = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut errors)
            .await
            .unwrap();
        assert!(errors.contains("extension worker unavailable"), "{errors}");
    })
    .await
    .unwrap();
}

struct Asker;
#[async_trait]
impl Provider for Asker {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"a","name":"worker__echo","input":{"text":"ask"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn answer_pending_question(store: &Store, session: &str, label: &str) {
    loop {
        let events = store.events(session, 0, 500).await.unwrap();
        if let Some(event) = events
            .iter()
            .rev()
            .find(|event| event.kind == "question.requested")
        {
            store
                .answer_question(
                    session,
                    Answer {
                        question_id: event.data["question_id"].as_str().unwrap().into(),
                        input_hash: event.data["input_hash"].as_str().unwrap().into(),
                        answers: vec![vec![label.into()]],
                    },
                )
                .await
                .unwrap();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

async fn run_ask_session(store: &Store, workspace: &std::path::Path) -> Runtime {
    let tools = Tools::new(workspace)
        .await
        .unwrap()
        .with_worker(registry(workspace).await);
    let runtime = Runtime::with_policy(store.clone(), Arc::new(Asker), tools, policy())
        .await
        .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "ask".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    runtime
}

#[tokio::test]
async fn worker_ask_relays_to_the_durable_question_flow() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = run_ask_session(&store, &workspace).await;
    let session = "s".to_string();
    answer_pending_question(&store, &session, "Allow").await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events(&session, 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history(&session).await.unwrap();
                return serde_json::from_str::<Value>(
                    history[2].content[0]["content"].as_str().unwrap(),
                )
                .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(result["asked"], true, "{result}");
    assert_eq!(result["approved"], true, "{result}");
    let events = store.events(&session, 0, 500).await.unwrap();
    let resolved = events
        .iter()
        .find(|event| event.kind == "question.resolved")
        .unwrap();
    assert_eq!(resolved.data["state"], "answered");
    runtime.shutdown().await;
}

#[tokio::test]
async fn worker_ask_denial_surfaces_as_a_denied_answer() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = run_ask_session(&store, &workspace).await;
    let session = "s".to_string();
    answer_pending_question(&store, &session, "Deny").await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events(&session, 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                let history = store.history(&session).await.unwrap();
                return serde_json::from_str::<Value>(
                    history[2].content[0]["content"].as_str().unwrap(),
                )
                .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(result["asked"], true, "{result}");
    assert_eq!(result["approved"], false, "{result}");
    runtime.shutdown().await;
}
