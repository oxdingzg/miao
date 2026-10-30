//! One-time handoff of legacy saved rules to native ownership. This storage
//! primitive is not enabled by the product and does not widen workspace scope.
use crate::{permission::digest, permission_rules::Rule, protocol::Error, store::Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRule {
    pub id: String,
    pub rule: Rule,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub project: String,
    pub rules: Vec<LegacyRule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remove {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub project: String,
    pub fingerprint: String,
    pub imported: usize,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_permission_migration(
           workspace TEXT PRIMARY KEY, project TEXT NOT NULL, fingerprint TEXT NOT NULL,
           imported INTEGER NOT NULL, migrated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS engine_permission_import(
           workspace TEXT NOT NULL, legacy_id TEXT NOT NULL, digest TEXT NOT NULL,
           rule TEXT NOT NULL, removed_at_ms INTEGER,
           PRIMARY KEY(workspace,legacy_id),
           FOREIGN KEY(workspace) REFERENCES engine_permission_migration(workspace)
         );
         CREATE TRIGGER IF NOT EXISTS engine_permission_migration_no_legacy_insert
         BEFORE INSERT ON engine_permission_rule_legacy
         WHEN EXISTS(SELECT 1 FROM engine_permission_migration WHERE workspace=NEW.workspace)
         BEGIN SELECT RAISE(ABORT, 'saved permission ownership migrated'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_migration_no_legacy_delete
         BEFORE DELETE ON engine_permission_rule_legacy
         WHEN EXISTS(SELECT 1 FROM engine_permission_import WHERE workspace=OLD.workspace AND digest=OLD.digest AND removed_at_ms IS NULL)
         BEGIN SELECT RAISE(ABORT, 'saved permission ownership migrated'); END;",
    )?;
    crate::permission_import_changes::initialize(connection)?;
    Ok(())
}

impl Store {
    pub async fn migrate_legacy_permissions(
        &self,
        workspace: String,
        project: String,
        rules: Vec<LegacyRule>,
    ) -> Result<Receipt, Error> {
        self.call(move |connection| migrate(connection, &workspace, &project, rules))
            .await
    }

    pub async fn legacy_permission_migration(
        &self,
        workspace: String,
    ) -> Result<Option<Receipt>, Error> {
        self.call(move |connection| receipt(connection, &workspace))
            .await
    }

    pub async fn imported_permissions(&self, workspace: String) -> Result<Vec<LegacyRule>, Error> {
        self.call(move |connection| imported(connection, &workspace))
            .await
    }

    pub async fn remove_imported_permission(
        &self,
        workspace: String,
        id: String,
    ) -> Result<bool, Error> {
        self.call(move |connection| remove(connection, &workspace, &id))
            .await
    }
}

pub(crate) fn imported(connection: &Connection, workspace: &str) -> Result<Vec<LegacyRule>, Error> {
    crate::permission_source::require_legacy(connection, workspace)?;
    crate::permission_patterns::require_workspace(workspace)?;
    let mut statement = connection.prepare(
                "SELECT legacy_id,rule,digest FROM engine_permission_import WHERE workspace=?1 AND removed_at_ms IS NULL ORDER BY legacy_id LIMIT 257",
            )?;
    let rows = statement.query_map([workspace], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (id, encoded, hash) = row?;
        let rule: Rule = serde_json::from_str(&encoded)
            .map_err(|_| Error::Invalid("corrupt imported permission".into()))?;
        crate::permission_patterns::require_rule(&rule)?;
        if digest(encoded.as_bytes()) != hash {
            return Err(Error::Invalid("corrupt imported permission digest".into()));
        }
        result.push(LegacyRule { id, rule });
    }
    if result.len() > crate::permission_rules::MAX_RULES {
        return Err(Error::Invalid("imported permission budget exceeded".into()));
    }
    Ok(result)
}

pub(crate) fn require_rules(project: &str, rules: &[LegacyRule]) -> Result<(), Error> {
    if project.is_empty()
        || project.len() > 512
        || project.chars().any(char::is_control)
        || rules.len() > crate::permission_rules::MAX_RULES
    {
        return Err(Error::Invalid("invalid legacy permission migration".into()));
    }
    for (index, item) in rules.iter().enumerate() {
        require_id(&item.id)?;
        if index > 0 && rules[index - 1].id >= item.id {
            return Err(Error::Invalid(
                "invalid legacy permission identity order".into(),
            ));
        }
        crate::permission_patterns::require_rule(&item.rule)?;
    }
    Ok(())
}

pub(crate) fn require_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.starts_with("psv_native_")
        || id.len() > 512
        || id.chars().any(char::is_control)
    {
        return Err(Error::Invalid("invalid legacy permission identity".into()));
    }
    Ok(())
}

pub(crate) fn receipt(connection: &Connection, workspace: &str) -> Result<Option<Receipt>, Error> {
    crate::permission_source::require_legacy(connection, workspace)?;
    crate::permission_patterns::require_workspace(workspace)?;
    Ok(connection.query_row(
        "SELECT project,fingerprint,imported FROM engine_permission_migration WHERE workspace=?1", [workspace],
        |row| Ok(Receipt { project: row.get(0)?, fingerprint: row.get(1)?, imported: row.get(2)? }),
    ).optional()?)
}

fn migrate(
    connection: &mut Connection,
    workspace: &str,
    project: &str,
    mut rules: Vec<LegacyRule>,
) -> Result<Receipt, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    if rules.len() > crate::permission_rules::MAX_RULES {
        return Err(Error::Invalid("invalid legacy permission migration".into()));
    }
    rules.sort_by(|left, right| left.id.cmp(&right.id));
    require_rules(project, &rules)?;
    let fingerprint = digest(&serde_json::to_vec(&(workspace, project, &rules))?);
    let transaction = crate::store::write_tx(connection)?;
    let before = receipt(&transaction, workspace)?;
    if let Some(before) = before {
        if before.project != project || before.fingerprint != fingerprint {
            return Err(Error::Invalid(
                "legacy permission migration already bound to different input".into(),
            ));
        }
        // The immutable receipt survives revocation. Replaying an old import
        // must never recreate a rule the user removed after the handoff.
        return Ok(before);
    }
    transaction.execute(
        "DELETE FROM engine_permission_rule_legacy WHERE workspace=?1",
        [workspace],
    )?;
    let now = crate::approval::now_ms();
    for item in &rules {
        let encoded = serde_json::to_string(&item.rule)?;
        transaction.execute(
            "INSERT OR IGNORE INTO engine_permission_rule_legacy(workspace,digest,rule,created_at_ms) VALUES(?1,?2,?3,?4)",
            params![workspace, digest(encoded.as_bytes()), encoded, now],
        )?;
    }
    let receipt = Receipt {
        project: project.into(),
        fingerprint,
        imported: rules.len(),
    };
    transaction.execute(
        "INSERT INTO engine_permission_migration(workspace,project,fingerprint,imported,migrated_at_ms) VALUES(?1,?2,?3,?4,?5)",
        params![workspace, project, receipt.fingerprint, receipt.imported, now],
    )?;
    for item in &rules {
        let encoded = serde_json::to_string(&item.rule)?;
        transaction.execute(
            "INSERT INTO engine_permission_import(workspace,legacy_id,digest,rule) VALUES(?1,?2,?3,?4)",
            params![workspace, item.id, digest(encoded.as_bytes()), encoded],
        )?;
    }
    crate::permission_import_changes::append(
        &transaction,
        workspace,
        &crate::permission_import_changes::Change::Migrated {
            receipt: receipt.clone(),
            rules,
        },
    )?;
    transaction.commit()?;
    Ok(receipt)
}

fn remove(connection: &mut Connection, workspace: &str, id: &str) -> Result<bool, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    let transaction = crate::store::write_tx(connection)?;
    let stored: Option<(String, String)> = transaction.query_row(
        "SELECT digest,rule FROM engine_permission_import WHERE workspace=?1 AND legacy_id=?2 AND removed_at_ms IS NULL",
        params![workspace, id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((rule, encoded)) = stored else {
        return Ok(false);
    };
    let decoded: Rule = serde_json::from_str(&encoded)
        .map_err(|_| Error::Invalid("corrupt imported permission".into()))?;
    crate::permission_patterns::require_rule(&decoded)?;
    if digest(encoded.as_bytes()) != rule {
        return Err(Error::Invalid("corrupt imported permission digest".into()));
    }
    transaction.execute(
        "UPDATE engine_permission_import SET removed_at_ms=?3 WHERE workspace=?1 AND legacy_id=?2",
        params![workspace, id, crate::approval::now_ms()],
    )?;
    transaction.execute(
        "DELETE FROM engine_permission_rule_legacy WHERE workspace=?1 AND digest=?2
         AND NOT EXISTS(SELECT 1 FROM engine_permission_import WHERE workspace=?1 AND digest=?2 AND removed_at_ms IS NULL)",
        params![workspace, rule],
    )?;
    crate::permission_import_changes::append(
        &transaction,
        workspace,
        &crate::permission_import_changes::Change::Removed {
            id: id.into(),
            fingerprint: receipt(&transaction, workspace)?
                .ok_or_else(|| {
                    Error::Invalid("imported permission has no migration receipt".into())
                })?
                .fingerprint,
        },
    )?;
    transaction.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::Decision;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::permission_saved::initialize(&connection).unwrap();
        crate::permission_patterns::initialize(&connection).unwrap();
        initialize(&connection).unwrap();
        connection
    }
    fn rule(id: &str, resource: &str) -> LegacyRule {
        LegacyRule {
            id: id.into(),
            rule: Rule {
                action: "read".into(),
                resource: resource.into(),
                effect: Decision::Allow,
            },
        }
    }

    #[test]
    fn import_receipts_are_order_independent_and_revocation_cannot_be_replayed_away() {
        let mut connection = connection();
        let rules = vec![rule("psv_a", "a"), rule("legacy-row-b", "b")];
        let receipt = migrate(&mut connection, "/repo", "project", rules.clone()).unwrap();
        assert!(remove(&mut connection, "/repo", "psv_a").unwrap());
        assert!(!remove(&mut connection, "/repo", "psv_a").unwrap());
        assert_eq!(
            migrate(
                &mut connection,
                "/repo",
                "project",
                rules.into_iter().rev().collect()
            )
            .unwrap(),
            receipt
        );
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo").unwrap(),
            vec![rule("psv_b", "b").rule]
        );
        assert!(migrate(&mut connection, "/repo", "other", vec![]).is_err());
    }

    #[test]
    fn ownership_rejects_old_append_and_snapshot_deletion_without_losing_native_rules() {
        let mut connection = connection();
        let same = rule("psv_a", "a");
        let transaction = crate::store::write_tx(&mut connection).unwrap();
        let native = crate::permission_patterns::put_in(&transaction, "/repo", &same.rule).unwrap();
        transaction.commit().unwrap();
        migrate(&mut connection, "/repo", "project", vec![same.clone()]).unwrap();
        assert!(crate::permission_saved::project(&mut connection, "/repo", &[same.rule]).is_err());
        assert!(connection
            .execute(
                "DELETE FROM engine_permission_rule_legacy WHERE workspace='/repo'",
                []
            )
            .is_err());
        assert!(remove(&mut connection, "/repo", "psv_a").unwrap());
        assert_eq!(
            crate::permission_patterns::records(&connection, "/repo").unwrap(),
            vec![native]
        );
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn duplicate_content_keeps_each_legacy_identity_and_workspaces_isolate_tombstones() {
        let mut connection = connection();
        let rules = vec![rule("psv_a", "a"), rule("psv_b", "a")];
        for workspace in ["/repo", "/other"] {
            migrate(&mut connection, workspace, "project", rules.clone()).unwrap();
        }
        assert!(!remove(&mut connection, "/foreign", "psv_a").unwrap());
        remove(&mut connection, "/repo", "psv_a").unwrap();
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            1
        );
        remove(&mut connection, "/repo", "psv_b").unwrap();
        assert!(crate::permission_saved::rules(&connection, "/repo")
            .unwrap()
            .is_empty());
        assert_eq!(
            crate::permission_saved::rules(&connection, "/other")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn budget_failure_rolls_back_old_projection_and_handoff_receipt() {
        let mut connection = connection();
        let old = rule("psv_old", "old").rule;
        crate::permission_saved::project(&mut connection, "/repo", std::slice::from_ref(&old))
            .unwrap();
        // Arrange a full valid store in one transaction; this test exercises
        // migration rollback, while pattern insertion has its own boundary suite.
        let transaction = crate::store::write_tx(&mut connection).unwrap();
        for index in 0..255 {
            let rule = rule("psv_native", &format!("native-{index}")).rule;
            transaction.execute(
                "INSERT INTO engine_owned_permission_rule_legacy(workspace,digest,rule,created_at_ms) VALUES(?1,?2,?3,0)",
                params!["/repo", crate::permission_patterns::rule_digest("/repo", &rule).unwrap(), serde_json::to_string(&rule).unwrap()],
            ).unwrap();
        }
        transaction.commit().unwrap();
        assert!(migrate(
            &mut connection,
            "/repo",
            "project",
            vec![rule("psv_a", "a"), rule("psv_b", "b")]
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM engine_permission_migration",
                    [],
                    |row| row.get::<_, usize>(0)
                )
                .unwrap(),
            0
        );
        assert!(crate::permission_saved::rules(&connection, "/repo")
            .unwrap()
            .contains(&old));
    }

    #[test]
    fn invalid_identity_effect_and_conflicting_retry_leave_state_unchanged() {
        let mut connection = connection();
        for rules in [
            vec![rule("psv_native_mirror", "a")],
            vec![rule("psv_a", "a"), rule("psv_a", "b")],
            vec![LegacyRule {
                id: "psv_a".into(),
                rule: Rule {
                    effect: Decision::Deny,
                    ..rule("psv_a", "a").rule
                },
            }],
        ] {
            assert!(migrate(&mut connection, "/repo", "project", rules).is_err());
        }
        migrate(&mut connection, "/repo", "project", vec![]).unwrap();
        assert!(migrate(
            &mut connection,
            "/repo",
            "project",
            vec![rule("psv_a", "a")]
        )
        .is_err());
        assert!(crate::permission_saved::rules(&connection, "/repo")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn failed_receipt_write_rolls_back_replacement_and_failed_revoke_restores_tombstone() {
        let mut connection = connection();
        let old = rule("psv_old", "old").rule;
        crate::permission_saved::project(&mut connection, "/repo", std::slice::from_ref(&old))
            .unwrap();
        connection.execute_batch("CREATE TRIGGER fail_handoff BEFORE INSERT ON engine_permission_migration BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;").unwrap();
        assert!(migrate(
            &mut connection,
            "/repo",
            "project",
            vec![rule("psv_a", "a")]
        )
        .is_err());
        assert!(receipt(&connection, "/repo").unwrap().is_none());
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo").unwrap(),
            vec![old]
        );
        connection
            .execute_batch("DROP TRIGGER fail_handoff")
            .unwrap();
        migrate(
            &mut connection,
            "/repo",
            "project",
            vec![rule("psv_a", "a")],
        )
        .unwrap();
        connection.execute_batch("CREATE TRIGGER fail_revoke BEFORE DELETE ON engine_permission_rule_legacy BEGIN SELECT RAISE(ABORT, 'injected revoke failure'); END;").unwrap();
        assert!(remove(&mut connection, "/repo", "psv_a").is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM engine_permission_import WHERE removed_at_ms IS NULL",
                    [],
                    |row| row.get::<_, usize>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn empty_handoff_removes_stale_projection_and_permanently_closes_legacy_writes() {
        let mut connection = connection();
        crate::permission_saved::project(&mut connection, "/repo", &[rule("psv_old", "old").rule])
            .unwrap();
        let before = migrate(&mut connection, "/repo", "project", vec![]).unwrap();
        assert_eq!(before.imported, 0);
        assert!(crate::permission_saved::rules(&connection, "/repo")
            .unwrap()
            .is_empty());
        assert!(crate::permission_saved::project(
            &mut connection,
            "/repo",
            &[rule("psv_old", "old").rule]
        )
        .is_err());
        assert_eq!(
            migrate(&mut connection, "/repo", "project", vec![]).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn receipts_and_tombstones_survive_store_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let filename = directory.path().join("engine.db");
        let store = Store::open(&filename).await.unwrap();
        let rules = vec![rule("psv_a", "a")];
        assert!(store
            .legacy_permission_migration("/repo".into())
            .await
            .unwrap()
            .is_none());
        let receipt = store
            .migrate_legacy_permissions("/repo".into(), "project".into(), rules.clone())
            .await
            .unwrap();
        assert_eq!(
            store
                .imported_permissions("/repo".into())
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .remove_imported_permission("/repo".into(), "psv_a".into())
            .await
            .unwrap());
        drop(store);
        // The previous store's in-process path lease is released when its
        // worker thread finishes dropping it, which races a fast reopen on a
        // loaded runner. Retry briefly instead of failing on the window.
        let reopened = loop {
            match Store::open(&filename).await {
                Ok(store) => break store,
                Err(Error::Busy) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                Err(error) => panic!("store reopen failed: {error}"),
            }
        };
        assert_eq!(
            reopened
                .legacy_permission_migration("/repo".into())
                .await
                .unwrap(),
            Some(receipt.clone())
        );
        assert!(reopened
            .imported_permissions("/repo".into())
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            reopened
                .migrate_legacy_permissions("/repo".into(), "project".into(), rules)
                .await
                .unwrap(),
            receipt
        );
        assert!(reopened
            .saved_rules("/repo".into())
            .await
            .unwrap()
            .is_empty());
    }
}
