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

#[tokio::test]
async fn reply_identity_is_atomic_replayable_and_preserved_when_forked() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("engine.db");
    let store = Store::open(&db).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store.promote("s", false).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    let started = store
        .record("s", "provider.started", json!({"run_id":"run","step":2}))
        .await
        .unwrap();
    let content = json!([{"type":"text","text":"answer"}]);
    let committed = store
        .assistant_reply_profiled(
            "s",
            "run",
            2,
            Some(started.seq),
            content.clone(),
            Some(miao_engine::provider::Identity {
                protocol: "openai-chat".into(),
                model: "actual-secondary".into(),
            }),
        )
        .await
        .unwrap();
    let events = store.events("s", committed.seq, 100).await.unwrap();
    assert_eq!(committed.data["anchor_seq"], started.seq);
    assert_eq!(events[0].data["anchor_seq"], started.seq);
    assert_eq!(events[0].kind, "assistant.identity");
    assert_eq!(events[0].data["assistant_seq"], committed.seq);
    assert_eq!(events[0].data["run_id"], "run");
    assert_eq!(events[0].data["step"], 2);
    assert_eq!(events[0].recorded_at_ms, committed.recorded_at_ms);
    assert!(events[0].data["agent"].is_null());
    store.fork("s", "copy", Some(committed.seq)).await.unwrap();
    let snapshot = store.snapshot("copy").await.unwrap();
    let assistant = snapshot["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(
        assistant["identity"]["provider"]["model"],
        "actual-secondary"
    );
    assert_eq!(assistant["identity"]["assistant_seq"], assistant["seq"]);
    assert!(assistant["identity"].get("anchor_seq").is_none());
    assert_eq!(
        assistant["identity"]["origin"]["assistant_seq"],
        committed.seq
    );
    assert_eq!(
        store.history("copy").await.unwrap().last().unwrap().content,
        content
    );
    drop(store);
    let reopened = Store::open(&db).await.unwrap();
    assert_eq!(
        reopened.events("s", committed.seq, 100).await.unwrap()[0].data,
        events[0].data
    );
    let unknown = reopened
        .assistant_reply_profiled(
            "s",
            "run",
            3,
            None,
            json!([{"type":"text","text":"unknown"}]),
            None,
        )
        .await
        .unwrap();
    assert!(reopened.events("s", unknown.seq, 10).await.unwrap()[0].data["provider"].is_null());
    assert!(reopened
        .assistant_reply_profiled("s", "missing-run", 4, None, json!([]), None)
        .await
        .is_err());
    assert_eq!(
        reopened.events("s", unknown.seq, 10).await.unwrap().len(),
        1
    );
    let mut jsonl = Vec::new();
    miao_engine::export::committed_events(&db, "s", committed.seq, &mut jsonl).unwrap();
    let exported: Vec<serde_json::Value> = String::from_utf8(jsonl)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(exported[0]["kind"], "assistant.identity");
    assert_eq!(exported[0]["data"], events[0].data);
}
