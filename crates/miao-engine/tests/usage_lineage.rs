use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn usage_report_aggregates_turns_tokens_ttft_and_lineage() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(miao_engine::protocol::Input {
            session_id: "s".into(),
            input_id: "seed".into(),
            prompt: "task".into(),
            delivery: miao_engine::protocol::Delivery::Steer,
        })
        .await
        .unwrap();
    store
        .record(
            "s",
            "provider.started",
            json!({"run_id":"r1","step":0,"identity":{"protocol":"openai-chat","model":"glm-5.3-flash"}}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r1","step":0,"ttft_ms":900,
                   "usage":{"inputTokens":200,"outputTokens":10,"cacheReadInputTokens":150,"nonCachedInputTokens":50}}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "provider.started",
            json!({"run_id":"r1","step":1,"identity":{"protocol":"openai-chat","model":"glm-5.3-flash"}}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r1","step":1,"ttft_ms":300,"partial":true,
                   "usage":{"inputTokens":100,"outputTokens":2}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["turns"], 1);
    assert_eq!(report["partialTurns"], 1);
    assert_eq!(report["tokens"]["input"], 300);
    assert_eq!(report["tokens"]["output"], 12);
    assert_eq!(report["tokens"]["cacheRead"], 150);
    assert_eq!(report["ttftMs"]["count"], 2);
    assert_eq!(report["ttftMs"]["min"], 300);
    assert_eq!(report["ttftMs"]["max"], 900);
    assert_eq!(report["lineage"][0]["protocol"], "openai-chat");
    assert_eq!(report["lineage"][0]["model"], "glm-5.3-flash");
    // The partial turn still counted toward the identity that served it.
    assert_eq!(report["lineage"][0]["turns"], 2);

    // A session with no usage evidence reports zeros, not an error.
    let empty = store.usage_report("other").await.unwrap();
    assert_eq!(empty["turns"], 0);
    assert_eq!(empty["ttftMs"], json!(null));
}
