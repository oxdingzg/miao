use async_trait::async_trait;
use miao_engine::{
    approval::{Approval, Response},
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Error, Input, ModelRequest},
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
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn policy(timeout: u64, decision: Decision) -> Policy {
    Policy::new(Config {
        rules: vec![Rule {
            tool: "read_file".into(),
            path: "file".into(),
            decision,
        }],
        approval_timeout_ms: timeout,
        ..Config::default()
    })
    .unwrap()
}
fn input() -> Input {
    Input {
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "read".into(),
        delivery: Delivery::Steer,
    }
}
async fn approval(store: &Store) -> Approval {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .find(|e| e.kind == "approval.requested")
            {
                return serde_json::from_value(event.data.clone()).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
fn response(approval: &Approval, decision: Decision) -> Response {
    Response {
        request_id: approval.request_id.clone(),
        input_hash: approval.input_hash.clone(),
        policy_revision: approval.policy_revision.clone(),
        decision,
        matcher: None,
    }
}

#[tokio::test]
async fn approval_matches_controller_input_policy_and_only_resolves_once() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(dir.path()).await.unwrap(),
        policy(60_000, Decision::Ask),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    assert_eq!(binding.resource, "file");
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "tool.dispatched"));
    let mut wrong = response(&binding, Decision::Allow);
    wrong.input_hash = "other".into();
    assert!(matches!(
        runtime.approve(&runtime.controller(), "s", wrong).await,
        Err(Error::ApprovalMismatch)
    ));
    let mut wrong = response(&binding, Decision::Allow);
    wrong.policy_revision = "other".into();
    assert!(matches!(
        runtime.approve(&runtime.controller(), "s", wrong).await,
        Err(Error::ApprovalMismatch)
    ));
    let foreign = Runtime::with_policy(
        Store::open(dir.path().join("foreign.db")).await.unwrap(),
        Arc::new(Reader),
        Tools::new(dir.path()).await.unwrap(),
        policy(60_000, Decision::Ask),
    )
    .await
    .unwrap();
    assert!(matches!(
        runtime
            .approve(
                &foreign.controller(),
                "s",
                response(&binding, Decision::Allow)
            )
            .await,
        Err(Error::ApprovalMismatch)
    ));
    assert_eq!(
        store.approval_state(&binding.request_id).await.unwrap(),
        "pending"
    );
    runtime
        .approve(
            &runtime.controller(),
            "s",
            response(&binding, Decision::Allow),
        )
        .await
        .unwrap();
    assert!(matches!(
        runtime
            .approve(
                &runtime.controller(),
                "s",
                response(&binding, Decision::Allow)
            )
            .await,
        Err(Error::ApprovalResolved)
    ));
    finished(&store).await;
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "tool.dispatched")
            .count(),
        1
    );
    assert!(store.history("s").await.unwrap()[2].content[0]["content"]
        .as_str()
        .unwrap()
        .contains("contents"));
    runtime.shutdown().await;
    foreign.shutdown().await;
}

#[tokio::test]
async fn cancel_while_waiting_invalidates_late_response_without_dispatch_or_unknown() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(dir.path()).await.unwrap(),
        policy(60_000, Decision::Ask),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(250), runtime.cancel("s"))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(matches!(
        runtime
            .approve(
                &runtime.controller(),
                "s",
                response(&binding, Decision::Allow)
            )
            .await,
        Err(Error::ApprovalResolved)
    ));
    finished(&store).await;
    assert_eq!(
        store.approval_state(&binding.request_id).await.unwrap(),
        "cancelled"
    );
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "tool.dispatched"));
    let conn = rusqlite::Connection::open(dir.path().join("engine.db")).unwrap();
    let state: String = conn
        .query_row("SELECT state FROM engine_tool", [], |r| r.get(0))
        .unwrap();
    assert_eq!(state, "not_executed");
    runtime.shutdown().await;
}

#[tokio::test]
async fn timeout_or_deny_does_not_dispatch() {
    for decision in [Decision::Ask, Decision::Deny] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file"), "contents").unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let runtime = Runtime::with_policy(
            store.clone(),
            Arc::new(Reader),
            Tools::new(dir.path()).await.unwrap(),
            policy(200, decision),
        )
        .await
        .unwrap();
        runtime.admit(input(), true).await.unwrap();
        finished(&store).await;
        let events = store.events("s", 0, 100).await.unwrap();
        assert!(!events.iter().any(|e| e.kind == "tool.dispatched"));
        if decision == Decision::Ask {
            let binding = approval(&store).await;
            assert_eq!(
                store.approval_state(&binding.request_id).await.unwrap(),
                "expired"
            );
        } else {
            assert!(!events.iter().any(|e| e.kind == "approval.requested"));
        }
        assert_eq!(
            store.history("s").await.unwrap()[2].content[0]["is_error"],
            true
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn location_conflict_is_atomic_and_same_store_cannot_host_two_runtimes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let runtime = Runtime::new(store.clone(), Arc::new(Reader), tools.clone())
        .await
        .unwrap();
    runtime.admit(input(), false).await.unwrap();
    assert!(matches!(
        Store::admit_at(
            &store,
            Input {
                input_id: "new".into(),
                ..input()
            },
            Some("other".into())
        )
        .await,
        Err(Error::Conflict)
    ));
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
    assert!(matches!(
        Runtime::new(store.clone(), Arc::new(Reader), tools).await,
        Err(Error::Busy)
    ));
    runtime.shutdown().await;
}

#[tokio::test]
async fn approval_carries_matcher_semantics_and_scopes_the_resolution() {
    use miao_engine::permission::MatchSource;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "contents").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(dir.path()).await.unwrap(),
        policy(60_000, Decision::Ask),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    assert_eq!(binding.matcher.tool, "read_file");
    assert_eq!(binding.matcher.path, "file");
    assert_eq!(binding.matcher.decision, Decision::Ask);
    assert_eq!(binding.matcher.source, MatchSource::Rule);
    let mut wrong = response(&binding, Decision::Allow);
    wrong.matcher = Some(miao_engine::permission::RuleMatch {
        tool: "read_file".into(),
        path: "other".into(),
        decision: Decision::Ask,
        source: MatchSource::Rule,
    });
    assert!(matches!(
        runtime.approve(&runtime.controller(), "s", wrong).await,
        Err(Error::ApprovalMismatch)
    ));
    let mut scoped = response(&binding, Decision::Allow);
    scoped.matcher = Some(binding.matcher.clone());
    runtime
        .approve(&runtime.controller(), "s", scoped)
        .await
        .unwrap();
    finished(&store).await;
    runtime.shutdown().await;
}
