use miao_engine::{protocol::CollaborationMode, store::Store};

#[tokio::test]
async fn fork_keeps_parent_identity_title_and_read_only_mode() {
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
    assert_eq!(child["title"], "Parent title");
    assert_eq!(child["mode"], "plan");
    assert_eq!(child["active_run"], serde_json::Value::Null);
    assert_eq!(child["pending"], serde_json::json!([]));
    store.fork("parent", "child", None).await.unwrap();
    assert_eq!(store.snapshot("child").await.unwrap(), child);
}
