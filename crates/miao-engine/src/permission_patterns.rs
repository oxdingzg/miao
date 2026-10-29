//! Native-owned standing allow patterns. Kept separate from the host's saved
//! rule projection so refreshing that projection cannot delete native policy.
use crate::{
    permission::{digest, Decision},
    permission_rules::{Request, Rule, MAX_RULES},
    protocol::Error,
    store::Store,
};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;

const ID_PREFIX: &str = "prule_";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pattern {
    pub id: String,
    pub workspace: String,
    pub rule: Rule,
    pub source: Origin,
    pub created_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Put {
    pub rule: Rule,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remove {
    pub rule_id: String,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS engine_owned_permission_rule_legacy(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );
         CREATE TRIGGER IF NOT EXISTS engine_projected_permission_budget
         BEFORE INSERT ON engine_permission_rule_legacy
         WHEN NOT EXISTS(SELECT 1 FROM engine_permission_rule_legacy WHERE workspace=NEW.workspace AND digest=NEW.digest)
         AND (SELECT COUNT(*) FROM engine_permission_rule_legacy WHERE workspace=NEW.workspace)
             +(SELECT COUNT(*) FROM engine_owned_permission_rule_legacy WHERE workspace=NEW.workspace)>={MAX_RULES}
         BEGIN SELECT RAISE(ABORT, 'saved permission rule budget exceeded'); END;
         CREATE TRIGGER IF NOT EXISTS engine_owned_permission_budget
         BEFORE INSERT ON engine_owned_permission_rule_legacy
         WHEN NOT EXISTS(SELECT 1 FROM engine_owned_permission_rule_legacy WHERE workspace=NEW.workspace AND digest=NEW.digest)
         AND (SELECT COUNT(*) FROM engine_permission_rule_legacy WHERE workspace=NEW.workspace)
             +(SELECT COUNT(*) FROM engine_owned_permission_rule_legacy WHERE workspace=NEW.workspace)>={MAX_RULES}
         BEGIN SELECT RAISE(ABORT, 'saved permission rule budget exceeded'); END;"
    ))?;
    crate::permission_pattern_changes::initialize(connection)?;
    Ok(())
}

impl Store {
    pub async fn permission_patterns(&self, workspace: String) -> Result<Vec<Pattern>, Error> {
        self.call(move |connection| records(connection, &workspace))
            .await
    }

    pub async fn put_permission_pattern(
        &self,
        workspace: String,
        rule: Rule,
    ) -> Result<Pattern, Error> {
        self.call(move |connection| put(connection, &workspace, &rule))
            .await
    }

    pub async fn remove_permission_pattern(
        &self,
        workspace: String,
        id: String,
    ) -> Result<bool, Error> {
        self.call(move |connection| remove(connection, &workspace, &id))
            .await
    }
}

pub(crate) fn rules(connection: &Connection, workspace: &str) -> Result<Vec<Rule>, Error> {
    Ok(records(connection, workspace)?
        .into_iter()
        .map(|record| record.rule)
        .collect())
}

pub(crate) fn records(connection: &Connection, workspace: &str) -> Result<Vec<Pattern>, Error> {
    crate::permission_source::require_legacy(connection, workspace)?;
    raw_records(connection, workspace)
}

