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

struct Batch(Value);
#[async_trait]
impl Provider for Batch {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(if request.messages.len() == 1 {
            Reply {
                content: self.0.clone(),
                usage: json!({}),
                needs_tools: true,
            }
        } else {
            Reply {
                content: json!([{"type":"text","text":"done"}]),
                usage: json!({}),
                needs_tools: false,
            }
        })
    }
}
fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"tool_use","id":id,"name":name,"input":input})
}
async fn execute(root: &std::path::Path, calls: Value, denied: bool) -> Store {
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let policy = Policy::new(Config {
        mode: Mode::Workspace,
        rules: if denied {
            vec![Rule {
                tool: "read_file".into(),
                path: "a".into(),
                decision: Decision::Deny,
            }]
        } else {
            vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }]
        },
        ..Config::default()
    })
    .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Batch(calls)),
        Tools::new(root).await.unwrap(),
        policy,
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "run tools".into(),
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
    store
}

#[tokio::test]
async fn native_reads_dispatch_together_and_project_results_in_call_order() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "alpha").unwrap();
    std::fs::write(dir.path().join("b"), "beta").unwrap();
    let store = execute(
        dir.path(),
        json!([
            call("one", "read_file", json!({"path":"a"})),
            call("two", "read_file", json!({"path":"b"})),
            call("three", "list_files", json!({"path":"."})),
            call("four", "glob", json!({"pattern":"*"})),
        ]),
        false,
    )
    .await;
    let events = store.events("s", 0, 1000).await.unwrap();
    let batch = events
        .iter()
        .find(|event| event.kind == "tool.parallel.started")
        .unwrap();
    assert_eq!(batch.data["concurrency"], 4);
    assert_eq!(
        batch.data["call_ids"],
        json!(["one", "two", "three", "four"])
    );
    let first_result = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap()
        .seq;
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched" && event.seq < first_result)
            .count(),
        4
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "post_tool_use")
            .count(),
        4
    );
    let history = store.history("s").await.unwrap();
    let results: Vec<&Value> = history
        .iter()
        .flat_map(|message| message.content.as_array().unwrap())
        .filter(|block| block["type"] == "tool_result")
        .collect();
    assert_eq!(
        results
            .iter()
            .map(|result| result["tool_use_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["one", "two", "three", "four"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(results[0]["content"].as_str().unwrap()).unwrap()["text"],
        "alpha"
    );
    assert_eq!(
        serde_json::from_str::<Value>(results[1]["content"].as_str().unwrap()).unwrap()["text"],
        "beta"
    );
    assert!(results.iter().all(|result| result["is_error"] == false));
    // Each batched read settles with the window the batch measured for it.
    assert!(events
        .iter()
        .filter(|event| event.kind == "tool.completed")
        .all(|event| event.data["elapsed_ms"].as_u64().is_some()));
}

#[tokio::test]
async fn mixed_turn_keeps_write_then_read_barrier() {
    let dir = tempfile::tempdir().unwrap();
    let store = execute(
        dir.path(),
        json!([
            call(
                "write",
                "write_file",
                json!({"path":"a","text":"created","expected_sha256":null})
            ),
            call("read", "read_file", json!({"path":"a"})),
        ]),
        false,
    )
    .await;
    let events = store.events("s", 0, 1000).await.unwrap();
    assert!(!events
        .iter()
        .any(|event| event.kind == "tool.parallel.started"));
    let first_result = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap()
        .seq;
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched" && event.seq < first_result)
            .count(),
        1
    );
    let history = store.history("s").await.unwrap();
    assert!(history
        .iter()
        .any(|message| message.content.to_string().contains("created")));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a")).unwrap(),
        "created"
    );
}

#[tokio::test]
async fn denied_read_keeps_policy_result_and_serial_admission() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "secret").unwrap();
    std::fs::write(dir.path().join("b"), "public").unwrap();
    let store = execute(
        dir.path(),
        json!([
            call("one", "read_file", json!({"path":"a"})),
            call("two", "read_file", json!({"path":"b"})),
        ]),
        true,
    )
    .await;
    let events = store.events("s", 0, 1000).await.unwrap();
    assert!(!events
        .iter()
        .any(|event| event.kind == "tool.parallel.started"));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched")
            .count(),
        1
    );
    let history = store.history("s").await.unwrap();
    assert!(!history
        .iter()
        .any(|message| message.content.to_string().contains("secret")));
    assert!(history
        .iter()
        .any(|message| message.content.to_string().contains("permission denied")));
}

#[tokio::test]
async fn all_dispatched_reads_settle_before_repeat_guard_stops_the_run() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "same").unwrap();
    let store = execute(
        dir.path(),
        json!((0..4)
            .map(|index| call(&format!("read{index}"), "read_file", json!({"path":"a"})))
            .collect::<Vec<_>>()),
        false,
    )
    .await;
    let events = store.events("s", 0, 1000).await.unwrap();
    assert!(events.iter().any(|event| event.kind == "loop.detected"));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched")
            .count(),
        4
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed")
            .count(),
        4
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "post_tool_use")
            .count(),
        4
    );
    assert!(!events.iter().any(|event| event.kind == "tool.unknown"));
}

#[tokio::test]
async fn cancellation_settles_every_dispatched_read_without_unknown_results() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("a"), "alpha").unwrap();
    std::fs::write(workspace.join("b"), "beta").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Batch(json!([
            call("one", "read_file", json!({"path":"a"})),
            call("two", "read_file", json!({"path":"b"}))
        ]))),
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
                session_id: "reader".into(),
                input_id: "one".into(),
                prompt: "read".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // Cancel as soon as both reads are admitted; settlement must still
    // complete for every dispatched call regardless of the race outcome.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("reader", 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "tool.dispatched")
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let cancelled =
        tokio::time::timeout(std::time::Duration::from_secs(5), runtime.cancel("reader"))
            .await
            .unwrap()
            .unwrap();
    assert!(cancelled);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("reader", 0, 1000)
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
    let events = store.events("reader", 0, 1000).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched")
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed")
            .count(),
        2
    );
    assert!(!events.iter().any(|event| event.kind == "tool.unknown"));
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "interrupted"));
    runtime.shutdown().await;
}
