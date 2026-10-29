//! Reloading the MCP server list reuses unchanged connections.
//!
//! A reload must not restart a server whose configuration did not change, and
//! a rebuild that fails must leave the previous connection serving rather than
//! take the whole manifest down. Each test observes the initialized connection
//! and the advertised tools, not just the report.

use async_trait::async_trait;
use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
use miao_engine::{
    config_derive::McpOrigin,
    mcp::{Config as McpConfig, Registry},
    permission::{Config, Mode, Policy},
    protocol::ModelRequest,
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One loopback MCP server that advertises a single tool. `initializes` counts
/// connections, so a test can tell a kept connection from a rebuilt one.
async fn server(
    tool: &'static str,
    initializes: Arc<AtomicUsize>,
) -> (String, tokio::task::JoinHandle<()>) {
    let router = Router::new().route(
        "/mcp",
        post(move |Json(request): Json<Value>| {
            let initializes = initializes.clone();
            async move {
                let Some(id) = request.get("id") else {
                    return StatusCode::ACCEPTED.into_response();
                };
                let result = match request["method"].as_str().unwrap() {
                    "initialize" => {
                        initializes.fetch_add(1, Ordering::SeqCst);
                        json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":tool,"version":"1"}})
                    }
                    "tools/list" => json!({"tools":[{"name":tool,"description":"fixture","inputSchema":{"type":"object","additionalProperties":false}}]}),
                    "tools/call" => json!({"content":[{"type":"text","text":tool}]}),
                    _ => panic!("unexpected MCP method"),
                };
                Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (endpoint, task)
}

fn config(name: &str, endpoint: &str) -> McpConfig {
    serde_json::from_value(json!({"name":name,"url":endpoint})).unwrap()
}

fn aliases(registry: &Registry) -> Vec<String> {
    registry
        .definitions()
        .iter()
        .map(|definition| definition.name.clone())
        .collect()
}

#[tokio::test]
async fn reconcile_keeps_unchanged_connections_and_swaps_the_rest() {
    let alpha_connections = Arc::new(AtomicUsize::new(0));
    let beta_connections = Arc::new(AtomicUsize::new(0));
    let gamma_connections = Arc::new(AtomicUsize::new(0));
    let (alpha, alpha_server) = server("alpha", alpha_connections.clone()).await;
    let (beta, beta_server) = server("beta", beta_connections.clone()).await;
    let (gamma, gamma_server) = server("gamma", gamma_connections.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        Registry::connect(vec![config("alpha", &alpha)], dir.path())
            .await
            .unwrap(),
    );
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    let before = aliases(&registry);

    // Nothing changed: the connection is kept and no catalog is rebuilt.
    let report = registry
        .reconcile(vec![config("alpha", &alpha)])
        .await
        .unwrap();
    assert_eq!(report.unchanged, vec!["alpha"]);
    assert!(report.changed.is_empty());
    assert!(report.removed.is_empty());
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    assert_eq!(aliases(&registry), before);

    // A new server is connected; the existing one is untouched.
    let report = registry
        .reconcile(vec![config("alpha", &alpha), config("beta", &beta)])
        .await
        .unwrap();
    assert_eq!(report.changed, vec!["beta"]);
    assert_eq!(report.unchanged, vec!["alpha"]);
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    assert_eq!(beta_connections.load(Ordering::SeqCst), 1);
    assert_eq!(aliases(&registry).len(), 2);

    // A changed configuration replaces only that server's connection.
    let report = registry
        .reconcile(vec![config("alpha", &alpha), config("beta", &gamma)])
        .await
        .unwrap();
    assert_eq!(report.changed, vec!["beta"]);
    assert_eq!(report.unchanged, vec!["alpha"]);
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    assert_eq!(gamma_connections.load(Ordering::SeqCst), 1);
    assert!(aliases(&registry)
        .iter()
        .any(|alias| alias.contains("_gamma_")));
    assert!(!aliases(&registry)
        .iter()
        .any(|alias| alias.contains("_beta_beta_")));

    // Removing a server drops its tools and leaves the rest connected.
    let report = registry
        .reconcile(vec![config("alpha", &alpha)])
        .await
        .unwrap();
    assert_eq!(report.removed, vec!["beta"]);
    assert_eq!(report.unchanged, vec!["alpha"]);
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    assert_eq!(aliases(&registry), before);

    registry.shutdown().await;
    alpha_server.abort();
    beta_server.abort();
    gamma_server.abort();
}

#[tokio::test]
async fn a_failed_rebuild_keeps_the_previous_connection_serving() {
    let connections = Arc::new(AtomicUsize::new(0));
    let (alpha, alpha_server) = server("alpha", connections.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        Registry::connect(vec![config("alpha", &alpha)], dir.path())
            .await
            .unwrap(),
    );
    let definitions = aliases(&registry);

    // Port 1 refuses the connection, so the rebuild fails after validation.
    let report = registry
        .reconcile(vec![config("alpha", "http://127.0.0.1:1/mcp")])
        .await
        .unwrap();
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].server, "alpha");
    // Nothing new is serving, so the section did not change: the failure is
    // reported, not counted as an applied configuration.
    assert!(report.changed.is_empty());
    assert!(report.unchanged.is_empty());
    assert_eq!(connections.load(Ordering::SeqCst), 1);

    // The old connection still answers: the catalog never went away.
    assert_eq!(aliases(&registry), definitions);
    let result = registry
        .call(&definitions[0], json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "alpha");

    // The failed configuration is not adopted either: the same manifest still
    // passes as unchanged, so the engine does not retry a rejected rebuild.
    let report = registry
        .reconcile(vec![config("alpha", &alpha)])
        .await
        .unwrap();
    assert_eq!(report.unchanged, vec!["alpha"]);
    assert!(report.failed.is_empty());

    registry.shutdown().await;
    alpha_server.abort();
}

#[tokio::test]
async fn an_invalid_manifest_changes_nothing() {
    let connections = Arc::new(AtomicUsize::new(0));
    let (alpha, alpha_server) = server("alpha", connections.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        Registry::connect(vec![config("alpha", &alpha)], dir.path())
            .await
            .unwrap(),
    );
    let before = aliases(&registry);

    let duplicates = vec![config("alpha", &alpha), config("alpha", &alpha)];
    let overflow = (0..9)
        .map(|index| config(&format!("server{index}"), &alpha))
        .collect::<Vec<_>>();
    let bad_revision = serde_json::from_value::<McpConfig>(json!({
        "name":"alpha","url":alpha,"authority_revision":"short"
    }))
    .unwrap();
    for manifest in [duplicates, overflow, vec![bad_revision]] {
        assert!(registry.reconcile(manifest).await.is_err());
        assert_eq!(aliases(&registry), before);
    }
    assert_eq!(connections.load(Ordering::SeqCst), 1);

    registry.shutdown().await;
    alpha_server.abort();
}

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

async fn engine(dir: &Path, manifest: &Path, registry: Arc<Registry>) -> Runtime {
    let tools = Tools::new(dir).await.unwrap().with_mcp(registry);
    let runtime = Runtime::with_policy(
        Store::open(dir.join("engine.db")).await.unwrap(),
        Arc::new(Unused),
        tools.clone(),
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_mcp: true,
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_mcp_origin(McpOrigin::Manifest(manifest.to_path_buf()))
        .await;
    runtime
}

fn write_manifest(path: &Path, configs: &[McpConfig]) {
    std::fs::write(path, serde_json::to_vec(configs).unwrap()).unwrap();
}

#[tokio::test]
async fn config_reload_reports_and_swaps_the_mcp_section() {
    let dir = tempfile::tempdir().unwrap();
    let alpha_connections = Arc::new(AtomicUsize::new(0));
    let beta_connections = Arc::new(AtomicUsize::new(0));
    let (alpha, alpha_server) = server("alpha", alpha_connections.clone()).await;
    let (beta, beta_server) = server("beta", beta_connections.clone()).await;
    let manifest = dir.path().join("mcp.json");
    write_manifest(&manifest, &[config("alpha", &alpha)]);
    let registry = Arc::new(
        Registry::connect(vec![config("alpha", &alpha)], dir.path())
            .await
            .unwrap(),
    );
    let runtime = engine(dir.path(), &manifest, registry.clone()).await;

    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(1));
    assert_eq!(report["changed"], json!([]));
    assert_eq!(report["unchanged"], json!(["mcp"]));
    assert_eq!(report["mcp"]["unchanged"], json!(["alpha"]));
    assert!(!report["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("mcp")));

    write_manifest(&manifest, &[config("alpha", &alpha), config("beta", &beta)]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(2));
    assert_eq!(report["changed"], json!(["mcp"]));
    assert_eq!(report["mcp"]["changed"], json!(["beta"]));
    assert_eq!(report["mcp"]["unchanged"], json!(["alpha"]));
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 1);
    assert_eq!(registry.definitions().len(), 2);

    write_manifest(&manifest, &[config("beta", &beta)]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(3));
    assert_eq!(report["mcp"]["removed"], json!(["alpha"]));
    assert_eq!(registry.definitions().len(), 1);

    // A malformed manifest fails the reload and leaves the connections as they
    // were: the engine keeps serving the last good server list.
    std::fs::write(&manifest, "{").unwrap();
    let error = runtime.reload_config().await.unwrap_err();
    assert!(error.to_string().contains("mcp.json"));
    assert_eq!(registry.definitions().len(), 1);
    assert_eq!(beta_connections.load(Ordering::SeqCst), 1);

    write_manifest(&manifest, &[config("alpha", &alpha)]);
    let report = runtime.reload_config().await.unwrap();
    assert_eq!(report["generation"], json!(4));
    assert_eq!(report["mcp"]["changed"], json!(["alpha"]));
    assert_eq!(alpha_connections.load(Ordering::SeqCst), 2);

    runtime.shutdown().await;
    alpha_server.abort();
    beta_server.abort();
}
