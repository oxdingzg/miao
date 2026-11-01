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
