use miao_engine::{
    approval::now_ms,
    export::committed_events,
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::{json, Value};

#[tokio::test]
async fn commit_times_survive_replay_reopen_fork_and_export() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    let before = now_ms();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "hello".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    let promoted = store.promote("s", true).await.unwrap();
    let direct = store
        .message("s", "assistant", json!([{"type":"text","text":"first"}]))
        .await
        .unwrap();
    store.start_run("s", "run").await.unwrap();
    let reply = store
        .assistant_reply("s", "run", json!([{"type":"text","text":"second"}]))
        .await
        .unwrap();
    let after = now_ms();
    let times = [
        promoted[0].recorded_at_ms,
        direct.recorded_at_ms,
        reply.recorded_at_ms,
    ];
    assert!(times
        .iter()
        .all(|time| time.is_some_and(|time| time >= before && time <= after)));
    let history = store.history("s").await.unwrap();
    assert_eq!(
        history.iter().map(|m| m.recorded_at_ms).collect::<Vec<_>>(),
        times
    );
    let snapshot = store.snapshot("s").await.unwrap();
    for (message, time) in snapshot["messages"].as_array().unwrap().iter().zip(times) {
        assert_eq!(message["recorded_at_ms"], json!(time));
    }
    store.fork("s", "fork", Some(reply.seq)).await.unwrap();
    assert_eq!(
        store
            .history("fork")
            .await
            .unwrap()
            .iter()
            .map(|m| m.recorded_at_ms)
            .collect::<Vec<_>>(),
        times
    );
    let fork_events = store.events("fork", 0, 100).await.unwrap();
    assert_eq!(
        fork_events
            .iter()
            .filter(|e| e.kind == "message.committed")
            .map(|e| e.recorded_at_ms)
            .collect::<Vec<_>>(),
        times
    );
    let events = store.events("s", 0, 100).await.unwrap();
    let serialized = serde_json::to_value(&events).unwrap();
    let mut output = Vec::new();
    committed_events(&path, "s", 0, &mut output).unwrap();
    let exported = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(json!(exported), serialized);
    drop(store);
    // The store worker releases its database lease asynchronously.
    let reopened = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match Store::open(&path).await {
                Ok(store) => break store,
                Err(miao_engine::protocol::Error::Busy) => tokio::task::yield_now().await,
                Err(error) => panic!("{error}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(reopened.events("s", 0, 100).await.unwrap()).unwrap(),
        serialized
    );
    assert_eq!(
        reopened.snapshot("s").await.unwrap()["messages"],
        snapshot["messages"]
    );
}

#[tokio::test]
async fn legacy_migration_and_read_only_export_leave_unknown_times_null() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA application_id=1296646469; PRAGMA user_version=10;
        CREATE TABLE engine_session(id TEXT PRIMARY KEY,next_seq INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'build');
        CREATE TABLE engine_event(session_id TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,seq));
        CREATE TABLE engine_message(session_id TEXT NOT NULL,seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,checkpoint TEXT,PRIMARY KEY(session_id,seq));
        INSERT INTO engine_session(id,next_seq) VALUES('s',1);").unwrap();
    let content = json!([{"type":"text","text":"historical"}]);
    conn.execute(
        "INSERT INTO engine_event VALUES('s',1,'message.committed',?1)",
        [json!({"role":"user","content":content}).to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO engine_message VALUES('s',1,'user',?1,NULL)",
        [content.to_string()],
    )
    .unwrap();
    drop(conn);
    let mut output = Vec::new();
    committed_events(&path, "s", 0, &mut output).unwrap();
    assert!(serde_json::from_slice::<Value>(&output).unwrap()["recorded_at_ms"].is_null());
    let store = Store::open(&path).await.unwrap();
    assert!(store.events("s", 0, 100).await.unwrap()[0]
        .recorded_at_ms
        .is_none());
    assert!(store.history("s").await.unwrap()[0]
        .recorded_at_ms
        .is_none());
    assert!(store.snapshot("s").await.unwrap()["messages"][0]["recorded_at_ms"].is_null());
    store.fork("s", "fork", None).await.unwrap();
    assert!(store.history("fork").await.unwrap()[0]
        .recorded_at_ms
        .is_none());
    assert!(store
        .events("fork", 0, 100)
        .await
        .unwrap()
        .iter()
        .find(|e| e.kind == "message.committed")
        .unwrap()
        .recorded_at_ms
        .is_none());
    let new = store
        .message("s", "assistant", json!([{"type":"text","text":"new"}]))
        .await
        .unwrap();
    assert!(new.recorded_at_ms.is_some());
    assert_eq!(
        store.history("s").await.unwrap()[1].recorded_at_ms,
        new.recorded_at_ms
    );
}
