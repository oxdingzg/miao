use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
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

/// A fake worker implementing the ADR-12 revision-1 protocol.
async fn fake_worker(stream: DuplexStream) {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    while let Some(message) = recv(&mut read).await {
        let id = message.get("id").cloned();
        match message["method"].as_str().unwrap_or_default() {
            "hello" => {
                send(
                    &mut write,
                    &json!({"id":id,"result":{"protocol":1,"operations":["tool.list","tool.call","shutdown"]}}),
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
