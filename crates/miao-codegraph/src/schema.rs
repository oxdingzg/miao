//! The index store: one SQLite file per workspace, rebuilt when the extractor
//! changes shape.

use crate::Error;
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
    path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    hash TEXT NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_col INTEGER NOT NULL,
    signature TEXT,
    docstring TEXT,
    container TEXT,
    exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS nodes_qualified ON nodes(qualified);
CREATE TABLE IF NOT EXISTS edges(
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER,
    provenance TEXT
);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source, kind);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target, kind);
CREATE TABLE IF NOT EXISTS refs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refs_status ON refs(status, id);
CREATE TABLE IF NOT EXISTS imports(
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    names TEXT NOT NULL,
    line INTEGER NOT NULL,
    target TEXT
);
CREATE INDEX IF NOT EXISTS imports_path ON imports(path);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, name, qualified, signature, docstring);
"#;

const TABLES: &[&str] = &[
    "files",
    "nodes",
    "edges",
    "refs",
    "imports",
    "nodes_fts",
    "meta",
];

pub fn open(path: &Path) -> Result<Connection, Error> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.busy_timeout(Duration::from_millis(5000))?;
    connection.execute_batch(DDL)?;
    migrate(&connection)?;
    Ok(connection)
}

/// A wipe rather than a per-table migration: the index is a cache of the source
/// tree, so dropping it costs one re-index and no correctness risk.
fn migrate(connection: &Connection) -> Result<(), Error> {
    let recorded: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key='extract_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    let wanted = crate::extract::VERSION.to_string();
    if recorded.as_deref() == Some(wanted.as_str()) {
        return Ok(());
    }
    for table in TABLES {
        connection.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
    }
    connection.execute_batch(DDL)?;
    connection.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('extract_version', ?1)",
        [wanted],
    )?;
    Ok(())
}

pub fn meta(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .ok()
}

pub fn set_meta(connection: &Connection, key: &str, value: &str) -> Result<(), Error> {
    connection.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES(?1, ?2)",
        [key, value],
    )?;
    Ok(())
}
