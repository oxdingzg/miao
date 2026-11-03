//! RUN-01 acceptance: the cancel cycle observed end to end in one process —
//! two admissions with distinct delivery classes, a cancel of the queued one,
//! and the pending set narrowing accordingly — read through the store's own
//! view so the WAL is always visible to the asserting reader.

use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};

async fn store_with_session() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("s", "session", "/tmp").await.unwrap();
    (dir, store)
}

fn input(id: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".to_owned(),
        input_id: id.to_owned(),
        prompt: format!("prompt {id}"),
        delivery,
    }
}

#[tokio::test]
async fn cancel_removes_the_queued_input_and_preserves_the_steer() {
    let (dir, store) = store_with_session().await;
    store
        .admit(input("in-steer", Delivery::Steer))
        .await
        .unwrap();
    store
        .admit(input("in-queue", Delivery::Queue))
        .await
        .unwrap();

    // Both wait for promotion before the cancel: steer first, queue behind.
    let pending = store.pending_inputs("s", None, 50).await.unwrap();
    let ids: Vec<&str> = pending["inputs"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| e["id"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(ids, vec!["in-steer", "in-queue"], "{pending}");

    store.cancel_input("s", "in-queue").await.unwrap();

    // The queued input is gone from the pending set; the steer remains.
    let pending = store.pending_inputs("s", None, 50).await.unwrap();
    let ids: Vec<&str> = pending["inputs"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| e["id"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(ids, vec!["in-steer"], "{pending}");

    // And the durable receipt records the cancellation rather than deleting
    // the row: the state survives any later restart of the process.
    let conn = rusqlite::Connection::open(dir.path().join("engine.db")).unwrap();
    let state: String = conn
        .query_row(
            "SELECT state FROM engine_input WHERE id='in-queue'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cancelled", "{state}");
}

#[tokio::test]
async fn a_cancelled_input_can_be_read_but_not_cancelled_twice() {
    let (_dir, store) = store_with_session().await;
    store.admit(input("q", Delivery::Queue)).await.unwrap();
    store.cancel_input("s", "q").await.unwrap();

    // The receipt of a cancelled input is still readable (the durable
    // record survives), and a second cancel settles as a no-op rather
    // than erroring or flipping the state back.
    let receipt = store.input_status("s", "q").await.unwrap();
    assert_eq!(receipt["state"], "cancelled", "{receipt}");
    let again = store.cancel_input("s", "q").await.unwrap();
    assert_eq!(
        again["duplicate"], true,
        "the second cancel settles as a duplicate: {again}"
    );
    // The receipt still reads cancelled — the duplicate settle did not flip it back.
    let receipt = store.input_status("s", "q").await.unwrap();
    assert_eq!(receipt["state"], "cancelled", "{receipt}");
}
