use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    session_agent::AgentManifest,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct Capture {
    model: Mutex<String>,
    requests: Mutex<Vec<ModelRequest>>,
}
#[async_trait]
impl Provider for Capture {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: self.model.lock().unwrap().clone(),
        })
    }
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.requests.lock().unwrap().push(request);
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn turn(runtime: &Runtime, store: &Store, count: usize) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: format!("prompt-{count}"),
                prompt: "Inspect the task".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 5000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= count
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn effective_model_replaces_product_persona_and_explicit_agent_instructions_win() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Capture {
        model: Mutex::new("gemini-fixture".into()),
        requests: Mutex::new(vec![]),
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let agent: AgentManifest =
        serde_json::from_value(json!({"name":"build","semantics":"product-agent-ordered-v1"}))
            .unwrap();
    runtime.initialize("s", "New session").await.unwrap();
    runtime.set_agent("s", agent.clone()).await.unwrap();
    turn(&runtime, &store, 1).await;
    *provider.model.lock().unwrap() = "claude-fixture".into();
    turn(&runtime, &store, 2).await;
    // A model-family change must not persist a second persona in history.
    assert_eq!(store.context("s", None).await.unwrap().unwrap()["epoch"], 1);
    let mut focused = agent;
    focused.instructions = Some("CUSTOM FOCUSED AGENT".into());
    runtime.set_agent("s", focused).await.unwrap();
    turn(&runtime, &store, 3).await;
    runtime.shutdown().await;
    let requests = provider.requests.lock().unwrap();
    let gemini = include_str!("../../../packages/core/src/system-context/persona/gemini.txt");
    let anthropic = include_str!("../../../packages/core/src/system-context/persona/anthropic.txt");
    assert!(requests[0].system.starts_with(gemini));
    assert!(requests[1].system.starts_with(anthropic));
    assert!(!requests[1].system.contains(gemini));
    assert!(requests[2].system.contains("CUSTOM FOCUSED AGENT"));
    assert!(!requests[2].system.contains(anthropic));
}
