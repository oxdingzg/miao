use miao_engine::{
    export::committed_events,
    protocol::{Delivery, Error, Event, Input},
    store::Store,
};
use std::{io::Write, path::PathBuf};

struct UpdatingWriter {
    path: PathBuf,
    bytes: Vec<u8>,
    changed: bool,
}
impl Write for UpdatingWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if !self.changed {
            self.changed = true;
            let conn = rusqlite::Connection::open(&self.path).unwrap();
            conn.execute_batch("BEGIN; UPDATE engine_session SET next_seq=next_seq+1 WHERE id='s'; INSERT INTO engine_event SELECT 's',next_seq,'later','{}' FROM engine_session WHERE id='s'; COMMIT;").unwrap();
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn export_is_read_only_works_during_ownership_and_pins_high_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "hello".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    let mut output = UpdatingWriter {
        path: path.clone(),
        bytes: Vec::new(),
        changed: false,
    };
    assert_eq!(committed_events(&path, "s", 0, &mut output).unwrap(), 1);
    let events: Vec<Event> = String::from_utf8(output.bytes)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "input.admitted");
    let mut after = Vec::new();
    assert_eq!(committed_events(&path, "s", 1, &mut after).unwrap(), 2);
    assert_eq!(
        serde_json::from_slice::<Event>(&after).unwrap().kind,
        "later"
    );
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 2);
    let missing = dir.path().join("missing.db");
    assert!(committed_events(&missing, "s", 0, Vec::new()).is_err());
    assert!(!missing.exists());
}

#[tokio::test]
async fn unrelated_or_future_database_is_not_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let unrelated = dir.path().join("other.db");
    let conn = rusqlite::Connection::open(&unrelated).unwrap();
    conn.execute("CREATE TABLE session(id TEXT)", []).unwrap();
    drop(conn);
    assert!(matches!(
        Store::open(&unrelated).await,
        Err(Error::Invalid(_))
    ));
    let future = dir.path().join("future.db");
    let conn = rusqlite::Connection::open(&future).unwrap();
    conn.execute_batch("PRAGMA application_id=1296646469; PRAGMA user_version=999; CREATE TABLE engine_session(id TEXT)").unwrap();
    drop(conn);
    assert!(matches!(Store::open(&future).await, Err(Error::Invalid(_))));
}
