use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    product::Bridge,
    protocol::{Delivery, Input, ModelRequest, ToolDefinition},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Submitter {
    next: Arc<Notify>,
}
#[async_trait]
impl Provider for Submitter {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        println!(
            "TOOLS {:?}",
            request
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
        );
        assert!(request.tools.iter().any(|tool| tool.name == "send_message"));
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call_send","name":"send_message","input":{"to":"@other","text":"hello from native"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        self.next.notify_one();
        cancel.cancelled().await;
        Err(ProviderError::Interrupted)
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

fn product_definitions() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "send_message".into(),
        description: "Send a message to a sibling session.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {"to": {"type": "string"}, "text": {"type": "string"}},
            "required": ["to", "text"],
            "additionalProperties": false,
        }),
    }]
}

#[tokio::test]
async fn product_tool_reverse_dispatches_to_host_and_returns_result() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let next = Arc::new(Notify::new());
    let tools = Tools::new(&root).await.unwrap();
    let (bridge_tx, mut bridge_rx) = tokio::sync::mpsc::channel::<Value>(8);
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter { next: next.clone() }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime.with_product_tools(product_definitions(), Bridge::new(bridge_tx));
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "bridge".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();

    // The runtime reverse-dispatches the product tool to the host channel.
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), bridge_rx.recv())
        .await
        .unwrap()
        .expect("bridge request");
    let bridge_id = request["bridge_id"].as_u64().expect("bridge id");
    assert_eq!(request["method"], "product_tool");
    assert_eq!(request["params"]["session_id"], "s");
    assert_eq!(request["params"]["name"], "send_message");
    assert_eq!(
        request["params"]["input"]["text"],
        json!("hello from native")
    );

    // The host replies; the runtime routes it back and the turn continues.
    assert!(runtime.deliver_product_reply(
        bridge_id,
        json!({"result": {"delivered": true, "to": "@other"}})
    ));

    // The durable tool result is the host's product-tool output.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let rendered = loop {
        let history = store.history("s").await.unwrap();
        let rendered = serde_json::to_string(&history).unwrap();
        if rendered.contains(r#"\"delivered\":true"#) {
            break rendered;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "product tool result never landed: {rendered}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(rendered.contains("hello from native"));
    runtime.shutdown().await;

    // Unknown bridge replies are dropped, not fabricated into results.
    assert!(!runtime.deliver_product_reply(999_999, json!({"result": {}})));
}
