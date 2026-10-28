//! Native-owned standing allow patterns. Kept separate from the host's saved
//! rule projection so refreshing that projection cannot delete native policy.
use crate::{
    permission::{digest, Decision},
    permission_rules::{Request, Rule},
    protocol::Error,
    store::Store,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_RULES: usize = 256;
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
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_owned_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );",
    )?;
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

fn records(connection: &Connection, workspace: &str) -> Result<Vec<Pattern>, Error> {
    require_workspace(workspace)?;
    // Older compatible databases may be opened read-only by a catalog. Missing
    // optional native patterns mean no additional allow, never an implicit grant.
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_owned_permission_rule')",
        [], |row| row.get(0),
    )?;
    if !present {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT digest,rule,created_at_ms FROM engine_owned_permission_rule WHERE workspace=?1 ORDER BY created_at_ms,digest LIMIT 257",
    )?;
    let rows = statement.query_map([workspace], |row| {
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
    require_workspace(workspace)?;
    require_rule(rule)?;
    let id = rule_digest(workspace, rule)?;
    let transaction = crate::store::write_tx(connection)?;
    transaction.execute(
        "INSERT OR IGNORE INTO engine_owned_permission_rule(workspace,digest,rule,created_at_ms) VALUES(?1,?2,?3,?4)",
        params![workspace, id, serde_json::to_string(rule)?, crate::approval::now_ms()],
    )?;
    // Validate the complete saved rule set before committing the new row. A
    // budget failure must not leave behind policy that cannot be evaluated.
    crate::permission_rules::evaluate(&Request {
        configured: Some(Vec::new()),
        saved: Some(crate::permission_saved::rules(&transaction, workspace)?),
        ..Request::default()
    })?;
    let record = records(&transaction, workspace)?
        .into_iter()
        .find(|record| record.id == format!("{ID_PREFIX}{id}"))
        .ok_or_else(|| Error::Invalid("native permission pattern was not stored".into()))?;
    transaction.commit()?;
    Ok(record)
}

fn remove(connection: &mut Connection, workspace: &str, id: &str) -> Result<bool, Error> {
    require_workspace(workspace)?;
    let id = id
        .strip_prefix(ID_PREFIX)
        .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| Error::Invalid("invalid native permission pattern id".into()))?;
    let transaction = crate::store::write_tx(connection)?;
    let removed = transaction.execute(
        "DELETE FROM engine_owned_permission_rule WHERE workspace=?1 AND digest=?2",
        params![workspace, id],
    )? != 0;
    transaction.commit()?;
    Ok(removed)
}

fn require_workspace(workspace: &str) -> Result<(), Error> {
    if workspace.is_empty() || workspace.len() > 8192 || workspace.contains('\0') {
        return Err(Error::Invalid("invalid native permission workspace".into()));
    }
    Ok(())
}

fn require_rule(rule: &Rule) -> Result<(), Error> {
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

fn rule_digest(workspace: &str, rule: &Rule) -> Result<String, Error> {
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
                "UPDATE engine_owned_permission_rule SET created_at_ms=1",
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
    fn corrupt_effects_and_moved_scope_rows_fail_closed() {
        let mut connection = connection();
        let first = put(&mut connection, "/repo", &rule("*")).unwrap();
        connection
            .execute(
                "UPDATE engine_owned_permission_rule SET rule=?1",
                [serde_json::to_string(&Rule {
                    effect: Decision::Deny,
                    ..rule("*")
                })
                .unwrap()],
            )
            .unwrap();
        assert!(records(&connection, "/repo").is_err());
        connection.execute("UPDATE engine_owned_permission_rule SET rule=?1,workspace='/other' WHERE digest=?2", params![serde_json::to_string(&rule("*")).unwrap(), first.id.strip_prefix("prule_").unwrap()]).unwrap();
        assert!(records(&connection, "/other").is_err());
    }
}
