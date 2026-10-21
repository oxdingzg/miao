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
use std::sync::atomic::{AtomicUsize, Ordering};
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
    runtime.with_product_tools(product_definitions(), Bridge::new(bridge_tx), None);
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

/// A product tool reply carrying `moved: true` (the worktree bridge) settles
/// the call durably and ends the run cleanly: no further provider turn is
/// requested from a location the Session no longer belongs to.
#[tokio::test]
async fn product_tool_moved_reply_ends_the_run_cleanly() {
    struct Mover {
        turns: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl Provider for Mover {
        async fn stream(
            &self,
            _: ModelRequest,
            _: mpsc::Sender<Value>,
            _: CancellationToken,
        ) -> Result<Reply, ProviderError> {
            if self.turns.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(Reply {
                    content: json!([{"type":"tool_use","id":"call_move","name":"enter_worktree","input":{"path":"../wt"}}]),
                    usage: json!({}),
                    needs_tools: true,
                });
            }
            Ok(Reply {
                content: json!([{"type":"text","text":"unreachable second turn"}]),
                usage: json!({}),
                needs_tools: false,
            })
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let turns = Arc::new(AtomicUsize::new(0));
    let tools = Tools::new(&root).await.unwrap();
    let (bridge_tx, mut bridge_rx) = tokio::sync::mpsc::channel::<Value>(8);
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Mover {
            turns: turns.clone(),
        }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime.with_product_tools(
        vec![ToolDefinition {
            name: "enter_worktree".into(),
            description: "Move this Session into a git worktree.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": false,
            }),
        }],
        Bridge::new(bridge_tx),
        None,
    );
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "move".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();

    let request = tokio::time::timeout(std::time::Duration::from_secs(5), bridge_rx.recv())
        .await
        .unwrap()
        .expect("bridge request");
    assert_eq!(request["params"]["name"], "enter_worktree");
    assert!(runtime.deliver_product_reply(
        request["bridge_id"].as_u64().unwrap(),
        json!({"result": {"moved": true, "directory": "/tmp/wt"}})
    ));

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let events = store.events("s", 0, 1000).await.unwrap();
        if events.iter().any(|event| event.kind == "run.finished") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run never finished after a moved reply"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    runtime.shutdown().await;

    assert_eq!(
        turns.load(Ordering::SeqCst),
        1,
        "a moved reply must end the run without another provider turn"
    );
    let history = store.history("s").await.unwrap();
    let rendered = serde_json::to_string(&history).unwrap();
    assert!(
        rendered.contains(r#"\"moved\":true"#),
        "moved tool result must settle durably: {rendered}"
    );
}
