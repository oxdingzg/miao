//! One Session carries one running execution, enforced by the database itself:
//! `engine_active_run` is a unique index on `engine_run(session_id)` for rows
//! whose state is `running`, so a second `start_run` on the same Session
//! cannot commit while the first is live — and a different Session is free to
//! run at the same time. This pins the storage-level half of the single
//! execution authority (the lease fencing around it is exercised in
//! `concurrent_open.rs`).

use miao_engine::store::Store;

#[tokio::test]
async fn a_second_run_on_a_live_session_is_rejected_until_the_first_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("ses_one", "one", dir.path().to_str().unwrap())
        .await
        .unwrap();

    store.start_run("ses_one", "run-1").await.unwrap();
    assert_eq!(
        store.active_run("ses_one").await.unwrap().as_deref(),
        Some("run-1"),
        "the first run is the Session's single active run"
    );

    let second = store.start_run("ses_one", "run-2").await;
    assert!(
        second.is_err(),
        "a second running run on the same Session must not commit"
    );
    assert_eq!(
        store.active_run("ses_one").await.unwrap().as_deref(),
        Some("run-1"),
        "the rejection leaves the first run owning the Session"
    );

    store
        .finish_run("ses_one", "run-1", "completed")
        .await
        .unwrap();
    store.start_run("ses_one", "run-2").await.unwrap();
    assert_eq!(
        store.active_run("ses_one").await.unwrap().as_deref(),
        Some("run-2"),
        "after the first run finishes the Session accepts the next run"
    );
}

#[tokio::test]
async fn different_sessions_run_concurrently() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("ses_a", "a", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store
        .initialize("ses_b", "b", dir.path().to_str().unwrap())
        .await
        .unwrap();

    store.start_run("ses_a", "run-a").await.unwrap();
    store.start_run("ses_b", "run-b").await.unwrap();
    assert_eq!(
        store.active_run("ses_a").await.unwrap().as_deref(),
        Some("run-a")
    );
    assert_eq!(
        store.active_run("ses_b").await.unwrap().as_deref(),
        Some("run-b"),
        "cross-Session concurrency is not fenced away with the same-Session one"
    );
}
