use miao_engine::{
    approval::{now_ms, Approval, Response},
    permission::{input_digest, Config, Decision, Policy, Rule},
    permission_grant::Scope,
    protocol::Error,
    store::Store,
};
use serde_json::json;

async fn pending() -> (tempfile::TempDir, Store, Vec<(Approval, Scope)>) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store
        .initialize("s", "approval lifetime", "/workspace")
        .await
        .unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([
                {"type":"tool_use","id":"first","name":"read_file","input":{"path":"file"}},
                {"type":"tool_use","id":"other","name":"read_file","input":{"path":"file"}}
            ]),
        )
        .await
        .unwrap();
    let policy = Policy::new(Config {
        rules: vec![Rule {
            tool: "read_file".into(),
            path: "file".into(),
            decision: Decision::Ask,
        }],
        ..Config::default()
    })
    .unwrap();
    let mut requests = Vec::new();
    for call in ["first", "other"] {
        let input = json!({"path":"file"});
        let approval = Approval {
            request_id: format!("approval-{call}"),
            session_id: "s".into(),
            run_id: "run".into(),
            call_id: call.into(),
            location: "/workspace".into(),
            tool: "read_file".into(),
            mcp: None,
            resource: "file".into(),
            input_hash: input_digest("/workspace", "read_file", "file", &input).unwrap(),
            input,
            policy_revision: policy.revision().into(),
            matcher: policy
                .assess("read_file", "file", miao_engine::permission::Access::Read)
                .1,
            expires_at_ms: now_ms() + 60_000,
        };
        let scope = Scope::new(
            "/workspace".into(),
            "fixture-authority".into(),
            "read_file".into(),
            "file".into(),
            vec!["/workspace/file".into()],
            approval.input_hash.clone(),
        )
        .unwrap();
        store
            .request_approval_with_scope(approval.clone(), scope.clone())
            .await
            .unwrap();
        requests.push((approval, scope));
    }
    (directory, store, requests)
}

fn response(approval: &Approval) -> Response {
    Response {
        request_id: approval.request_id.clone(),
        input_hash: approval.input_hash.clone(),
        policy_revision: approval.policy_revision.clone(),
        decision: Decision::Allow,
        matcher: None,
    }
}

#[tokio::test]
async fn settled_call_cancels_only_its_pending_approval_before_the_run_finishes() {
    let (_directory, store, requests) = pending().await;
    let (approval, scope) = &requests[0];
    store
        .tool_result("s", "run", "first", json!({"error":"call cancelled"}), true)
        .await
        .unwrap();
    assert_eq!(store.active_run("s").await.unwrap().as_deref(), Some("run"));
    assert_eq!(
        store.approval_state(&approval.request_id).await.unwrap(),
        "cancelled"
    );
    assert_eq!(
        store
            .approval_state(&requests[1].0.request_id)
            .await
            .unwrap(),
        "pending"
    );
    assert!(matches!(
        store
            .resolve_approval_persistent("s", response(approval))
            .await,
        Err(Error::ApprovalResolved)
    ));
    assert!(!store.has_permission_grant(scope.clone()).await.unwrap());
    let events = store.events("s", 0, 100).await.unwrap();
    let resolved = events
        .iter()
        .position(|event| {
            event.kind == "approval.resolved" && event.data["request_id"] == approval.request_id
        })
        .unwrap();
    let completed = events
        .iter()
        .position(|event| event.kind == "tool.completed")
        .unwrap();
    assert!(resolved < completed);
    store.close().await.unwrap();
}

#[tokio::test]
async fn late_replies_cannot_grant_a_call_that_has_left_its_approval_boundary() {
    let (_directory, store, requests) = pending().await;
    let (approval, scope) = &requests[0];
    // Exercise the durable transition itself: a pending request left behind by
    // an older writer must not become authority just because its run is live.
    store.mark_dispatched("s", "run", "first").await.unwrap();
    store.mark_dispatched("s", "run", "other").await.unwrap();
    let permanent = store
        .resolve_approval_persistent("s", response(approval))
        .await;
    let ordinary = store.resolve_approval("s", response(&requests[1].0)).await;
    let granted = store.has_permission_grant(scope.clone()).await.unwrap();
    store.close().await.unwrap();
    assert!(
        !granted,
        "a late persistent reply created a grant: {permanent:?}"
    );
    assert!(matches!(permanent, Err(Error::ApprovalResolved)));
    assert!(matches!(ordinary, Err(Error::ApprovalResolved)));
}

#[tokio::test]
async fn failed_approval_cancellation_rolls_back_tool_settlement() {
    let (directory, store, requests) = pending().await;
    let approval = &requests[0].0;
    let connection = rusqlite::Connection::open(directory.path().join("engine.db")).unwrap();
    connection.execute_batch("CREATE TRIGGER refuse_cancellation BEFORE INSERT ON engine_event WHEN NEW.kind='approval.resolved' BEGIN SELECT RAISE(ABORT,'fixture cancellation rollback'); END;").unwrap();
    assert!(store
        .tool_result("s", "run", "first", json!({"error":"call cancelled"}), true)
        .await
        .is_err());
    assert_eq!(
        store.approval_state(&approval.request_id).await.unwrap(),
        "pending"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT state FROM engine_tool WHERE id='run/first'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "planned"
    );
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "tool.completed"));
    connection
        .execute_batch("DROP TRIGGER refuse_cancellation")
        .unwrap();
    store
        .tool_result("s", "run", "first", json!({"error":"call cancelled"}), true)
        .await
        .unwrap();
    assert_eq!(
        store.approval_state(&approval.request_id).await.unwrap(),
        "cancelled"
    );
    drop(connection);
    store.close().await.unwrap();
}
