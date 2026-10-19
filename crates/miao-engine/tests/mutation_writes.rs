use fs2::FileExt;
use miao_engine::{
    protocol::Error, recovery::Decision, session_model::Binding, state::Mutation, store::Store,
};
use serde_json::{json, Value};
use std::{fs::OpenOptions, future::Future, path::Path, time::Duration};

// A separate file description acts as a competing host process. Hold only
// the engine's OS write reservation, not a SQLite transaction, so bypassing
// the coordination boundary cannot pass merely by waiting on SQLite.
async fn queued<F>(path: &Path, operation: F) -> Value
where
    F: Future<Output = Result<Value, Error>> + Send + 'static,
{
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{}.engine-write-lock", path.display()))
        .unwrap();
    lock.lock_exclusive().unwrap();
    let mut task = tokio::spawn(operation);
    let early = tokio::time::timeout(Duration::from_millis(200), &mut task).await;
    FileExt::unlock(&lock).unwrap();
    assert!(
        early.is_err(),
        "mutation bypassed the host write reservation"
    );
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn state_updates_queue_on_the_host_write_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize("s", "state", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let writer = store.clone();
    let result =
        queued(&path, async move {
            writer.update_state("s", "state-op", Mutation::parse("todowrite", json!({
            "todos": [{"content":"verified", "status":"completed", "priority":"high"}],
            "expected_revision":0,
        })).unwrap()).await
        })
        .await;
    assert_eq!(result["duplicate"], false);
    assert_eq!(
        store.state("s").await.unwrap()["todos"]["value"]["todos"][0]["content"],
        "verified"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn model_selection_queues_on_the_host_write_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize("s", "model", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let writer = store.clone();
    let result = queued(&path, async move {
        writer
            .select_model(
                "s",
                Some(Binding {
                    protocol: "fixture".into(),
                    model: "selected".into(),
                    route_id: None,
                    variant: None,
                }),
            )
            .await
    })
    .await;
    assert_eq!(result["binding"]["model"], "selected");
    assert_eq!(
        store.model_selection("s").await.unwrap().unwrap().model,
        "selected"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn recovery_decisions_queue_on_the_host_write_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize("s", "recovery", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store.start_run("s", "interrupted").await.unwrap();
    store
        .tool_dispatch(
            "s",
            "interrupted",
            "call",
            "bash",
            json!({
                "provider_id":"wire-call", "command":"external-operation",
            }),
        )
        .await
        .unwrap();
    store.recover().await.unwrap();
    let writer = store.clone();
    let result = queued(&path, async move {
        writer
            .resolve_recovery("s", "call", "decision", Decision::Retry)
            .await
    })
    .await;
    assert_eq!(result["outcome"], "unknown");
    assert_eq!(
        store.snapshot("s").await.unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        result,
        store
            .resolve_recovery("s", "call", "decision", Decision::Retry)
            .await
            .unwrap()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn snapshot_and_model_readers_do_not_take_the_host_write_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize("s", "reader", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{}.engine-write-lock", path.display()))
        .unwrap();
    lock.lock_exclusive().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), async {
        let snapshot = store.snapshot("s").await.unwrap();
        let selection = store.model_selection("s").await.unwrap();
        (snapshot, selection)
    })
    .await;
    FileExt::unlock(&lock).unwrap();
    let (snapshot, selection) = result.unwrap();
    assert_eq!(snapshot["title"], "reader");
    assert!(selection.is_none());
    store.close().await.unwrap();
}
