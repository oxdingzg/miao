use crate::protocol::{Error, Event};
use rusqlite::{params, Connection, OpenFlags};
use std::{io::Write, path::Path};

/// A consistent, read-only JSONL export. SQLite remains authoritative; no
/// exporter acknowledgement is on the admission/settlement critical path.
/// The read transaction pins a committed high-watermark even while serving.
pub fn committed_events(
    path: impl AsRef<Path>,
    session: &str,
    after: u64,
    mut output: impl Write,
) -> Result<u64, Error> {
    let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let app_id: u32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    if app_id != 0x4d494145 {
        return Err(Error::Invalid("not a miao-engine database".into()));
    }
    let tx = conn.transaction()?;
    let high: u64 = tx.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM engine_event WHERE session_id=?1",
        [session],
        |r| r.get(0),
    )?;
    {
        // Read-only exports must also support stores not yet migrated by serve.
        let has_time: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_event') WHERE name='recorded_at_ms')",
            [], |row| row.get(0),
        )?;
        let time = if has_time { "recorded_at_ms" } else { "NULL" };
        let mut stmt=tx.prepare(&format!("SELECT seq,kind,data,{time} FROM engine_event WHERE session_id=?1 AND seq>?2 AND seq<=?3 ORDER BY seq"))?;
        let mut rows = stmt.query(params![session, after, high])?;
        while let Some(row) = rows.next()? {
            let event = Event {
                session_id: session.into(),
                seq: row.get(0)?,
                kind: row.get(1)?,
                recorded_at_ms: row.get(3)?,
                data: serde_json::from_str(&row.get::<_, String>(2)?)?,
            };
            serde_json::to_writer(&mut output, &event)?;
            output.write_all(b"\n")?;
        }
    }
    tx.commit()?;
    output.flush()?;
    Ok(high)
}
