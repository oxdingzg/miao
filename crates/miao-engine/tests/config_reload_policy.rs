//! Reloading the base permission policy swaps the capability gates with it.
//!
//! The gates are what actually refuses a tool call, so a tightened policy that
//! left the old gates in place would check one thing and enforce another. Each
//! test observes the gate set the running engine would dispatch under, not the
//! reply alone.

use async_trait::async_trait;
use miao_engine::{
    config_derive::PolicyOrigin,
    permission::{Config, Mode, Policy},
    protocol::ModelRequest,
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Unused;
#[async_trait]
impl Provider for Unused {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn config(mode: Mode, process: bool) -> Config {
    Config {
        mode,
        allow_process: process,
        ..Config::default()
    }
}

fn write_config(path: &Path, mode: Mode, process: bool) {
    std::fs::write(path, serde_json::to_vec(&config(mode, process)).unwrap()).unwrap();
}

/// An engine whose database lives inside the workspace, started read-only and
/// told to reload from `file`. `Tools` is cloned so the test can read the gate
/// set the same instance dispatches under.
async fn engine(dir: &Path, file: &Path) -> (Runtime, Tools) {
    let tools = Tools::new(dir).await.unwrap();
    let runtime = Runtime::with_policy(
        Store::open(dir.join("engine.db")).await.unwrap(),
        Arc::new(Unused),
        tools.clone(),
        Policy::new(config(Mode::ReadOnly, false)).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_policy_origin(PolicyOrigin::File(file.to_path_buf()), None)
        .await;
    (runtime, tools)
}

fn exposes(tools: &Tools, name: &str) -> bool {
    tools.definitions().iter().any(|tool| tool.name == name)
}

#[tokio::test]
async fn a_policy_rewrite_swaps_the_capability_gates_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    write_config(&file, Mode::ReadOnly, false);
    let (runtime, tools) = engine(dir.path(), &file).await;
    assert!(!tools.gates().writes);
    assert!(!exposes(&tools, "write_file"));

    // Same file, same policy: nothing is rebuilt and no generation is spent.
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(1));
    assert_eq!(report["changed"], json!([]));
    assert_eq!(report["unchanged"], json!(["policy"]));
    assert!(report["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("lsp")));

    write_config(&file, Mode::Workspace, false);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["changed"], json!(["policy"]));
    assert_eq!(report["unchanged"], json!([]));
    assert!(tools.gates().writes);
    assert!(exposes(&tools, "write_file"));

    // And back: tightening takes the tools away again.
    write_config(&file, Mode::ReadOnly, false);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(3));
    assert_eq!(report["changed"], json!(["policy"]));
    assert!(!tools.gates().writes);
    assert!(!exposes(&tools, "write_file"));
}

#[tokio::test]
async fn a_malformed_policy_fails_the_reload_and_keeps_the_running_gates() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    write_config(&file, Mode::Workspace, false);
    let (runtime, tools) = engine(dir.path(), &file).await;
    // Pick up the workspace policy the file already names.
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert!(tools.gates().writes);

    std::fs::write(&file, "{").unwrap();
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("policy.json"));
    assert!(
        tools.gates().writes,
        "a failed derivation changes nothing it read"
    );

    let report = runtime.reload_config().await.unwrap_err();
    assert_eq!(report.to_string(), error.to_string());
    write_config(&file, Mode::ReadOnly, false);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(3));
    assert!(!tools.gates().writes);
}

#[tokio::test]
async fn a_reload_cannot_enable_process_authority_inside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    write_config(&file, Mode::Workspace, false);
    let (runtime, tools) = engine(dir.path(), &file).await;
    assert!(!tools.gates().process);

    write_config(&file, Mode::Workspace, true);
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("outside the workspace"));
    assert!(
        !tools.gates().process,
        "the refused boundary never reaches the gates"
    );

    // The refusal is a validation of the new plan, not a broken runtime: a
    // policy that stays inside the boundary still reloads.
    write_config(&file, Mode::ReadOnly, true);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["changed"], json!(["policy"]));
    assert!(!tools.gates().writes);
}
