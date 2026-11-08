//! RUN-01 slice: the durable input receipt answers the delivery lifecycle
//! (admitted / pending-promotion / executing / failed, with the steer/queue
//! mark), an exact retry of a durable identity duplicates nothing, and queued
//! messages promote one per idle boundary in admission order that survives a
//! reconnect.
use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};

async fn store(name: &str) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize(name, name, "/tmp").await.unwrap();
    (dir, store)
}

fn prompt(session: &str, input_id: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.to_owned(),
        input_id: input_id.to_owned(),
        prompt: format!("prompt {input_id}"),
        delivery,
    }
}

#[tokio::test]
async fn a_receipt_walks_the_lifecycle_from_pending_to_executing_to_failed() {
    let (_dir, store) = store("s").await;
    let admission = store
        .admit(prompt("s", "in-1", Delivery::Steer))
        .await
        .unwrap();
    assert!(!admission.duplicate);

    // Admitted and waiting: the receipt names the delivery class and the
    // place in that class, which is the pending-promotion state.
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["state"], "pending", "{receipt}");
    assert_eq!(receipt["delivery"], "steer");
    assert_eq!(receipt["pending_ahead"], 0);
    assert!(receipt.get("run").is_none(), "{receipt}");

    store.promote("s", false).await.unwrap();
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["state"], "promoted", "{receipt}");
    assert!(receipt["promoted"]["seq"].is_u64(), "{receipt}");
    assert!(receipt.get("run").is_none(), "no run yet: {receipt}");

    // A run started after the promotion is the one consuming it: executing.
    store.start_run("s", "run-1").await.unwrap();
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["run"]["state"], "executing", "{receipt}");
    assert_eq!(receipt["run"]["run_id"], "run-1");

    // The finish reason rides the run row, so failure is visible as failure.
    store.finish_run("s", "run-1", "failed").await.unwrap();
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["run"]["state"], "failed", "{receipt}");

    // A later successful run of the same session replaces the picture.
    store.start_run("s", "run-2").await.unwrap();
    store.finish_run("s", "run-2", "completed").await.unwrap();
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["run"]["state"], "completed", "{receipt}");
}

#[tokio::test]
async fn an_exact_retry_of_a_durable_identity_duplicates_nothing() {
    let (_dir, store) = store("s").await;
    let first = store
        .admit(prompt("s", "in-1", Delivery::Queue))
        .await
        .unwrap();
    assert!(!first.duplicate);

    // Same identity: the retry is answered from the stored receipt, carrying
    // the original admitted_seq, not a second admission.
    let second = store
        .admit(prompt("s", "in-1", Delivery::Queue))
        .await
        .unwrap();
    assert!(second.duplicate, "{second:?}");
    assert_eq!(second.admitted_seq, first.admitted_seq);

    // Conflicting reuse is refused rather than silently replaced.
    let mut different = prompt("s", "in-1", Delivery::Queue);
    different.prompt = "a different prompt".into();
    assert!(store.admit(different).await.is_err());

    store.promote("s", true).await.unwrap();
    let promoted_events = store
        .events("s", 0, 100)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.kind == "input.promoted"
                && event.data["input_id"] == "in-1"
        })
        .count();
    assert_eq!(promoted_events, 1, "one promotion for one admission");
    let receipt = store.input_status("s", "in-1").await.unwrap();
    assert_eq!(receipt["state"], "promoted");
    assert_eq!(
        receipt["promoted"]["seq"].as_u64(),
        Some(first.admitted_seq + 1)
    );
}

#[tokio::test]
async fn queued_inputs_promote_one_per_idle_boundary_in_admission_order() {
    let (_dir, store) = store("s").await;
    store
        .admit(prompt("s", "steer-a", Delivery::Steer))
        .await
        .unwrap();
    store
        .admit(prompt("s", "queue-b", Delivery::Queue))
        .await
        .unwrap();
    store
        .admit(prompt("s", "queue-c", Delivery::Queue))
        .await
        .unwrap();

    // Draining steers never touches the queue.
    let events = store.promote("s", false).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data["input_id"], "steer-a");
    for id in ["queue-b", "queue-c"] {
        assert_eq!(
            store.input_status("s", id).await.unwrap()["state"],
            "pending",
            "{id}"
        );
    }

    // The idle boundary promotes exactly one queued message, oldest first.
    let events = store.promote("s", true).await.unwrap();
    assert_eq!(events.len(), 1, "{:?}", events);
    assert_eq!(events[0].data["input_id"], "queue-b");
    assert_eq!(
        store.input_status("s", "queue-c").await.unwrap()["state"],
        "pending"
    );
    let events = store.promote("s", true).await.unwrap();
    assert_eq!(events[0].data["input_id"], "queue-c");

    // Order restored after a reconnect: a fresh handle on the same storage
    // reads the same receipts, and the promoted message seqs follow the
    // admission order a<b<c.
    drop(store);
    let store = Store::open(_dir.path().join("engine.db")).await.unwrap();
    let a = store.input_status("s", "steer-a").await.unwrap();
    let b = store.input_status("s", "queue-b").await.unwrap();
    let c = store.input_status("s", "queue-c").await.unwrap();
    let seq = |r: &serde_json::Value| r["promoted"]["seq"].as_u64().unwrap();
    assert_eq!(a["state"], "promoted");
    assert!(seq(&a) < seq(&b) && seq(&b) < seq(&c), "{a} {b} {c}");
    let pending = store.pending_inputs("s", None, 10).await.unwrap();
    assert_eq!(
        pending["inputs"].as_array().map(Vec::len),
        Some(0),
        "every admitted input promoted: {pending}"
    );
}
