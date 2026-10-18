use miao_engine::{protocol::CollaborationMode, store::Store};

#[tokio::test]
async fn fork_keeps_parent_identity_and_read_only_mode() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store.ensure("parent").await.unwrap();
    store.rename("parent", "Parent title").await.unwrap();
    store
        .set_mode("parent", CollaborationMode::Plan)
        .await
        .unwrap();
    store.fork("parent", "child", None).await.unwrap();
    let child = store.snapshot("child").await.unwrap();
    assert_eq!(child["parent_session_id"], "parent");
    assert_eq!(child["title"], "");
    assert_eq!(child["mode"], "plan");
    assert_eq!(child["active_run"], serde_json::Value::Null);
    assert_eq!(child["pending"], serde_json::json!([]));
    store.fork("parent", "child", None).await.unwrap();
    assert_eq!(store.snapshot("child").await.unwrap(), child);
}

#[tokio::test]
async fn copied_user_prompts_are_promoted_exact_retries_not_new_work() {
    use miao_engine::protocol::{Delivery, Input};
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "parent".into(),
            input_id: "msg_source".into(),
            prompt: "request".into(),
            delivery: Delivery::Queue,
        })
        .await
        .unwrap();
    store.promote("parent", true).await.unwrap();
    store.fork("parent", "child", None).await.unwrap();
    let before = store.snapshot("child").await.unwrap();
    let seq = before["messages"][0]["seq"].as_u64().unwrap();
    let copied_id = format!("msg_child_{seq}");
    let receipt = store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "child".into(),
            input_id: copied_id.clone(),
            prompt: "request".into(),
            delivery: Delivery::Queue,
        })
        .await
        .unwrap();
    assert!(receipt.duplicate);
    assert_eq!(store.snapshot("child").await.unwrap(), before);
    assert!(store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "child".into(),
            input_id: copied_id,
            prompt: "changed".into(),
            delivery: Delivery::Queue
        })
        .await
        .is_err());
}
