#![cfg(unix)]
use miao_engine::terminal::{Registry, Start};
use serde_json::{json, Value};
use std::time::Duration;

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

#[tokio::test]
async fn interactive_terminal_input_resize_replay_and_session_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::default();
    let started = registry.start("a", std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")), dir.path(), dir.path(), Start::parse(json!({"argv":["bash","-c","test -t 0 && test -t 1 && echo READY; while IFS= read -r line; do if test \"$line\" = size; then stty size; elif test \"$line\" = quit; then echo BYE; exit 7; else printf 'RESULT:%s\\n' \"$line\"; fi; done"]})).unwrap(), false).await.unwrap();
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

#[tokio::test]
async fn terminal_stop_and_shutdown_reap_processes_and_bound_output() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::default();
    let started = registry.start("a", std::path::Path::new(env!("CARGO_BIN_EXE_miao-engine")), dir.path(), dir.path(), Start::parse(json!({"argv":["bash","-c","head -c 1200000 /dev/zero | tr '\\000' x; echo END; read -r line"]})).unwrap(), false).await.unwrap();
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

struct Workflow {
    terminal: tokio::sync::Mutex<Option<String>>,
}
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
                .events("s", 0, 1000)
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
