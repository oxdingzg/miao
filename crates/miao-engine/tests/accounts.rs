//! #2236: money for a Session includes its auxiliary calls and its delegated
//! Sessions, each entry priced at the rates of the model that served it.

use miao_engine::store::Store;
use serde_json::json;

/// One dollar per million non-cached input tokens, nothing else.
fn rates() -> serde_json::Value {
    json!({ "model-a": [{ "input": 1.0, "output": 0.0, "cache": { "read": 0.0, "write": 0.0 } }] })
}

fn auxiliary(session: &str, run: &str, tokens: u64) -> serde_json::Value {
    json!({
        "run_id": run,
        "role": "summarize",
        "accepted": true,
        "providerSuccess": true,
        "identity": { "model": "model-a", "protocol": "openai-chat" },
        "usage": { "inputTokens": tokens, "nonCachedInputTokens": tokens }
    })
}

#[tokio::test]
async fn a_session_pays_for_its_own_auxiliary_calls() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    store
        .record("parent", "role.provider.completed", auxiliary("parent", "r", 1_000_000))
        .await
        .unwrap();

    let accounts = store.accounts("parent", &rates()).await.unwrap();
    assert_eq!(accounts["auxiliary"], json!(1.0));
    assert_eq!(accounts["delegated"], json!(0.0));
    assert_eq!(accounts["total"], json!(1.0));
    assert_eq!(accounts["unpriced"], json!(0));
}

#[tokio::test]
async fn a_delegated_session_is_paid_for_under_the_parent() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    // `fork` writes the lineage edge, which is how a subagent appears.
    store.fork("parent", "child", None).await.unwrap();
    store
        .record("parent", "role.provider.completed", auxiliary("parent", "p", 1_000_000))
        .await
        .unwrap();
    store
        .record("child", "role.provider.completed", auxiliary("child", "c", 2_000_000))
        .await
        .unwrap();

    let accounts = store.accounts("parent", &rates()).await.unwrap();
    assert_eq!(accounts["auxiliary"], json!(1.0));
    assert_eq!(accounts["delegated"], json!(2.0));
    assert_eq!(accounts["total"], json!(3.0));
}

#[tokio::test]
async fn an_entry_whose_model_has_no_rate_is_counted_not_priced_at_zero() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    store
        .record("parent", "role.provider.completed", auxiliary("parent", "r", 10))
        .await
        .unwrap();

    let accounts = store.accounts("parent", &json!({})).await.unwrap();
    assert_eq!(accounts["auxiliary"], json!(0.0));
    assert_eq!(accounts["unpriced"], json!(1));
}
