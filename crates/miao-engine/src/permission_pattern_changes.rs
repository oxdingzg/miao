//! Atomic standing-rule snapshots and a durable, workspace-scoped change cursor.
//! This is projection evidence, never an additional authorization path.
use crate::{permission_patterns::Pattern, protocol::Error, store::Store};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Upsert { pattern: Pattern },
    Remove { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub seq: u64,
    pub change: Change,
    pub recorded_at_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub workspace: String,
    pub cursor: u64,
    pub patterns: Vec<Pattern>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub after: u64,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub workspace: String,
    pub cursor: u64,
    pub changes: Vec<Entry>,
    pub has_more: bool,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_permission_pattern_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace TEXT NOT NULL,
           change TEXT NOT NULL,
           recorded_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS engine_permission_pattern_change_scope
           ON engine_permission_pattern_change(workspace,seq);",
    )?;
    Ok(())
}

/// The caller's write transaction covers both policy mutation and its receipt,
/// including always replies that save several patterns before settling peers.
pub(crate) fn append(
    connection: &Connection,
    workspace: &str,
    change: &Change,
) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO engine_permission_pattern_change(workspace,change,recorded_at_ms) VALUES(?1,?2,?3)",
        params![workspace, serde_json::to_string(change)?, crate::approval::now_ms()],
    )?;
    Ok(())
}

impl Store {
    pub async fn permission_pattern_snapshot(&self, workspace: String) -> Result<Snapshot, Error> {
        self.call(move |connection| snapshot(connection, &workspace))
            .await
    }

    pub async fn permission_pattern_changes(
        &self,
        workspace: String,
        input: Input,
    ) -> Result<Page, Error> {
        self.call(move |connection| changes(connection, &workspace, input))
            .await
    }
}

pub(crate) fn snapshot(connection: &mut Connection, workspace: &str) -> Result<Snapshot, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    // A deferred read transaction pins both queries to one SQLite snapshot,
    // even when another process owns a writer on this database.
    let transaction = connection.transaction()?;
    let patterns = crate::permission_patterns::records(&transaction, workspace)?;
    let cursor = transaction.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM engine_permission_pattern_change WHERE workspace=?1",
        [workspace],
        |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(Snapshot {
        workspace: workspace.into(),
        cursor,
        patterns,
    })
}

pub(crate) fn changes(
    connection: &Connection,
    workspace: &str,
    input: Input,
) -> Result<Page, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    if input.limit == 0 || input.limit > 256 || input.after > i64::MAX as u64 {
        return Err(Error::Invalid(
            "invalid permission change cursor or page size".into(),
        ));
    }
    let mut statement = connection.prepare(
        "SELECT seq,change,recorded_at_ms FROM engine_permission_pattern_change
         WHERE workspace=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
    )?;
    let rows = statement.query_map(params![workspace, input.after, input.limit + 1], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
        ))
    })?;
    let mut entries = rows
        .map(|row| {
            let (seq, encoded, recorded_at_ms) = row?;
            let change: Change = serde_json::from_str(&encoded)
                .map_err(|_| Error::Invalid("corrupt permission change receipt".into()))?;
            match &change {
                Change::Upsert { pattern } => {
                    crate::permission_patterns::require_rule(&pattern.rule)?;
                    if pattern.workspace != workspace
                        || pattern.id
                            != format!(
                                "prule_{}",
                                crate::permission_patterns::rule_digest(workspace, &pattern.rule)?
                            )
                    {
                        return Err(Error::Invalid("permission change scope mismatch".into()));
                    }
                }
                Change::Remove { id } => {
                    if !id.strip_prefix("prule_").is_some_and(|digest| {
                        digest.len() == 64
                            && digest
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    }) {
                        return Err(Error::Invalid("invalid permission change rule id".into()));
                    }
                }
            }
            Ok(Entry {
                seq,
                change,
                recorded_at_ms,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let has_more = entries.len() > input.limit;
    entries.truncate(input.limit);
    let cursor = entries.last().map_or(input.after, |entry| entry.seq);
    Ok(Page {
        workspace: workspace.into(),
        cursor,
        changes: entries,
        has_more,
    })
}
