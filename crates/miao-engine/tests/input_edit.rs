//! Rewriting a queued prompt in place: the identity, delivery and order stay,
//! the text the eventual user message carries changes (RUN-02).
use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;

async fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("s", "session", "/tmp").await.unwrap();
    (dir, store)
}

fn prompt(id: &str, text: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".to_owned(),
        input_id: id.to_owned(),
        prompt: text.to_owned(),
        delivery,
    }
}

#[tokio::test]
async fn an_edited_pending_input_promotes_the_new_text() {
    let (_dir, store) = store().await;
    store
        .admit(prompt("one", "first draft", Delivery::Steer))
        .await
        .unwrap();
    let edited = store.edit_input("s", "one", "second draft").await.unwrap();
    assert_eq!(edited["duplicate"], false);
    assert_eq!(edited["delivery"], "steer");
    assert_eq!(edited["input_id"], "one");

    store.promote("s", true).await.unwrap();
    let history = store.history("s").await.unwrap();
    assert_eq!(history.len(), 1, "the edit did not add a second message");
    assert_eq!(history[0].content[0]["text"], "second draft");

    // The audit fact carries digests, never a second copy of the prompt.
    let events = store.events("s", 0, 100).await.unwrap();
    let edited_events: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "input.edited")
        .collect();
    assert_eq!(edited_events.len(), 1);
    let data = &edited_events[0].data;
    assert_eq!(data["input_id"], "one");
    assert!(data.get("prompt").is_none(), "{data}");
    assert_ne!(data["previous_digest"], data["prompt_digest"]);
}

#[tokio::test]
async fn an_edit_keeps_the_queue_position_and_delivery() {
    let (_dir, store) = store().await;
    for (id, text) in [("one", "one"), ("two", "two")] {
        store
            .admit(prompt(id, text, Delivery::Queue))
            .await
            .unwrap();
    }
    store.edit_input("s", "two", "two rewritten").await.unwrap();
    let pending = store.pending_inputs("s", None, 10).await.unwrap();
    let inputs = pending["inputs"].as_array().unwrap();
    assert_eq!(
        inputs
            .iter()
            .map(|input| input["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    assert_eq!(inputs[1]["prompt"], json!("two rewritten"));
    assert_eq!(inputs[1]["delivery"], json!("queue"));

    // An idle promotion still takes the oldest queued item first.
    store.promote("s", true).await.unwrap();
    let history = store.history("s").await.unwrap();
    assert_eq!(history[0].content[0]["text"], "one");
}

#[tokio::test]
async fn an_unchanged_edit_is_a_duplicate_without_a_second_event() {
    let (_dir, store) = store().await;
    store
        .admit(prompt("one", "same", Delivery::Steer))
        .await
        .unwrap();
    let duplicate = store.edit_input("s", "one", "same").await.unwrap();
    assert_eq!(duplicate["duplicate"], true);
    let events = store.events("s", 0, 100).await.unwrap();
    assert!(events.iter().all(|event| event.kind != "input.edited"));
}

#[tokio::test]
async fn only_pending_inputs_are_editable() {
    let (_dir, store) = store().await;
    store
        .admit(prompt("done", "finished", Delivery::Steer))
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    assert!(store.edit_input("s", "done", "late rewrite").await.is_err());

    store
        .admit(prompt("dropped", "dropped text", Delivery::Steer))
        .await
        .unwrap();
    store.cancel_input("s", "dropped").await.unwrap();
    assert!(store
        .edit_input("s", "dropped", "resurrected")
        .await
        .is_err());

    assert!(store.edit_input("s", "missing", "text").await.is_err());
    assert!(store.edit_input("other", "done", "text").await.is_err());
    // Empty text is not an edit, and the bound matches admission.
    assert!(store.edit_input("s", "missing", "").await.is_err());
}
