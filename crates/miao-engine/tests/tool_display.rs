use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;

/// A file mutation reports its diff under `_display`. The host renders it from
/// the `tool.completed` event; the model-facing result and the transcript's
/// tool_result must stay free of it, because the patch only repeats text the
/// model already wrote.
#[tokio::test]
async fn a_display_diff_reaches_the_event_and_never_reaches_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "input".into(),
            prompt: "edit a file".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([{"type":"tool_use","id":"call","name":"edit_file","input":{"path":"notes.txt"}}]),
        )
        .await
        .unwrap();
    let display = json!({"files":[{"path":"notes.txt","action":"update","patch":"@@ -1 +1 @@","additions":1,"deletions":1}]});
    store
        .tool_result(
            "s",
            "run",
            "call",
            json!({"applied":true,"sha256":"abc","_display":display}),
            false,
        )
        .await
        .unwrap();

    let events = store.events("s", 0, 100).await.unwrap();
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    assert_eq!(completed.data["display"], display);
    assert!(completed.data["result"].get("_display").is_none());
    assert!(!completed.data["result_json"]
        .as_str()
        .unwrap()
        .contains("_display"));

    let history = store.history("s").await.unwrap();
    let projected = history.last().unwrap().content[0]["content"]
        .as_str()
        .unwrap();
    assert!(!projected.contains("_display"));
    assert!(projected.contains("\"applied\":true"));
    store.close().await.unwrap();
}

#[tokio::test]
async fn a_result_without_a_display_block_keeps_its_event_shape() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "input".into(),
            prompt: "read a file".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .assistant_reply(
            "s",
            "run",
            None,
            json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"notes.txt"}}]),
        )
        .await
        .unwrap();
    store
        .tool_result(
            "s",
            "run",
            "call",
            json!({"text":"hello","sha256":"abc"}),
            false,
        )
        .await
        .unwrap();
    let events = store.events("s", 0, 100).await.unwrap();
    let completed = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    assert!(completed.data.get("display").is_none());
    assert_eq!(completed.data["result"]["text"], "hello");
    store.close().await.unwrap();
}
