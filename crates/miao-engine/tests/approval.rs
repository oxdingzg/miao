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
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: "one".into(),
        prompt: "read".into(),
        delivery: Delivery::Steer,
    }
}
async fn approval(store: &Store) -> Approval {
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
    .await;
    match outcome {
        Ok(value) => value,
        Err(error) => {
            let events = store.events("s", 0, 100).await.map(|events| {
                events
                    .into_iter()
                    .map(|event| event.kind)
                    .collect::<Vec<_>>()
            });
            panic!("event wait timed out: {error}; committed event kinds: {events:?}");
        }
    }
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
    assert_eq!(grants(&dir.path().join("engine.db")), 0);
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

async fn session_event(store: &Store, session: &str, kind: &str) -> miao_engine::protocol::Event {
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events(session, 0, 200)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == kind)
            {
                return event;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await;
    match result {
        Ok(event) => event,
        Err(error) => panic!(
            "{session} waiting for {kind}: {error}; events: {:?}",
            store.events(session, 0, 200).await.unwrap()
        ),
    }
}
fn grants(database: &std::path::Path) -> u64 {
    rusqlite::Connection::open(database)
        .unwrap()
        .query_row("SELECT count(*) FROM engine_permission_grant", [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn ask_reads() -> Policy {
    Policy::new(Config {
        rules: vec![Rule {
            tool: "read_file".into(),
            path: "*".into(),
            decision: Decision::Ask,
        }],
        approval_timeout_ms: 60_000,
        ..Config::default()
    })
    .unwrap()
}
struct OtherReader;
#[async_trait]
impl Provider for OtherReader {
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let mut reply = Reader.stream(request, progress, cancel).await?;
        if reply.needs_tools {
            reply.content[0]["input"]["path"] = json!("other");
        }
        Ok(reply)
    }
}
#[tokio::test]
async fn persistent_grant_survives_restart_across_sessions_but_not_changed_input() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("file"), "original").unwrap();
    std::fs::write(directory.path().join("other"), "different").unwrap();
    let database = directory.path().join("engine.db");
    let store = Store::open(&database).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(directory.path()).await.unwrap(),
        ask_reads(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    let mut forged = response(&binding, Decision::Allow);
    forged.input_hash = "wrong".into();
    assert!(matches!(
        runtime
            .approve_persistent(&runtime.controller(), "s", forged)
            .await,
        Err(Error::ApprovalMismatch)
    ));
    assert_eq!(grants(&database), 0);
    runtime
        .approve_persistent(
            &runtime.controller(),
            "s",
            response(&binding, Decision::Allow),
        )
        .await
        .unwrap();
    finished(&store).await;
    assert_eq!(grants(&database), 1);
    assert!(matches!(
        runtime
            .approve_persistent(
                &runtime.controller(),
                "s",
                response(&binding, Decision::Allow)
            )
            .await,
        Err(Error::ApprovalResolved)
    ));
    assert_eq!(grants(&database), 1);
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
    let store = Store::open(&database).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(directory.path()).await.unwrap(),
        ask_reads(),
    )
    .await
    .unwrap();
    let mut next = input();
    next.session_id = "second".into();
    next.input_id = "second-input".into();
    runtime.admit(next, true).await.unwrap();
    session_event(&store, "second", "run.finished").await;
    let events = store.events("second", 0, 200).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "permission.grant.used"));
    assert!(events
        .iter()
        .all(|event| event.kind != "approval.requested"));
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
    let store = Store::open(&database).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(OtherReader),
        Tools::new(directory.path()).await.unwrap(),
        ask_reads(),
    )
    .await
    .unwrap();
    let mut next = input();
    next.session_id = "changed".into();
    next.input_id = "changed-input".into();
    runtime.admit(next, true).await.unwrap();
    let event = session_event(&store, "changed", "approval.requested").await;
    let binding: Approval = serde_json::from_value(event.data).unwrap();
    assert_eq!(binding.resource, "other");
    runtime
        .approve(
            &runtime.controller(),
            "changed",
            response(&binding, Decision::Deny),
        )
        .await
        .unwrap();
    session_event(&store, "changed", "run.finished").await;
    assert_eq!(grants(&database), 1);
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
    for (session, boundary, deny) in [("boundary", true, false), ("denied", false, true)] {
        let store = Store::open(&database).await.unwrap();
        let selected = if deny {
            policy(60_000, Decision::Deny)
        } else {
            ask_reads()
        };
        let tools = Tools::new(directory.path()).await.unwrap();
        let tools = if boundary {
            tools.with_protected_resource(&directory.path().join("other"))
        } else {
            tools
        };
        let runtime = Runtime::with_policy(store.clone(), Arc::new(Reader), tools, selected)
            .await
            .unwrap();
        let mut next = input();
        next.session_id = session.into();
        next.input_id = format!("{session}-input");
        runtime.admit(next, true).await.unwrap();
        if !deny {
            let event = session_event(&store, session, "approval.requested").await;
            let binding: Approval = serde_json::from_value(event.data).unwrap();
            runtime
                .approve(
                    &runtime.controller(),
                    session,
                    response(&binding, Decision::Deny),
                )
                .await
                .unwrap();
        }
        session_event(&store, session, "run.finished").await;
        let events = store.events(session, 0, 200).await.unwrap();
        assert!(events
            .iter()
            .all(|event| event.kind != "permission.grant.used"));
        if deny {
            assert!(events
                .iter()
                .all(|event| event.kind != "approval.requested"));
        }
        assert_eq!(grants(&database), 1);
        runtime.shutdown().await;
        drop(runtime);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn grant_and_resolution_roll_back_together_when_event_commit_fails() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("file"), "original").unwrap();
    let database = directory.path().join("engine.db");
    let store = Store::open(&database).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(directory.path()).await.unwrap(),
        ask_reads(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    connection.execute_batch("CREATE TRIGGER reject_resolution BEFORE INSERT ON engine_event WHEN NEW.kind='approval.resolved' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;").unwrap();
    assert!(runtime
        .approve_persistent(
            &runtime.controller(),
            "s",
            response(&binding, Decision::Allow)
        )
        .await
        .is_err());
    assert_eq!(grants(&database), 0);
    assert_eq!(
        store.approval_state(&binding.request_id).await.unwrap(),
        "pending"
    );
    assert!(!store
        .events("s", 0, 200)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "approval.resolved"));
    connection
        .execute_batch("DROP TRIGGER reject_resolution;")
        .unwrap();
    runtime
        .approve_persistent(
            &runtime.controller(),
            "s",
            response(&binding, Decision::Allow),
        )
        .await
        .unwrap();
    finished(&store).await;
    assert_eq!(grants(&database), 1);
    let event = session_event(&store, "s", "approval.resolved").await;
    assert_eq!(event.data["persistent"], true);
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
}

