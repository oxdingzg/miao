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

/// A provider whose first call blocks until the test releases it, so a
/// reload can land while a turn is genuinely in flight. It counts calls and
/// announces each entry, which is how the test knows the turn has started.
struct Gated {
    calls: std::sync::atomic::AtomicUsize,
    entered: tokio::sync::Notify,
    release: CancellationToken,
}

impl Gated {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: std::sync::atomic::AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
            release: CancellationToken::new(),
        })
    }

    fn release(&self) {
        self.release.cancel();
    }
}

#[async_trait]
impl Provider for Gated {
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
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.entered.notify_waiters();
        if call == 0 {
            tokio::select! {
                _ = self.release.cancelled() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                    panic!("the test never released the active turn")
                }
            }
        }
        Ok(Reply {
            content: json!([{"type": "text", "text": "done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

/// The engine built around a caller-supplied base provider.
async fn engine_with(workspace: &Path, manifest: &Path, base: Arc<dyn Provider>) -> Runtime {
    let workspace = workspace.to_path_buf();
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
    engine_with(workspace, manifest, Arc::new(Base)).await
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

/// A reload landing on a turn that is genuinely in flight must not disturb
/// it: the active turn finishes on the catalog it started with, and the
/// swapped catalog is what the next admission resolves against. That is the
/// safe boundary the item asks for.
#[tokio::test]
async fn a_reload_during_an_active_turn_lands_at_the_boundary() {
    let host = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manifest = host.path().join("routes.json");
    write_manifest(&manifest, &[route("alpha", "a")]);
    let base = Gated::new();
    let runtime = engine_with(workspace.path(), &manifest, base.clone()).await;

    runtime
        .admit(
            miao_engine::protocol::Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "go".into(),
                delivery: miao_engine::protocol::Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // The turn is in flight once the provider has been entered.
    let entered = base.clone();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if entered.calls.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                break;
            }
            entered.entered.notified().await;
        }
    })
    .await
    .expect("the active turn reaches the provider");

    write_manifest(&manifest, &[route("alpha", "a"), route("beta", "b")]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["changed"], json!(["models"]));
    assert_eq!(route_ids(&runtime), vec!["alpha", "beta"]);

    base.release();
    let store = runtime.store().clone();
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let events = store.events("s", 0, 1000).await.unwrap();
            if let Some(event) = events.iter().find(|event| event.kind == "run.finished") {
                break event.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the active turn survives the reload");
    assert_eq!(finished.data["reason"], "completed", "{finished:?}");
    let after = finished.seq;

    // The next admission resolves against the swapped catalog and finishes.
    runtime
        .admit(
            miao_engine::protocol::Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "two".into(),
                prompt: "again".into(),
                delivery: miao_engine::protocol::Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let events = store.events("s", after, 1000).await.unwrap();
            if let Some(event) = events.iter().find(|event| event.kind == "run.finished") {
                break event.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the next turn finishes on the swapped catalog");
    assert_eq!(finished.data["reason"], "completed", "{finished:?}");
    assert_eq!(
        base.calls.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "both turns reached the provider"
    );
    runtime.shutdown().await;
}
