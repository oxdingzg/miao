//! Imported-rule projection evidence. Kept separate from the existing native
//! pattern journal so older clients never receive an unknown change variant.
use crate::{
    permission::digest,
    permission_migration::{LegacyRule, Receipt},
    protocol::Error,
    store::Store,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub use crate::permission_journal::Input;
pub type Page = crate::permission_journal::Page<Change>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Migrated {
        receipt: Receipt,
        rules: Vec<LegacyRule>,
    },
    Removed {
        id: String,
        fingerprint: String,
    },
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub workspace: String,
    pub cursor: u64,
    pub migration: Option<Receipt>,
    pub rules: Vec<LegacyRule>,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_permission_import_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL,
           change TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS engine_permission_import_change_scope
           ON engine_permission_import_change(workspace,seq);",
    )?;
    Ok(())
}

pub(crate) fn append(
    connection: &Connection,
    workspace: &str,
    change: &Change,
) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO engine_permission_import_change(workspace,change,recorded_at_ms) VALUES(?1,?2,?3)",
        params![workspace, serde_json::to_string(change)?, crate::approval::now_ms()],
    )?;
    Ok(())
}

impl Store {
    pub async fn permission_import_snapshot(&self, workspace: String) -> Result<Snapshot, Error> {
        self.call(move |connection| snapshot(connection, &workspace))
            .await
    }
    pub async fn permission_import_changes(
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
    let transaction = connection.transaction()?;
    let migration = crate::permission_migration::receipt(&transaction, workspace)?;
    let rules = crate::permission_migration::imported(&transaction, workspace)?;
    if let Some(receipt) = &migration {
        crate::permission_migration::require_rules(&receipt.project, &rules)?;
        if receipt.imported > crate::permission_rules::MAX_RULES
            || receipt.imported < rules.len()
            || !valid_hash(&receipt.fingerprint)
        {
            return Err(Error::Invalid(
                "invalid imported permission snapshot".into(),
            ));
        }
    } else if !rules.is_empty() {
        return Err(Error::Invalid(
            "imported permissions have no migration receipt".into(),
        ));
    }
    let cursor = transaction.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM engine_permission_import_change WHERE workspace=?1",
        [workspace],
        |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(Snapshot {
        workspace: workspace.into(),
        cursor,
        migration,
        rules,
    })
}

pub(crate) fn changes(
    connection: &Connection,
    workspace: &str,
    input: Input,
) -> Result<Page, Error> {
    crate::permission_journal::page(
        connection,
        "engine_permission_import_change",
        workspace,
        input,
        |change| {
            match change {
                Change::Migrated { receipt, rules } => {
                    crate::permission_migration::require_rules(&receipt.project, rules)?;
                    if receipt.imported != rules.len()
                        || receipt.fingerprint
                            != digest(&serde_json::to_vec(&(workspace, &receipt.project, rules))?)
                    {
                        return Err(Error::Invalid(
                            "imported permission receipt binding mismatch".into(),
                        ));
                    }
                }
                Change::Removed { id, fingerprint } => {
                    crate::permission_migration::require_id(id)?;
                    let migration = crate::permission_migration::receipt(connection, workspace)?;
                    if !migration.is_some_and(|receipt| receipt.fingerprint == *fingerprint) {
                        return Err(Error::Invalid(
                            "imported permission removal scope mismatch".into(),
                        ));
                    }
                }
            }
            Ok(())
        },
    )
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::Decision;
    use crate::permission_rules::Rule;

    async fn database() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().join("engine.db"))
            .await
            .unwrap();
        (directory, store)
    }
    fn rules() -> Vec<LegacyRule> {
        vec![LegacyRule {
            id: "legacy".into(),
            rule: Rule {
                action: "read".into(),
                resource: "public".into(),
                effect: Decision::Allow,
            },
        }]
    }
    async fn page(store: &Store, workspace: &str, after: u64, limit: usize) -> Page {
        store
            .permission_import_changes(workspace.into(), Input { after, limit })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn snapshot_pages_retries_and_scope_keep_import_and_native_journals_separate() {
        let (_directory, store) = database().await;
        let initial = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(initial.cursor, 0);
        assert!(initial.migration.is_none());
        assert!(initial.rules.is_empty());
        store
            .put_permission_pattern("/repo".into(), rules()[0].rule.clone())
            .await
            .unwrap();
        let receipt = store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .unwrap();
        let snapshot = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(snapshot.migration, Some(receipt.clone()));
        assert_eq!(snapshot.rules, rules());
        assert_eq!(snapshot.cursor, 1);
        store
            .remove_imported_permission("/repo".into(), "legacy".into())
            .await
            .unwrap();
        assert!(!store
            .remove_imported_permission("/repo".into(), "legacy".into())
            .await
            .unwrap());
        assert!(!store
            .remove_imported_permission("/other".into(), "legacy".into())
            .await
            .unwrap());
        assert_eq!(
            store
                .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
                .await
                .unwrap(),
            receipt
        );
        let first = page(&store, "/repo", 0, 1).await;
        assert_eq!(first.cursor, 1);
        assert!(first.has_more);
        assert!(
            matches!(&first.changes[0].change, Change::Migrated { rules: imported, .. } if imported == &rules())
        );
        let second = page(&store, "/repo", first.cursor, 1).await;
        assert_eq!(second.cursor, 2);
        assert!(!second.has_more);
        assert_eq!(
            second.changes[0].change,
            Change::Removed {
                id: "legacy".into(),
                fingerprint: receipt.fingerprint.clone(),
            }
        );
        assert_eq!(page(&store, "/repo", 2, 1).await.cursor, 2);
        assert!(page(&store, "/other", 0, 256).await.changes.is_empty());
        assert_eq!(
            store
                .permission_pattern_changes(
                    "/repo".into(),
                    Input {
                        after: 0,
                        limit: 256
                    }
                )
                .await
                .unwrap()
                .changes
                .len(),
            1
        );
        assert_eq!(
            store
                .permission_patterns("/repo".into())
                .await
                .unwrap()
                .len(),
            1
        );
        let final_snapshot = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(final_snapshot.cursor, 2);
        assert!(final_snapshot.rules.is_empty());
    }

    #[tokio::test]
    async fn empty_handoff_has_evidence_and_prejournal_rows_bootstrap_from_snapshot() {
        let (_directory, store) = database().await;
        store
            .migrate_legacy_permissions("/empty".into(), "project".into(), vec![])
            .await
            .unwrap();
        assert!(
            matches!(&page(&store, "/empty", 0, 256).await.changes[0].change, Change::Migrated { rules, .. } if rules.is_empty())
        );
        store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .unwrap();
        store
            .call(|connection| {
                connection.execute_batch("DROP TABLE engine_permission_import_change")?;
                initialize(connection)
            })
            .await
            .unwrap();
        let before = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(before.cursor, 0);
        assert_eq!(before.rules, rules());
        assert!(before.migration.is_some());
        assert!(page(&store, "/repo", 0, 256).await.changes.is_empty());
        store
            .remove_imported_permission("/repo".into(), "legacy".into())
            .await
            .unwrap();
        assert_eq!(page(&store, "/repo", 0, 256).await.changes.len(), 1);
    }

    #[tokio::test]
    async fn journal_failure_rolls_back_handoff_and_revocation_together() {
        let (_directory, store) = database().await;
        store.call(|connection| {
            connection.execute_batch("CREATE TRIGGER fail_import_journal BEFORE INSERT ON engine_permission_import_change BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .is_err());
        assert!(store
            .legacy_permission_migration("/repo".into())
            .await
            .unwrap()
            .is_none());
        assert!(store.saved_rules("/repo".into()).await.unwrap().is_empty());
        store
            .call(|connection| {
                connection.execute_batch("DROP TRIGGER fail_import_journal")?;
                Ok(())
            })
            .await
            .unwrap();
        store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .unwrap();
        store.call(|connection| {
            connection.execute_batch("CREATE TRIGGER fail_import_journal BEFORE INSERT ON engine_permission_import_change BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(store
            .remove_imported_permission("/repo".into(), "legacy".into())
            .await
            .is_err());
        let after = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(after.cursor, 1);
        assert_eq!(after.rules, rules());
        assert_eq!(store.saved_rules("/repo".into()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn corrupt_receipts_and_invalid_cursors_never_return_a_partial_page() {
        let (_directory, store) = database().await;
        store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .unwrap();
        for input in [
            Input { after: 0, limit: 0 },
            Input {
                after: 0,
                limit: 257,
            },
            Input {
                after: u64::MAX,
                limit: 1,
            },
        ] {
            assert!(store
                .permission_import_changes("/repo".into(), input)
                .await
                .is_err());
        }
        store.call(|connection| {
            connection.execute("INSERT INTO engine_permission_import_change(workspace,change,recorded_at_ms) VALUES('/repo',?1,0)", [r#"{"kind":"removed","id":"psv_native_corrupt"}"#])?;
            Ok(())
        }).await.unwrap();
        assert!(store
            .permission_import_changes("/repo".into(), Input { after: 0, limit: 1 })
            .await
            .is_err());
        let fresh = store
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap();
        assert_eq!(fresh.cursor, 2);
        assert_eq!(fresh.rules, rules());
        assert!(page(&store, "/repo", fresh.cursor, 1)
            .await
            .changes
            .is_empty());
        store.call(|connection| {
            connection.execute("UPDATE engine_permission_import_change SET change=?1 WHERE seq=1", [r#"{"kind":"migrated","receipt":{"project":"other","fingerprint":"bad","imported":0},"rules":[]}"#])?;
            Ok(())
        }).await.unwrap();
        assert!(store
            .permission_import_changes(
                "/repo".into(),
                Input {
                    after: 0,
                    limit: 256
                }
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn foreign_workspace_receipt_cannot_remove_an_equal_local_legacy_id() {
        let (_directory, store) = database().await;
        store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules())
            .await
            .unwrap();
        let foreign = store
            .migrate_legacy_permissions("/other".into(), "project".into(), rules())
            .await
            .unwrap();
        store
            .call(move |connection| {
                append(
                    connection,
                    "/repo",
                    &Change::Removed {
                        id: "legacy".into(),
                        fingerprint: foreign.fingerprint,
                    },
                )
            })
            .await
            .unwrap();
        assert!(store
            .permission_import_changes(
                "/repo".into(),
                Input {
                    after: 0,
                    limit: 256
                }
            )
            .await
            .is_err());
        assert_eq!(
            store
                .permission_import_snapshot("/repo".into())
                .await
                .unwrap()
                .rules,
            rules()
        );
    }

    #[tokio::test]
    async fn snapshot_pins_rules_and_cursor_while_a_store_revokes() {
        let (directory, writer) = database().await;
        let rules = (0..32)
            .map(|index| LegacyRule {
                id: format!("legacy-{index}"),
                rule: Rule {
                    action: "read".into(),
                    resource: format!("public-{index}"),
                    effect: Decision::Allow,
                },
            })
            .collect();
        writer
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules)
            .await
            .unwrap();
        let writing = async {
            for index in 0..32 {
                writer
                    .remove_imported_permission("/repo".into(), format!("legacy-{index}"))
                    .await
                    .unwrap();
                tokio::task::yield_now().await;
            }
        };
        // A second Store in this process is deliberately forbidden. Read-only
        // inspection uses the same snapshot implementation on its own connection.
        let filename = directory.path().join("engine.db");
        let reading = tokio::task::spawn_blocking(move || {
            let mut connection =
                Connection::open_with_flags(filename, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            for _ in 0..128 {
                let view = snapshot(&mut connection, "/repo").unwrap();
                assert_eq!(view.rules.len() as u64 + view.cursor, 33);
                assert!(view.migration.is_some());
                std::thread::yield_now();
            }
        });
        let (_, read) = tokio::join!(writing, reading);
        read.unwrap();
        assert!(writer
            .permission_import_snapshot("/repo".into())
            .await
            .unwrap()
            .rules
            .is_empty());
    }
}
