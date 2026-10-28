//! Reloading the context host files swaps each part through `Tools`.
//!
//! The parts are derived and validated before any of them is applied, so a
//! malformed or stale file fails the whole reload with its own name and leaves
//! the running configuration — including the read scope a reference grants —
//! exactly as it was.

use async_trait::async_trait;
use miao_engine::{
    config_derive::ContextOrigin,
    permission::{Config, Policy},
    protocol::ModelRequest,
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Base;

#[async_trait]
impl Provider for Base {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: "base".into(),
        })
    }

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

fn write(path: &Path, value: Value) {
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn origin(host: &Path) -> ContextOrigin {
    ContextOrigin {
        sources: Some(host.join("sources.json")),
        skills: Some(host.join("skills.json")),
        references: Some(host.join("references.json")),
        hooks: Some(host.join("hooks.json")),
        formatter: Some(host.join("formatter.json")),
    }
}

/// A runtime whose `Tools` startup never touched; the first reload is what
/// installs the host files, exactly as a later reload would replace them.
async fn engine(workspace: &Path, origin: ContextOrigin) -> (Runtime, Tools) {
    let tools = Tools::new(workspace).await.unwrap();
    let runtime = Runtime::with_policy(
        Store::open(workspace.join("engine.db")).await.unwrap(),
        Arc::new(Base),
        tools.clone(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    runtime.set_context_origin(origin).await;
    (runtime, tools)
}

async fn readable(tools: &Tools, path: &Path) -> bool {
    tools
        .prepare("read_file", json!({"path": path}))
        .await
        .is_ok()
}

#[tokio::test]
async fn config_reload_swaps_and_reports_each_context_part() {
    let host = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let doc = host.path().join("doc.md");
    std::fs::write(&doc, "host doc").unwrap();
    let detached = host.path().join("detached.md");
    std::fs::write(&detached, "second doc").unwrap();
    let skills = host.path().join("skills.json");
    let references = host.path().join("references.json");
    let hooks = host.path().join("hooks.json");
    write(
        &host.path().join("sources.json"),
        json!([{"label": "global", "path": path_string(&host.path().join("GLOBAL.md"))}]),
    );
    write(
        &skills,
        json!([{"path": path_string(&host.path().join("skills"))}]),
    );
    write(
        &references,
        json!([{"path": path_string(&doc), "description": "host doc"}]),
    );
    write(
        &hooks,
        json!([{"event": "post_tool_use", "tool": "*", "argv": ["/bin/true"]}]),
    );
    write(
        &host.path().join("formatter.json"),
        json!([{"name": "fmt", "argv": ["/bin/true"], "extensions": [".txt"]}]),
    );
    let (runtime, tools) = engine(workspace.path(), origin(host.path())).await;

    // Every configured part is installed and named in the report.
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["changed"], json!(["context"]));
    assert_eq!(
        report["context"]["changed"],
        json!(["sources", "skills", "references", "hooks", "formatter"])
    );
    assert!(!report["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("context")));

    // The reference's read scope is live: the named file is readable and its
    // neighbour in the same directory is not.
    assert!(readable(&tools, &doc).await);
    assert!(matches!(
        tools.prepare("read_file", json!({"path": &detached})).await,
        Err(ToolError::OutsideWorkspace)
    ));

    // Replaying the same files moves nothing.
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["unchanged"], json!(["context"]));
    assert_eq!(report["context"]["changed"], json!([]));
    assert_eq!(
        report["context"]["unchanged"],
        json!(["sources", "skills", "references", "hooks", "formatter"])
    );

    // One part's edit is reported on its own, not as a whole-section reset.
    write(
        &skills,
        json!([
            {"path": path_string(&host.path().join("skills"))},
            {"path": path_string(&host.path().join("more"))},
        ]),
    );
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(3));
    assert_eq!(report["changed"], json!(["context"]));
    assert_eq!(report["context"]["changed"], json!(["skills"]));
    assert_eq!(
        report["context"]["unchanged"],
        json!(["sources", "references", "hooks", "formatter"])
    );

    // Pointing the reference elsewhere moves the read scope in place.
    write(
        &references,
        json!([{"path": path_string(&detached), "description": "second doc"}]),
    );
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(4));
    assert_eq!(report["context"]["changed"], json!(["references"]));
    assert!(readable(&tools, &detached).await);
    assert!(!readable(&tools, &doc).await);

    // A malformed file names itself and nothing is applied.
    std::fs::write(&hooks, "{").unwrap();
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("hooks.json"), "{error}");
    write(
        &hooks,
        json!([{"event": "post_tool_use", "tool": "*", "argv": ["/bin/true"]}]),
    );
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(4));

    // A reference that cannot be resolved names its file too, and the old
    // scope keeps granting exactly what it did.
    write(
        &references,
        json!([{"path": path_string(&host.path().join("missing.md")), "description": "gone"}]),
    );
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("references.json"), "{error}");
    assert!(readable(&tools, &detached).await);
    assert!(!readable(&tools, &doc).await);
}
