use async_trait::async_trait;
use miao_engine::{
    approval::{Approval, Response},
    host::Host,
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest, Request},
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
        let settled = request
            .messages
            .last()
            .and_then(|message| message.content.as_array())
            .is_some_and(|content| content.iter().any(|part| part["type"] == "tool_result"));
        Ok(Reply {
            content: if settled {
                json!([{"type":"text","text":"done"}])
            } else {
                json!([{"type":"tool_use","id":"read","name":"read_file","input":{"path":"file"}}])
            },
            usage: json!({}),
            needs_tools: !settled,
        })
    }
}

fn input(id: &str) -> Input {
    Input {
        session_id: "saved".into(),
        input_id: id.into(),
        prompt: "read the file".into(),
        delivery: Delivery::Steer,
        command: None,
        agent_references: Default::default(),
    }
}

#[tokio::test]
async fn a_revoked_snapshot_asks_again_on_the_same_runtime_and_cannot_clear_another_workspace() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let other = root.path().join("other");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&other).unwrap();
    std::fs::write(workspace.join("file"), "contents").unwrap();
    let store = Store::open(root.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            rules: vec![Rule {
                tool: "read_file".into(),
                path: "file".into(),
                decision: Decision::Ask,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let mut host = Host::new(runtime.clone());
    let rules = json!([{"action":"read_file","resource":"*","effect":"allow"}]);
    let request:Request=serde_json::from_value(json!({"id":1,"method":"permission_saved_snapshot","params":{"workspace":workspace.join("."),"rules":rules}})).unwrap();
    host.dispatch(request.command).await.unwrap();
    let canonical = workspace
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(store.saved_rules(canonical.clone()).await.unwrap().len(), 1);
    runtime.admit(input("first"), true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("saved", 0, 100)
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
    assert!(!store
        .events("saved", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "approval.requested"));
    let cursor = store
        .events("saved", 0, 100)
        .await
        .unwrap()
        .last()
        .unwrap()
        .seq;
    let request:Request=serde_json::from_value(json!({"id":2,"method":"permission_saved_snapshot","params":{"workspace":workspace,"rules":[]}})).unwrap();
    host.dispatch(request.command).await.unwrap();
    assert!(store.saved_rules(canonical).await.unwrap().is_empty());
    runtime.admit(input("second"), true).await.unwrap();
    let approval: Approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("saved", cursor, 100)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "approval.requested")
            {
                break serde_json::from_value(event.data).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(approval.tool, "read_file");
    runtime
        .approve(
            &runtime.controller(),
            "saved",
            Response {
                request_id: approval.request_id,
                input_hash: approval.input_hash,
                policy_revision: approval.policy_revision,
                decision: Decision::Deny,
                matcher: None,
            },
        )
        .await
        .unwrap();
    let request:Request=serde_json::from_value(json!({"id":3,"method":"permission_saved_snapshot","params":{"workspace":other,"rules":[]}})).unwrap();
    assert!(host.dispatch(request.command).await.is_err());
    runtime.shutdown().await;
}
