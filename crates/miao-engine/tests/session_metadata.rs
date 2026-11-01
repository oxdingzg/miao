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

#[tokio::test]
async fn metadata_snapshot_omits_large_history_but_preserves_catalog_facts() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store.rename("s", "Large Session").await.unwrap();
    assert_eq!(
        store.snapshot_with_metadata("s", true).await.unwrap()["has_messages"],
        false
    );
    store
        .message(
            "s",
            "user",
            serde_json::json!([{ "type": "text", "text": "x".repeat(4 * 1024 * 1024) }]),
        )
        .await
        .unwrap();
    let full = store.snapshot("s").await.unwrap();
    assert_eq!(full["messages"].as_array().unwrap().len(), 1);
    let summary = store.snapshot_with_metadata("s", true).await.unwrap();
    assert!(summary.get("messages").is_none());
    assert_eq!(summary["has_messages"], true);
    assert!(serde_json::to_vec(&summary).unwrap().len() < 4096);
    for key in [
        "session_id",
        "cursor",
        "title",
        "created_at_ms",
        "updated_at_ms",
        "active_run",
        "pending",
        "state",
        "model_selection",
        "account_selection",
        "agent",
    ] {
        assert_eq!(summary[key], full[key], "{key}");
    }
}

#[tokio::test]
async fn metadata_snapshot_carries_a_bounded_last_message_preview() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();

    // A Session without readable text has no preview to show.
    assert_eq!(
        store.snapshot_with_metadata("s", true).await.unwrap()["preview"],
        serde_json::Value::Null
    );

    store
        .message(
            "s",
            "user",
            serde_json::json!([{ "type": "text", "text": "fix the failing login test" }]),
        )
        .await
        .unwrap();
    store
        .message(
            "s",
            "assistant",
            serde_json::json!([{ "type": "text", "text": "it  was\nthe  stub\nconfig" }]),
        )
        .await
        .unwrap();
    let preview = store.snapshot_with_metadata("s", true).await.unwrap()["preview"].clone();
    assert_eq!(preview["text"], "it was the stub config");
    assert_eq!(preview["truncated"], false);

    // A trailing tool-only turn is skipped so the preview still says what the
    // conversation last said.
    store
        .message(
            "s",
            "assistant",
            serde_json::json!([{ "type": "tool_use", "id": "t1", "name": "bash", "input": {} }]),
        )
        .await
        .unwrap();
    let preview = store.snapshot_with_metadata("s", true).await.unwrap()["preview"].clone();
    assert_eq!(preview["text"], "it was the stub config");

    // Long text collapses to the bounded head with the flag set.
    store
        .message(
            "s",
            "user",
            serde_json::json!([{ "type": "text", "text": "word ".repeat(80) }]),
        )
        .await
        .unwrap();
    let preview = store.snapshot_with_metadata("s", true).await.unwrap()["preview"].clone();
    assert_eq!(preview["truncated"], true);
    let text = preview["text"].as_str().unwrap();
    assert_eq!(text.chars().count(), 200);
    assert!(text.starts_with("word word"));

    // A full snapshot needs no preview; it already carries the messages.
    assert_eq!(
        store.snapshot("s").await.unwrap()["preview"],
        serde_json::Value::Null
    );
}

/// A tag is the operator's own label for a Session: it round-trips through the
/// snapshot, an empty tag clears it, and an oversized one is refused rather
/// than truncated.
#[tokio::test]
async fn a_tag_round_trips_and_an_empty_tag_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    assert_eq!(store.snapshot("s").await.unwrap()["tag"], "");

    let event = store.tag("s", "release").await.unwrap();
    assert_eq!(event.kind, "session.tagged");
    assert_eq!(store.snapshot("s").await.unwrap()["tag"], "release");

    store.tag("s", "").await.unwrap();
    assert_eq!(store.snapshot("s").await.unwrap()["tag"], "");

    assert!(store.tag("s", &"x".repeat(65)).await.is_err());
    assert_eq!(store.snapshot("s").await.unwrap()["tag"], "");
}
