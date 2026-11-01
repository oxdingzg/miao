//! VAL-02 / VAL-03: supervision cost and rework are measured, not estimated.
//!
//! The acceptance wording asks for human interventions and for mistakes and
//! rework. Neither needs a stopwatch: the engine already records the events
//! that make them countable, so the report names them.

use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn the_report_counts_operator_interventions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    // One approval answered, one "always allow", one question answered, one
    // question rejected, one queued input withdrawn, one queued input edited.
    for (kind, data) in [
        ("permission.approved", json!({})),
        ("permission.saved_allowed", json!({})),
        ("question.resolved", json!({"state": "answered"})),
        ("question.resolved", json!({"state": "rejected"})),
        ("question.resolved", json!({"state": "expired"})),
        ("input.cancelled", json!({})),
        ("input.edited", json!({})),
    ] {
        store.record("s", kind, data).await.unwrap();
    }

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["interventions"]["approvals"], 1);
    assert_eq!(report["interventions"]["allowAll"], 1);
    assert_eq!(report["interventions"]["answers"], 1);
    assert_eq!(report["interventions"]["rejections"], 1);
    // An expired question is not an operator decision.
    assert_eq!(report["interventions"]["cancels"], 1);
    assert_eq!(report["interventions"]["inputEdits"], 1);
}

#[tokio::test]
async fn the_report_counts_rework_that_needed_no_operator() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store
        .record("s", "tool.input_error", json!({"reason": "invalid_json"}))
        .await
        .unwrap();
    store
        .record("s", "tool.input_error", json!({"reason": "invalid_json"}))
        .await
        .unwrap();
    store
        .record(
            "s",
            "tool.input_recovery.stopped",
            json!({"reason": "correction_budget"}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["rework"]["toolInputErrors"], 2);
    assert_eq!(report["rework"]["inputRecoveryStopped"], 1);
    // Nothing happened that a person had to do.
    assert_eq!(report["interventions"]["approvals"], 0);
}

#[tokio::test]
async fn a_clean_session_reports_zeros_rather_than_missing_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r","step":0,"usage":{"inputTokens":5,"outputTokens":1}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["interventions"]["approvals"], 0);
    assert_eq!(report["rework"]["toolInputErrors"], 0);
}
