//! Gate ② wire tests: the provider count endpoints hit the right paths with
//! the right bodies, and every refusal degrades to the estimate instead of
//! failing the turn.

mod common;

use common::endpoint;
use miao_engine::{
    context_trigger::resolve_pending_tokens,
    gemini::Gemini,
    protocol::{Message, ModelRequest},
    provider::{Anthropic, CountTokens, Provider},
};
use serde_json::{json, Value};

fn request() -> ModelRequest {
    ModelRequest {
        system: "fixture system".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type": "text", "text": "count me"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    }
}

#[tokio::test]
async fn anthropic_counts_on_the_count_tokens_path() {
    let (endpoint, mut requests, server) =
        endpoint(vec![(200, json!({"input_tokens": 4321}).to_string())]).await;
    let provider = Anthropic::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap();
    assert_eq!(
        provider.count_tokens(&request()).await,
        CountTokens::Counted(4321)
    );
    let body = requests.recv().await.unwrap();
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["messages"][0]["content"][0]["text"], "count me");
    server.await.unwrap();
}

#[tokio::test]
async fn anthropic_refusal_is_reported_not_fatal() {
    let (endpoint, _requests, server) = endpoint(vec![(
        429,
        json!({"error": {"message": "slow down"}}).to_string(),
    )])
    .await;
    let provider = Anthropic::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap();
    assert!(matches!(
        provider.count_tokens(&request()).await,
        CountTokens::Failed(_)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn gemini_counts_on_the_count_tokens_path() {
    let (endpoint, mut requests, server) =
        endpoint(vec![(200, json!({"totalTokens": 777}).to_string())]).await;
    let provider = Gemini::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap();
    assert_eq!(
        provider.count_tokens(&request()).await,
        CountTokens::Counted(777)
    );
    let body: Value = requests.recv().await.unwrap();
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "fixture system"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn gemini_refusal_is_reported_not_fatal() {
    let (endpoint, _requests, server) =
        endpoint(vec![(400, json!({"error": {"code": 400}}).to_string())]).await;
    let provider = Gemini::new(endpoint, "fixture".into(), "fixture-model".into()).unwrap();
    assert!(matches!(
        provider.count_tokens(&request()).await,
        CountTokens::Failed(_)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn every_non_counted_outcome_falls_back_to_the_estimate() {
    assert_eq!(resolve_pending_tokens(CountTokens::Counted(42), 9_000), 42);
    assert_eq!(
        resolve_pending_tokens(CountTokens::Unsupported, 3),
        miao_engine::context_trigger::estimate_tokens(3)
    );
    assert_eq!(
        resolve_pending_tokens(CountTokens::Failed("count refused: 500".into()), 6),
        2
    );
}
