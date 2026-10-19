//! Prefix stability measurement.
//!
//! DeepSeek caches prompt prefixes on a fixed block boundary and invalidates
//! everything from the first changed token, so a session only keeps hitting its
//! cache while the system prompt, the tool catalog and the committed history
//! stay byte-identical between consecutive provider turns. This test measures
//! that property on a real runtime rather than assuming it.

use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Recording {
    requests: Mutex<Vec<ModelRequest>>,
}

#[async_trait]
impl Provider for Recording {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let turn = self.requests.lock().unwrap().len();
        self.requests.lock().unwrap().push(request);
        Ok(if turn == 0 {
            Reply {
                content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"a"}}]),
                usage: json!({"inputTokens":1,"outputTokens":1}),
                needs_tools: true,
            }
        } else {
            Reply {
                content: json!([{"type":"text","text":"done"}]),
                usage: json!({"inputTokens":1,"outputTokens":1}),
                needs_tools: false,
            }
        })
    }
}

#[tokio::test]
async fn consecutive_turns_keep_a_byte_stable_provider_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("a"), "hi").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Recording::default());
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
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
                prompt: "read a".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;

    let requests = provider.requests.lock().unwrap();
    assert!(requests.len() >= 2, "expected at least two provider turns");
    let (first, second) = (&requests[0], &requests[1]);
    // The cacheable region: system prompt, tool catalog and the history already
    // sent. Anything that changes here invalidates the provider's prompt cache.
    assert_eq!(
        first.system, second.system,
        "system prompt changed between turns"
    );
    assert_eq!(
        serde_json::to_string(&first.tools).unwrap(),
        serde_json::to_string(&second.tools).unwrap(),
        "tool catalog changed between turns"
    );
    assert!(
        second.messages.len() > first.messages.len(),
        "history must grow, not rewrite: {} -> {}",
        first.messages.len(),
        second.messages.len()
    );
    for (index, message) in first.messages.iter().enumerate() {
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::to_value(&second.messages[index]).unwrap(),
            "message {index} was rewritten between turns"
        );
    }
}
