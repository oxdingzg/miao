use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Policy},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Reader;

#[async_trait]
impl Provider for Reader {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let first = request.messages.len() == 1;
        Ok(Reply {
            content: if first {
                json!([{"type":"tool_use","id":"read","name":"read_file","input":{"path":"😀.txt"}}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools: first,
        })
    }
}

#[tokio::test]
async fn configured_deny_counts_utf16_units_before_native_tool_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("😀.txt"), "must not be read").unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(directory.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "unicode".into(),
                input_id: "read".into(),
                prompt: "read the file".into(),
                delivery: Delivery::Steer,
            },
            false,
        )
        .await
        .unwrap();
    runtime
        .set_agent(
            "unicode",
            serde_json::from_value(json!({
                "name":"reader",
                "ordered_permissions":{
                    "semantics":"ordered-wildcard-v1",
                    "rules":[
                        {"action":"read","resource":"*","effect":"allow"},
                        {"action":"read","resource":"??.txt","effect":"deny"}
                    ],
                    "bindings":{"read_file":{"action":"read","resource":{"input":"path"}}}
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    runtime.resume("unicode").await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("unicode", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let events = store.events("unicode", 0, 100).await.unwrap();
    assert!(
        !events
            .iter()
            .any(|event| event.kind == "tool.dispatched" || event.kind == "approval.requested"),
        "a configured deny must prevent execution and approval: {:?}",
        events.iter().map(|event| &event.kind).collect::<Vec<_>>()
    );
    assert!(events
        .iter()
        .any(|event| event.kind == "permission_denied" && event.data["reason"] == "policy"));
    assert_eq!(
        store.history("unicode").await.unwrap()[2].content[0]["is_error"],
        true
    );
    runtime.shutdown().await;
}
