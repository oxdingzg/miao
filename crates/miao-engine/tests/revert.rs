use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};
use serde_json::json;

fn input(id: &str) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: format!("prompt {id}"),
        delivery: Delivery::Steer,
    }
}

#[tokio::test]
async fn revert_rewinds_the_projection_and_unrevert_restores_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    for id in ["one", "two"] {
        store.admit(input(id)).await.unwrap();
        store.promote("s", true).await.unwrap();
        store
            .message(
                "s",
                "assistant",
                json!([{"type":"text","text":format!("answer {id}")}]),
            )
            .await
            .unwrap();
    }
    let history = store.history("s").await.unwrap();
    assert_eq!(history.len(), 4, "two user + two assistant messages");

    // Rewind to the second user message: it and its response disappear.
    let second = history[2].checkpoint.clone().unwrap();
    let result = store.revert("s", &second).await.unwrap();
    assert_eq!(result["reverted"], 2);
    let remaining = store.history("s").await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(
        remaining[0].checkpoint.as_deref(),
        history[0].checkpoint.as_deref()
    );

    // Rewind to the first user message: everything is hidden, not deleted.
    let first = remaining[0].checkpoint.clone().unwrap();
    store.revert("s", &first).await.unwrap();
    assert!(store.history("s").await.unwrap().is_empty());

    // Unrevert restores the full visible projection.
    let restored = store.unrevert("s").await.unwrap();
    assert_eq!(restored["restored"], 4);
    assert_eq!(store.history("s").await.unwrap().len(), 4);

    let events = store.events("s", 0, 500).await.unwrap();
    assert!(events.iter().any(|event| event.kind == "session.reverted"));
    assert!(events
        .iter()
        .any(|event| event.kind == "session.unreverted"));

    // An unknown checkpoint is rejected, not silently ignored.
    assert!(matches!(
        store.revert("s", "missing").await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn revert_drops_compaction_at_or_after_the_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    for id in ["one", "two"] {
        store.admit(input(id)).await.unwrap();
        store.promote("s", true).await.unwrap();
        store
            .message(
                "s",
                "assistant",
                json!([{"type":"text","text":format!("answer {id}")}]),
            )
            .await
            .unwrap();
    }
    // Compact through the second assistant message, a closed boundary.
    let events = store.events("s", 0, 100).await.unwrap();
    let assistants: Vec<u64> = events
        .iter()
        .filter(|event| event.kind == "message.committed" && event.data["role"] == "assistant")
        .map(|event| event.seq)
        .collect();
    store
        .compact("s", "c1", assistants[1], "summary".into())
        .await
        .unwrap();
    assert!(
        store.selected_history("s").await.unwrap()[0].content[0]["text"]
            .as_str()
            .unwrap()
            .contains("history-summary")
    );

    let second = store.history("s").await.unwrap()[2]
        .checkpoint
        .clone()
        .unwrap();
    store.revert("s", &second).await.unwrap();
    // The compaction that covered reverted messages is gone; the summary no
    // longer refers to work that was rewound.
    assert!(
        !store.selected_history("s").await.unwrap()[0].content[0]["text"]
            .as_str()
            .unwrap()
            .contains("history-summary")
    );
}
