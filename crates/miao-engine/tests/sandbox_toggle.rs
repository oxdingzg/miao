//! `/sandbox`: flipping the operator's switch swaps the policy cell in place,
//! the same way a config reload does. The reply names the new state so a
//! client can report it, and the next turn's snapshot carries the flip.

use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Mode, Policy},
    protocol::ModelRequest,
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
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

#[tokio::test]
async fn set_sandbox_toggles_and_then_follows_an_explicit_choice() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::with_policy(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Unused),
        tools,
        Policy::new(Config {
            mode: Mode::ReadOnly,
            sandbox: true,
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let reply = runtime.set_sandbox(None).await.unwrap();
    assert_eq!(reply["sandbox"], false);
    let reply = runtime.set_sandbox(Some(true)).await.unwrap();
    assert_eq!(reply["sandbox"], true);
    // An explicit choice wins over the toggle.
    let reply = runtime.set_sandbox(Some(true)).await.unwrap();
    assert_eq!(reply["sandbox"], true);
    let reply = runtime.set_sandbox(None).await.unwrap();
    assert_eq!(reply["sandbox"], false);
}
