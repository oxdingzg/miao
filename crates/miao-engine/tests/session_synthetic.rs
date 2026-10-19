use miao_engine::{protocol::Error, store::Store};
use serde_json::json;

#[tokio::test]
async fn injection_is_immediate_history_without_an_inbox_or_provider_turn() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("s", "fixture", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let receipt = store
        .inject("s", "injected-1", "Use the fixture skill.", "skill:fixture")
        .await
        .unwrap();
    assert_eq!(receipt["duplicate"], false);
    assert_eq!(
        store
            .inject("s", "injected-1", "Use the fixture skill.", "skill:fixture")
            .await
            .unwrap()["duplicate"],
        true
    );
    assert!(matches!(
        store
            .inject("s", "injected-1", "changed", "skill:fixture")
            .await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        store
            .inject("s", "injected-1", "Use the fixture skill.", "skill:other")
            .await,
        Err(Error::Conflict)
    ));
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["pending"], json!([]));
    assert!(snapshot["active_run"].is_null());
    let history = store.selected_history("s").await.unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("skill:fixture"));
    assert!(history[0].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("Use the fixture skill."));
    let events = store.events("s", 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "message.synthetic")
            .count(),
        1
    );
    assert!(!events.iter().any(|event| matches!(
        event.kind.as_str(),
        "input.admitted" | "input.promoted" | "provider.started"
    )));
    store
        .message("s", "assistant", json!([{"type":"text","text":"done"}]))
        .await
        .unwrap();
    store.fork("s", "child", None).await.unwrap();
    let events = store.events("child", 0, 100).await.unwrap();
    let inherited = events
        .iter()
        .find(|event| event.kind == "message.synthetic")
        .unwrap();
    assert_eq!(inherited.data["text"], "Use the fixture skill.");
    assert_eq!(inherited.data["source"], "skill:fixture");
    assert!(store.snapshot("child").await.unwrap()["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!events.iter().any(|event| event.kind == "input.promoted"));
    store.fork("child", "grandchild", None).await.unwrap();
    assert!(store
        .events("grandchild", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "message.synthetic"));
    store.close().await.unwrap();
    let reopened = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert_eq!(
        reopened
            .inject("s", "injected-1", "Use the fixture skill.", "skill:fixture")
            .await
            .unwrap()["duplicate"],
        true
    );
}

#[tokio::test]
async fn injection_rejects_unknown_sessions_and_invalid_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert!(store
        .inject("missing", "x", "text", "skill:x")
        .await
        .is_err());
    store
        .initialize("s", "fixture", dir.path().to_str().unwrap())
        .await
        .unwrap();
    for (id, text, source) in [
        ("", "text", "source"),
        ("id", "", "source"),
        ("id", "text", ""),
    ] {
        assert!(store.inject("s", id, text, source).await.is_err());
    }
    assert!(store
        .inject("s", "id", &"a".repeat(1024 * 1024 + 1), "source")
        .await
        .is_err());
}

#[tokio::test]
async fn injection_during_tools_preserves_the_provider_tool_block() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("s", "fixture", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store
        .message(
            "s",
            "assistant",
            json!([{"type":"tool_use","id":"call1","name":"read_file","input":{"path":"x"}}]),
        )
        .await
        .unwrap();
    store
        .inject("s", "context", "instructions", "skill:fixture")
        .await
        .unwrap();
    assert_eq!(store.selected_history("s").await.unwrap().len(), 1);
    store
        .message(
            "s",
            "user",
            json!([{"type":"tool_result","tool_use_id":"call1","content":"result"}]),
        )
        .await
        .unwrap();
    let history = store.selected_history("s").await.unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[1].content[0]["type"], "tool_result");
    assert!(history[2].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("instructions"));
    let audit = store.history("s").await.unwrap();
    assert!(audit[1].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("instructions"));
    assert_eq!(audit[2].content[0]["type"], "tool_result");
}

#[tokio::test]
async fn synthetic_selection_keeps_recovery_orphan_results_readable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("s", "fixture", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store.message("s","user",json!([{"type":"tool_result","tool_use_id":"uncommitted-call","content":"outcome unknown"}])).await.unwrap();
    store
        .inject("s", "context", "instructions", "skill:fixture")
        .await
        .unwrap();
    assert_eq!(store.selected_history("s").await.unwrap().len(), 2);
}
