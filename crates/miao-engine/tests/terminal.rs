use miao_engine::terminal::{Registry, Start};
use serde_json::{json, Value};
use std::time::Duration;

#[cfg(unix)]
async fn wait_output(registry: &Registry, session: &str, id: &str, pattern: &str) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let output = registry
                .execute(session, "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap();
            if output["output"].as_str().unwrap().contains(pattern) {
                return output;
            }
            assert!(
                output["exit"].is_null(),
                "terminal exited before {pattern}: {output}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    match result {
        Ok(output) => output,
        Err(error) => panic!(
            "waiting for {pattern}: {error}; observed {}",
            registry
                .execute(session, "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap()
        ),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn interactive_terminal_input_resize_replay_and_session_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::default();
    let started = registry.start("a", std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")), dir.path(), dir.path(), Start::parse(json!({"argv":["bash","-c","test -t 0 && test -t 1 && echo READY; while IFS= read -r line; do if test \"$line\" = size; then stty size; elif test \"$line\" = quit; then echo BYE; exit 7; else printf 'RESULT:%s\\n' \"$line\"; fi; done"]})).unwrap(), false, true).await.unwrap();
    let id = started["id"].as_str().unwrap();
    let ready = wait_output(&registry, "a", id, "READY").await;
    assert!(registry
        .execute("b", "terminal_read", json!({"id":id}))
        .await
        .is_err());
    assert_eq!(
        registry
            .execute("b", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
    registry
        .execute("a", "terminal_write", json!({"id":id,"input":"hello\n"}))
        .await
        .unwrap();
    let output = wait_output(&registry, "a", id, "RESULT:hello").await;
    assert!(output["cursor"].as_u64().unwrap() > ready["cursor"].as_u64().unwrap());
    // Replaying an absolute cursor neither loses nor duplicates retained bytes.
    assert_eq!(
        registry
            .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
            .await
            .unwrap()["output"],
        output["output"]
    );
    registry
        .execute(
            "a",
            "terminal_resize",
            json!({"id":id,"rows":37,"cols":103}),
        )
        .await
        .unwrap();
    registry
        .execute("a", "terminal_write", json!({"id":id,"input":"size\n"}))
        .await
        .unwrap();
    wait_output(&registry, "a", id, "37 103").await;
    registry
        .execute("a", "terminal_write", json!({"id":id,"input":"quit\n"}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let output = registry
                .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap();
            if !output["exit"].is_null() {
                assert_eq!(output["exit"]["exit_code"], 7);
                assert!(output["output"].as_str().unwrap().contains("BYE"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(registry
        .execute("a", "terminal_write", json!({"id":id,"input":"oops\n"}))
        .await
        .is_err());
    registry
        .execute("a", "terminal_stop", json!({"id":id}))
        .await
        .unwrap();
    assert_eq!(
        registry
            .execute("a", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
    tokio::time::timeout(Duration::from_secs(5), registry.shutdown())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_stop_and_shutdown_reap_processes_and_bound_output() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::default();
    let started = registry.start("a", std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")), dir.path(), dir.path(), Start::parse(json!({"argv":["bash","-c","head -c 1200000 /dev/zero | tr '\\000' x; echo END; read -r line"]})).unwrap(), false, true).await.unwrap();
    let id = started["id"].as_str().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let output = registry
                .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap();
            if output["retained_from"].as_u64().unwrap() > 0 {
                break output;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(output["dropped"].as_u64().unwrap() > 0);
    assert!(output["output"].as_str().unwrap().len() <= 32768);
    assert_eq!(output["truncated"], true);
    assert!(registry
        .execute("a", "terminal_read", json!({"id":id,"cursor":u64::MAX}))
        .await
        .is_err());
    let stopped = tokio::time::timeout(
        Duration::from_secs(5),
        registry.execute("a", "terminal_stop", json!({"id":id})),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stopped["exit"]["reason"], "stopped");
    let started = registry
        .start(
            "a",
            std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")),
            dir.path(),
            dir.path(),
            Start::parse(json!({"argv":["bash","-c","echo $$ > pid; echo READY; read -r line"]}))
                .unwrap(),
            false,
            true,
        )
        .await
        .unwrap();
    let id = started["id"].as_str().unwrap();
    wait_output(&registry, "a", id, "READY").await;
    let pid: i32 = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), registry.shutdown())
        .await
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
}

#[test]
fn terminal_input_validation_is_operation_specific() {
    use miao_engine::terminal::Control;
    assert!(Control::parse("terminal_write", json!({"id":"x"})).is_err());
    assert!(Control::parse("terminal_read", json!({"id":"x","input":"foo"})).is_err());
    assert!(Control::parse("terminal_resize", json!({"id":"x","rows":0,"cols":80})).is_err());
    assert!(Start::parse(json!({"argv":[]})).is_err());
}

#[cfg(unix)]
struct Workflow {
    terminal: tokio::sync::Mutex<Option<String>>,
}
#[cfg(unix)]
#[async_trait::async_trait]
impl miao_engine::provider::Provider for Workflow {
    async fn stream(
        &self,
        request: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<miao_engine::provider::Reply, miao_engine::provider::ProviderError> {
        let last = request.messages.last().unwrap();
        let result = last
            .content
            .as_array()
            .and_then(|blocks| blocks.first())
            .and_then(|block| block["content"].as_str())
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        let (name, input) = if request.messages.len() == 1 {
            assert!(request
                .tools
                .iter()
                .any(|tool| tool.name == "terminal_start"));
            (
                "terminal_start",
                json!({"argv":["bash","-c","sleep 0.5; echo READY; while IFS= read -r line; do printf 'RESULT:%s\\n' \"$line\"; done"]}),
            )
        } else {
            let result = result.unwrap();
            if let Some(id) = result["id"].as_str() {
                *self.terminal.lock().await = Some(id.into());
            }
            let id = self.terminal.lock().await.clone().unwrap();
            let written = request
                .messages
                .iter()
                .flat_map(|message| message.content.as_array().into_iter().flatten())
                .any(|block| block["type"] == "tool_use" && block["name"] == "terminal_write");
            if result["output"]
                .as_str()
                .is_some_and(|text| text.contains("READY"))
                && !written
            {
                ("terminal_write", json!({"id":id,"input":"runtime\n"}))
            } else if result["output"]
                .as_str()
                .is_some_and(|text| text.contains("RESULT:runtime"))
                && result["exit"].is_null()
            {
                ("terminal_stop", json!({"id":id}))
            } else if !result["exit"].is_null() {
                return Ok(miao_engine::provider::Reply {
                    content: json!([{"type":"text","text":"verified"}]),
                    usage: json!({}),
                    needs_tools: false,
                });
            } else {
                // Emulate transport latency so a synthetic zero-latency
                // provider cannot exhaust all turns before the OS schedules PTY I/O.
                tokio::time::sleep(Duration::from_millis(100)).await;
                ("terminal_read", json!({"id":id,"cursor":0}))
            }
        };
        Ok(miao_engine::provider::Reply {
            content: json!([{"type":"tool_use","id":format!("call{}",request.messages.len()),"name":name,"input":input}]),
            usage: json!({}),
            needs_tools: true,
        })
    }
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_dispatches_terminal_tools_through_durable_history() {
    use miao_engine::{
        permission::{Config, Decision, Mode, Policy, Rule},
        protocol::{Delivery, Input},
        runtime::Runtime,
        store::Store,
        tools::Tools,
    };
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(
        store.clone(),
        std::sync::Arc::new(Workflow {
            terminal: Default::default(),
        }),
        tools,
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            allow_background: true,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            // This workflow polls a real PTY through provider turns; give
            // its readiness handshake a budget independent of the default.
            ..serde_json::from_value(json!({"max_provider_turns":100})).unwrap()
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
                input_id: "one".into(),
                prompt: "test terminal".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 5000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let history = store.history("s").await.unwrap();
    assert_eq!(
        history.last().unwrap().content[0]["text"],
        "verified",
        "{history:?}"
    );
    let results: Vec<Value> = history
        .iter()
        .filter(|message| message.role == "user")
        .flat_map(|message| message.content.as_array().unwrap())
        .filter(|block| block["type"] == "tool_result")
        .cloned()
        .collect();
    assert!(results.len() >= 4);
    assert!(
        results.iter().all(|result| result["is_error"] != true),
        "{results:?}"
    );
    runtime.shutdown().await;
}

#[cfg(windows)]
async fn wait_for(
    registry: &Registry,
    session: &str,
    id: &str,
    cursor: u64,
    patterns: &[&str],
) -> Value {
    let last = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let seen = last.clone();
    let result = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let output = registry
                .execute(session, "terminal_read", json!({"id":id,"cursor":cursor}))
                .await
                .unwrap();
            let text = output["output"].as_str().unwrap().to_string();
            *seen.lock().unwrap() = text.clone();
            if patterns.iter().all(|pattern| text.contains(pattern)) {
                return output;
            }
            assert!(
                output["exit"].is_null(),
                "terminal exited before {patterns:?}: {output}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    match result {
        Ok(output) => output,
        Err(error) => panic!(
            "waiting for {patterns:?}: {error}; last output was {:?}",
            last.lock().unwrap()
        ),
    }
}

#[cfg(windows)]
async fn wait_exit(registry: &Registry, session: &str, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let output = registry
                .execute(session, "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap();
            if !output["exit"].is_null() {
                return output;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

#[cfg(windows)]
async fn start_terminal(registry: &Registry, argv: &[&str]) -> (Value, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let input = Start::parse(json!({ "argv": argv })).unwrap();
    let started = registry
        .start(
            "a",
            std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")),
            dir.path(),
            dir.path(),
            input,
            false,
            true,
        )
        .await
        .unwrap();
    (started, dir)
}

#[cfg(windows)]
#[tokio::test]
async fn windows_pseudoconsole_startup_input_resize_exit_and_session_isolation() {
    let registry = Registry::default();
    let (started, _dir) = start_terminal(&registry, &["cmd.exe"]).await;
    let id = started["id"].as_str().unwrap().to_string();
    // Startup output arrives before any input.
    let startup = wait_for(&registry, "a", &id, 0, &[">"]).await;
    assert!(startup["cursor"].as_u64().unwrap() > 0);
    // A second Session cannot address this terminal.
    assert!(registry
        .execute("b", "terminal_read", json!({"id":id}))
        .await
        .is_err());
    assert_eq!(
        registry
            .execute("b", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
    // Exact write is echoed and answered.
    registry
        .execute(
            "a",
            "terminal_write",
            json!({"id":id,"input":"echo READY\r\n"}),
        )
        .await
        .unwrap();
    wait_for(&registry, "a", &id, 0, &["READY"]).await;
    // Resize is applied to the live pseudoconsole. Its numeric effect cannot be
    // read back from inside the session here: the app container blocks the
    // console-size tools (`mode con` fails, PowerShell is unavailable), so this
    // asserts the resize is accepted and that the session survives it.
    let before = registry
        .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
        .await
        .unwrap()["cursor"]
        .as_u64()
        .unwrap();
    let resized = registry
        .execute(
            "a",
            "terminal_resize",
            json!({"id":id,"rows":37,"cols":103}),
        )
        .await
        .unwrap();
    assert_eq!(resized["accepted"], true);
    registry
        .execute(
            "a",
            "terminal_write",
            json!({"id":id,"input":"echo RESUMED\r\n"}),
        )
        .await
        .unwrap();
    wait_for(&registry, "a", &id, before, &["RESUMED"]).await;
    // Exit code is reported.
    registry
        .execute("a", "terminal_write", json!({"id":id,"input":"exit 7\r\n"}))
        .await
        .unwrap();
    let exited = wait_exit(&registry, "a", &id).await;
    assert_eq!(exited["exit"]["exit_code"], 7);
    assert!(registry
        .execute("a", "terminal_write", json!({"id":id,"input":"oops\r\n"}))
        .await
        .is_err());
    registry
        .execute("a", "terminal_stop", json!({"id":id}))
        .await
        .unwrap();
    assert_eq!(
        registry
            .execute("a", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
    registry.shutdown().await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_terminal_output_is_bounded_by_the_ring() {
    let registry = Registry::default();
    // A shell loop rather than a file: the app container in this environment
    // denies the child workspace file IO, which is a confinement property of the
    // shared sandbox and not specific to the pseudoconsole.
    let (started, _dir) = start_terminal(
        &registry,
        &[
            "cmd.exe",
            "/c",
            "for /l %i in (1,1,80000) do @echo 0123456789012345678901234567890123456789012345678901234567",
        ],
    )
    .await;
    let id = started["id"].as_str().unwrap().to_string();
    let output = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            let output = registry
                .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
                .await
                .unwrap();
            if output["retained_from"].as_u64().unwrap() > 0 {
                break output;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(output["dropped"].as_u64().unwrap() > 0);
    assert!(output["output"].as_str().unwrap().len() <= 32768);
    assert_eq!(output["truncated"], true);
    assert!(registry
        .execute("a", "terminal_read", json!({"id":id,"cursor":u64::MAX}))
        .await
        .is_err());
    registry.shutdown().await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_terminal_stop_reaps_the_process_tree() {
    let registry = Registry::default();
    let (started, _dir) = start_terminal(&registry, &["cmd.exe", "/c", "pause"]).await;
    let id = started["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let running = registry
        .execute("a", "terminal_read", json!({"id":id,"cursor":0}))
        .await
        .unwrap();
    assert!(
        running["exit"].is_null(),
        "terminal exited early: {running}"
    );
    // Stop must kill the tree and join the reader, which is blocked on the
    // pseudoconsole until the process goes away.
    let stopped = registry
        .execute("a", "terminal_stop", json!({"id":id}))
        .await
        .unwrap();
    assert_eq!(stopped["exit"]["reason"], "stopped");
    assert!(stopped["exit"]["exit_code"].is_number());
    assert_eq!(
        registry
            .execute("a", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
    assert!(registry
        .execute("a", "terminal_write", json!({"id":id,"input":"x\r\n"}))
        .await
        .is_err());
    // A second terminal reaped by shutdown must not leak either.
    let (second, _dir2) = start_terminal(&registry, &["cmd.exe", "/c", "pause"]).await;
    assert!(registry
        .execute("a", "terminal_list", json!({}))
        .await
        .unwrap()["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .any(|terminal| terminal["id"] == second["id"]));
    registry.shutdown().await;
    assert_eq!(
        registry
            .execute("a", "terminal_list", json!({}))
            .await
            .unwrap()["terminals"],
        json!([])
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_terminal_preserves_nested_cwd_and_write_confinement() {
    let registry = Registry::default();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("sentinel");
    std::fs::write(&sentinel, "unchanged").unwrap();
    let nested = workspace.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let cwd = nested.canonicalize().unwrap();
    let started = registry
        .start(
            "a",
            std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")),
            &root,
            &cwd,
            Start::parse(json!({"argv":["cmd.exe"]})).unwrap(),
            false,
            true,
        )
        .await
        .unwrap();
    assert_eq!(started["sandbox_profile"], "workspace_write");
    let id = started["id"].as_str().unwrap();
    wait_for(&registry, "a", id, 0, &[">"]).await;
    registry.execute("a", "terminal_write", json!({"id":id,"input":format!(
        "echo WORKSPACE_OK>allowed.txt\r\necho forbidden>\"{}\"\r\nexit\r\n", sentinel.display()
    )})).await.unwrap();
    let output = wait_exit(&registry, "a", id).await;
    assert_eq!(
        std::fs::read_to_string(nested.join("allowed.txt"))
            .unwrap_or_else(|error| panic!(
                "nested write: {error}; started={started}; output={output}"
            ))
            .trim(),
        "WORKSPACE_OK"
    );
    assert!(!workspace.path().join("allowed.txt").exists());
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "unchanged");
    registry.shutdown().await;
}
