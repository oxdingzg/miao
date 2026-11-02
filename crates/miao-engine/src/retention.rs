//! Snapshot-then-truncate retention for one engine ledger.
//!
//! The event log grows forever, and most of it is provider conversation flow
//! whose content is already summarised by compaction or projected into
//! `engine_message`. Retention moves that tail out of the database — into a
//! JSONL snapshot next to the ledger — only after every reader that could
//! still want a row has been accounted for: the reader audit on
//! oxdingzg/miao#2178 found the message-history INNER JOIN (fixed by
//! materialising `engine_message.kind`), the input-command resolution (kept
//! safe by never deleting `input.admitted`), and the export cursor (kept safe
//! by the cut-point record this module writes and `export` honours).
//!
//! Kinds are split in two. The delete set is the conversation flow whose
//! information lives elsewhere (message content, tool state, run state in
//! their own tables). Everything else — the control plane and any kind this
//! audit did not examine — is kept: a retention run that is too careful costs
//! a few rows, one that is too eager loses history.

use crate::protocol::Error;
use rusqlite::Connection;
use std::io::Write as IoWrite;

/// Kinds retention may take at or before a session's compaction baseline.
/// Their payload lives in `engine_message`, `engine_tool`, or `engine_run`;
/// the event row is the transient flow, not the state.
const DELETE_KINDS: &[&str] = &[
    "provider.started",
    "provider.request",
    "provider.attempt",
    "provider.retry",
    "provider.failed",
    "provider.failure.quarantined",
    "role.provider.started",
    "role.provider.completed",
    "tool.completed",
    "tool.input_error",
    "tool.input_recovery.stopped",
    "run.started",
    "run.finished",
    "run.cancel_requested",
    "message.committed",
];

/// What one truncation did to one session, recorded where the export cursor
/// can see it. `through_seq` is the cut: any export asking for events below it
/// is asking for rows that no longer exist.
#[derive(Debug)]
pub struct Cut {
    pub session_id: String,
    pub through_seq: u64,
    pub removed: u64,
}

pub struct Summary {
    pub cuts: Vec<Cut>,
    /// Rows the never-delete set protected even though they sat at or before
    /// the baseline. Reported, never deleted.
    pub kept_by_kind: u64,
}

/// Per-session pruning report: what a `--apply` would snapshot and remove.
pub fn plan(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut lines = Vec::new();
    let mut statement = connection.prepare(
        "SELECT e.session_id, COUNT(*), COALESCE(SUM(LENGTH(e.data)), 0)
         FROM engine_event e
         JOIN engine_compaction c ON c.session_id = e.session_id
         WHERE e.seq <= c.through_seq
           AND e.kind IN (SELECT value FROM json_each(?1))
         GROUP BY e.session_id
         ORDER BY e.session_id",
    )?;
    let kinds = serde_json::to_string(DELETE_KINDS).expect("static kind list");
    let rows = statement.query_map([kinds], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (session, events, bytes) = row?;
        lines.push(format!(
            "session {session} · {events} event(s) · {bytes} bytes prunable"
        ));
    }
    if lines.is_empty() {
        lines.push("nothing prunable: no session has a compaction baseline yet".into());
    }
    Ok(lines)
}

