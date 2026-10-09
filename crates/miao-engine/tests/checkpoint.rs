use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;

#[tokio::test]
async fn promoted_user_message_carries_a_checkpoint_uuid() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_at(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "hello".into(),
                delivery: Delivery::Steer,
            },
            Some("workspace".into()),
        )
        .await
        .unwrap();
    let promoted = store.promote("s", true).await.unwrap();
    assert_eq!(promoted.len(), 1);
    let checkpoint = promoted[0].data["checkpoint"]
        .as_str()
        .expect("checkpoint on the promoted event")
        .to_string();
    assert_eq!(checkpoint.len(), 36);
    assert_eq!(checkpoint.matches('-').count(), 4);

    let history = store.history("s").await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].role, "user");
    assert_eq!(history[0].checkpoint.as_deref(), Some(checkpoint.as_str()));

    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["messages"][0]["checkpoint"], json!(checkpoint));
}
