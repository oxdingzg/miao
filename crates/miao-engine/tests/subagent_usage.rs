//! VAL-02 / COST-01: delegated work is part of the Session that delegated it.
//!
//! A subagent runs as its own child Session, so its usage is recorded under the
//! child id. A parent report that only reads its own events answers "what did
//! this Session cost" while omitting every delegated turn.

use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn a_parent_report_rolls_up_its_child_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    // `fork` creates the child Session and the lineage row in one step, which is
    // how a subagent actually appears.
    store.fork("parent", "child", None).await.unwrap();
    store
        .record(
            "parent",
            "usage",
            json!({"run_id":"r","step":0,"usage":{"inputTokens":100,"outputTokens":10}}),
        )
        .await
        .unwrap();
    store
        .record(
            "parent",
            "usage",
            json!({"run_id":"r","step":1,"usage":{"inputTokens":50,"outputTokens":5}}),
        )
        .await
        .unwrap();
    store
        .record(
            "child",
            "usage",
            json!({"run_id":"c","step":0,"usage":{"inputTokens":70,"outputTokens":7,"cacheReadInputTokens":20}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("parent").await.unwrap();
    // The parent's own numbers stay its own...
    assert_eq!(report["turns"], 2);
    assert_eq!(report["tokens"]["input"], 150);
    // ...and the delegated work is attributable rather than invisible.
    assert_eq!(report["subagents"]["sessions"], 1);
    assert_eq!(report["subagents"]["turns"], 1);
    assert_eq!(report["subagents"]["tokens"]["input"], 70);
    assert_eq!(report["subagents"]["tokens"]["cacheRead"], 20);
}

#[tokio::test]
async fn a_session_without_children_reports_no_subagents() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("solo").await.unwrap();
    store
        .record(
            "solo",
            "usage",
            json!({"run_id":"r","step":0,"usage":{"inputTokens":10,"outputTokens":1}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("solo").await.unwrap();
    assert_eq!(report["subagents"]["sessions"], 0);
    assert_eq!(report["subagents"]["turns"], 0);
    assert_eq!(report["subagents"]["tokens"]["input"], 0);
}

#[tokio::test]
async fn a_parent_report_rolls_up_its_child_retries() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    store.fork("parent", "child", None).await.unwrap();
    // The child spent three attempts on its only turn: a 500, a transport that
    // died before any status, then the attempt that settled. Every one of them
    // is billed work, so the parent's report has to show them.
    store
        .record(
            "child",
            "provider.attempt",
            json!({"run_id":"c","step":0,"attempt":1,"status":500}),
        )
        .await
        .unwrap();
    store
        .record(
            "child",
            "provider.attempt",
            json!({"run_id":"c","step":0,"attempt":2,"outcome":"transport-unknown"}),
        )
        .await
        .unwrap();
    store
        .record(
            "child",
            "provider.retry",
            json!({"run_id":"c","step":0,"attempt":1,"status":500,"reason":"status 500","delay_ms":10}),
        )
        .await
        .unwrap();
    store
        .record(
            "child",
            "provider.attempt",
            json!({"run_id":"c","step":0,"attempt":3,"status":200}),
        )
        .await
        .unwrap();
    store
        .record(
            "child",
            "usage",
            json!({"run_id":"c","step":0,"usage":{"inputTokens":10,"outputTokens":1}}),
        )
        .await
        .unwrap();
    // The parent's own attempt stays in the parent's retry block, not the child's.
    store
        .record(
            "parent",
            "provider.attempt",
            json!({"run_id":"p","step":0,"attempt":1,"status":200}),
        )
        .await
        .unwrap();

    let report = store.usage_report("parent").await.unwrap();
    assert_eq!(report["subagents"]["turns"], 1);
    assert_eq!(report["subagents"]["attempts"], 3);
    assert_eq!(report["subagents"]["failedAttempts"], 2);
    assert_eq!(report["subagents"]["replayedTurns"], 1);
    assert_eq!(report["retries"]["attempts"], 1);
}