/// Snapshot-then-remove for every session with a compaction baseline, or only
/// the named one. The snapshot is written first and left in place even if the
/// delete fails — a snapshot without a delete is waste, a delete without a
/// snapshot is data loss. `--apply` is the caller's decision; this function is
/// the explicit-authorisation boundary, not the confirmation prompt.
pub fn truncate(
    connection: &mut Connection,
    only: Option<&str>,
    now_ms: u64,
) -> Result<Summary, Error> {
    let mut cuts = Vec::new();
    let mut kept_by_kind = 0u64;
    let sessions: Vec<String> = match only {
        Some(session) => vec![session.to_owned()],
        None => {
            let mut statement =
                connection.prepare("SELECT DISTINCT session_id FROM engine_compaction")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    for session in sessions {
        let baseline: Option<u64> = connection
            .query_row(
                "SELECT MAX(through_seq) FROM engine_compaction WHERE session_id=?1",
                [&session],
                |row| row.get(0),
            )
            .map_err(|error| Error::Invalid(format!("baseline read failed: {error}")))?;
        let Some(through) = baseline else { continue };

        // The snapshot sits beside the ledger, named for the session and the
        // exact cut, so a later audit can pair a snapshot with its cut record.
        let ledger_path: String = connection
            .query_row("PRAGMA database_list", [], |row| row.get(2))
            .map_err(|error| Error::Invalid(format!("ledger path read failed: {error}")))?;
        let mut snapshot = std::path::PathBuf::from(ledger_path);
        snapshot.set_file_name(format!(
            "{}.retention-{session}-{through}.jsonl",
            snapshot
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("engine")
        ));

        let (rows, kept) = {
            // Read-only commands may meet a store that serve has not migrated
            // yet; the timestamp column is probed the same way export probes it.
            let has_time: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_event') WHERE name='recorded_at_ms')",
                [],
                |row| row.get(0),
            )?;
            let time = if has_time { "recorded_at_ms" } else { "NULL" };
            let mut statement = connection.prepare(&format!(
                "SELECT seq, kind, data, {time} FROM engine_event
                 WHERE session_id=?1 AND seq<=?2 ORDER BY seq"
            ))?;
            let listed = statement.query_map(rusqlite::params![session, through], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })?;
            let mut deletable = Vec::new();
            let mut kept = 0u64;
            for row in listed {
                let (seq, kind, data, recorded_at_ms) = row?;
                if DELETE_KINDS.contains(&kind.as_str()) {
                    deletable.push((seq, kind, data, recorded_at_ms));
                } else {
                    kept += 1;
                }
            }
            (deletable, kept)
        };
        kept_by_kind += kept;
        if rows.is_empty() {
            continue;
        }

        let mut file = std::fs::File::create(&snapshot)
            .map_err(|error| Error::Invalid(format!("snapshot create failed: {error}")))?;
        let mut removed = 0u64;
        {
            let mut serialize = |row: &(u64, String, String, Option<i64>)| -> Result<(), Error> {
                let event = crate::protocol::Event {
                    session_id: session.clone(),
                    seq: row.0,
                    kind: row.1.clone(),
                    data: serde_json::from_str(&row.2).map_err(|error| {
                        Error::Invalid(format!("snapshot decode failed: {error}"))
                    })?,
                    recorded_at_ms: row.3.map(|value| value.max(0) as u64),
                };
                serde_json::to_writer(std::io::BufWriter::new(&mut file).by_ref(), &event)
                    .map_err(|error| Error::Invalid(format!("snapshot write failed: {error}")))?;
                file.write_all(b"\n")
                    .map_err(|error| Error::Invalid(format!("snapshot write failed: {error}")))
            };
            for row in &rows {
                serialize(row)?;
                removed += 1;
            }
        }
        std::fs::File::flush(&mut file)
            .map_err(|error| Error::Invalid(format!("snapshot flush failed: {error}")))?;

        let applied = connection
            .transaction()
            .map_err(|error| Error::Invalid(format!("transaction failed: {error}")))?;
        applied
            .execute(
                "DELETE FROM engine_event WHERE session_id=?1 AND seq<=?2 AND kind IN (SELECT value FROM json_each(?3))",
                rusqlite::params![session, through, serde_json::to_string(DELETE_KINDS).expect("static kind list")],
            )
            .map_err(|error| Error::Invalid(format!("delete failed: {error}")))?;
        applied
            .execute(
                "INSERT INTO engine_retention(session_id, through_seq, removed, created_ms) VALUES(?1,?2,?3,?4)",
                rusqlite::params![session, through, removed, now_ms],
            )
            .map_err(|error| Error::Invalid(format!("cut record failed: {error}")))?;
        applied
            .commit()
            .map_err(|error| Error::Invalid(format!("commit failed: {error}")))?;

        cuts.push(Cut {
            session_id: session,
            through_seq: through,
            removed,
        });
    }
    Ok(Summary { cuts, kept_by_kind })
}

/// The largest cut recorded for a session, if any. The export cursor consults
/// this: a request for rows below the cut is asking for deleted history and
/// must be refused, not silently shorted.
pub fn cut_for(connection: &Connection, session: &str) -> rusqlite::Result<Option<u64>> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT MAX(through_seq) FROM engine_retention WHERE session_id=?1",
            [session],
            |row| row.get::<_, Option<u64>>(0),
        )
        .optional()
        .map(|value| value.flatten())
}

#[cfg(test)]
mod tests {
    use super::truncate;

