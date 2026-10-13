use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn initialization_is_idle_durable_and_an_exact_retry_preserves_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    assert_eq!(
        store
            .initialize("s", "New session", "/workspace")
            .await
            .unwrap()["duplicate"],
        false
    );
    let initial = store.snapshot("s").await.unwrap();
    assert_eq!(initial["location"], "/workspace");
    assert_eq!(initial["pending"], json!([]));
    assert_eq!(initial["messages"], json!([]));
    assert_eq!(initial["active_run"], serde_json::Value::Null);
    assert_eq!(store.sessions().await.unwrap(), vec!["s"]);
    store.rename("s", "User title").await.unwrap();
    let edited = store.snapshot("s").await.unwrap();
    assert_eq!(
        store
            .initialize("s", "New session", "/workspace")
            .await
            .unwrap()["duplicate"],
        true
    );
    assert_eq!(store.snapshot("s").await.unwrap(), edited);
    assert!(store
        .initialize("s", "New session", "/other-workspace")
        .await
        .is_err());
    assert_eq!(store.snapshot("s").await.unwrap(), edited);
}
