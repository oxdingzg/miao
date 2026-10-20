use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Responder;
#[async_trait]
impl Provider for Responder {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type": "text", "text": "moved history"}]),
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

async fn wait_finished(store: &Store, session: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let events = store.events(session, 0, 1000).await.unwrap();
        if events.iter().any(|event| event.kind == "run.finished") {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "run never finished");
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// A drained native Session exports as a rust-source move bundle whose
/// timeline is verbatim engine rows stamped with the DESTINATION directory;
/// staging it into a fresh store creates the identity at that new root.
#[tokio::test]
async fn move_export_stages_into_a_fresh_location() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Responder),
        Tools::new(&root).await.unwrap(),
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
                prompt: "hello".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    wait_finished(&store, "s").await;
    runtime.shutdown().await;

    let destination_dir = dir.path().join("worktree");
    std::fs::create_dir(&destination_dir).unwrap();
    let bundle_path = dir.path().join("move.json");
    let summary = store
        .export_session_move("s", destination_dir.to_str().unwrap(), bundle_path.clone())
        .await
        .unwrap();
    assert_eq!(summary["session_id"], "s");
    assert!(summary["timeline"].as_u64().unwrap() >= 2);
    let bundle = std::fs::read_to_string(&bundle_path).unwrap();
    let parsed: Value = serde_json::from_str(&bundle).unwrap();
    assert_eq!(parsed["format"], "miao.session.transfer.v1");
    assert_eq!(parsed["source"]["engine"], "rust");
    assert_eq!(parsed["source"]["moved"], true);
    assert_eq!(
        parsed["session"]["location"]["directory"],
        destination_dir.to_str().unwrap()
    );
    assert_eq!(summary["bundle_sha256"].as_str().unwrap().len(), 64);
    let digest = summary["bundle_sha256"].as_str().unwrap().to_owned();

    // Stage the bundle into a fresh destination store at the new location.
    let destination = Store::open(dir.path().join("destination.db"))
        .await
        .unwrap();
    let preparation = miao_engine::transfer_activation::prepare_native(
        &bundle,
        Identity {
            protocol: "openai-chat".into(),
            model: "m".into(),
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        preparation.messages.len(),
        parsed["timeline"].as_array().unwrap().len()
    );
    assert_eq!(
        preparation.directory.to_str().unwrap(),
        destination_dir.to_str().unwrap()
    );
    let staged = destination
        .stage_transfer_with_preparation("move-1", bundle, &digest, preparation)
        .await
        .unwrap();
    assert_eq!(staged.state, "staged");
    assert_eq!(staged.session_id, "s");
    assert_eq!(
        destination.location("s").await.unwrap().as_deref(),
        Some(destination_dir.to_str().unwrap())
    );
}