    fn open_store(path: &std::path::Path) -> crate::store::Store {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async { crate::store::Store::open(path).await.expect("store") })
    }

    #[test]
    fn truncate_takes_only_the_delete_set_at_or_before_the_baseline() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.db");
        let _store = open_store(&path);
        let mut connection = rusqlite::Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "INSERT INTO engine_session(id) VALUES ('s');
                 INSERT INTO engine_event(session_id,seq,kind,data) VALUES
                   ('s',1,'provider.started','{\"run_id\":\"r\"}'),
                   ('s',2,'message.committed','{\"role\":\"user\"}'),
                   ('s',3,'input.admitted','{\"command\":null}'),
                   ('s',4,'cron.scheduled','{\"cron_id\":\"c\"}'),
                   ('s',5,'message.committed','{\"role\":\"assistant\"}'),
                   ('s',6,'question.requested','{\"question_id\":\"q\"}');
                 INSERT INTO engine_compaction(id,session_id,through_seq,summary,created_seq) VALUES ('c1','s',4,'summary',5);",
            )
            .expect("seed");

        let summary = truncate(&mut connection, Some("s"), 1_000).expect("truncate");
        assert_eq!(summary.cuts.len(), 1, "{:?}", summary.cuts);
        assert_eq!(
            summary.cuts[0].removed, 2,
            "provider.started and seq<=4 message.committed"
        );
        assert!(
            summary.kept_by_kind >= 2,
            "input.admitted and cron.scheduled protected"
        );

        let counts: String = {
            let mut statement = connection
                .prepare("SELECT kind FROM engine_event WHERE session_id='s' ORDER BY seq")
                .expect("prepare");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("map");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("rows")
                .join(",")
        };
        // The seq-5 message.committed sits past the baseline (4) and stays;
        // only the flow events at or before it go.
        assert_eq!(
            counts, "input.admitted,cron.scheduled,message.committed,question.requested",
            "{counts}"
        );
    }

    #[test]
    fn the_snapshot_holds_every_removed_event_and_the_cut_is_recorded() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.db");
        let _store = open_store(&path);
        let mut connection = rusqlite::Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "INSERT INTO engine_session(id) VALUES ('s');
                 INSERT INTO engine_event(session_id,seq,kind,data) VALUES
                   ('s',1,'provider.started','{\"run_id\":\"r\"}'),
                   ('s',2,'message.committed','{\"role\":\"user\"}');
                 INSERT INTO engine_compaction(id,session_id,through_seq,summary,created_seq) VALUES ('c1','s',2,'summary',2);",
            )
            .expect("seed");

        let summary = truncate(&mut connection, Some("s"), 1_000).expect("truncate");
        assert_eq!(summary.cuts[0].removed, 2);

        let snapshot = std::fs::read_dir(dir.path())
            .expect("dir")
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().contains(".retention-"))
            .expect("snapshot file exists");
        let text = std::fs::read_to_string(snapshot.path()).expect("snapshot");
        assert!(text.contains("\"kind\":\"provider.started\""), "{text}");
        assert!(text.contains("\"kind\":\"message.committed\""), "{text}");

        assert_eq!(super::cut_for(&connection, "s").expect("cut"), Some(2));
        assert_eq!(super::cut_for(&connection, "other").expect("no cut"), None);
    }

    #[test]
    fn the_export_cursor_refuses_a_range_below_the_cut() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.db");
        let _store = open_store(&path);
        let mut connection = rusqlite::Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "INSERT INTO engine_session(id) VALUES ('s');
                 INSERT INTO engine_event(session_id,seq,kind,data) VALUES
                   ('s',1,'provider.started','{\"run_id\":\"r\"}'),
                   ('s',2,'message.committed','{\"role\":\"user\"}'),
                   ('s',3,'input.admitted','{}');
                 INSERT INTO engine_compaction(id,session_id,through_seq,summary,created_seq) VALUES ('c1','s',2,'summary',2);",
            )
            .expect("seed");
        let summary = truncate(&mut connection, Some("s"), 1_000).expect("truncate");
        assert_eq!(summary.cuts[0].removed, 2, "the two flow events go");
        drop(connection);

        // A cursor below the cut asks for deleted rows: refuse, with the cut
        // named. A cursor at or above it still works.
        let below = crate::export::committed_events(&path, "s", 0, std::io::sink());
        assert!(below.is_err(), "cursor 0 is below the cut of 2");
        let message = format!("{}", below.expect_err("refused"));
        assert!(message.contains("retention cut 2"), "{message}");
        let above = crate::export::committed_events(&path, "s", 2, std::io::sink());
        assert!(above.is_ok(), "cursor 2 is at the cut: {:?}", above.err());
    }
}
