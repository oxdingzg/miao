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

pub type Entry = crate::permission_journal::Entry<Change>;
pub type Page = crate::permission_journal::Page<Change>;
pub use crate::permission_journal::Input;

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub workspace: String,
    pub cursor: u64,
    pub patterns: Vec<Pattern>,
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
    crate::permission_source::require_legacy(connection, workspace)?;
    crate::permission_journal::page(
        connection,
        "engine_permission_pattern_change",
        workspace,
        input,
        |change| {
            match change {
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
            Ok(())
        },
    )
}
