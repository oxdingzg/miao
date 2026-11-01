//! COST-01: a retry is billed work of its own.
//!
//! A turn that recovered after a transport failure, or a request retried after
//! a 429, must not read as a single clean turn: the report has to answer "how
//! much did retrying cost" without replaying the raw event stream.

use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn retries_are_attributed_apart_from_the_turn_they_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store
        .record(
            "s",
            "provider.started",
            json!({"run_id":"r","step":0,"identity":{"protocol":"openai-responses","model":"provider/main"}}),
        )
        .await
        .unwrap();
    // One attempt that never got a status, one 200, and one 429 before the
    // turn finally succeeded.
    for (attempt, status, outcome) in [
        (0, None, "transport_unknown"),
        (1, Some(429u64), "headers_received"),
        (2, Some(200u64), "headers_received"),
    ] {
        store
            .record(
                "s",
                "provider.attempt",
                json!({"run_id":"r","step":0,"attempt":attempt,"status":status,"outcome":outcome,"detail":null}),
            )
            .await
            .unwrap();
    }
    store
        .record(
            "s",
            "provider.retry",
            json!({"run_id":"r","step":0,"scope":"turn","attempt":1,"reason":"transport closed","status":null,"delay_ms":0}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r","step":0,"usage":{"inputTokens":100,"outputTokens":10}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["turns"], 1);
    assert_eq!(report["retries"]["attempts"], 3);
    // The transport attempt and the 429 both failed; the 200 did not.
    assert_eq!(report["retries"]["failedAttempts"], 2);
    assert_eq!(report["retries"]["replayedTurns"], 1);
    assert_eq!(
        report["retries"]["details"][0]["reason"],
        "transport closed"
    );
}

#[tokio::test]
async fn a_clean_turn_reports_no_retries_rather_than_a_missing_field() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store
        .record(
            "s",
            "provider.attempt",
            json!({"run_id":"r","step":0,"attempt":0,"status":200,"outcome":"headers_received","detail":null}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r","step":0,"usage":{"inputTokens":10,"outputTokens":1}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["retries"]["attempts"], 1);
    assert_eq!(report["retries"]["failedAttempts"], 0);
    assert_eq!(report["retries"]["replayedTurns"], 0);
    assert_eq!(report["retries"]["details"].as_array().unwrap().len(), 0);
}
