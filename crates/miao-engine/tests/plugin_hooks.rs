use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    product::{Bridge, Marker},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

struct Reader {
    next: Arc<Notify>,
}
#[async_trait]
impl Provider for Reader {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call_read","name":"read_file","input":{"path":"a.txt"}}]),
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

async fn workspace(work: &str) -> (tempfile::TempDir, Store, Runtime, mpsc::Receiver<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.txt"), "alpha").unwrap();
    std::fs::write(root.join("b.txt"), "beta").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(&root).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader {
            next: Arc::new(Notify::new()),
        }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    let (bridge_tx, bridge_rx) = tokio::sync::mpsc::channel::<Value>(8);
    let marker = match work {
        "before" => Some(Marker {
            before: true,
            after: false,
            definition: false,
        }),
        "both" => Some(Marker {
            before: true,
            after: true,
            definition: false,
        }),
        "definition" => Some(Marker {
            before: false,
            after: false,
            definition: true,
        }),
        _ => None,
    };
    runtime.with_product_tools(vec![], Bridge::new(bridge_tx), marker);
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "hooks".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (dir, store, runtime, bridge_rx)
}

async fn next_request(bridge_rx: &mut mpsc::Receiver<Value>) -> (u64, Value) {
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), bridge_rx.recv())
        .await
        .unwrap()
        .expect("bridge request");
    let bridge_id = request["bridge_id"].as_u64().expect("bridge id");
    assert_eq!(request["method"], "hook_tool");
    (bridge_id, request["params"].clone())
}

async fn history_contains(store: &Store, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let history = store.history("s").await.unwrap();
        let rendered = serde_json::to_string(&history).unwrap();
        if rendered.contains(needle) {
            return rendered;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "expected {needle} in history, last: {rendered}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn plugin_before_transforms_the_input_before_execution() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("before").await;
    let (bridge_id, params) = next_request(&mut bridge_rx).await;
    assert_eq!(params["kind"], "before");
    assert_eq!(params["tool"], "read_file");
    assert_eq!(params["call_id"], "call_read");
    assert_eq!(params["session_id"], "s");
    assert_eq!(params["args"]["path"], "a.txt");
    assert!(
        runtime.deliver_product_reply(bridge_id, json!({"result": {"args": {"path": "b.txt"}}}))
    );
    let rendered = history_contains(&store, "beta").await;
    assert!(!rendered.contains("alpha"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn plugin_before_denial_blocks_the_call() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("before").await;
    let (bridge_id, _params) = next_request(&mut bridge_rx).await;
    assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {"deny": "audit said no"}})));
    let rendered = history_contains(&store, "audit said no").await;
    assert!(rendered.contains("error"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn plugin_after_replaces_the_settled_output() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("both").await;
    let (bridge_id, before) = next_request(&mut bridge_rx).await;
    assert_eq!(before["kind"], "before");
    assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {}})));
    let (bridge_id, after) = next_request(&mut bridge_rx).await;
    assert_eq!(after["kind"], "after");
    assert!(after["output"].is_object());
    assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {"output": "replaced"}})));
    history_contains(&store, "replaced").await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn plugin_after_denial_turns_the_result_into_an_error() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("both").await;
    let (bridge_id, _before) = next_request(&mut bridge_rx).await;
    assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {}})));
    let (bridge_id, _after) = next_request(&mut bridge_rx).await;
    assert!(
        runtime.deliver_product_reply(bridge_id, json!({"result": {"deny": "post-check failed"}}))
    );
    let rendered = history_contains(&store, "post-check failed").await;
    assert!(rendered.contains("error"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn plugin_hook_error_reply_fails_closed() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("before").await;
    let (bridge_id, _params) = next_request(&mut bridge_rx).await;
    assert!(runtime.deliver_product_reply(bridge_id, json!({"error": "host exploded"})));
    let rendered = history_contains(&store, "host exploded").await;
    assert!(rendered.contains("tool.execute.before hook unavailable"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn unmarked_tools_never_dispatch() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("none").await;
    history_contains(&store, "alpha").await;
    assert!(bridge_rx.try_recv().is_err());
    runtime.shutdown().await;
}

/// A `definition` marker routes the assembled tool surface through the host:
/// a deny verdict drops the tool, a transformed definition replaces it, and
/// each verdict is journaled.
#[tokio::test]
async fn plugin_definition_hooks_review_the_tool_surface() {
    let (_dir, store, runtime, mut bridge_rx) = workspace("definition").await;

    // The harness already admitted the prompt: every surfaced tool is reviewed before the provider turn: the first
    // dispatch is denied, the second transformed, the rest pass through.
    let mut denied: Option<String> = None;
    let mut transformed: Option<String> = None;
    loop {
        let request =
            match tokio::time::timeout(std::time::Duration::from_millis(500), bridge_rx.recv())
                .await
            {
                Ok(Some(request)) => request,
                _ => break,
            };
        let bridge_id = request["bridge_id"].as_u64().expect("bridge id");
        let params = request["params"].clone();
        if params["kind"] != "definition" {
            assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {}})));
            continue;
        }
        assert!(params["definition"].is_object());
        if denied.is_none() {
            denied = Some(params["tool"].as_str().unwrap().to_owned());
            assert!(runtime.deliver_product_reply(
                bridge_id,
                json!({"result": {"deny": "not allowed for this session"}})
            ));
            continue;
        }
        if transformed.is_none() {
            let reviewed = format!("{}_reviewed", params["tool"].as_str().unwrap());
            transformed = Some(reviewed.clone());
            assert!(runtime.deliver_product_reply(
                bridge_id,
                json!({"result": {"definition": {
                    "name": reviewed,
                    "description": "reviewed",
                    "input_schema": {"type": "object", "properties": {}}
                }}})
            ));
            continue;
        }
        assert!(runtime.deliver_product_reply(bridge_id, json!({"result": {}})));
    }

    let denied_tool = denied.expect("at least one definition dispatch");
    // Verdicts land in the event journal, not the message history.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let events = store.events("s", 0, 1000).await.unwrap();
        let definition = events.iter().find(|event| {
            event.kind == "hook_tool.completed"
                && event.data["kind"] == "definition"
                && event.data["outcome"] == "denied"
                && event.data["tool"] == json!(denied_tool)
        });
        if let Some(event) = definition {
            assert_eq!(event.data["reason"], "not allowed for this session");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "definition verdict never journaled: {events:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    runtime.shutdown().await;
}
