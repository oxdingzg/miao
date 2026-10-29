//! Reloading the model route manifest rebuilds the catalog in place.
//!
//! The reload derives the catalog from the same manifest and base provider
//! startup used, compares it with what is running, and swaps only when the
//! derived catalog differs. A malformed manifest leaves the running catalog
//! serving, so an edit in progress cannot take the engine down.

use async_trait::async_trait;
use miao_engine::{
    model_routes::{self, Origin},
    permission::{Config, Policy},
    protocol::ModelRequest,
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The unrouted provider startup would have built from the operator's flags.
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

/// One route. Any present environment variable stands in for the credential
/// bytes: the runtime test never makes a request, and `HOME` keeps the test
/// from mutating this process's environment.
fn route(id: &str, model: &str) -> Value {
    route_with_key(id, model, "HOME")
}

fn route_with_key(id: &str, model: &str, key: &str) -> Value {
    json!({
        "id": id,
        "provider": "openai-chat",
        "model": model,
        "credential": {"type": "environment", "key": key},
    })
}

fn write_manifest(path: &Path, routes: &[Value]) {
    std::fs::write(path, serde_json::to_vec(routes).unwrap()).unwrap();
}

async fn engine(workspace: &Path, manifest: &Path) -> Runtime {
    let workspace = workspace.to_path_buf();
    let base: Arc<dyn Provider> = Arc::new(Base);
    let (provider, limits) = model_routes::load(manifest, &workspace, base.clone())
        .await
        .unwrap();
    let runtime = Runtime::with_policy(
        Store::open(workspace.join("engine.db")).await.unwrap(),
        provider,
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    runtime.set_route_limits(limits).await;
    runtime
        .set_model_origin(Origin {
            base,
            path: manifest.to_path_buf(),
            workspace,
        })
        .await
        .unwrap();
    runtime
}

fn route_ids(runtime: &Runtime) -> Vec<String> {
    runtime
        .model_catalog()
        .into_iter()
        .filter_map(|info| info.route_id)
        .collect()
}

#[tokio::test]
async fn config_reload_rebuilds_and_reports_the_models_section() {
    let host = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manifest = host.path().join("routes.json");
    write_manifest(&manifest, &[route("alpha", "a")]);
    let runtime = engine(workspace.path(), &manifest).await;

    // Replaying the configuration startup read is not a change.
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(1));
    assert_eq!(report["changed"], json!([]));
    assert_eq!(report["unchanged"], json!(["models"]));
    assert!(!report["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("models")));

    write_manifest(&manifest, &[route("alpha", "a"), route("beta", "b")]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["changed"], json!(["models"]));
    assert_eq!(route_ids(&runtime), vec!["alpha", "beta"]);

    // The new catalog is what the next turn sees, and nothing else moved.
    assert_eq!(runtime.model_catalog().len(), 3);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["unchanged"], json!(["models"]));

    // Rewriting the same document with different whitespace is not a change.
    std::fs::write(
        &manifest,
        serde_json::to_vec_pretty(&[route("alpha", "a"), route("beta", "b")]).unwrap(),
    )
    .unwrap();
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["unchanged"], json!(["models"]));

    // A credential-only edit leaves the visible catalog identical and must
    // still take effect: the fingerprint follows the document.
    write_manifest(
        &manifest,
        &[route_with_key("alpha", "a", "PATH"), route("beta", "b")],
    );
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(3));
    assert_eq!(report["changed"], json!(["models"]));
    assert_eq!(route_ids(&runtime), vec!["alpha", "beta"]);

    write_manifest(&manifest, &[route("beta", "b")]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(4));
    assert_eq!(report["changed"], json!(["models"]));
    assert_eq!(route_ids(&runtime), vec!["beta"]);

    // A malformed manifest names its file, changes nothing, and leaves the
    // previous catalog serving.
    std::fs::write(&manifest, "{").unwrap();
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("routes.json"), "{error}");
    assert_eq!(route_ids(&runtime), vec!["beta"]);

    // Restoring the previous manifest is not a change either: the failed
    // attempt never advanced the generation.
    write_manifest(&manifest, &[route("beta", "b")]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(4));
    assert_eq!(report["unchanged"], json!(["models"]));
}
