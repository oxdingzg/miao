use async_trait::async_trait;
use miao_engine::{
    formatter::{Config, Registry},
    permission::{Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn config() -> Config {
    #[cfg(unix)]
    let argv = vec![
        "sh".into(),
        "-c".into(),
        "printf formatted > \"$1\"".into(),
        "formatter".into(),
        "$FILE".into(),
    ];
    #[cfg(windows)]
    let argv = vec![
        "cmd.exe".into(),
        "/d".into(),
        "/s".into(),
        "/c".into(),
        "echo formatted>\"$FILE\"".into(),
    ];
    Config {
        name: "fixture".into(),
        argv,
        extensions: vec![".txt".into()],
        env: BTreeMap::new(),
        timeout_ms: 5_000,
    }
}

struct Mutation {
    name: String,
    input: Value,
    called: AtomicBool,
}
#[async_trait]
impl Provider for Mutation {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let tool = !self.called.swap(true, Ordering::SeqCst);
        Ok(Reply {
            content: if tool {
                json!([{"type":"tool_use","id":"mutation","name":self.name,"input":self.input}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools: tool,
        })
    }
}

async fn drive(tools: Tools, name: &str, input: Value) -> Value {
    let private = tempfile::tempdir().unwrap();
    let store = Store::open(private.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Mutation {
            name: name.into(),
            input,
            called: AtomicBool::new(false),
        }),
        tools,
        Policy::new(miao_engine::permission::Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Default::default()
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
                input_id: "input".into(),
                prompt: "mutate".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let settled = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    let events = store.events("s", 0, 200).await.unwrap();
    assert!(
        settled.is_ok(),
        "formatter runtime did not settle: {events:?}"
    );
    runtime.shutdown().await;
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .expect("missing tool completion");
    assert_eq!(completed.data["is_error"], false, "{completed:?}");
    completed.data["result"].clone()
}

#[tokio::test]
async fn formatters_run_after_write_edit_and_patch_and_report_final_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let tools = Tools::new(&root)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into())
        .with_formatter(Arc::new(Registry::new(vec![config()], &root).unwrap()));
    let write = drive(
        tools.clone(),
        "write_file",
        json!({"path":"space file.txt","text":"unformatted"}),
    )
    .await;
    assert_eq!(write["formatters"][0]["status"], "formatted", "{write}");
    let read = tools
        .execute(
            "read_file",
            json!({"path":"space file.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read["text"].as_str().unwrap().trim(), "formatted");
    assert_eq!(write["sha256"], read["sha256"]);
    let edit = drive(tools.clone(), "edit_file", json!({"path":"space file.txt","old_string":"formatted","new_string":"edited","expected_sha256":read["sha256"]})).await;
    assert_eq!(edit["formatters"][0]["status"], "formatted", "{edit}");
    let patch = drive(
        tools.clone(),
        "apply_patch",
        json!({"patch":"*** Begin Patch\n*** Add File: patch.txt\n+patch content\n*** End Patch"}),
    )
    .await;
    assert_eq!(
        patch["files"][0]["formatters"][0]["status"], "formatted",
        "{patch}"
    );
    let read = tools
        .execute(
            "read_file",
            json!({"path":"patch.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(patch["files"][0]["sha256"], read["sha256"]);
    assert_eq!(read["text"].as_str().unwrap().trim(), "formatted");
    let other = drive(
        tools,
        "write_file",
        json!({"path":"other.md","text":"untouched"}),
    )
    .await;
    assert!(other.get("formatters").is_none());
    assert_eq!(
        std::fs::read_to_string(root.join("other.md")).unwrap(),
        "untouched"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn formatter_timeout_preserves_committed_mutation_and_final_hash() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let mut config = config();
    config.argv = vec!["sh".into(), "-c".into(), "sleep 10".into()];
    config.timeout_ms = 100;
    let tools = Tools::new(&root)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into())
        .with_formatter(Arc::new(Registry::new(vec![config], &root).unwrap()));
    let result = drive(
        tools.clone(),
        "write_file",
        json!({"path":"file.txt","text":"committed"}),
    )
    .await;
    assert_eq!(result["formatters"][0]["status"], "timeout", "{result}");
    assert_eq!(
        std::fs::read_to_string(root.join("file.txt")).unwrap(),
        "committed"
    );
    let read = tools
        .execute(
            "read_file",
            json!({"path":"file.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["sha256"], read["sha256"]);
}