#[tokio::test]
async fn agent_switch_invalidates_pending_permanent_resolution_without_a_grant() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("file"), "original").unwrap();
    let database = directory.path().join("engine.db");
    let store = Store::open(&database).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Reader),
        Tools::new(directory.path()).await.unwrap(),
        ask_reads(),
    )
    .await
    .unwrap();
    runtime.admit(input(), true).await.unwrap();
    let binding = approval(&store).await;
    runtime
        .set_agent(
            "s",
            serde_json::from_value(json!({"name":"restricted","tools":{"deny":["read_file"]}}))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(runtime
        .approve_persistent(
            &runtime.controller(),
            "s",
            response(&binding, Decision::Allow)
        )
        .await
        .is_err());
    assert_ne!(
        store.approval_state(&binding.request_id).await.unwrap(),
        "pending"
    );
    assert_eq!(grants(&database), 0);
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
}

#[tokio::test]
async fn expired_or_cancelled_approval_cannot_commit_a_permanent_grant() {
    for expire in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("file"), "original").unwrap();
        let database = directory.path().join("engine.db");
        let store = Store::open(&database).await.unwrap();
        let runtime = Runtime::with_policy(
            store.clone(),
            Arc::new(Reader),
            Tools::new(directory.path()).await.unwrap(),
            ask_reads(),
        )
        .await
        .unwrap();
        runtime.admit(input(), true).await.unwrap();
        let binding = approval(&store).await;
        if expire {
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .busy_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            connection.execute("UPDATE engine_approval SET binding=json_set(binding,'$.expires_at_ms',0),expires_at=0 WHERE id=?1",[&binding.request_id]).unwrap();
        }
        if !expire {
            runtime.cancel("s").await.unwrap();
        }
        assert!(runtime
            .approve_persistent(
                &runtime.controller(),
                "s",
                response(&binding, Decision::Allow)
            )
            .await
            .is_err());
        assert_eq!(grants(&database), 0);
        assert_ne!(
            store.approval_state(&binding.request_id).await.unwrap(),
            "allow"
        );
        runtime.shutdown().await;
        drop(runtime);
        store.close().await.unwrap();
    }
}
