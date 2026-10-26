use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn snapshot_and_fork_preserve_history_beyond_a_thousand_messages() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    for index in 0..1102 {
        store
            .message(
                "s",
                if index % 2 == 0 { "user" } else { "assistant" },
                json!([{"type":"text","text":format!("message-{index}")}]),
            )
            .await
            .unwrap();
    }
    let original = store.snapshot("s").await.unwrap();
    let messages = original["messages"].as_array().unwrap();
    assert_eq!(
        messages.len(),
        1102,
        "a snapshot must not silently drop the newest history"
    );
    assert_eq!(
        messages.last().unwrap()["content"][0]["text"],
        "message-1101"
    );
    let selected = store.selected_history("s").await.unwrap();
    assert_eq!(
        selected.len(),
        1102,
        "provider context must keep the newest history too"
    );
    assert_eq!(selected.last().unwrap().content[0]["text"], "message-1101");
    store.fork("s", "copy", None).await.unwrap();
    let forked = store.snapshot("copy").await.unwrap();
    assert_eq!(forked["messages"].as_array().unwrap().len(), 1102);
    assert_eq!(
        forked["messages"][1101]["content"],
        messages[1101]["content"]
    );
}
