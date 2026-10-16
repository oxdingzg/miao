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
            json!({"run_id":"r1","step":0,
                   "usage":{"inputTokens":200,"outputTokens":10,"cacheReadInputTokens":150,"nonCachedInputTokens":50}}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "tool.completed",
            json!({"run_id":"r1","step":0,"name":"read_file","is_error":false}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "tool.completed",
            json!({"run_id":"r1","step":0,"name":"edit_file","is_error":true}),
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
            json!({"run_id":"r1","step":1,"partial":true,
                   "usage":{"inputTokens":100,"outputTokens":2}}),
        )
        .await
        .unwrap();

    store.record_timing("s", "r1", 0, 900).await.unwrap();
    store.record_timing("s", "r1", 1, 300).await.unwrap();
    // The billed turn settles into the same timing row without losing TTFT.
    store
        .record_turn_time("s", "r1", 0, 1_700_000_000_000)
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
    // min/max unchanged proves the turn-time upsert kept the recorded TTFT.
    assert_eq!(report["lineage"][0]["protocol"], "openai-chat");
    assert_eq!(report["lineage"][0]["model"], "glm-5.3-flash");
    // The partial turn still counted toward the identity that served it.
    assert_eq!(report["lineage"][0]["turns"], 2);
    assert_eq!(report["tools"]["calls"], 2);
    assert_eq!(report["tools"]["failures"], 1);
    // Billed turns are itemized with their own usage so the product prices
    // each turn's tier separately, and carry their recorded settle time.
    assert_eq!(report["turnsDetail"].as_array().unwrap().len(), 1);
    let detail = &report["turnsDetail"][0];
    assert_eq!(detail["model"], "glm-5.3-flash");
    assert_eq!(detail["usage"]["inputTokens"], 200);
    assert_eq!(detail["usage"]["nonCachedInputTokens"], 50);
    assert_eq!(detail["turnMs"], 1_700_000_000_000u64);

    // A session with no usage evidence reports zeros, not an error.
    let empty = store.usage_report("other").await.unwrap();
    assert_eq!(empty["turns"], 0);
    assert_eq!(empty["ttftMs"], json!(null));
    assert_eq!(empty["tools"]["calls"], 0);
    assert_eq!(empty["turnsDetail"].as_array().unwrap().len(), 0);
}
