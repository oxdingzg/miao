//! EXT-05: a hook's execution counts toward what the task cost.
//!
//! The engine already records `hook.completed` with the outcome and the wall
//! time it took. The report is what an operator reads, so it has to carry those
//! numbers instead of leaving them in the raw journal.

use miao_engine::store::Store;
use serde_json::json;

#[tokio::test]
async fn the_report_counts_hook_time_and_failures() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    for data in [
        json!({"phase":"pre_tool_use","tool":"run_command","outcome":"ok","reason":"completed","duration_ms":40}),
        // A hook that timed out: kept as a failure, and its wait is real time
        // the Session spent before the tool could run.
        json!({"phase":"pre_tool_use","tool":"run_command","outcome":"failed","reason":"timeout","duration_ms":1500}),
        json!({"phase":"post_tool_use","tool":"run_command","outcome":"failed","reason":"exit 2","duration_ms":10}),
    ] {
        store.record("s", "hook.completed", data).await.unwrap();
    }

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["hooks"]["calls"], 3);
    assert_eq!(report["hooks"]["failed"], 2);
    assert_eq!(
        report["hooks"]["timeMs"], 1550,
        "a hook's wall time is part of the task's cost"
    );
    // The aggregate says a hook failed; the detail says which phase and why.
    let detail = report["hooks"]["detail"].as_array().unwrap();
    assert_eq!(detail.len(), 3);
    assert_eq!(detail[1]["phase"], "pre_tool_use");
    assert_eq!(detail[1]["tool"], "run_command");
    assert_eq!(detail[1]["outcome"], "failed");
    assert_eq!(detail[1]["reason"], "timeout");
    assert_eq!(detail[1]["durationMs"], 1500);
}

#[tokio::test]
async fn a_session_without_hooks_reports_zero_rather_than_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["hooks"]["calls"], 0);
    assert_eq!(report["hooks"]["failed"], 0);
    assert_eq!(report["hooks"]["timeMs"], 0);
}