pub(crate) fn raw_records(connection: &Connection, workspace: &str) -> Result<Vec<Pattern>, Error> {
    require_workspace(workspace)?;
    // Older compatible databases may be opened read-only by a catalog. Missing
    // optional native patterns mean no additional allow, never an implicit grant.
    let Some(table) =
        crate::permission_legacy::read_table(connection, crate::permission_legacy::Table::Native)?
    else {
        return Ok(Vec::new());
    };
    let mut statement = connection.prepare(
        &format!("SELECT digest,rule,created_at_ms FROM {table} WHERE workspace=?1 ORDER BY created_at_ms,digest LIMIT ?2"),
    )?;
    let rows = statement.query_map(params![workspace, MAX_RULES + 1], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
        ))
    })?;
    let records = rows
        .map(|row| {
            let (id, encoded, created_at_ms) = row?;
            let rule: Rule = serde_json::from_str(&encoded)
                .map_err(|_| Error::Invalid("corrupt native permission pattern".into()))?;
            require_rule(&rule)?;
            if id != rule_digest(workspace, &rule)? {
                return Err(Error::Invalid(
                    "native permission pattern scope mismatch".into(),
                ));
            }
            Ok(Pattern {
                id: format!("{ID_PREFIX}{id}"),
                workspace: workspace.into(),
                rule,
                source: Origin::Native,
                created_at_ms,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    if records.len() > MAX_RULES {
        return Err(Error::Invalid(
            "native permission pattern budget exceeded".into(),
        ));
    }
    Ok(records)
}

fn put(connection: &mut Connection, workspace: &str, rule: &Rule) -> Result<Pattern, Error> {
    let transaction = crate::store::write_tx(connection)?;
    let record = put_in(&transaction, workspace, rule)?;
    transaction.commit()?;
    Ok(record)
}

pub(crate) fn put_in(
    transaction: &Transaction<'_>,
    workspace: &str,
    rule: &Rule,
) -> Result<Pattern, Error> {
    crate::permission_source::require_legacy(transaction, workspace)?;
    require_workspace(workspace)?;
    require_rule(rule)?;
    let id = rule_digest(workspace, rule)?;
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO engine_owned_permission_rule_legacy(workspace,digest,rule,created_at_ms) VALUES(?1,?2,?3,?4)",
        params![workspace, id, serde_json::to_string(rule)?, crate::approval::now_ms()],
    )?;
    // Validate the complete saved rule set before committing the new row. A
    // budget failure must not leave behind policy that cannot be evaluated.
    crate::permission_rules::evaluate(&Request {
        configured: Some(Vec::new()),
        saved: Some(crate::permission_saved::rules(transaction, workspace)?),
        ..Request::default()
    })?;
    let record = records(transaction, workspace)?
        .into_iter()
        .find(|record| record.id == format!("{ID_PREFIX}{id}"))
        .ok_or_else(|| Error::Invalid("native permission pattern was not stored".into()))?;
    if inserted != 0 {
        crate::permission_pattern_changes::append(
            transaction,
            workspace,
            &crate::permission_pattern_changes::Change::Upsert {
                pattern: record.clone(),
            },
        )?;
    }
    Ok(record)
}

fn remove(connection: &mut Connection, workspace: &str, id: &str) -> Result<bool, Error> {
    require_workspace(workspace)?;
    let id = id
        .strip_prefix(ID_PREFIX)
        .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| Error::Invalid("invalid native permission pattern id".into()))?;
    let transaction = crate::store::write_tx(connection)?;
    crate::permission_source::require_legacy(&transaction, workspace)?;
    let removed = transaction.execute(
        "DELETE FROM engine_owned_permission_rule_legacy WHERE workspace=?1 AND digest=?2",
        params![workspace, id],
    )? != 0;
    if removed {
        crate::permission_pattern_changes::append(
            &transaction,
            workspace,
            &crate::permission_pattern_changes::Change::Remove {
                id: format!("{ID_PREFIX}{id}"),
            },
        )?;
    }
    transaction.commit()?;
    Ok(removed)
}

pub(crate) fn require_workspace(workspace: &str) -> Result<(), Error> {
    if workspace.is_empty() || workspace.len() > 8192 || workspace.contains('\0') {
        return Err(Error::Invalid("invalid native permission workspace".into()));
    }
    Ok(())
}

pub(crate) fn require_rule(rule: &Rule) -> Result<(), Error> {
    if rule.effect != Decision::Allow {
        return Err(Error::Invalid("native saved patterns must allow".into()));
    }
    if !crate::permission_rules::bounded_rule(rule) {
        return Err(Error::Invalid(
            "native permission pattern exceeds wire bounds".into(),
        ));
    }
    Ok(())
}

pub(crate) fn rule_digest(workspace: &str, rule: &Rule) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(
        &json!({"semantics":"native-permission-pattern-v1","workspace":workspace,"rule":rule}),
    )?))
}

