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
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Recovery;
#[async_trait]
impl Provider for Recovery {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let results: Vec<Value> = request
            .messages
            .iter()
            .flat_map(|message| message.content.as_array().into_iter().flatten())
            .filter(|part| part["type"] == "tool_result")
            .map(|part| {
                serde_json::from_str(part["content"].as_str().unwrap_or_default())
                    .unwrap_or(json!({}))
            })
            .collect();
        let call = |name: &str, input: Value| json!([{"type":"tool_use","id":format!("call{}",request.messages.len()),"name":name,"input":input}]);
        Ok(if results.is_empty() {
            Reply {
                content: call(
                    "write_file",
                    json!({"path":"doc","text":"alpha beta alpha","expected_sha256":null}),
                ),
                usage: json!({}),
                needs_tools: true,
            }
        } else if results.len() == 1 {
            Reply {
                content: call(
                    "edit_file",
                    json!({"path":"doc","old_string":"beta","new_string":"BETA","expected_sha256":"de".repeat(32)}),
                ),
                usage: json!({}),
                needs_tools: true,
            }
        } else if results.len() == 2 {
            let stale = &results[1];
            assert_eq!(
                stale["error"], "file content changed or expected fingerprint does not match",
                "{stale}"
            );
            assert_eq!(stale["current_sha256"], results[0]["sha256"]);
            assert_eq!(stale["old_string_occurrences"], 1);
            Reply {
                content: call(
                    "edit_file",
                    json!({"path":"doc","old_string":"beta","new_string":"BETA","expected_sha256":stale["current_sha256"]}),
                ),
                usage: json!({}),
                needs_tools: true,
            }
        } else if results.len() == 3 {
            assert_eq!(results[2]["applied"], true, "{:?}", results[2]);
            Reply {
                content: json!([{"type":"text","text":"recovered"}]),
                usage: json!({}),
                needs_tools: false,
            }
        } else {
            unreachable!("unexpected extra provider turn");
        })
    }
}

#[tokio::test]
async fn stale_edit_rejection_carries_fingerprint_and_settles_as_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Recovery),
        Tools::new(dir.path()).await.unwrap().with_writes(true),
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
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "edit".into(),
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
    let receipt = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "tool.completed")
        .map(|event| event.data["is_error"] == true)
        .collect::<Vec<_>>();
    assert_eq!(
        receipt,
        vec![false, true, false],
        "stale rejection must settle as an error receipt"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("doc")).unwrap(),
        "alpha BETA alpha"
    );
    runtime.shutdown().await;
}
