//! Session metadata: title and creation/update time are engine-owned facts the
//! product projection needs for a native Session record.

use miao_engine::store::Store;

#[tokio::test]
async fn snapshot_exposes_title_and_times_and_rename_is_durable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["title"], "");
    assert!(snapshot["created_at_ms"]
        .as_i64()
        .is_some_and(|value| value > 0));
    assert_eq!(snapshot["updated_at_ms"], serde_json::Value::Null);

    let event = store.rename("s", "First title").await.unwrap();
    assert_eq!(event.kind, "session.renamed");
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["title"], "First title");
    assert!(snapshot["updated_at_ms"]
        .as_i64()
        .is_some_and(|value| value > 0));
    // The rename is a durable event, so replay sees it too.
    let events = store.events("s", 0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "session.renamed" && event.data["title"] == "First title"));

    assert!(store.rename("s", &"x".repeat(1025)).await.is_err());
    assert_eq!(store.snapshot("s").await.unwrap()["title"], "First title");

    // A forked Session starts with its own creation time and an empty title.
    store.fork("s", "copy", None).await.unwrap();
    let copy = store.snapshot("copy").await.unwrap();
    assert_eq!(copy["title"], "");
    assert!(copy["created_at_ms"]
        .as_i64()
        .is_some_and(|value| value > 0));
}
