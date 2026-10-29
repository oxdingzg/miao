//! The parent's view of its delegated Sessions (AGT-01, C1).
//!
//! Lineage already records who forked whom; what a parent UI still cannot ask
//! is "which children do I have, and is one of them still working". This read
//! answers that from Session catalog rows, the lineage edge and the child's
//! latest run, so no new event or status vocabulary is invented: `busy` is
//! literally "the child has a running run".

use crate::{protocol::Error, store::Store};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

/// Most children one answer carries. A delegation loop is bounded by the
/// subagent depth and concurrency limits, but a fork tree is not, so the read
/// states how many entries it left out instead of growing without bound.
pub const MAX_CHILDREN: usize = 200;

impl Store {
    /// The Sessions forked from or delegated to by `session`, oldest first.
    ///
    /// Archived children stay in the list: archiving is a catalog preference,
    /// not a statement that the delegation never happened. A Session that has
    /// no children answers an empty list; an unknown Session is an error,
    /// which is the difference between "nothing was delegated" and "you asked
    /// about an identity that does not exist".
    pub async fn children(&self, session: &str, limit: usize) -> Result<Value, Error> {
        // One answer is bounded whatever the caller asks for: `limit + 1`
        // detects truncation, so an unbounded value would overflow that read.
        let (session, limit) = (session.to_owned(), limit.clamp(1, MAX_CHILDREN) as i64);
        self.call(move |conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
                [&session],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(Error::Invalid("Session does not exist".into()));
            }
            let mut statement = conn.prepare(
                "SELECT s.id,s.title,l.message_seq,s.created_at_ms,s.updated_at_ms,
                        s.archived_at_ms,s.pinned_at_ms,
                        (SELECT COUNT(*) FROM engine_message m WHERE m.session_id=s.id AND m.reverted=0 AND m.quarantined=0)
                 FROM engine_lineage l JOIN engine_session s ON s.id=l.session_id
                 WHERE l.parent_session_id=?1
                 ORDER BY s.created_at_ms, s.id
                 LIMIT ?2",
            )?;
            let rows = statement.query_map(rusqlite::params![session, limit + 1], |row| {
                Ok(json!({
                    "session_id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "parent_message_seq": row.get::<_, u64>(2)?,
                    "created_at_ms": row.get::<_, Option<i64>>(3)?,
                    "updated_at_ms": row.get::<_, Option<i64>>(4)?,
                    "archived_at_ms": row.get::<_, Option<i64>>(5)?,
                    "pinned_at_ms": row.get::<_, Option<i64>>(6)?,
                    "message_count": row.get::<_, u64>(7)?,
                }))
            })?;
            let mut children = rows.collect::<Result<Vec<_>, _>>()?;
            let truncated = children.len() as i64 > limit;
            children.truncate(limit as usize);
            // The latest run is the child's state: a running one means busy,
            // a finished one names how it ended. A child that never ran has no
            // run at all rather than a fabricated idle run.
            for child in children.iter_mut() {
                let session_id = child["session_id"].as_str().unwrap_or_default();
                child["run"] = latest_run(conn, session_id)?;
                child["status"] = json!(if child["run"]["state"] == "running" {
                    "busy"
                } else {
                    "idle"
                });
            }
            Ok(json!({
                "session_id": session,
                "children": children,
                "truncated": truncated,
            }))
        })
        .await
    }
}

/// One child's most recently opened run, with the local timestamp its
/// `run.started` event recorded, so a UI can show elapsed time without
/// replaying events itself.
fn latest_run(conn: &rusqlite::Connection, session: &str) -> Result<Value, Error> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id,state FROM engine_run WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((run, state)) = row else {
        return Ok(Value::Null);
    };
    let started_at_ms: Option<i64> = conn
        .query_row(
            "SELECT recorded_at_ms FROM engine_event
             WHERE session_id=?1 AND kind='run.started' AND json_extract(data,'$.run_id')=?2
             ORDER BY seq LIMIT 1",
            rusqlite::params![session, run],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(json!({"id": run, "state": state, "started_at_ms": started_at_ms}))
}
