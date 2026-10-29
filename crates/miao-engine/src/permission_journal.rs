//! Bounded cursor decoding shared by the two permission projection journals.
use crate::protocol::Error;
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub after: u64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry<T> {
    pub seq: u64,
    pub change: T,
    pub recorded_at_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub workspace: String,
    pub cursor: u64,
    pub changes: Vec<Entry<T>>,
    pub has_more: bool,
}

pub(crate) fn page<T: DeserializeOwned>(
    connection: &Connection,
    table: &'static str,
    workspace: &str,
    input: Input,
    validate: impl Fn(&T) -> Result<(), Error>,
) -> Result<Page<T>, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    if input.limit == 0 || input.limit > 256 || input.after > i64::MAX as u64 {
        return Err(Error::Invalid(
            "invalid permission change cursor or page size".into(),
        ));
    }
    // Table names are fixed by internal callers, never supplied by a command.
    let mut statement = connection.prepare(&format!(
        "SELECT seq,change,recorded_at_ms FROM {table} WHERE workspace=?1 AND seq>?2 ORDER BY seq LIMIT ?3"
    ))?;
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
            let change: T = serde_json::from_str(&encoded)
                .map_err(|_| Error::Invalid("corrupt permission change receipt".into()))?;
            validate(&change)?;
            Ok(Entry {
                seq,
                change,
                recorded_at_ms,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let has_more = entries.len() > input.limit;
    entries.truncate(input.limit);
    Ok(Page {
        workspace: workspace.into(),
        cursor: entries.last().map_or(input.after, |entry| entry.seq),
        changes: entries,
        has_more,
    })
}
