use miao_engine::{protocol::Error, store::Store};
use serde_json::json;

async fn open(dir: &tempfile::TempDir) -> Store {
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("ses_fence", "fence", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store
}

#[tokio::test]
async fn a_superseded_writer_is_fenced_out() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir).await;
    let first = store.claim_session("ses_fence", 30_000).await.unwrap();
    assert_eq!(first.epoch, 1);
    store
        .record_fenced("ses_fence", "note", json!({"text": "owner"}), &first)
        .await
        .unwrap();
    let second = store.claim_session("ses_fence", 30_000).await.unwrap();
    assert_eq!(second.epoch, first.epoch + 1);
    let committed = store.events("ses_fence", 0, 100).await.unwrap().len();
    let error = store
        .record_fenced("ses_fence", "note", json!({"text": "stale"}), &first)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Fenced));
    assert_eq!(error.code(), "store_fenced");
    assert_eq!(
        store.events("ses_fence", 0, 100).await.unwrap().len(),
        committed
    );
    let event = store
        .record_fenced("ses_fence", "note", json!({"text": "current"}), &second)
        .await
        .unwrap();
    assert_eq!(event.kind, "note");
    assert_eq!(
        store.events("ses_fence", 0, 100).await.unwrap().len(),
        committed + 1
    );
}

#[tokio::test]
async fn a_lease_never_covers_another_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir).await;
    store
        .initialize("ses_other", "other", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let lease = store.claim_session("ses_fence", 30_000).await.unwrap();
    let error = store
        .record_fenced("ses_other", "note", json!({}), &lease)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Fenced));
}

#[tokio::test]
async fn an_unclaimed_session_rejects_fenced_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir).await;
    let lease = miao_engine::store::SessionLease {
        session: "ses_fence".into(),
        epoch: 1,
    };
    let error = store
        .record_fenced("ses_fence", "note", json!({}), &lease)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Fenced));
}

#[tokio::test]
async fn execution_writes_reject_a_superseded_lease() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir).await;
    let stale = store.claim_session("ses_fence", 30_000).await.unwrap();
    let current = store.claim_session("ses_fence", 30_000).await.unwrap();
    assert!(matches!(
        store
            .promote_fenced("ses_fence", true, &stale)
            .await
            .unwrap_err(),
        Error::Fenced
    ));
    assert!(matches!(
        store
            .start_run_fenced("ses_fence", "run-1", &stale)
            .await
            .unwrap_err(),
        Error::Fenced
    ));
    assert!(matches!(
        store
            .tool_dispatch_fenced("ses_fence", "run-1", "call", "read_file", json!({}), &stale)
            .await
            .unwrap_err(),
        Error::Fenced
    ));
    assert!(matches!(
        store
            .tool_settle_fenced("ses_fence", "call", json!({}), &stale)
            .await
            .unwrap_err(),
        Error::Fenced
    ));
    assert!(matches!(
        store
            .finish_run_fenced("ses_fence", "run-1", "stop", &stale)
            .await
            .unwrap_err(),
        Error::Fenced
    ));
    // The active owner still settles the turn.
    store
        .start_run_fenced("ses_fence", "run-1", &current)
        .await
        .unwrap();
    store
        .finish_run_fenced("ses_fence", "run-1", "stop", &current)
        .await
        .unwrap();
    assert!(store
        .promote_fenced("ses_fence", true, &current)
        .await
        .unwrap()
        .is_empty());
}
