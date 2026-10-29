//! RUN-01 slice: one admitted input's durable receipt, readable without
//! replaying the event log.
use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};

async fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("s", "session", "/tmp").await.unwrap();
    (dir, store)
}

fn prompt(input_id: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".to_owned(),
        input_id: input_id.to_owned(),
        prompt: format!("prompt {input_id}"),
        delivery,
    }
}

#[tokio::test]
async fn an_unknown_input_is_not_another_sessions_receipt() {
    let (_dir, store) = store().await;
    store.initialize("other", "other", "/tmp").await.unwrap();
    let mut theirs = prompt("theirs", Delivery::Steer);
    theirs.session_id = "other".to_owned();
    store.admit(theirs).await.unwrap();

    let receipt = store.input_status("s", "missing").await.unwrap();
    assert_eq!(receipt["state"], "unknown");
    assert!(receipt.get("delivery").is_none(), "{receipt}");
    // The id exists in its own Session, so the answer above came from scoping
    // rather than from an id the engine never saw.
    let scoped = store.input_status("s", "theirs").await.unwrap();
    assert_eq!(scoped["state"], "unknown", "{scoped}");
    assert_eq!(
        store.input_status("other", "theirs").await.unwrap()["state"],
        "pending"
    );
    // An unknown Session is still a refusal: there is no inbox to ask about.
    assert!(store.input_status("missing", "theirs").await.is_err());
}

#[tokio::test]
async fn a_pending_input_reports_its_delivery_and_place_in_that_queue() {
    let (_dir, store) = store().await;
    store.admit(prompt("one", Delivery::Steer)).await.unwrap();
    store.admit(prompt("two", Delivery::Steer)).await.unwrap();
    store
        .admit(prompt("queued", Delivery::Queue))
        .await
        .unwrap();

    let first = store.input_status("s", "one").await.unwrap();
    assert_eq!(first["state"], "pending");
    assert_eq!(first["delivery"], "steer");
    assert_eq!(first["pending_ahead"], 0, "{first}");
    assert!(first["admitted_seq"].as_u64().unwrap() > 0);
    assert!(first["admitted_at_ms"].is_u64(), "{first}");

    let second = store.input_status("s", "two").await.unwrap();
    assert_eq!(second["pending_ahead"], 1, "{second}");
    // Steers and queued prompts are two queues, so a queued prompt is first
    // in its own class even though two steers were admitted before it.
    let queued = store.input_status("s", "queued").await.unwrap();
    assert_eq!(queued["delivery"], "queue");
    assert_eq!(queued["pending_ahead"], 0, "{queued}");
}

#[tokio::test]
async fn a_promoted_input_points_at_the_message_it_became() {
    let (_dir, store) = store().await;
    store.admit(prompt("one", Delivery::Steer)).await.unwrap();
    let promoted = store
        .promote("s", true)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "input.promoted")
        .unwrap();

    let receipt = store.input_status("s", "one").await.unwrap();
    assert_eq!(receipt["state"], "promoted");
    assert_eq!(receipt["promoted"]["seq"], promoted.seq, "{receipt}");
    assert!(receipt["promoted"]["recorded_at_ms"].is_u64(), "{receipt}");
    let checkpoint = receipt["promoted"]["checkpoint"].as_str().unwrap();
    assert_eq!(checkpoint.len(), 36);
    // The receipt is the projection: the checkpoint matches the user message
    // sitting at that seq. (`selected_history` is the provider view and drops
    // checkpoints; `history` is the stored transcript.)
    let history = store.history("s").await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].checkpoint.as_deref(), Some(checkpoint));
    // A promoted input is no longer waiting, so it has no queue position.
    assert!(receipt.get("pending_ahead").is_none(), "{receipt}");
}

#[tokio::test]
async fn a_cancelled_input_keeps_the_event_that_dropped_it() {
    let (_dir, store) = store().await;
    store.admit(prompt("one", Delivery::Steer)).await.unwrap();
    assert_eq!(
        store.cancel_input("s", "one").await.unwrap()["accepted"],
        true
    );

    let receipt = store.input_status("s", "one").await.unwrap();
    assert_eq!(receipt["state"], "cancelled");
    assert!(receipt["cancelled"]["seq"].is_u64(), "{receipt}");
    assert!(receipt["cancelled"]["recorded_at_ms"].is_u64(), "{receipt}");
    assert!(receipt.get("pending_ahead").is_none(), "{receipt}");
    // A cancelled prompt never became a message.
    assert!(store.history("s").await.unwrap().is_empty());
}
