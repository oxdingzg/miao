use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A file mutation reports its diff under `_display`. The host renders it from
/// the `tool.completed` event; the model-facing result and the transcript's
/// tool_result must stay free of it, because the patch only repeats text the
/// model already wrote.
#[tokio::test]
async fn a_display_diff_reaches_the_event_and_never_reaches_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "input".into(),
            prompt: "edit a file".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([{"type":"tool_use","id":"call","name":"edit_file","input":{"path":"notes.txt"}}]),
        )
        .await
        .unwrap();
    let display = json!({"files":[{"path":"notes.txt","action":"update","patch":"@@ -1 +1 @@","additions":1,"deletions":1}]});
    store
        .tool_result(
            "s",
            "run",
            "call",
            json!({"applied":true,"sha256":"abc","_display":display}),
            false,
        )
        .await
        .unwrap();

    let events = store.events("s", 0, 100).await.unwrap();
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    assert_eq!(completed.data["display"], display);
    assert!(completed.data["result"].get("_display").is_none());
    assert!(!completed.data["result_json"]
        .as_str()
        .unwrap()
        .contains("_display"));

    let history = store.history("s").await.unwrap();
    let projected = history.last().unwrap().content[0]["content"]
        .as_str()
        .unwrap();
    assert!(!projected.contains("_display"));
    assert!(projected.contains("\"applied\":true"));
    store.close().await.unwrap();
}

#[tokio::test]
async fn a_result_without_a_display_block_keeps_its_event_shape() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "input".into(),
            prompt: "read a file".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"notes.txt"}}]),
        )
        .await
        .unwrap();
    store
        .tool_result(
            "s",
            "run",
            "call",
            json!({"text":"hello","sha256":"abc"}),
            false,
        )
        .await
        .unwrap();
    let events = store.events("s", 0, 100).await.unwrap();
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    assert!(completed.data.get("display").is_none());
    assert_eq!(completed.data["result"]["text"], "hello");
    store.close().await.unwrap();
}

/// An editor whose only move is one `edit_file` call.
struct Editor {
    input: Value,
}

#[async_trait]
impl Provider for Editor {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([
                    {"type":"tool_use","id":"edit","name":"edit_file","input":self.input}
                ]),
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

/// The host renders what landed on disk: a real edit drives a display diff
/// holding the committed text, because the model-facing result never carries
/// the file's body.
#[tokio::test]
async fn a_real_edit_reports_the_committed_text_to_the_host() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("notes.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Editor {
            input: json!({
                "path": "notes.txt",
                "old_string": "beta",
                "new_string": "BETA",
                "expected_sha256": format!(
                    "{:x}",
                    Sha256::digest("alpha\nbeta\ngamma\n")
                ),
            }),
        }),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
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
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "edit notes".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;

    assert_eq!(
        std::fs::read_to_string(workspace.join("notes.txt")).unwrap(),
        "alpha\nBETA\ngamma\n"
    );
    let events = store.events("s", 0, 200).await.unwrap();
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    let entry = &completed.data["display"]["files"][0];
    assert_eq!(entry["path"], json!("notes.txt"));
    assert_eq!(entry["action"], json!("update"));
    assert_eq!(entry["additions"], json!(1));
    assert_eq!(entry["deletions"], json!(1));
    let patch = entry["patch"].as_str().unwrap();
    assert!(patch.contains("-beta\n+BETA\n"), "{patch}");
    // The model pays for the diff only in its own tool call, never twice.
    assert!(completed.data["result"].get("_display").is_none());
    let transcript = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
    assert!(!transcript.contains("_display"));
}
