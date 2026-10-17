use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn all_in_usage_includes_rejected_auxiliary_work_and_preserves_missing_axes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store.record("s","provider.started",json!({"run_id":"r","step":0,"identity":{"protocol":"openai-responses","model":"provider/main"}})).await.unwrap();
    store.record("s","usage",json!({"run_id":"r","step":0,"usage":{"inputTokens":100,"outputTokens":10,"cacheReadInputTokens":80,"providerMetadata":{"inputTokens":999999}}})).await.unwrap();
    for (id, accepted, success, usage) in [
        (
            "rejected",
            false,
            true,
            json!({"inputTokens":50,"outputTokens":5,"cacheReadInputTokens":30,"cacheWriteInputTokens":5,"nonCachedInputTokens":15}),
        ),
        ("failed", false, false, serde_json::Value::Null),
        (
            "zero",
            true,
            true,
            json!({"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheWriteInputTokens":0}),
        ),
    ] {
        let start=store.record("s","role.provider.started",json!({"run_id":"r","role":"summarize","path":"prefix","identity":{"protocol":"openai-responses","model":"provider/cheap"}})).await.unwrap();
        store.record("s","role.provider.completed",json!({"run_id":"r","startedSeq":start.seq,"role":"summarize","path":"prefix","providerSuccess":success,"accepted":accepted,"reason":id,"identity":{"protocol":"openai-responses","model":"provider/cheap"},"usage":usage})).await.unwrap();
    }
    let events = store.events("s", 0, 100).await.unwrap();
    let main = events
        .iter()
        .rev()
        .find(|event| event.kind == "usage")
        .unwrap();
    assert_eq!(main.data["usage"]["inputTokens"], 100);
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"partial","step":0,"partial":true,"usage":null}),
        )
        .await
        .unwrap();
    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["turns"], 1);
    assert_eq!(report["partialTurns"], 1);
    assert_eq!(report["tokens"]["input"], 100);
    assert_eq!(report["providerUsage"]["observations"], 5);
    assert_eq!(report["providerUsage"]["missingUsageObservations"], 2);
    assert_eq!(report["providerUsage"]["tokens"]["input"], 150);
    assert_eq!(report["providerUsage"]["tokens"]["cacheRead"], 110);
    assert_eq!(report["providerUsage"]["coverage"]["input"], 3);
    assert!(report["providerUsage"]["hitRatio"].is_null());
    assert_eq!(report["auxiliary"]["usage"]["observations"], 3);
    assert_eq!(report["auxiliary"]["usage"]["tokens"]["input"], 50);
    assert_eq!(report["auxiliary"]["accepted"], 1);
    assert_eq!(report["auxiliary"]["semanticRejected"], 1);
    assert_eq!(report["auxiliary"]["providerFailed"], 1);
    assert_eq!(report["providerDetail"].as_array().unwrap().len(), 5);
    assert_eq!(report["turnsDetail"].as_array().unwrap().len(), 1);
    assert!(report["providerDetail"][0]["observedUsage"]
        .get("providerMetadata")
        .is_none());
    assert!(report["auxiliary"]["turnsDetail"][0]["durationMs"].is_u64());
}

#[tokio::test]
async fn unknown_auxiliary_usage_is_not_a_measured_zero() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store
        .record(
            "s",
            "role.provider.completed",
            json!({"role":"summarize","providerSuccess":false,"accepted":false,"usage":null}),
        )
        .await
        .unwrap();
    let report = store.usage_report("s").await.unwrap();
    assert!(report["auxiliary"]["usage"]["tokens"]["input"].is_null());
    assert_eq!(report["auxiliary"]["usage"]["coverage"]["input"], 0);
    assert_eq!(report["auxiliary"]["usage"]["missingUsageObservations"], 1);
    assert!(report["auxiliary"]["turnsDetail"][0]["durationMs"].is_null());
}
