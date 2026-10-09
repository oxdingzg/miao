use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};
use serde_json::json;

fn input(id: &str, delivery: Delivery) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery,
    }
}

#[tokio::test]
async fn lost_ack_is_exact_retry_and_conflicts_do_not_change_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let first = store.admit(input("one", Delivery::Steer)).await.unwrap();
    let retry = store.admit(input("one", Delivery::Steer)).await.unwrap();
    assert!(retry.duplicate);
    assert_eq!(first.admitted_seq, retry.admitted_seq);
    for conflict in [
        Input {
            prompt: "other".into(),
            ..input("one", Delivery::Steer)
        },
        Input {
            session_id: "other".into(),
            ..input("one", Delivery::Steer)
        },
        input("one", Delivery::Queue),
    ] {
        assert!(matches!(store.admit(conflict).await, Err(Error::Conflict)));
    }
    assert!(store.history("s").await.unwrap().is_empty());
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
}

#[tokio::test]
async fn promotion_serializes_admissions_and_queues_only_at_idle() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("queued", Delivery::Queue)).await.unwrap();
    assert!(store.promote("s", false).await.unwrap().is_empty());
    store.admit(input("steer1", Delivery::Steer)).await.unwrap();
    store.admit(input("steer2", Delivery::Steer)).await.unwrap();
    assert_eq!(store.promote("s", false).await.unwrap().len(), 2);
    assert_eq!(store.history("s").await.unwrap().len(), 2);
    assert!(store.promote("s", false).await.unwrap().is_empty());
    assert_eq!(store.promote("s", true).await.unwrap().len(), 1);
    assert!(store.promote("s", true).await.unwrap().is_empty());
    let events = store.events("s", 3, 100).await.unwrap();
    assert_eq!(
        events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![4, 5, 6]
    );
}

#[tokio::test]
async fn lease_rejects_second_runtime_and_recovery_never_repeats_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    assert!(matches!(Store::open(&path).await, Err(Error::Busy)));
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .tool_dispatch("s", "run", "call", "write", json!({"path":"file"}))
        .await
        .unwrap();
    let events = store.recover().await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data["reason"], "interrupted");
    assert!(store.recover().await.unwrap().is_empty());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let state: String = conn
        .query_row("SELECT state FROM engine_tool WHERE id='call'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "unknown");
    assert!(store.tool_settle("s", "call", json!({})).await.is_err());
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "tool.dispatched")
            .count(),
        1
    );
}

#[tokio::test]
async fn message_projection_and_event_have_one_committed_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    let event = store
        .message("s", "assistant", json!([{"type":"text","text":"answer"}]))
        .await
        .unwrap();
    assert_eq!(event.seq, 2);
    assert_eq!(
        store.history("s").await.unwrap()[0].content[0]["text"],
        "answer"
    );
    assert_eq!(
        store.events("s", 1, 100).await.unwrap()[0].data["content"][0]["text"],
        "answer"
    );
}

/// A subscriber replays from a cursor to a captured high-watermark and then
/// hands off to live events after it. The durable ledger is the single source
/// both sides read, so the handoff has no gap and no duplicate: paging from the
/// watermark resumes exactly at the next committed event, and re-reading the
/// whole ledger reproduces the same ordered sequence.
#[tokio::test]
async fn replay_to_watermark_then_live_has_no_gap_or_duplicate() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store
        .message("s", "assistant", json!([{"type":"text","text":"a"}]))
        .await
        .unwrap();

    let mut replayed = Vec::new();
    let mut cursor = 0u64;
    loop {
        let page = store.events("s", cursor, 1).await.unwrap();
        if page.is_empty() {
            break;
        }
        replayed.extend(page.iter().map(|event| event.seq));
        cursor = page.last().unwrap().seq;
    }
    let watermark = cursor;
    assert_eq!(replayed, (1..=watermark).collect::<Vec<_>>());

    store
        .message("s", "assistant", json!([{"type":"text","text":"b"}]))
        .await
        .unwrap();
    let live: Vec<u64> = store
        .events("s", watermark, 100)
        .await
        .unwrap()
        .iter()
        .map(|event| event.seq)
        .collect();
    assert_eq!(live, vec![watermark + 1]);

    let full: Vec<u64> = store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .map(|event| event.seq)
        .collect();
    let mut combined = replayed;
    combined.extend(live);
    assert_eq!(combined, full);
}