#[cfg(test)]
mod tests {
    use super::{initialize, put, records, remove, Origin};
    use crate::{permission::Decision, permission_rules::Rule};
    use rusqlite::{params, Connection};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::permission_saved::initialize(&connection).unwrap();
        initialize(&connection).unwrap();
        connection
    }

    fn rule(resource: &str) -> Rule {
        Rule {
            action: "read".into(),
            resource: resource.into(),
            effect: Decision::Allow,
        }
    }

    #[test]
    fn content_retries_preserve_identity_timestamp_and_native_provenance() {
        let mut connection = connection();
        put(&mut connection, "/repo", &rule("*.rs")).unwrap();
        // Use a historical timestamp so even two operations in the same clock
        // tick prove that replay cannot overwrite existing metadata.
        connection
            .execute(
                "UPDATE engine_owned_permission_rule_legacy SET created_at_ms=1",
                [],
            )
            .unwrap();
        let first = records(&connection, "/repo").unwrap().pop().unwrap();
        assert_eq!(first, put(&mut connection, "/repo", &rule("*.rs")).unwrap());
        assert_eq!(first.source, Origin::Native);
        assert_eq!(first.workspace, "/repo");
        assert_eq!(records(&connection, "/repo").unwrap(), vec![first]);
    }

    #[test]
    fn rule_ids_and_removal_are_bound_to_the_workspace() {
        let mut connection = connection();
        let first = put(&mut connection, "/first", &rule("*")).unwrap();
        let other = put(&mut connection, "/other", &rule("*")).unwrap();
        assert_ne!(first.id, other.id);
        assert!(!remove(&mut connection, "/other", &first.id).unwrap());
        assert_eq!(records(&connection, "/other").unwrap(), vec![other]);
        assert!(remove(&mut connection, "/first", &first.id).unwrap());
        assert!(!remove(&mut connection, "/first", &first.id).unwrap());
    }

    #[test]
    fn projection_and_native_rule_removal_do_not_modify_each_other() {
        let mut connection = connection();
        crate::permission_saved::project(&mut connection, "/repo", &[rule("legacy")]).unwrap();
        let native = put(&mut connection, "/repo", &rule("native")).unwrap();
        crate::permission_saved::project(&mut connection, "/repo", &[rule("legacy")]).unwrap();
        assert_eq!(records(&connection, "/repo").unwrap(), vec![native.clone()]);
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            2
        );
        assert!(remove(&mut connection, "/repo", &native.id).unwrap());
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo").unwrap(),
            vec![rule("legacy")]
        );
    }

    #[test]
    fn persisted_native_rules_survive_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rules.db");
        let first = {
            let mut connection = Connection::open(&path).unwrap();
            crate::permission_saved::initialize(&connection).unwrap();
            initialize(&connection).unwrap();
            put(&mut connection, "/repo", &rule("file")).unwrap()
        };
        let connection =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(records(&connection, "/repo").unwrap(), vec![first]);
    }

    #[test]
    fn a_compatible_database_without_native_patterns_retains_only_its_projection() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::permission_saved::initialize(&connection).unwrap();
        crate::permission_saved::project(&mut connection, "/repo", &[rule("legacy")]).unwrap();
        assert!(records(&connection, "/repo").unwrap().is_empty());
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo").unwrap(),
            vec![rule("legacy")]
        );
    }

    #[test]
    fn invalid_patterns_and_unusable_combined_budgets_never_commit() {
        let mut connection = connection();
        for effect in [Decision::Ask, Decision::Deny] {
            assert!(put(
                &mut connection,
                "/repo",
                &Rule {
                    effect,
                    ..rule("*")
                }
            )
            .is_err());
        }
        assert!(put(&mut connection, "", &rule("*")).is_err());
        assert!(put(&mut connection, "/repo", &rule(&"x".repeat(4097))).is_err());
        assert!(put(&mut connection, "/repo", &rule("a\0b")).is_err());
        assert!(remove(&mut connection, "/repo", "foreign-id").is_err());
        assert!(records(&connection, "/repo").unwrap().is_empty());
        let projected = (0..255)
            .map(|index| rule(&format!("legacy-{index}")))
            .collect::<Vec<_>>();
        crate::permission_saved::project(&mut connection, "/repo", &projected).unwrap();
        let first = put(&mut connection, "/repo", &rule("native-first")).unwrap();
        assert!(put(&mut connection, "/repo", &rule("native-over-budget")).is_err());
        assert_eq!(records(&connection, "/repo").unwrap(), vec![first]);
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            256
        );
    }

    #[test]
    fn native_projection_replays_do_not_overfill_the_shared_saved_rule_budget() {
        let mut connection = connection();
        let native = put(&mut connection, "/repo", &rule("native")).unwrap();
        let projected = (0..255)
            .map(|index| rule(&format!("legacy-{index}")))
            .collect::<Vec<_>>();
        crate::permission_saved::project(&mut connection, "/repo", &projected).unwrap();
        crate::permission_saved::project(&mut connection, "/repo", &projected).unwrap();
        assert!(
            crate::permission_saved::project(&mut connection, "/repo", &[rule("over-budget")])
                .is_err()
        );
        assert_eq!(
            crate::permission_saved::rules(&connection, "/repo")
                .unwrap()
                .len(),
            256
        );
        assert_eq!(records(&connection, "/repo").unwrap(), vec![native]);
    }

    #[test]
    fn corrupt_effects_and_moved_scope_rows_fail_closed() {
        let mut connection = connection();
        let first = put(&mut connection, "/repo", &rule("*")).unwrap();
        connection
            .execute(
                "UPDATE engine_owned_permission_rule_legacy SET rule=?1",
                [serde_json::to_string(&Rule {
                    effect: Decision::Deny,
                    ..rule("*")
                })
                .unwrap()],
            )
            .unwrap();
        assert!(records(&connection, "/repo").is_err());
        connection.execute("UPDATE engine_owned_permission_rule_legacy SET rule=?1,workspace='/other' WHERE digest=?2", params![serde_json::to_string(&rule("*")).unwrap(), first.id.strip_prefix("prule_").unwrap()]).unwrap();
        assert!(records(&connection, "/other").is_err());
    }
    #[test]
    fn durable_change_pages_are_scoped_ordered_and_content_retries_are_silent() {
        use crate::permission_pattern_changes::{changes, Change, Input};
        let mut connection = connection();
        let first = put(&mut connection, "/first", &rule("one")).unwrap();
        put(&mut connection, "/other", &rule("other")).unwrap();
        assert_eq!(put(&mut connection, "/first", &rule("one")).unwrap(), first);
        let second = put(&mut connection, "/first", &rule("two")).unwrap();
        assert!(remove(&mut connection, "/first", &first.id).unwrap());
        assert!(!remove(&mut connection, "/first", &first.id).unwrap());
        assert!(!remove(&mut connection, "/other", &second.id).unwrap());
        let page = changes(&connection, "/first", Input { after: 0, limit: 2 }).unwrap();
        assert_eq!(page.changes.len(), 2);
        assert!(page.has_more);
        assert_eq!(
            page.changes[0].change,
            Change::Upsert {
                pattern: first.clone()
            }
        );
        assert_eq!(page.changes[1].change, Change::Upsert { pattern: second });
        assert!(page.changes[1].seq > page.changes[0].seq + 1);
        let tail = changes(
            &connection,
            "/first",
            Input {
                after: page.cursor,
                limit: 2,
            },
        )
        .unwrap();
        assert!(!tail.has_more);
        assert_eq!(tail.changes.len(), 1);
        assert_eq!(tail.changes[0].change, Change::Remove { id: first.id });
        let empty = changes(
            &connection,
            "/first",
            Input {
                after: tail.cursor,
                limit: 2,
            },
        )
        .unwrap();
        assert!(empty.changes.is_empty());
        assert_eq!(empty.cursor, tail.cursor);
        assert_eq!(
            changes(
                &connection,
                "/other",
                Input {
                    after: 0,
                    limit: 256
                }
            )
            .unwrap()
            .changes
            .len(),
            1
        );
    }

    #[test]
    fn change_receipt_failures_roll_back_put_and_revoke() {
        use crate::permission_pattern_changes::{changes, Input};
        let mut connection = connection();
        let first = put(&mut connection, "/repo", &rule("one")).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_permission_change BEFORE INSERT ON engine_permission_pattern_change BEGIN SELECT RAISE(ABORT,'receipt fault'); END;").unwrap();
        assert!(put(&mut connection, "/repo", &rule("two")).is_err());
        assert!(remove(&mut connection, "/repo", &first.id).is_err());
        assert_eq!(records(&connection, "/repo").unwrap(), vec![first]);
        assert_eq!(
            changes(
                &connection,
                "/repo",
                Input {
                    after: 0,
                    limit: 256
                }
            )
            .unwrap()
            .changes
            .len(),
            1
        );
    }

    #[test]
    fn atomic_snapshot_bootstraps_pre_journal_rules_and_replays_later_removal() {
        use crate::permission_pattern_changes::{changes, snapshot, Change, Input};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("changes.db");
        let initial = {
            let mut connection = Connection::open(&path).unwrap();
            crate::permission_saved::initialize(&connection).unwrap();
            initialize(&connection).unwrap();
            let first = put(&mut connection, "/repo", &rule("one")).unwrap();
            connection
                .execute("DELETE FROM engine_permission_pattern_change", [])
                .unwrap();
            let initial = snapshot(&mut connection, "/repo").unwrap();
            assert_eq!(initial.cursor, 0);
            assert_eq!(initial.patterns, vec![first.clone()]);
            assert!(remove(&mut connection, "/repo", &first.id).unwrap());
            initial
        };
        let mut connection = Connection::open(&path).unwrap();
        initialize(&connection).unwrap();
        let page = changes(
            &connection,
            "/repo",
            Input {
                after: initial.cursor,
                limit: 256,
            },
        )
        .unwrap();
        assert_eq!(page.changes.len(), 1);
        assert_eq!(
            page.changes[0].change,
            Change::Remove {
                id: initial.patterns[0].id.clone()
            }
        );
        assert!(snapshot(&mut connection, "/repo")
            .unwrap()
            .patterns
            .is_empty());
    }

    #[test]
    fn change_cursor_bounds_and_corrupt_receipts_fail_without_a_partial_projection() {
        use crate::permission_pattern_changes::{changes, Input};
        let mut connection = connection();
        put(&mut connection, "/repo", &rule("one")).unwrap();
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
            assert!(changes(&connection, "/repo", input).is_err());
        }
        assert!(changes(&connection, "", Input { after: 0, limit: 1 }).is_err());
        connection
            .execute(
                "UPDATE engine_permission_pattern_change SET change='{}'",
                [],
            )
            .unwrap();
        assert!(changes(&connection, "/repo", Input { after: 0, limit: 1 }).is_err());
    }
    #[test]
    fn a_later_receipt_failure_rolls_back_every_pattern_in_the_outer_transaction() {
        use crate::permission_pattern_changes::{changes, Input};
        let mut connection = connection();
        connection.execute_batch("CREATE TRIGGER fail_second_receipt BEFORE INSERT ON engine_permission_pattern_change WHEN json_extract(NEW.change,'$.pattern.rule.resource')='two' BEGIN SELECT RAISE(ABORT,'second receipt fault'); END;").unwrap();
        {
            let transaction = crate::store::write_tx(&mut connection).unwrap();
            super::put_in(&transaction, "/repo", &rule("one")).unwrap();
            assert!(super::put_in(&transaction, "/repo", &rule("two")).is_err());
        }
        assert!(records(&connection, "/repo").unwrap().is_empty());
        assert!(changes(
            &connection,
            "/repo",
            Input {
                after: 0,
                limit: 256
            }
        )
        .unwrap()
        .changes
        .is_empty());
    }
}
