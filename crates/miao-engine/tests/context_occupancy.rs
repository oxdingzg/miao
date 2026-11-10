use miao_engine::store::Store;
use serde_json::json;

async fn admitted(store: &Store, session: &str) {
    store
        .admit(miao_engine::protocol::Input {
            agent_references: Default::default(),
            command: None,
            session_id: session.into(),
            input_id: format!("seed-{session}"),
            prompt: "task".into(),
            delivery: miao_engine::protocol::Delivery::Steer,
        })
        .await
        .unwrap();
}

/// The usage report carries the window the last turn planned against and the
/// occupancy it planned for, so a client can show how full the Session's
/// context is at the granularity of the last provider turn. A turn after a
/// compaction overwrites the figure; a Session that never reported a window
/// stays null rather than reading as empty.
#[tokio::test]
async fn the_usage_report_exposes_the_last_turns_context_window() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    admitted(&store, "s").await;

    let bare = store.usage_report("s").await.unwrap();
    assert!(
        bare["context"].is_null(),
        "no reported window is not an empty one: {}",
        bare["context"]
    );

    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r1","step":0,
                   "usage":{"inputTokens":900,"outputTokens":100},
                   "context_window":262_144,"context_tokens":240_000}),
        )
        .await
        .unwrap();
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r1","step":1,
                   "usage":{"inputTokens":300,"outputTokens":20}}),
        )
        .await
        .unwrap();
    let report = store.usage_report("s").await.unwrap();
    assert_eq!(
        report["context"]["window"], 262_144,
        "an event without the fields leaves the newest figure standing"
    );
    assert_eq!(report["context"]["tokens"], 240_000);

    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r1","step":2,
                   "usage":{"inputTokens":150,"outputTokens":30},
                   "context_window":262_144,"context_tokens":41_000}),
        )
        .await
        .unwrap();
    let report = store.usage_report("s").await.unwrap();
    assert_eq!(
        report["context"]["tokens"], 41_000,
        "a compaction or trim shows up the next time a turn settles"
    );
}
