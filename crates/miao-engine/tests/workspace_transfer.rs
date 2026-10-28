use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn workspace_move_recovers_default_model_from_committed_assistant_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store
        .initialize("s", "workspace switch", directory.path().to_str().unwrap())
        .await
        .unwrap();
    store
        .message(
            "s",
            "user",
            json!([{"type":"text","text":"work in another repository"}]),
        )
        .await
        .unwrap();
    let assistant = store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"switching"}]),
        )
        .await
        .unwrap();
    store.record("s", "assistant.identity", json!({"assistant_seq":assistant.seq,"provider":{"protocol":"openai-chat","model":"default-model"}})).await.unwrap();
    assert!(store.model_selection("s").await.unwrap().is_none());
    let file = directory.path().join("move.json");
    let receipt = store
        .export_session_move(
            "s",
            &directory.path().join("product.db"),
            directory.path().to_str().unwrap(),
            file.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        receipt["binding"],
        json!({"protocol":"openai-chat","model":"default-model"})
    );
    let bundle: serde_json::Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    assert_eq!(bundle["session"]["model"], receipt["binding"]);
    assert!(store.model_selection("s").await.unwrap().is_none());
}

#[tokio::test]
async fn workspace_move_keeps_an_explicit_model_selection_over_prior_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store
        .initialize("s", "workspace switch", directory.path().to_str().unwrap())
        .await
        .unwrap();
    let assistant = store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"previous model"}]),
        )
        .await
        .unwrap();
    store.record("s", "assistant.identity", json!({"assistant_seq":assistant.seq,"provider":{"protocol":"openai-chat","model":"old-model"}})).await.unwrap();
    let binding = miao_engine::session_model::Binding {
        protocol: "anthropic".into(),
        model: "selected-model".into(),
        route_id: Some("selected-route".into()),
        variant: Some("default".into()),
    };
    store
        .select_model("s", Some(binding.clone()))
        .await
        .unwrap();
    store
        .message(
            "s",
            "user",
            json!([{"type":"text","text":"switch workspace"}]),
        )
        .await
        .unwrap();
    let receipt = store
        .export_session_move(
            "s",
            &directory.path().join("product.db"),
            directory.path().to_str().unwrap(),
            directory.path().join("move.json"),
        )
        .await
        .unwrap();
    assert_eq!(receipt["binding"], serde_json::to_value(&binding).unwrap());
    assert_eq!(store.model_selection("s").await.unwrap(), Some(binding));
}
