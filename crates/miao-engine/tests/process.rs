#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Executor {
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
                content: json!([{"type":"tool_use","id":"call","name":"run_command","input":self.input}]),
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
fn policy(network: bool) -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        process_network: network,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}
async fn start(parent: &Path, input: Value, network: bool) -> (Runtime, Store, PathBuf) {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Executor { input }),
        tools,
        policy(network),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "execute".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store, workspace)
}
async fn finish(store: &Store) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished")
            {
                let history = store.history("s").await.unwrap();
                return serde_json::from_str(history[2].content[0]["content"].as_str().unwrap())
                    .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn explicit_argv_runs_in_workspace_and_stdout_stderr_are_separate() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, workspace) = start(
        dir.path(),
        json!({"argv":["/bin/sh","-c","pwd; printf output; printf error >&2"]}),
        false,
    )
    .await;
    let result = finish(&store).await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert_eq!(result["reason"], "completed");
    assert!(result["stdout"]
        .as_str()
        .unwrap()
        .contains(workspace.canonicalize().unwrap().to_str().unwrap()));
    assert!(result["stdout"].as_str().unwrap().ends_with("output"));
    assert_eq!(result["stderr"], "error");
    runtime.shutdown().await;
}

#[tokio::test]
async fn timeout_and_cancel_reap_normal_descendants() {
    for cancel in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime,store,workspace)=start(dir.path(),json!({"argv":["/bin/sh","-c","(while :; do printf x >> heartbeat; sleep 0.02; done) & wait"],"timeout_ms":if cancel{10000}else{2000}}),false).await;
        if cancel {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !workspace.join("heartbeat").exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert!(tokio::time::timeout(
                std::time::Duration::from_millis(250),
                runtime.cancel("s")
            )
            .await
            .unwrap()
            .unwrap());
        }
        let result = finish(&store).await;
        assert_eq!(
            result["reason"],
            if cancel { "cancelled" } else { "timed_out" },
            "{result}"
        );
        let before = std::fs::metadata(workspace.join("heartbeat"))
            .unwrap()
            .len();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(
            std::fs::metadata(workspace.join("heartbeat"))
                .unwrap()
                .len(),
            before
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn excessive_output_stops_process_instead_of_unbounded_buffering() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = start(
        dir.path(),
        json!({"argv":["/bin/sh","-c","while :; do printf 0123456789; done"]}),
        false,
    )
    .await;
    let result = finish(&store).await;
    assert_eq!(result["reason"], "output_limit", "{result}");
    assert_eq!(result["stdout"].as_str().unwrap().len(), 32768);
    runtime.shutdown().await;
}

#[tokio::test]
async fn outside_write_is_denied_and_network_cannot_be_elevated_by_tool_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    let (runtime, store, _) = start(
        dir.path(),
        json!({"argv":["/bin/sh","-c",format!("printf changed > '{}'",outside.display())]}),
        false,
    )
    .await;
    let result = finish(&store).await;
    assert_ne!(result["exit_code"], 0, "{result}");
    assert!(!outside.exists());
    runtime.shutdown().await;
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = start(
        dir.path(),
        json!({"argv":["/bin/echo","never"],"allow_network":true}),
        false,
    )
    .await;
    let result = finish(&store).await;
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("invalid tool input"));
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "tool.dispatched"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn network_io_obeys_policy_for_tcp_and_udp() {
    let probe=std::process::Command::new("python3").args(["-B","-c","import socket,sys; print(sys.executable); socket.socket(socket.AF_INET,socket.SOCK_DGRAM)"]).output().unwrap();
    assert!(probe.status.success(), "python socket probe unavailable");
    let python = String::from_utf8(probe.stdout).unwrap().trim().to_owned();
    for network in [false, true] {
        for kind in ["SOCK_STREAM", "SOCK_DGRAM"] {
            // Creating a socket alone is not network I/O on macOS. Keep a real
            // localhost peer available and exercise connect plus send.
            let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            let port = if kind == "SOCK_STREAM" {
                tcp.local_addr().unwrap().port()
            } else {
                udp.local_addr().unwrap().port()
            };
            let dir = tempfile::tempdir().unwrap();
            let (runtime,store,_)=start(dir.path(),json!({"argv":[python,"-B","-c",format!("import socket; s=socket.socket(socket.AF_INET,socket.{kind}); s.settimeout(1); s.connect(('127.0.0.1',{port})); s.send(b'x'); print('sent')")]}),network).await;
            let result = finish(&store).await;
            if network {
                assert_eq!(result["exit_code"], 0, "{result}");
                assert_eq!(result["stdout"], "sent\n");
            } else {
                assert_ne!(result["exit_code"], 0, "{result}");
                assert!(!result["stdout"].as_str().unwrap().contains("sent"));
            }
            runtime.shutdown().await;
        }
    }
}

#[tokio::test]
async fn process_enabled_runtime_cannot_put_authority_database_in_command_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert!(matches!(
        Runtime::with_policy(
            store,
            Arc::new(Executor { input: json!({}) }),
            Tools::new(dir.path()).await.unwrap(),
            policy(false)
        )
        .await,
        Err(Error::Invalid(_))
    ));
}
