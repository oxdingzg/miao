use async_trait::async_trait;
use miao_engine::{
    lsp::Registry,
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

struct Executor {
    name: &'static str,
    input: Value,
}
#[async_trait]
impl Provider for Executor {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":self.name,"input":self.input}]),
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
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn write_frame(write: &mut (impl AsyncWriteExt + Unpin), message: &Value) {
    let body = serde_json::to_vec(message).unwrap();
    write
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .unwrap();
    write.write_all(&body).await.unwrap();
    write.flush().await.unwrap();
}
async fn read_frame(read: &mut (impl AsyncBufReadExt + Unpin)) -> Option<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if read.read_line(&mut line).await.unwrap() == 0 {
            return None;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            length = rest.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0u8; length?];
    read.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).ok()
}

/// A deterministic language server over the injected transport.
async fn fake_server(stream: DuplexStream) {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    while let Some(message) = read_frame(&mut read).await {
        if let (Some(id), Some(method)) = (message.get("id"), message.get("method")) {
            let result = match method.as_str().unwrap_or_default() {
                "initialize" => json!({"capabilities":{}}),
                "textDocument/definition" => json!([{
                    "uri":"file:///file.rs",
                    "range":{"start":{"line":3,"character":4},"end":{"line":3,"character":8}}
                }]),
                "textDocument/references" => json!([{
                    "uri":"file:///file.rs",
                    "range":{"start":{"line":1,"character":0},"end":{"line":1,"character":3}}
                }]),
                _ => Value::Null,
            };
            write_frame(
                &mut write,
                &json!({"jsonrpc":"2.0","id":id,"result":result}),
            )
            .await;
            continue;
        }
        if message.get("method") == Some(&json!("textDocument/didOpen")) {
            let uri = message["params"]["textDocument"]["uri"].clone();
            write_frame(
                &mut write,
                &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{
                    "uri":uri,
                    "diagnostics":[{
                        "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},
                        "severity":2,
                        "message":"fixture diagnostic",
                        "source":"fixture"
                    }]
                }}),
            )
            .await;
        }
    }
}

async fn run(root: &Path, registry: Arc<Registry>, name: &'static str, input: Value) -> Value {
    // A distinct store per call: an exact retry against a shared store would
    // reconcile the first admission and suppress this tool call.
    let store = Store::open(root.join(format!("engine-{name}.db")))
        .await
        .unwrap();
    let tools = Tools::new(root).await.unwrap().with_lsp(registry);
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Executor { name, input }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "query".into(),
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
                .any(|e| e.kind == "run.finished")
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
    // Keep the shared registry alive across calls; the runtime shutdown would
    // otherwise send LSP shutdown/exit to the fixture server.
    std::mem::forget(runtime);
    result
}

#[tokio::test]
async fn lsp_tools_query_a_language_server() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file.rs"), "fn main() {}\n").unwrap();
    let (client, server) = tokio::io::duplex(1 << 20);
    let (client_read, client_write) = tokio::io::split(client);
    tokio::spawn(fake_server(server));
    let registry = Arc::new(
        Registry::connect_io("rust".into(), vec!["rs".into()], client_read, client_write)
            .await
            .unwrap(),
    );

    let diagnostics = run(
        dir.path(),
        registry.clone(),
        "lsp_diagnostics",
        json!({"path":"file.rs"}),
    )
    .await;
    assert_eq!(
        diagnostics["diagnostics"][0]["message"],
        "fixture diagnostic"
    );
    assert_eq!(diagnostics["diagnostics"][0]["severity"], 2);

    let definition = run(
        dir.path(),
        registry.clone(),
        "lsp_definition",
        json!({"path":"file.rs","line":3,"character":4}),
    )
    .await;
    assert_eq!(definition[0]["uri"], "file:///file.rs");
    assert_eq!(definition[0]["range"]["start"]["line"], 3);

    let references = run(
        dir.path(),
        registry.clone(),
        "lsp_references",
        json!({"path":"file.rs","line":1,"character":0}),
    )
    .await;
    assert_eq!(references[0]["range"]["start"]["line"], 1);
}

#[tokio::test]
async fn lsp_tools_are_absent_without_a_registry() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let names: Vec<String> = tools
        .definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert!(!names.iter().any(|name| name.starts_with("lsp_")));
}
