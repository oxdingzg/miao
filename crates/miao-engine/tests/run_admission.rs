use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};

fn input(id: &str) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
        command: None,
        agent_references: Default::default(),
    }
}

#[tokio::test]
async fn initial_promotion_and_running_state_commit_together() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one")).await.unwrap();
    let lease = store.claim_session("s", 30_000).await.unwrap();
    let pending = store.snapshot("s").await.unwrap();
    assert_eq!(pending["pending"].as_array().unwrap().len(), 1);
    assert!(pending["active_run"].is_null());
    let promoted = store
        .start_run_with_inputs_fenced("s", "run", false, &lease)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.len(), 1);
    let running = store.snapshot("s").await.unwrap();
    assert!(running["pending"].as_array().unwrap().is_empty());
    assert_eq!(running["active_run"], "run");
    assert_eq!(running["messages"].as_array().unwrap().len(), 1);
    store
        .finish_run_fenced("s", "run", "completed", &lease)
        .await
        .unwrap();
    assert!(store
        .start_run_with_inputs_fenced("s", "unused", false, &lease)
        .await
        .unwrap()
        .is_none());
    assert!(store.active_run("s").await.unwrap().is_none());
}

#[tokio::test]
async fn a_failed_or_fenced_run_start_does_not_consume_the_pending_input() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("other").await.unwrap();
    store.start_run("other", "taken").await.unwrap();
    store.admit(input("one")).await.unwrap();
    let stale = store.claim_session("s", 30_000).await.unwrap();
    let lease = store.claim_session("s", 30_000).await.unwrap();
    assert!(matches!(
        store
            .start_run_with_inputs_fenced("s", "run", false, &stale)
            .await,
        Err(Error::Fenced)
    ));
    // A run-id collision happens after promotion inside the transaction.
    assert!(store
        .start_run_with_inputs_fenced("s", "taken", false, &lease)
        .await
        .is_err());
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["pending"].as_array().unwrap().len(), 1);
    assert!(snapshot["messages"].as_array().unwrap().is_empty());
    assert!(snapshot["active_run"].is_null());
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
}
