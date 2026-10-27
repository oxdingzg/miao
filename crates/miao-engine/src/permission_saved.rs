//! Projected saved permission rules (S6 step 2).
//!
//! The product's `permission` table is the historical authority for project
//! "always allow" rules; the engine never saw them, so a native Session asked
//! again for something the user had already allowed. These rows are that
//! table's idempotent projection into the engine store, keyed by workspace so
//! two projects never see each other's rules. Storage only: evaluation stays
//! in [`crate::permission_rules`], whose golden corpus pins the semantics, and
//! the runtime consults the projection only where the ordered policy asked.

use crate::permission::digest;
use crate::permission_rules::Rule;
use crate::protocol::Error;
use rusqlite::{params, Connection};

const MAX_RULES: usize = 256;
const MAX_WORKSPACE_BYTES: usize = 8192;

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );",
    )?;
    Ok(())
}

fn rule_digest(rule: &Rule) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(rule)?))
}

fn bounded(workspace: &str) -> bool {
    !workspace.is_empty() && workspace.len() <= MAX_WORKSPACE_BYTES
}

/// Project the host's saved rules for one workspace. Idempotent by the rule's
/// content digest: replaying the import never duplicates a row.
pub(crate) fn project(connection: &mut Connection, workspace: &str, rules: &[Rule]) -> Result<(), Error> {
    if !bounded(workspace) || rules.len() > MAX_RULES {
        return Err(Error::Invalid("invalid saved permission projection".into()));
    }
    let tx = crate::store::write_tx(connection)?;
    let now = crate::approval::now_ms();
    for rule in rules {
        tx.execute(
            "INSERT OR IGNORE INTO engine_permission_rule(workspace,digest,rule,created_at_ms) VALUES(?1,?2,?3,?4)",
            params![workspace, rule_digest(rule)?, serde_json::to_string(rule)?, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The workspace's projected rules, in projection order.
pub(crate) fn rules(connection: &Connection, workspace: &str) -> Result<Vec<Rule>, Error> {
    if !bounded(workspace) {
        return Err(Error::Invalid("invalid saved permission workspace".into()));
    }
    let mut statement = connection
        .prepare("SELECT rule FROM engine_permission_rule WHERE workspace = ?1 ORDER BY created_at_ms, digest")?;
    let rows = statement.query_map(params![workspace], |row| row.get::<_, String>(0))?;
    let mut rules = Vec::new();
    for row in rows {
        let text = row?;
        rules.push(
            serde_json::from_str(&text)
                .map_err(|_| Error::Invalid("corrupt saved permission rule".into()))?,
        );
    }
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::Decision;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection
    }

    fn rule(action: &str, resource: &str) -> Rule {
        Rule {
            action: action.into(),
            resource: resource.into(),
            effect: Decision::Allow,
        }
    }

    #[test]
    fn projecting_the_same_rules_twice_stores_each_once() {
        let mut connection = connection();
        project(&mut connection, "/repo", &[rule("bash", "git *")]).unwrap();
        project(&mut connection, "/repo", &[rule("bash", "git *")]).unwrap();
        assert_eq!(rules(&connection, "/repo").unwrap().len(), 1);
    }

    #[test]
    fn workspaces_never_see_each_others_rules() {
        let mut connection = connection();
        project(&mut connection, "/repo-a", &[rule("bash", "git *")]).unwrap();
        project(&mut connection, "/repo-b", &[rule("edit", "**")]).unwrap();
        assert_eq!(rules(&connection, "/repo-a").unwrap().len(), 1);
        assert_eq!(rules(&connection, "/repo-b").unwrap().len(), 1);
        assert!(rules(&connection, "/repo-c").unwrap().is_empty());
    }

    #[test]
    fn an_empty_or_oversized_workspace_is_refused() {
        let mut connection = connection();
        assert!(project(&mut connection, "", &[rule("bash", "*")]).is_err());
        assert!(project(&mut connection, &"x".repeat(MAX_WORKSPACE_BYTES + 1), &[]).is_err());
        assert!(rules(&connection, "").is_err());
    }

    #[test]
    fn the_projection_survives_a_reopen() {
        let path = std::env::temp_dir().join(format!("miao-saved-{}-{}.db", std::process::id(), rule_digest(&rule("bash", "*")).unwrap()));
        let _ = std::fs::remove_file(&path);
        {
            let mut connection = Connection::open(&path).unwrap();
            initialize(&connection).unwrap();
            project(&mut connection, "/repo", &[rule("bash", "git *")]).unwrap();
        }
        let connection = Connection::open(&path).unwrap();
        initialize(&connection).unwrap();
        assert_eq!(rules(&connection, "/repo").unwrap().len(), 1);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_corrupt_row_is_an_error_not_a_panic() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO engine_permission_rule(workspace,digest,rule,created_at_ms) VALUES('/repo','x','{bogus',1)",
                [],
            )
            .unwrap();
        assert!(rules(&connection, "/repo").is_err());
    }
}
