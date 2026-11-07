//! The diagnostic bundle: a session's committed events a supporter can read,
//! with credential-shaped strings gone.
//!
//! The honest way to test this is a real turn: the secret rides in the
//! prompt the way it rides in real sessions — pasted by the operator — and
//! the bundle is built from the ledger after the turn settles.

use miao_engine::{
    permission::{Config, Policy},
    protocol::{Delivery, Input},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct Base;

#[async_trait::async_trait]
impl Provider for Base {
    fn identity(&self) -> Option<miao_engine::provider::Identity> {
        Some(miao_engine::provider::Identity {
            protocol: "openai-chat".into(),
            model: "base".into(),
        })
    }

    async fn stream(
        &self,
        _: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type": "text", "text": "ok"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn runtime() -> (Runtime, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::with_policy(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Base),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    // Hold the TempDir itself: dropping it deletes the database the bundle
    // needs to reopen.
    (runtime, dir)
}

async fn idle(store: &Store, session: &str, completed: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events(session, 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= completed
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the turn settles");
}

#[tokio::test]
async fn a_bundled_session_carries_no_pasted_key() {
    let (runtime, dir) = runtime().await;
    let secret = "sk-fixture0123456789abcdef";
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "ses_bundle".into(),
                input_id: "in-1".into(),
                prompt: format!("deploy with {secret} and keep this quiet"),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    idle(&runtime.store().clone(), "ses_bundle", 1).await;

    let bundle =
        miao_engine::export::diagnostic_bundle(dir.path().join("engine.db"), "ses_bundle", 0)
            .expect("the bundle builds");
    let rendered = serde_json::to_string(&bundle).unwrap();
    assert!(
        !rendered.contains(secret),
        "the pasted key must not travel: {rendered}"
    );
    assert!(
        rendered.contains("[redacted]"),
        "the removal is visible as a removal"
    );
    assert!(bundle["event_count"].as_u64().unwrap() > 0);
    assert!(bundle["redactions"].as_u64().unwrap() >= 1);
    assert_eq!(bundle["protocol"], miao_engine::PROTOCOL);
    // The harmless text survives: redaction removes the secret, not the turn.
    assert!(
        rendered.contains("deploy with"),
        "the prompt's plain words stay readable"
    );
}

#[test]
fn a_key_shaped_value_in_a_sensitive_field_is_dropped_whole() {
    let mut value = json!({
        "headers": {"Authorization": "Bearer token0123456789abcdef", "Accept": "application/json"},
        "config": {"api_key": "ghp_0123456789012345678901234567890123456789", "retries": 3},
        "note": "no secret here"
    });
    let count = miao_engine::export::redact_for_tests(&mut value);
    assert_eq!(value["headers"]["Authorization"], "[redacted]");
    assert_eq!(value["headers"]["Accept"], "application/json");
    assert_eq!(value["config"]["api_key"], "[redacted]");
    assert_eq!(value["config"]["retries"], 3);
    assert_eq!(value["note"], "no secret here");
    assert!(count >= 2, "both drops count: {count}");
}
