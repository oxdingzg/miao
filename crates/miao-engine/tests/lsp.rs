use async_trait::async_trait;
use miao_engine::{
    lsp::Registry,
    permission::{digest, Config, Decision, Mode, Policy, Rule},
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
    run_with(root, registry, name, input, true).await
}

async fn run_with(
    root: &Path,
    registry: Arc<Registry>,
    name: &'static str,
    input: Value,
    lsp_diagnostics: bool,
) -> Value {
    // A distinct store per call: an exact retry against a shared store would
    // reconcile the first admission and suppress this tool call.
    let store = Store::open(root.join(format!("engine-{name}-{lsp_diagnostics}.db")))
        .await
        .unwrap();
    let tools = Tools::new(root)
        .await
        .unwrap()
        .with_writes(true)
        .with_lsp_diagnostics(lsp_diagnostics)
        .with_lsp(registry);
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
                agent_references: Default::default(),
                command: None,
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
            initialization: None,
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
                    if text == "race" {
                        std::fs::write(&path, "outside").unwrap();
                    }
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":previous,"diagnostics":[{"message":"stale"}]}})).await;
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":version,"diagnostics":[{"message":text}]}})).await;
                }
                "textDocument/definition" => {
                    assert_eq!(message["params"]["textDocument"]["uri"], uri);
                    write_frame(&mut write, &json!({"jsonrpc":"2.0","id":message["id"],"result":{"observed_text":text,"version":version}})).await;
                }
                "shutdown" => {
                    assert_eq!(opens, 1);
                    assert_eq!(version, 4);
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
    let first = registry.diagnostics(&path).await.unwrap();
    assert_eq!(first["diagnostics"][0]["message"], "old");
    assert_eq!(
        first["source"]["sha256"],
        miao_engine::permission::digest(b"old")
    );
    assert_eq!(first["source"]["document_version"], 1);
    assert_eq!(first["source"]["diagnostics_version"], 1);
    assert_eq!(first["source"]["version_verified"], true);
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
    std::fs::write(&path, "race").unwrap();
    let raced = registry.diagnostics(&path).await.unwrap();
    assert_eq!(raced["source"]["stale"], true);
    assert_eq!(raced["source"]["version_verified"], false);
    assert_eq!(
        raced["source"]["current_sha256"],
        miao_engine::permission::digest(b"outside")
    );
    assert!(raced["diagnostics"].as_array().unwrap().is_empty());
    registry.shutdown().await;
    peer.await.unwrap();
}

/// Test fixture language server: records every opened/changed document and
/// publishes one error for it.
async fn reporting_server(
    stream: DuplexStream,
    opened: tokio::sync::mpsc::UnboundedSender<String>,
    message: String,
) {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    while let Some(frame) = read_frame(&mut read).await {
        if let (Some(id), Some(method)) = (frame.get("id"), frame.get("method")) {
            let result = match method.as_str().unwrap_or_default() {
                "initialize" => json!({"capabilities":{}}),
                _ => Value::Null,
            };
            write_frame(
                &mut write,
                &json!({"jsonrpc":"2.0","id":id,"result":result}),
            )
            .await;
            continue;
        }
        match frame["method"].as_str().unwrap_or_default() {
            "textDocument/didOpen" | "textDocument/didChange" => {
                let uri = frame["params"]["textDocument"]["uri"].clone();
                let _ = opened.send(frame["method"].as_str().unwrap_or_default().to_owned());
                write_frame(
                    &mut write,
                    &json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{
                        "uri":uri,
                        "diagnostics":[{
                            "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},
                            "severity":1,
                            "message":message,
                        }]
                    }}),
                )
                .await;
            }
            "shutdown" => {
                write_frame(
                    &mut write,
                    &json!({"jsonrpc":"2.0","id":frame["id"],"result":Value::Null}),
                )
                .await
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn read_file_warms_the_language_server_for_the_next_edit() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file.rs"), "fn main() {}\n").unwrap();
    let (client, server) = tokio::io::duplex(1 << 20);
    let (client_read, client_write) = tokio::io::split(client);
    let (opened, mut events) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(reporting_server(server, opened, "warm fixture".into()));
    let registry = Arc::new(
        Registry::connect_io("rust".into(), vec!["rs".into()], client_read, client_write)
            .await
            .unwrap(),
    );

    let read = run(
        dir.path(),
        registry.clone(),
        "read_file",
        json!({"path":"file.rs"}),
    )
    .await;
    assert!(read["text"].as_str().unwrap().contains("fn main"));
    // The warm-up is fire-and-forget, so wait briefly for the didOpen.
    let opened = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
        .await
        .expect("warm-up opened the document")
        .unwrap();
    assert_eq!(opened, "textDocument/didOpen");

    // The warmed document is cached, so the edit's diagnostics arrive at once.
    let edit = run(
        dir.path(),
        registry.clone(),
        "edit_file",
        json!({
            "path":"file.rs",
            "old_string":"fn main() {}",
            "new_string":"fn main() { let _ = 1; }",
            "expected_sha256": digest(b"fn main() {}\n"),
        }),
    )
    .await;
    assert_eq!(edit["diagnostics"][0]["message"], "warm fixture");
    assert_eq!(edit["diagnostics"][0]["severity"], 1);
    assert_eq!(edit["diagnostics_source"]["sha256"], edit["sha256"]);
    assert_eq!(edit["diagnostics_source"]["matches_applied_revision"], true);
    assert_eq!(
        edit["diagnostics_source"]["version_verified"], false,
        "unversioned server notifications are advisory"
    );

    // The ablation performs no LSP work at all.
    let ablated = run_with(
        dir.path(),
        registry.clone(),
        "edit_file",
        json!({
            "path":"file.rs",
            "old_string":"let _ = 1;",
            "new_string":"let _ = 2;",
            "expected_sha256": digest(b"fn main() { let _ = 1; }\n"),
        }),
        false,
    )
    .await;
    assert!(ablated.get("diagnostics").is_none());
    // The write hook still notifies an already-open document, which is not
    // warm-up work; the ablation must not open (warm) any document itself.
    while let Ok(event) = events.try_recv() {
        assert_ne!(event, "textDocument/didOpen", "the ablation must not warm");
    }
}
