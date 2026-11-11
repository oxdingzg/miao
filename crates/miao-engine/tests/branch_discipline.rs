//! Branch discipline at the permission gate: a landing action that would move
//! the protected branch is refused by the engine itself, so the operator is
//! never asked to approve one in the first place.

use async_trait::async_trait;
use miao_engine::{
    approval::Approval,
    permission::{Config, Mode, Policy},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The model's one move: run the command under test, then close with text.
struct Shell(String);

#[async_trait]
impl Provider for Shell {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let last_user = request
            .messages
            .last()
            .map(|message| message.role == "user")
            .unwrap_or(false);
        if last_user {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"bash","input":{"command":self.0}}]),
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
        allow_process: true,
        approval_timeout_ms: 60_000,
        ..Config::default()
    })
    .unwrap()
}

fn input() -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "push".into(),
        delivery: Delivery::Steer,
    }
}

/// A workspace whose checkout `HEAD` is `branch`, which is all branch
/// discipline reads. A process-enabled runtime keeps its database outside the
/// workspace, so the directory that holds it is the one returned with the
/// workspace.
fn checkout(branch: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let git = workspace.join(".git");
    std::fs::create_dir_all(&git).unwrap();
    std::fs::write(git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
    (root, workspace)
}

async fn kinds(store: &Store) -> Vec<String> {
    store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect()
}

async fn denial(store: &Store) -> Value {
    store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "permission_denied")
        .map(|event| event.data)
        .expect("a denied permission")
}

async fn wait_for(store: &Store, kind: &str) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if kinds(store).await.iter().any(|event| event == kind) {
            return true;
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}

/// The command names the protected branch, so the engine refuses it without
/// asking anyone: no approval prompt, no dispatch, and the refusal names the
/// branch it would have moved.
#[tokio::test]
async fn a_push_that_names_the_protected_branch_is_refused_without_a_prompt() {
    let (root, workspace) = checkout("feat/topic");
    let store = Store::open(root.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Shell("git push origin main".into())),
        Tools::new(&workspace).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    assert!(
        wait_for(&store, "run.finished").await,
        "event kinds: {:?}",
        kinds(&store).await
    );
    let events = kinds(&store).await;
    let denied = denial(&store).await;
    assert_eq!(denied["reason"], "branch_discipline");
    assert_eq!(denied["action"], "push");
    assert_eq!(denied["target"], "main");
    // A prompt would have meant the decision was the operator's, not the
    // engine's, and a dispatch would have meant it ran.
    assert!(
        !events.iter().any(|kind| kind == "approval.requested"),
        "{events:?}"
    );
    assert!(
        !events.iter().any(|kind| kind == "tool.dispatched"),
        "{events:?}"
    );
    runtime.shutdown().await;
}

/// The same push from the branch that is not protected is an ordinary ask, so
/// the refusal follows the observed branch rather than the command shape.
#[tokio::test]
async fn the_same_push_from_a_topic_branch_stays_an_explicit_ask() {
    let (root, workspace) = checkout("feat/topic");
    let store = Store::open(root.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Shell("git push origin feat/topic".into())),
        Tools::new(&workspace).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    assert!(
        wait_for(&store, "approval.requested").await,
        "event kinds: {:?}",
        kinds(&store).await
    );
    let events = kinds(&store).await;
    let approval: Approval = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "approval.requested")
        .map(|event| serde_json::from_value(event.data).unwrap())
        .expect("an approval request");
    assert_eq!(approval.tool, "bash");
    assert!(
        !events.iter().any(|kind| kind == "permission_denied"),
        "{events:?}"
    );
    runtime.shutdown().await;
}

/// A bare `git push` is judged by the branch the checkout records, so the same
/// words are refused on the protected branch and asked for anywhere else.
#[tokio::test]
async fn a_bare_push_is_judged_by_the_recorded_branch() {
    let (root, workspace) = checkout("main");
    let store = Store::open(root.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Shell("git push".into())),
        Tools::new(&workspace).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    assert!(
        wait_for(&store, "run.finished").await,
        "event kinds: {:?}",
        kinds(&store).await
    );
    let denied = denial(&store).await;
    assert_eq!(denied["reason"], "branch_discipline");
    assert_eq!(denied["target"], "main");
    runtime.shutdown().await;
}
