//! Shared-authority invalidations have their own durable cursor, never a Session sequence.
use crate::protocol::Error;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub authority: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub after: Cursor,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
pub struct Observation<T> {
    pub snapshot: T,
    pub cursor: Cursor,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scope {
    Project,
    Directory {
        directory: String,
        workspace_id: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub seq: u64,
    pub scope: Scope,
    pub revision: u64,
    pub recorded_at_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub cursor: Cursor,
    pub changes: Vec<Change>,
    pub has_more: bool,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    // Revision triggers cover already-open v2 writers too: their existing
    // mutations still commit the invalidation in the very same transaction.
    connection.execute_batch(
        "CREATE TABLE permission_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq BETWEEN 1 AND 9007199254740991),
           project TEXT NOT NULL REFERENCES permission_project(project),
           location TEXT, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
           recorded_at_ms INTEGER NOT NULL
         );
         CREATE INDEX permission_change_project ON permission_change(project,seq);
         CREATE TRIGGER permission_change_project_revision AFTER UPDATE OF revision ON permission_project
         WHEN NEW.revision != OLD.revision BEGIN
           INSERT INTO permission_change(project,location,revision,recorded_at_ms)
           VALUES(NEW.project,NULL,NEW.revision,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
         END;
         CREATE TRIGGER permission_change_directory_revision AFTER UPDATE OF revision ON permission_directory
         WHEN NEW.revision != OLD.revision BEGIN
           INSERT INTO permission_change(project,location,revision,recorded_at_ms)
           VALUES(NEW.project,NEW.location,NEW.revision,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
         END;
         CREATE TRIGGER permission_change_no_update BEFORE UPDATE ON permission_change
         BEGIN SELECT RAISE(ABORT,'permission changes are immutable'); END;
         CREATE TRIGGER permission_change_no_delete BEFORE DELETE ON permission_change
         BEGIN SELECT RAISE(ABORT,'permission changes are immutable'); END;"
    )?;
    Ok(())
}

pub(crate) fn cursor(connection: &Connection) -> Result<Cursor, Error> {
    let authority: String = connection.query_row(
        "SELECT id FROM permission_authority WHERE (SELECT count(*) FROM permission_authority)=1",
        [],
        |row| row.get(0),
    )?;
    uuid::Uuid::parse_str(&authority)
        .map_err(|_| Error::Invalid("invalid permission authority identity".into()))?;
    let seq = connection.query_row(
        "SELECT coalesce(max(seq),0) FROM permission_change",
        [],
        |row| row.get(0),
    )?;
    Ok(Cursor { authority, seq })
}

pub(crate) fn page(
    connection: &Connection,
    project: &str,
    location: Option<&str>,
    input: Input,
) -> Result<Page, Error> {
    let watermark = cursor(connection)?;
    if input.limit == 0
        || input.limit > 256
        || input.after.seq > MAX_SEQUENCE
        || input.after.authority != watermark.authority
        || input.after.seq > watermark.seq
    {
        return Err(Error::Invalid(
            "invalid shared permission change cursor or page size".into(),
        ));
    }
    let mut statement = connection.prepare(
        "SELECT seq,location,revision,recorded_at_ms FROM permission_change WHERE project=?1 AND seq>?2 AND seq<=?3 AND (?4 IS NULL OR location IS NULL OR location=?4) ORDER BY seq LIMIT ?5",
    )?;
    let mut changes = statement
        .query_map(
            params![
                project,
                input.after.seq,
                watermark.seq,
                location,
                input.limit + 1
            ],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            },
        )?
        .map(|row| {
            let (seq, location, revision, recorded_at_ms) = row?;
            let scope = match location {
                Some(location) => {
                    let (directory, workspace_id): (String, Option<String>) =
                        serde_json::from_str(&location)?;
                    Scope::Directory {
                        directory,
                        workspace_id,
                    }
                }
                None => Scope::Project,
            };
            Ok(Change {
                seq,
                scope,
                revision,
                recorded_at_ms,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let has_more = changes.len() > input.limit;
    changes.truncate(input.limit);
    let seq = if has_more {
        changes.last().map_or(input.after.seq, |change| change.seq)
    } else {
        watermark.seq
    };
    Ok(Page {
        cursor: Cursor {
            authority: watermark.authority,
            seq,
        },
        changes,
        has_more,
    })
}
