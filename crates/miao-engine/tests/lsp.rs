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
                "textDocument/hover" => json!({"contents":{"kind":"markdown","value":"fn main()"}}),
                "textDocument/implementation" => json!([{"uri":"file:///implementation.rs"}]),
                "textDocument/documentSymbol" => json!([{"name":"main","kind":12}]),
                "workspace/symbol" => {
                    assert_eq!(message["params"]["query"], "main");
                    json!([{"name":"main","kind":12}])
                }
                "textDocument/prepareCallHierarchy" => {
                    json!([{"name":"main","kind":12,"uri":"file:///file.rs","data":{"opaque":"retained"}}])
                }
                "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls" => {
                    assert_eq!(message["params"]["item"]["data"]["opaque"], "retained");
                    json!([{"peer":"caller","fromRanges":[]}])
                }
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

    for (name, expected) in [
        (
            "lsp_hover",
            json!({"contents":{"kind":"markdown","value":"fn main()"}}),
        ),
        (
            "lsp_implementation",
            json!([{"uri":"file:///implementation.rs"}]),
        ),
        ("lsp_document_symbols", json!([{"name":"main","kind":12}])),
        ("lsp_workspace_symbols", json!([{"name":"main","kind":12}])),
        (
            "lsp_call_hierarchy",
            json!([{"name":"main","kind":12,"uri":"file:///file.rs","data":{"opaque":"retained"}}]),
        ),
        (
            "lsp_incoming_calls",
            json!([{"peer":"caller","fromRanges":[]}]),
        ),
        (
            "lsp_outgoing_calls",
            json!([{"peer":"caller","fromRanges":[]}]),
        ),
    ] {
        let input = match name {
            "lsp_document_symbols" => json!({"path":"file.rs"}),
            "lsp_workspace_symbols" => json!({"path":"file.rs","query":"main"}),
            _ => json!({"path":"file.rs","line":0,"character":3}),
        };
        assert_eq!(
            run(dir.path(), registry.clone(), name, input).await,
            expected
        );
    }
    registry.shutdown().await;
}

#[test]
fn lsp_query_rejects_missing_positions_and_foreign_parameters() {
    use miao_engine::lsp::Query;
    assert!(Query::parse("lsp_hover", json!({"path":"file.rs"})).is_err());
    assert!(Query::parse(
        "lsp_hover",
        json!({"path":"file.rs","line":0,"character":0,"query":"x"})
    )
    .is_err());
    assert!(Query::parse("lsp_document_symbols", json!({"path":"file.rs","line":0})).is_err());
    assert!(Query::parse(
        "lsp_workspace_symbols",
        json!({"path":"file.rs","query":"main"})
    )
    .is_ok());
}

