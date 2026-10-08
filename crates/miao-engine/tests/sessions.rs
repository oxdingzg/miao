use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};
use serde_json::json;

fn input(session: &str, id: &str) -> Input {
    Input {
        session_id: session.into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}

#[tokio::test]
async fn snapshot_cursor_matches_projection_and_pending_inbox() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_at(input("parent", "first"), Some("root".into()))
        .await
        .unwrap();
    store.promote("parent", true).await.unwrap();
    store.admit(input("parent", "pending")).await.unwrap();
    let snapshot = store.snapshot("parent").await.unwrap();
    assert_eq!(snapshot["location"], "root");
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["pending"][0]["input_id"], "pending");
    let cursor = snapshot["cursor"].as_u64().unwrap();
    assert!(store
        .events("parent", cursor, 100)
        .await
        .unwrap()
        .is_empty());
    store
        .message(
            "parent",
            "assistant",
            json!([{"type":"text","text":"answer"}]),
        )
        .await
        .unwrap();
    assert_eq!(
        store.events("parent", cursor, 100).await.unwrap()[0].kind,
        "message.committed"
    );
    assert!(store.snapshot("missing").await.is_err());
}

#[tokio::test]
async fn fork_reconciles_retry_copies_only_closed_messages_and_never_wakes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_at(input("parent", "first"), Some("root".into()))
        .await
        .unwrap();
    store.promote("parent", true).await.unwrap();
    let end = store
        .message(
            "parent",
            "assistant",
            json!([{"type":"text","text":"answer"}]),
        )
        .await
        .unwrap();
    store.admit(input("parent", "pending")).await.unwrap();
    let branch = store.fork("parent", "child", None).await.unwrap();
    assert_eq!(branch["message_seq"], end.seq);
    assert_eq!(branch["duplicate"], false);
    assert_eq!(store.history("child").await.unwrap().len(), 2);
    assert_eq!(
        store.location("child").await.unwrap().as_deref(),
        Some("root")
    );
    let snapshot = store.snapshot("child").await.unwrap();
    assert!(snapshot["pending"].as_array().unwrap().is_empty());
    assert!(snapshot["active_run"].is_null());
    assert!(snapshot["approvals"].as_array().unwrap().is_empty());
    store
        .message(
            "parent",
            "assistant",
            json!([{"type":"text","text":"later"}]),
        )
        .await
        .unwrap();
    assert_eq!(
        store.fork("parent", "child", None).await.unwrap()["duplicate"],
        true
    );
    assert_eq!(store.history("child").await.unwrap().len(), 2);
    assert!(matches!(
        store.fork("parent", "child", Some(end.seq + 1)).await,
        Err(Error::Conflict)
    ));
    store.admit(input("other", "other")).await.unwrap();
    assert!(matches!(
        store.fork("other", "child", None).await,
        Err(Error::Conflict)
    ));
    assert!(!store
        .events("child", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.started"));
}

#[tokio::test]
async fn active_parent_requires_closed_explicit_message_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("parent", "first")).await.unwrap();
    let user = store.promote("parent", true).await.unwrap()[0].seq;
    store.start_run("parent", "run").await.unwrap();
    let open = store
        .assistant_reply(
            "parent",
            "run",
            json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
        )
        .await
        .unwrap();
    assert!(store.fork("parent", "child", None).await.is_err());
    assert!(store.fork("parent", "child", Some(open.seq)).await.is_err());
    assert!(store.snapshot("child").await.is_err());
    store.fork("parent", "early", Some(user)).await.unwrap();
    assert_eq!(store.history("early").await.unwrap().len(), 1);
    let closed = store
        .tool_result("parent", "run", "call", json!({"text":"value"}), false)
        .await
        .unwrap();
    store
        .fork("parent", "late", Some(closed.seq))
        .await
        .unwrap();
    assert_eq!(store.history("late").await.unwrap().len(), 3);
    assert!(store.snapshot("late").await.unwrap()["active_run"].is_null());
}

#[tokio::test]
async fn projection_limits_fail_without_partially_creating_branch() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("parent", "first")).await.unwrap();
    store.promote("parent", true).await.unwrap();
    store
        .message(
            "parent",
            "assistant",
            json!([{"type":"text","text":"x".repeat(2*1024*1024)}]),
        )
        .await
        .unwrap();
    assert!(store.snapshot("parent").await.is_err());
    assert!(store.fork("parent", "child", None).await.is_err());
    assert!(store.snapshot("child").await.is_err());
    assert!(store
        .admit(Input {
            input_id: "x".repeat(257),
            ..input("parent", "invalid")
        })
        .await
        .is_err());
}
