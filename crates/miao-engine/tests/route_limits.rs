use miao_engine::model_routes::{load, RouteLimits};
use miao_engine::openai_chat::OpenAIChat;
use miao_engine::provider::Provider;
use std::sync::Arc;

fn manifest_body(with_limit: bool) -> String {
    let limit = if with_limit {
        r#","limit":{"context":128000,"output":8192}"#
    } else {
        ""
    };
    format!(
        r#"[{{"id":"main","provider":"openai-chat","model":"fixture-model","endpoint":"http://127.0.0.1:1","credential":{{"type":"environment","key":"OPENAI_API_KEY"}},"primary":true{limit}}}]"#
    )
}

async fn load_limits(root: &std::path::Path, with_limit: bool) -> (Arc<dyn Provider>, RouteLimits) {
    // The Environment credential source reads the var at load time.
    if std::env::var("OPENAI_API_KEY").is_err() {
        std::env::set_var("OPENAI_API_KEY", "fixture-key");
    }
    let manifest = root.join("routes.json");
    std::fs::write(&manifest, manifest_body(with_limit)).unwrap();
    // The manifest must live outside the model-writable workspace.
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let provider = Arc::new(
        OpenAIChat::new(
            "http://127.0.0.1:1".into(),
            "fixture-key".into(),
            "fixture-model".into(),
        )
        .unwrap(),
    );
    load(&manifest, &workspace, provider).await.unwrap()
}

#[tokio::test]
async fn declared_capacity_is_exposed_for_capacity_checks() {
    let root = std::env::temp_dir().join("miao-route-limits-declared");
    std::fs::create_dir_all(&root).unwrap();
    let (_provider, limits) = load_limits(&root, true).await;
    assert_eq!(limits.context_limit_for("fixture-model"), Some(128_000));
    assert_eq!(limits.context_limit_for("unknown-model"), None);
}

#[tokio::test]
async fn undeclared_capacity_stays_unknown() {
    let root = std::env::temp_dir().join("miao-route-limits-undeclared");
    std::fs::create_dir_all(&root).unwrap();
    let (_provider, limits) = load_limits(&root, false).await;
    assert_eq!(limits.context_limit_for("fixture-model"), None);
}
