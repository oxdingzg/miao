//! Session-local legacy storage names. Old kernels must not keep reading an
//! authority after the shared permission handoff has retired its old writer.
use crate::protocol::Error;
use rusqlite::{Connection, OptionalExtension};

const RENAMED_SCHEMA: u32 = 23;

#[derive(Clone, Copy)]
pub(crate) enum Table {
    Projected,
    Native,
}

impl Table {
    fn names(self) -> (&'static str, &'static str) {
        match self {
            Self::Projected => ("engine_permission_rule", "engine_permission_rule_legacy"),
            Self::Native => (
                "engine_owned_permission_rule",
                "engine_owned_permission_rule_legacy",
            ),
        }
    }
}

pub(crate) fn initialize(
    connection: &Connection,
    version: u32,
    existing: bool,
) -> Result<(), Error> {
    for table in [Table::Projected, Table::Native] {
        let (old, current) = table.names();
        let previous = kind(connection, old)?;
        let present = kind(connection, current)?;
        if existing && version >= RENAMED_SCHEMA {
            if previous.is_some() || present.as_deref() != Some("table") {
                return Err(Error::Invalid(
                    "invalid legacy permission storage namespace".into(),
                ));
            }
            continue;
        }
        match (previous.as_deref(), present.as_deref()) {
            (Some("table"), None) => {
                connection.execute_batch(&format!("ALTER TABLE {old} RENAME TO {current}"))?
            }
            (None, None) | (None, Some("table")) => {}
            _ => {
                return Err(Error::Invalid(
                    "ambiguous legacy permission storage namespace".into(),
                ))
            }
        }
    }
    Ok(())
}

/// Read-only catalogs may inspect an older database without upgrading it.
/// A current-format authority never falls back to an old table or missing data.
pub(crate) fn read_table(
    connection: &Connection,
    table: Table,
) -> Result<Option<&'static str>, Error> {
    let (old, current) = table.names();
    let previous = kind(connection, old)?;
    let present = kind(connection, current)?;
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    match (previous.as_deref(), present.as_deref()) {
        (None, Some("table")) => Ok(Some(current)),
        (Some("table"), None) if version < RENAMED_SCHEMA => Ok(Some(old)),
        (None, None) if version < RENAMED_SCHEMA => Ok(None),
        _ => Err(Error::Invalid(
            "invalid legacy permission storage namespace".into(),
        )),
    }
}

fn kind(connection: &Connection, name: &str) -> Result<Option<String>, Error> {
    Ok(connection
        .query_row(
            "SELECT type FROM sqlite_schema WHERE name=?1 COLLATE NOCASE",
            [name],
            |row| row.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::{json, Value};
    use std::path::Path;

    fn restore(path: &Path) -> Value {
        Connection::open(path)
            .unwrap()
            .execute_batch(include_str!("../tests/fixtures/native_permissions_v22.sql"))
            .unwrap();
        serde_json::from_str(include_str!(
            "../tests/fixtures/native_permissions_v22.json"
        ))
        .unwrap()
    }

    async fn snapshot(store: &Store, workspace: &str) -> Value {
        json!({
            "patterns": store.permission_pattern_snapshot(workspace.into()).await.unwrap(),
            "imports": store.permission_import_snapshot(workspace.into()).await.unwrap(),
            "migration": store.legacy_permission_migration(workspace.into()).await.unwrap(),
        })
    }

    #[tokio::test]
    async fn actual_schema22_rules_receipts_revocations_and_cursors_survive_retirement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.db");
        let provenance = restore(&path);
        let workspace = provenance["workspace"].as_str().unwrap();
        let reader = Store::open_reader(&path).await.unwrap();
        assert_eq!(snapshot(&reader, workspace).await, provenance["expected"]);
        let old = Connection::open(&path).unwrap();
        assert_eq!(
            old.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            22
        );
        let mut prepared = old
            .prepare("SELECT rule FROM engine_permission_rule")
            .unwrap();
        let store = Store::open(&path).await.unwrap();
        assert_eq!(snapshot(&store, workspace).await, provenance["expected"]);
        assert_eq!(
            old.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            crate::store::SCHEMA_VERSION
        );
        assert!(prepared
            .query_row([], |_| Ok(()))
            .unwrap_err()
            .to_string()
            .contains("no such table"));
        assert!(old
            .prepare("SELECT * FROM engine_owned_permission_rule")
            .is_err());
        assert_eq!(
            old.query_row(
                "SELECT COUNT(*) FROM engine_permission_rule_legacy",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            old.query_row(
                "SELECT COUNT(*) FROM engine_owned_permission_rule_legacy",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
            1
        );
        // The new read-only catalog follows the current namespace after upgrade.
        assert_eq!(snapshot(&reader, workspace).await, provenance["expected"]);
        drop(prepared);
        drop(old);
        reader.close().await.unwrap();
        store.close().await.unwrap();
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(snapshot(&reopened, workspace).await, provenance["expected"]);
        reopened.close().await.unwrap();
    }

    #[tokio::test]
    async fn conflicting_names_roll_back_an_earlier_rename_and_the_format_stamp() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.db");
        restore(&path);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE engine_owned_permission_rule_legacy(sentinel TEXT); INSERT INTO engine_owned_permission_rule_legacy VALUES('keep')").unwrap();
        assert!(Store::open(&path).await.is_err());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            22
        );
        assert_eq!(
            kind(&connection, "engine_permission_rule")
                .unwrap()
                .as_deref(),
            Some("table")
        );
        assert!(kind(&connection, "engine_permission_rule_legacy")
            .unwrap()
            .is_none());
        assert_eq!(
            connection
                .query_row(
                    "SELECT sentinel FROM engine_owned_permission_rule_legacy",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "keep"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM engine_owned_permission_rule",
                    [],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn current_format_missing_or_ambiguous_names_never_fall_back_to_old_rules() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA user_version=23; CREATE TABLE engine_owned_permission_rule(value TEXT)",
            )
            .unwrap();
        assert!(read_table(&connection, Table::Native).is_err());
        assert!(read_table(&connection, Table::Projected).is_err());
        connection
            .execute_batch("CREATE TABLE engine_owned_permission_rule_legacy(value TEXT)")
            .unwrap();
        assert!(read_table(&connection, Table::Native).is_err());
    }
}