#[tokio::test]
#[ignore = "requires installed rust-analyzer; run explicitly on a build host"]
async fn real_rust_analyzer_observes_edited_document() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname=\"lsp-parity-fixture\"\nversion=\"0.0.0\"\nedition=\"2021\"\n",
    )
    .unwrap();
    let path = dir.path().join("src/main.rs");
    std::fs::write(&path, "fn target() {}\nfn main() { target(); }\n").unwrap();
    let registry = Registry::connect(
        vec![miao_engine::lsp::Config {
            name: "rust".into(),
            argv: vec!["rust-analyzer".into()],
            extensions: vec!["rs".into()],
            env: Default::default(),
        }],
        dir.path(),
    )
    .await
    .unwrap();
    // Initial indexing is asynchronous; bounded polling waits for a genuine
    // definition receipt rather than assuming a startup sleep is sufficient.
    let definition = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            if let Ok(value) = registry.definition(&path, 1, 13).await {
                if !value.is_null() && value != json!([]) {
                    break value;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(definition.to_string().contains("main.rs"));
    std::fs::write(&path, "\n\nfn changed() {}\nfn main() { changed(); }\n").unwrap();
    let definition = registry.definition(&path, 3, 13).await.unwrap();
    let items = definition.as_array().unwrap();
    assert!(!items.is_empty());
    let range = items[0]
        .get("targetSelectionRange")
        .or_else(|| items[0].get("range"))
        .unwrap();
    assert_eq!(range["start"]["line"], 2);
    let hover = registry
        .query(
            "lsp_hover",
            &path,
            miao_engine::lsp::Query::parse(
                "lsp_hover",
                json!({"path":"src/main.rs","line":3,"character":13}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(hover.to_string().contains("changed"));
    registry.shutdown().await;
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

#[tokio::test]
async fn edited_documents_refresh_diagnostics_and_queries_without_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("space # unicode-中.rs");
    std::fs::write(&path, "old").unwrap();
    let (client, server) = tokio::io::duplex(1 << 20);
    let (client_read, client_write) = tokio::io::split(client);
    let peer = tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(server);
        let mut read = BufReader::new(read);
        let mut version = 0;
        let mut text = String::new();
        let mut uri = Value::Null;
        let mut opens = 0;
        while let Some(message) = read_frame(&mut read).await {
            match message["method"].as_str().unwrap_or_default() {
                "initialize" => {
                    write_frame(
                        &mut write,
                        &json!({"jsonrpc":"2.0","id":message["id"],"result":{"capabilities":{}}}),
                    )
                    .await
                }
                "textDocument/didOpen" | "textDocument/didChange" => {
                    let previous = version;
                    version = message["params"]["textDocument"]["version"]
                        .as_u64()
                        .unwrap();
                    assert_eq!(version, previous + 1);
                    uri = message["params"]["textDocument"]["uri"].clone();
                    assert!(uri.as_str().unwrap().contains("space%20%23%20unicode-"));
                    assert_eq!(
                        reqwest::Url::parse(uri.as_str().unwrap())
                            .unwrap()
                            .to_file_path()
                            .unwrap(),
                        path
                    );
                    text = if message["method"] == "textDocument/didOpen" {
                        opens += 1;
                        message["params"]["textDocument"]["text"]
                            .as_str()
                            .unwrap()
                            .to_owned()
                    } else {
                        message["params"]["contentChanges"][0]["text"]
                            .as_str()
                            .unwrap()
                            .to_owned()
                    };
                    // Stale versioned diagnostics must not replace the new result.
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":previous,"diagnostics":[{"message":"stale"}]}})).await;
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":version,"diagnostics":[{"message":text}]}})).await;
                }
                "textDocument/definition" => {
                    assert_eq!(message["params"]["textDocument"]["uri"], uri);
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","id":message["id"],"result":{"observed_text":text,"version":version}})).await;
                }
                "shutdown" => {
                    assert_eq!(opens, 1);
                    assert_eq!(version, 3);
                    return;
                }
                _ => {}
            }
        }
        panic!("transport closed without shutdown");
    });
    let registry =
        Registry::connect_io("rust".into(), vec!["rs".into()], client_read, client_write)
            .await
            .unwrap();
    let path = dir.path().join("space # unicode-中.rs");
    assert_eq!(
        registry.diagnostics(&path).await.unwrap()["diagnostics"][0]["message"],
        "old"
    );
    assert_eq!(
        registry.diagnostics(&path).await.unwrap()["diagnostics"][0]["message"],
        "old"
    );
    std::fs::write(&path, "edited").unwrap();
    assert_eq!(
        registry.definition(&path, 0, 0).await.unwrap()["observed_text"],
        "edited"
    );
    // A query may consume the notification before diagnostics is requested.
    assert_eq!(
        registry.diagnostics(&path).await.unwrap()["diagnostics"][0]["message"],
        "edited"
    );
    std::fs::write(&path, "final").unwrap();
    assert_eq!(
        registry.diagnostics(&path).await.unwrap()["diagnostics"][0]["message"],
        "final"
    );
    registry.shutdown().await;
    peer.await.unwrap();
}
