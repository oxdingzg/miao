use async_trait::async_trait;
use miao_engine::{
    permission::{digest, Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Reads the file, then drifts it, then sends the stale edit: the exact
/// sequence a real run produces when an external writer wins the race.
struct Script {
    root: std::path::PathBuf,
    drift: String,
    edit: Value,
    turn: Mutex<usize>,
}

#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let mut turn = self.turn.lock().unwrap();
        *turn += 1;
        match *turn {
            1 => Ok(Reply {
                content: json!([{"type":"tool_use","id":"read","name":"read_file","input":{"path":"file.txt"}}]),
                usage: json!({}),
                needs_tools: true,
            }),
            2 => {
                std::fs::write(self.root.join("file.txt"), &self.drift).unwrap();
                Ok(Reply {
                    content: json!([{"type":"tool_use","id":"edit","name":"edit_file","input":self.edit}]),
                    usage: json!({}),
                    needs_tools: true,
                })
            }
            _ => Ok(Reply {
                content: json!([{"type":"text","text":"done"}]),
                usage: json!({}),
                needs_tools: false,
            }),
        }
    }
}

fn config() -> Config {
    Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    }
}

async fn launch(
    root: &std::path::Path,
    original: &str,
    drift: &str,
    edit: Value,
    recovery: bool,
) -> (Runtime, Store) {
    std::fs::write(root.join("file.txt"), original).unwrap();
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let tools = Tools::new(root)
        .await
        .unwrap()
        .with_writes(true)
        .with_edit_recovery(recovery);
    let runtime = Runtime::with_policy(
        store.clone(),
        std::sync::Arc::new(Script {
            root: root.to_path_buf(),
            drift: drift.into(),
            edit,
            turn: Mutex::new(0),
        }),
        tools,
        Policy::new(config()).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "change".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store)
}

async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}

async fn edit_result(store: &Store) -> Value {
    let events = store.events("s", 0, 200).await.unwrap();
    let completed = events
        .iter()
        .rfind(|event| event.kind == "tool.completed")
        .expect("tool completed");
    completed.data["result"].clone()
}

#[tokio::test]
async fn a_stale_edit_rebases_onto_drifted_content() {
    let dir = tempfile::tempdir().unwrap();
    let original = "alpha\nbeta\ngamma\n";
    let edit = json!({"path":"file.txt","old_string":"beta","new_string":"BETA","expected_sha256":digest(original.as_bytes())});
    let (runtime, store) = launch(
        dir.path(),
        original,
        "alpha\nrenamed\ngamma\nextra\n",
        edit,
        true,
    )
    .await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "alpha\nBETA\ngamma\nextra\n"
    );
    let result = edit_result(&store).await;
    assert_eq!(result["rebased"], json!(true));
    assert!(result["note"].as_str().unwrap().contains("rebased"));
    assert_eq!(result["previous_sha256"].as_str().unwrap().len(), 64);
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_in_place_edit_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let original = "alpha\nbeta\n";
    let edit = json!({"path":"file.txt","old_string":"beta","new_string":"BETA","expected_sha256":digest(original.as_bytes())});
    let (runtime, store) = launch(dir.path(), original, original, edit, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "alpha\nBETA\n"
    );
    let result = edit_result(&store).await;
    assert!(result.get("rebased").is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn recovery_refuses_unanchored_and_ambiguous_drift() {
    for (original, drift, old, reason) in [
        (
            "run\nwait\nrun\n",
            "done\nwait\ndone\nmore\n",
            "run",
            "ambiguous",
        ),
        (
            "x\ntarget\nx\n",
            "x\nthing\nx\nmore\n",
            "target",
            "unanchored",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let edit = json!({"path":"file.txt","old_string":old,"new_string":"X","expected_sha256":digest(original.as_bytes())});
        let (runtime, store) = launch(dir.path(), original, drift, edit, true).await;
        finished(&store).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            drift
        );
        let result = edit_result(&store).await;
        assert!(
            result["error"]
                .as_str()
                .unwrap_or_default()
                .contains(reason),
            "expected a {reason} refusal, got {result}"
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn replace_all_and_the_ablation_switch_never_rebase() {
    let original = "alpha\nbeta\ngamma\n";
    let drift = "alpha\nrenamed\ngamma\nextra\n";
    for (recovery, replace_all) in [(true, true), (false, false)] {
        let dir = tempfile::tempdir().unwrap();
        let edit = json!({"path":"file.txt","old_string":"beta","new_string":"BETA","replace_all":replace_all,"expected_sha256":digest(original.as_bytes())});
        let (runtime, store) = launch(dir.path(), original, drift, edit, recovery).await;
        finished(&store).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            drift
        );
        let result = edit_result(&store).await;
        assert!(
            result.get("rebased").is_none(),
            "no rebase may apply: {result}"
        );
        runtime.shutdown().await;
    }
}
