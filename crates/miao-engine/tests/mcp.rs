use miao_engine::{
    mcp::Registry,
    permission::{Access, Config, Decision, Mode, Policy},
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

// A wire-level peer exercises initialization, catalog pagination and calls
// without using the client's own model/dispatch implementation as the oracle.
async fn peer(
    mode: &'static str,
) -> (Arc<Registry>, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(131072);
    let (read, mut write) = tokio::io::split(server);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
                }
                "tools/list" => {
                    let native = if request["params"]["cursor"] == "page2" {
                        "second.tool"
                    } else {
                        "first/tool"
                    };
                    let mut result = json!({"tools":[{"name":native,"description":"Fixture","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}}]});
                    if mode == "duplicate" {
                        let tool = result["tools"][0].clone();
                        result["tools"].as_array_mut().unwrap().push(tool);
                    }
                    if mode == "pages" && native == "first/tool" {
                        result["nextCursor"] = json!("page2");
                    }
                    result
                }
                "tools/call" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    assert!(
                        request["params"]["name"] == "first/tool"
                            || request["params"]["name"] == "second.tool"
                    );
                    if mode == "pending" {
                        continue;
                    }
                    if mode == "disconnect" {
                        break;
                    }
                    let text = if mode == "frame" {
                        "x".repeat(300000)
                    } else if mode == "large" {
                        "x".repeat(70000)
                    } else {
                        request["params"]["arguments"]["text"]
                            .as_str()
                            .unwrap()
                            .into()
                    };
                    json!({"content":[{"type":"text","text":text}],"isError":mode=="error"})
                }
                _ => panic!("unexpected request {request}"),
            };
            let mut bytes =
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"result":result})).unwrap();
            bytes.push(b'\n');
            if write.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    let (read, write) = tokio::io::split(client);
    let registry = Registry::connect_io("fixture".into(), read, write)
        .await
        .unwrap();
    (Arc::new(registry), calls, task)
}

#[tokio::test]
async fn wire_catalog_schema_and_native_name_mapping() {
    let (registry, calls, task) = peer("pages").await;
    let defs = registry.definitions();
    assert_eq!(defs.len(), 2);
    for def in &defs {
        assert!(def.name.len() <= 64);
        assert!(!def.name.contains('/'));
        assert!(matches!(
            registry
                .call(&def.name, json!({"text":7}), CancellationToken::new())
                .await,
            Err(ToolError::InvalidInput)
        ));
        let result = registry
            .call(
                &def.name,
                json!({"text":"roundtrip"}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "roundtrip");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    registry.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn external_authority_is_a_capability_upper_bound_even_with_read_only_hint() {
    let (registry, calls, task) = peer("normal").await;
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_mcp(registry.clone());
    let name = &registry.definitions()[0].name;
    let prepared = tools.prepare(name, json!({"text":"hello"})).await.unwrap();
    assert_eq!(prepared.access(), Access::External);
    assert_eq!(
        Policy::new(Config::default()).unwrap().evaluate(
            name,
            prepared.resource(),
            prepared.access()
        ),
        Decision::Deny
    );
    let policy = Policy::new(Config {
        mode: Mode::Workspace,
        allow_mcp: true,
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        policy.evaluate(name, prepared.resource(), prepared.access()),
        Decision::Ask
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    registry.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn cancellation_after_dispatch_does_not_replay() {
    let (registry, calls, task) = peer("pending").await;
    let token = CancellationToken::new();
    let client = registry.clone();
    let cancel = token.clone();
    let name = registry.definitions()[0].name.clone();
    let call =
        tokio::spawn(async move { client.call(&name, json!({"text":"wait"}), cancel).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    token.cancel();
    assert!(matches!(call.await.unwrap(), Err(ToolError::Interrupted)));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    registry.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn server_errors_disconnect_and_output_budgets_are_explicit() {
    for mode in ["error", "disconnect", "large", "frame"] {
        let (registry, calls, task) = peer(mode).await;
        let result = registry
            .call(
                &registry.definitions()[0].name,
                json!({"text":"hello"}),
                CancellationToken::new(),
            )
            .await;
        if mode == "error" {
            assert_eq!(result.unwrap()["isError"], true);
        } else {
            assert!(matches!(result, Err(ToolError::External(_))));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        registry.shutdown().await;
        task.await.unwrap();
    }
}

struct Caller {
    name: String,
    done: Arc<tokio::sync::Notify>,
}
#[async_trait::async_trait]
impl miao_engine::provider::Provider for Caller {
    async fn stream(
        &self,
        request: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<miao_engine::provider::Reply, miao_engine::provider::ProviderError> {
        if request.messages.len() == 1 {
            return Ok(miao_engine::provider::Reply {
                content: json!([{"type":"tool_use","id":"external-call","name":self.name,"input":{"text":"effect"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        self.done.notify_one();
        Ok(miao_engine::provider::Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
#[tokio::test]
async fn runtime_permission_denial_prevents_wire_dispatch_and_allowed_error_is_durable() {
    use miao_engine::{
        permission::Rule,
        protocol::{Delivery, Input},
        runtime::Runtime,
        store::Store,
    };
    for decision in [Decision::Deny, Decision::Allow] {
        let (registry, calls, task) = peer("error").await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let done = Arc::new(tokio::sync::Notify::new());
        let name = registry.definitions()[0].name.clone();
        let runtime = Runtime::with_policy(
            store.clone(),
            Arc::new(Caller {
                name: name.clone(),
                done: done.clone(),
            }),
            Tools::new(root).await.unwrap().with_mcp(registry.clone()),
            Policy::new(Config {
                mode: Mode::Workspace,
                allow_mcp: true,
                rules: vec![Rule {
                    tool: name,
                    path: "@mcp/**".into(),
                    decision,
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
                    input_id: "input".into(),
                    prompt: "call external tool".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), done.notified())
            .await
            .unwrap();
        runtime.shutdown().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(decision == Decision::Allow)
        );
        let transcript = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
        assert!(transcript.contains("is_error"));
        if decision == Decision::Deny {
            assert!(transcript.contains("permission denied"));
        } else {
            assert!(transcript.contains("isError"));
        }
        task.await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn configured_child_is_initialized_and_reaped_at_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let script = r#"
import json,sys,os
open('server.pid','w').write(str(os.getpid()))
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    method=request['method']
    if method=='initialize':
        result={'protocolVersion':request['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'process','version':'1'}}
    elif method=='tools/list': result={'tools':[]}
    else: raise RuntimeError(method)
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#;
    let registry = Registry::connect(
        vec![miao_engine::mcp::Config {
            name: "process".into(),
            argv: vec!["python3".into(), "-u".into(), "-c".into(), script.into()],
            env: Default::default(),
        }],
        dir.path(),
    )
    .await
    .unwrap();
    let pid: libc::pid_t = std::fs::read_to_string(dir.path().join("server.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    registry.shutdown().await;
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
