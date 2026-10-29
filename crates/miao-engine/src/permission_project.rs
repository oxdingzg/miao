//! Shared project standing-rule storage. Not wired into Runtime authorization yet.
//! A concrete project named `global` is the legacy non-Git project, never a
//! universal grant. Session stores and execution leases remain separate.
use crate::{
    permission::digest,
    permission_migration::{LegacyRule, Receipt},
    permission_rules::{Rule, MAX_RULES},
    protocol::Error,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::sync::{mpsc, oneshot};

const APPLICATION_ID: u32 = 0x4d494150;
const SCHEMA_VERSION: u32 = 3;
const NATIVE_PREFIX: &str = "psv_native_project_";
type Work = Box<dyn FnOnce(&mut Connection) + Send>;

#[derive(Clone)]
pub struct Authority {
    work: mpsc::Sender<Work>,
}

/// Bound by the trusted host once; individual operations cannot select a scope.
#[derive(Clone)]
pub struct Project {
    pub(crate) authority: Authority,
    pub(crate) project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Native,
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub rule: Rule,
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub authority: String,
    pub project: String,
    pub revision: u64,
    pub migration: Option<Receipt>,
    pub rules: Vec<Record>,
}

impl Authority {
    /// Multiple connections/processes may share this dedicated database. It
    /// contains no Sessions, execution ownership, or exact invocation grants.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref().to_path_buf();
        let (work, mut receive) = mpsc::channel::<Work>(64);
        let (ready, started) = oneshot::channel();
        std::thread::spawn(move || {
            let opened = (|| {
                let mut connection = Connection::open(path)?;
                connection.busy_timeout(std::time::Duration::from_secs(2))?;
                initialize(&mut connection)?;
                Ok::<_, Error>(connection)
            })();
            match opened {
                Ok(mut connection) => {
                    if ready.send(Ok(())).is_err() {
                        return;
                    }
                    while let Some(job) = receive.blocking_recv() {
                        job(&mut connection);
                    }
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            }
        });
        started.await.map_err(|_| Error::Closed)??;
        Ok(Self { work })
    }

    pub fn project(&self, project: String) -> Result<Project, Error> {
        crate::permission_migration::require_rules(&project, &[])?;
        Ok(Project {
            authority: self.clone(),
            project,
        })
    }

    /// Run trusted shared-store work behind a live Runtime source fence.
    /// Only this authority's main database is writable. This does not decide
    /// permissions or validate a project/directory ownership handoff.
    pub async fn with_permission_source<T: Send + 'static>(
        &self,
        source: &crate::permission_source_transaction::Source,
        execute: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let source = source.clone();
        self.call(move |connection| source.with_root_transaction(connection, execute))
            .await
    }

    pub(crate) async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let (send, receive) = oneshot::channel();
        self.work
            .send(Box::new(move |connection| {
                let _ = send.send(f(connection));
            }))
            .await
            .map_err(|_| Error::Closed)?;
        receive.await.map_err(|_| Error::Closed)?
    }
}

impl Project {
    pub async fn observe(
        &self,
    ) -> Result<crate::permission_changefeed::Observation<Snapshot>, Error> {
        let project = self.project.clone();
        self.authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let snapshot = view(&transaction, &project)?;
                let cursor = crate::permission_changefeed::cursor(&transaction)?;
                transaction.commit()?;
                Ok(crate::permission_changefeed::Observation { snapshot, cursor })
            })
            .await
    }

    pub async fn changes(
        &self,
        input: crate::permission_changefeed::Input,
    ) -> Result<crate::permission_changefeed::Page, Error> {
        let project = self.project.clone();
        self.authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let page = crate::permission_changefeed::page(&transaction, &project, None, input)?;
                transaction.commit()?;
                Ok(page)
            })
            .await
    }

    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        let project = self.project.clone();
        self.authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let result = view(&transaction, &project)?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn migrate(&self, rules: Vec<LegacyRule>) -> Result<Snapshot, Error> {
        self.migrate_bound(None, rules).await
    }

    /// The source is frozen for one durable destination, never just a path.
    pub async fn handoff(
        &self,
        authority: String,
        rules: Vec<LegacyRule>,
    ) -> Result<Snapshot, Error> {
        self.migrate_bound(Some(authority), rules).await
    }

    async fn migrate_bound(
        &self,
        authority: Option<String>,
        mut rules: Vec<LegacyRule>,
    ) -> Result<Snapshot, Error> {
        let project = self.project.clone();
        rules.sort_by(|left, right| left.id.cmp(&right.id));
        crate::permission_migration::require_rules(&project, &rules)?;
        let fingerprint = migration_hash(&project, &rules)?;
        self.authority.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before = view(&transaction, &project)?;
            if authority.as_ref().is_some_and(|expected| expected != &before.authority) {
                return Err(Error::Invalid("project permission handoff destination mismatch".into()));
            }
            if let Some(receipt) = &before.migration {
                if receipt.fingerprint != fingerprint {
                    return Err(Error::Invalid("project permission migration input changed".into()));
                }
                return Ok(before);
            }
            ensure_project(&transaction, &project)?;
            transaction.execute(
                "INSERT INTO permission_project_migration(project,fingerprint,imported) VALUES(?1,?2,?3)",
                params![project, fingerprint, rules.len()],
            )?;
            for item in rules {
                transaction.execute(
                    "INSERT INTO permission_project_rule(project,id,origin,rule,digest) VALUES(?1,?2,'legacy',?3,?4)",
                    params![project, item.id, serde_json::to_string(&item.rule)?, rule_hash(&item.rule)?],
                )?;
            }
            budget(&transaction, &project)?;
            bump(&transaction, &project)?;
            let result = view(&transaction, &project)?;
            transaction.commit()?;
            Ok(result)
        }).await
    }

    pub async fn put(&self, rule: Rule) -> Result<Snapshot, Error> {
        crate::permission_patterns::require_rule(&rule)?;
        let project = self.project.clone();
        self.authority.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before = view(&transaction, &project)?;
            let id = native_id(&project, &rule)?;
            if before.rules.iter().any(|item| item.id == id) {
                return Ok(before);
            }
            ensure_project(&transaction, &project)?;
            transaction.execute(
                "INSERT INTO permission_project_rule(project,id,origin,rule,digest) VALUES(?1,?2,'native',?3,?4)",
                params![project, id, serde_json::to_string(&rule)?, rule_hash(&rule)?],
            )?;
            budget(&transaction, &project)?;
            bump(&transaction, &project)?;
            let result = view(&transaction, &project)?;
            transaction.commit()?;
            Ok(result)
        }).await
    }

    pub async fn remove(&self, id: String) -> Result<bool, Error> {
        require_id(&id)?;
        let project = self.project.clone();
        self.authority.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before = view(&transaction, &project)?;
            let Some(item) = before.rules.iter().find(|item| item.id == id) else {
                return Ok(false);
            };
            match item.origin {
                Origin::Native => { transaction.execute("DELETE FROM permission_project_rule WHERE project=?1 AND id=?2", params![project,id])?; }
                Origin::Legacy => { transaction.execute("UPDATE permission_project_rule SET revoked_at_ms=?3 WHERE project=?1 AND id=?2", params![project,id,crate::approval::now_ms()])?; }
            }
            bump(&transaction, &project)?;
            transaction.commit()?;
            Ok(true)
        }).await
    }
}

fn initialize(connection: &mut Connection) -> Result<(), Error> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    // Header and schema facts must share the initialization write transaction;
    // independent reads can straddle another owner's first commit.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let application: u32 = transaction.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let version: u32 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let empty: bool = transaction.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%')",
        [], |row| row.get(0),
    )?;
    if !((application == 0 && version == 0 && empty)
        || (application == APPLICATION_ID && (1..=SCHEMA_VERSION).contains(&version)))
    {
        return Err(Error::Invalid(
            "unsupported project permission database".into(),
        ));
    }
    if application == 0 {
        transaction.execute_batch(
        "CREATE TABLE permission_authority(id TEXT PRIMARY KEY);
         CREATE TABLE permission_project(project TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991));
         CREATE TABLE permission_project_migration(project TEXT PRIMARY KEY REFERENCES permission_project(project),fingerprint TEXT NOT NULL,imported INTEGER NOT NULL);
         CREATE TABLE permission_project_rule(project TEXT NOT NULL REFERENCES permission_project(project),id TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('native','legacy')),rule TEXT NOT NULL,digest TEXT NOT NULL,revoked_at_ms INTEGER,CHECK(origin='legacy' OR revoked_at_ms IS NULL),PRIMARY KEY(project,id));",
    )?;
        transaction.execute(
            "INSERT INTO permission_authority(id) VALUES(?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    }
    if version < 2 {
        crate::permission_context::initialize(&transaction)?;
    }
    if version < 3 {
        crate::permission_changefeed::initialize(&transaction)?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(())
}

pub(crate) fn view(connection: &Connection, project: &str) -> Result<Snapshot, Error> {
    let authority: String = connection.query_row(
        "SELECT id FROM permission_authority WHERE (SELECT count(*) FROM permission_authority)=1",
        [],
        |row| row.get(0),
    )?;
    uuid::Uuid::parse_str(&authority)
        .map_err(|_| Error::Invalid("invalid project permission authority identity".into()))?;
    let revision: Option<u64> = connection
        .query_row(
            "SELECT revision FROM permission_project WHERE project=?1",
            [project],
            |row| row.get(0),
        )
        .optional()?;
    let migration = connection
        .query_row(
            "SELECT fingerprint,imported FROM permission_project_migration WHERE project=?1",
            [project],
            |row| {
                Ok(Receipt {
                    project: project.into(),
                    fingerprint: row.get(0)?,
                    imported: row.get(1)?,
                })
            },
        )
        .optional()?;
    let mut statement = connection.prepare("SELECT id,origin,rule,digest,revoked_at_ms IS NOT NULL FROM permission_project_rule WHERE project=?1 ORDER BY id LIMIT 513")?;
    let rows = statement.query_map([project], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, bool>(4)?,
        ))
    })?;
    let mut rules = Vec::new();
    let mut legacy = Vec::new();
    for (index, row) in rows.enumerate() {
        if index >= 512 {
            return Err(Error::Invalid(
                "project permission identity budget exceeded".into(),
            ));
        }
        let (id, origin, encoded, hash, revoked) = row?;
        let rule: Rule = serde_json::from_str(&encoded)
            .map_err(|_| Error::Invalid("corrupt project permission rule".into()))?;
        crate::permission_patterns::require_rule(&rule)?;
        if rule_hash(&rule)? != hash {
            return Err(Error::Invalid("project permission digest mismatch".into()));
        }
        let origin = match origin.as_str() {
            "native" if id == native_id(project, &rule)? && !revoked => Origin::Native,
            "legacy" => {
                crate::permission_migration::require_id(&id)?;
                legacy.push(LegacyRule {
                    id: id.clone(),
                    rule: rule.clone(),
                });
                Origin::Legacy
            }
            _ => return Err(Error::Invalid("invalid project permission origin".into())),
        };
        if !revoked {
            rules.push(Record { id, rule, origin });
        }
    }
    crate::permission_migration::require_rules(project, &legacy)?;
    if let Some(receipt) = &migration {
        if receipt.imported != legacy.len()
            || receipt.fingerprint != migration_hash(project, &legacy)?
        {
            return Err(Error::Invalid(
                "project permission migration receipt mismatch".into(),
            ));
        }
    } else if !legacy.is_empty() {
        return Err(Error::Invalid(
            "project permission migration receipt missing".into(),
        ));
    }
    if revision.is_none() && (!rules.is_empty() || migration.is_some()) {
        return Err(Error::Invalid("project permission revision missing".into()));
    }
    budget(connection, project)?;
    Ok(Snapshot {
        authority,
        project: project.into(),
        revision: revision.unwrap_or(0),
        migration,
        rules,
    })
}

pub(crate) fn ensure_project(connection: &Connection, project: &str) -> Result<(), Error> {
    connection.execute(
        "INSERT OR IGNORE INTO permission_project(project) VALUES(?1)",
        [project],
    )?;
    Ok(())
}
fn bump(connection: &Connection, project: &str) -> Result<(), Error> {
    connection.execute(
        "UPDATE permission_project SET revision=revision+1 WHERE project=?1",
        [project],
    )?;
    Ok(())
}
fn budget(connection: &Connection, project: &str) -> Result<(), Error> {
    let count: usize = connection.query_row("SELECT count(DISTINCT digest) FROM permission_project_rule WHERE project=?1 AND revoked_at_ms IS NULL", [project], |row| row.get(0))?;
    if count > MAX_RULES {
        return Err(Error::Invalid(
            "project permission rule budget exceeded".into(),
        ));
    }
    Ok(())
}
pub(crate) fn rule_hash(rule: &Rule) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(rule)?))
}
fn native_id(project: &str, rule: &Rule) -> Result<String, Error> {
    Ok(format!(
        "{NATIVE_PREFIX}{}",
        digest(&serde_json::to_vec(&(project, rule))?)
    ))
}
fn migration_hash(project: &str, rules: &[LegacyRule]) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(&(
        "project-permissions-v1",
        project,
        rules,
    ))?))
}
fn require_id(id: &str) -> Result<(), Error> {
    if id.starts_with(NATIVE_PREFIX)
        && id.len() == NATIVE_PREFIX.len() + 64
        && id[NATIVE_PREFIX.len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Ok(());
    }
    crate::permission_migration::require_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::Decision;

    fn rule(resource: &str) -> Rule {
        Rule {
            action: "read".into(),
            resource: resource.into(),
            effect: Decision::Allow,
        }
    }
    fn legacy(id: &str, resource: &str) -> LegacyRule {
        LegacyRule {
            id: id.into(),
            rule: rule(resource),
        }
    }

    #[tokio::test]
    async fn handoff_checks_the_durable_destination_before_import_or_retry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("permissions.db");
        let project = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap();
        let before = project.put(rule("native/**")).await.unwrap();
        let input = vec![LegacyRule {
            id: "legacy".into(),
            rule: rule("legacy/**"),
        }];
        assert!(project
            .handoff(uuid::Uuid::new_v4().to_string(), input.clone())
            .await
            .is_err());
        assert_eq!(project.snapshot().await.unwrap(), before);
        let imported = project
            .handoff(before.authority.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(imported.migration.as_ref().unwrap().imported, 1);
        project.remove("legacy".into()).await.unwrap();
        let revoked = project.snapshot().await.unwrap();
        let peer = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap();
        assert_eq!(
            peer.handoff(before.authority.clone(), input.clone())
                .await
                .unwrap(),
            revoked
        );
        let replacement = uuid::Uuid::new_v4().to_string();
        Connection::open(&path)
            .unwrap()
            .execute("UPDATE permission_authority SET id=?1", [&replacement])
            .unwrap();
        assert!(peer.handoff(before.authority, input).await.is_err());
        let after = peer.snapshot().await.unwrap();
        assert_eq!(after.authority, replacement);
        assert_eq!(after.rules, revoked.rules);
        assert_eq!(after.revision, revoked.revision);
        assert_eq!(after.migration, revoked.migration);
    }

    #[tokio::test]
    async fn bound_projects_share_one_authority_without_global_or_storage_leakage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permissions.db");
        let first = Authority::open(&path).await.unwrap();
        let second = Authority::open(&path).await.unwrap();
        let project = first.project("project".into()).unwrap();
        let peer = second.project("project".into()).unwrap();
        let before = project.put(rule("public/**")).await.unwrap();
        assert_eq!(peer.snapshot().await.unwrap(), before);
        assert_eq!(peer.put(rule("public/**")).await.unwrap(), before);
        let other = second
            .project("other".into())
            .unwrap()
            .snapshot()
            .await
            .unwrap();
        assert_eq!(other.authority, before.authority);
        assert_eq!(other.revision, 0);
        assert!(other.rules.is_empty());
        let global = first.project("global".into()).unwrap();
        global.put(rule("nongit/**")).await.unwrap();
        assert_eq!(project.snapshot().await.unwrap(), before);
        let isolated = Authority::open(dir.path().join("other.db"))
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .snapshot()
            .await
            .unwrap();
        assert_ne!(isolated.authority, before.authority);
        assert!(isolated.rules.is_empty());
    }

    #[tokio::test]
    async fn migration_receipt_and_revocations_survive_reopen_and_reordered_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permissions.db");
        let owner = Authority::open(&path).await.unwrap();
        let project = owner.project("project".into()).unwrap();
        project.put(rule("native/**")).await.unwrap();
        let input = vec![
            legacy("legacy-b", "public/**"),
            legacy("legacy-a", "public/**"),
        ];
        let imported = project.migrate(input.clone()).await.unwrap();
        assert_eq!(imported.rules.len(), 3);
        assert_eq!(imported.migration.as_ref().unwrap().imported, 2);
        assert_eq!(imported.revision, 2);
        assert!(project.remove("legacy-a".into()).await.unwrap());
        assert!(!project.remove("legacy-a".into()).await.unwrap());
        let remaining = project.snapshot().await.unwrap();
        assert_eq!(remaining.rules.len(), 2);
        assert_eq!(remaining.revision, 3);
        assert!(project.remove("legacy-b".into()).await.unwrap());
        let revoked = project.snapshot().await.unwrap();
        assert_eq!(revoked.rules.len(), 1);
        assert_eq!(revoked.rules[0].origin, Origin::Native);
        assert_eq!(
            project
                .migrate(input.into_iter().rev().collect())
                .await
                .unwrap(),
            revoked
        );
        assert!(project
            .migrate(vec![legacy("different", "public/**")])
            .await
            .is_err());
        let reopened = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap();
        assert_eq!(reopened.snapshot().await.unwrap(), revoked);
    }

    #[tokio::test]
    async fn failed_revision_commit_rolls_back_rules_receipt_and_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let authority = Authority::open(dir.path().join("permissions.db"))
            .await
            .unwrap();
        let project = authority.project("project".into()).unwrap();
        let before = project.put(rule("existing")).await.unwrap();
        authority.call(|connection| {
            connection.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON permission_project BEGIN SELECT RAISE(ABORT,'injected failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(project.put(rule("new")).await.is_err());
        assert_eq!(project.snapshot().await.unwrap(), before);
        assert!(project
            .migrate(vec![legacy("legacy", "public/**")])
            .await
            .is_err());
        assert_eq!(project.snapshot().await.unwrap(), before);
        assert!(project.remove(before.rules[0].id.clone()).await.is_err());
        assert_eq!(project.snapshot().await.unwrap(), before);
    }

    #[tokio::test]
    async fn unique_rule_budget_preserves_full_retries_and_duplicate_legacy_identities() {
        let dir = tempfile::tempdir().unwrap();
        let authority = Authority::open(dir.path().join("permissions.db"))
            .await
            .unwrap();
        let project = authority.project("project".into()).unwrap();
        for index in 0..MAX_RULES {
            project.put(rule(&format!("public/{index}"))).await.unwrap();
        }
        let full = project.snapshot().await.unwrap();
        assert_eq!(project.put(rule("public/0")).await.unwrap(), full);
        assert!(project.put(rule("extra")).await.is_err());
        assert_eq!(project.snapshot().await.unwrap(), full);
        let input = (0..MAX_RULES)
            .map(|index| legacy(&format!("legacy-{index:03}"), &format!("public/{index}")))
            .collect();
        let combined = project.migrate(input).await.unwrap();
        assert_eq!(combined.rules.len(), MAX_RULES * 2);
        assert_eq!(combined.revision, (MAX_RULES + 1) as u64);
        assert!(project.remove("legacy-000".into()).await.unwrap());
        assert_eq!(
            project.snapshot().await.unwrap().rules.len(),
            MAX_RULES * 2 - 1
        );
    }

    #[tokio::test]
    async fn invalid_inputs_and_corrupt_receipts_never_become_authority() {
        let dir = tempfile::tempdir().unwrap();
        let authority = Authority::open(dir.path().join("permissions.db"))
            .await
            .unwrap();
        assert!(authority.project("".into()).is_err());
        assert!(authority.project("bad\0project".into()).is_err());
        let project = authority.project("project".into()).unwrap();
        assert!(project
            .migrate(vec![legacy("duplicate", "a"), legacy("duplicate", "b")])
            .await
            .is_err());
        assert!(project
            .migrate(vec![legacy("psv_native_foreign", "a")])
            .await
            .is_err());
        assert!(project
            .put(Rule {
                effect: Decision::Deny,
                ..rule("a")
            })
            .await
            .is_err());
        assert_eq!(project.snapshot().await.unwrap().revision, 0);
        project
            .migrate(vec![legacy("legacy", "public/**")])
            .await
            .unwrap();
        authority
            .call(|connection| {
                connection.execute(
                    "UPDATE permission_project_migration SET fingerprint='forged'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(project.snapshot().await.is_err());
        assert!(project.put(rule("new")).await.is_err());
        assert!(project.remove("legacy".into()).await.is_err());
        assert!(project
            .migrate(vec![legacy("legacy", "public/**")])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn foreign_and_future_databases_are_rejected_without_changing_their_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE sentinel(value INTEGER); INSERT INTO sentinel VALUES(42);")
            .unwrap();
        assert!(Authority::open(&path).await.is_err());
        assert_eq!(
            connection
                .query_row("SELECT value FROM sentinel", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert_eq!(
            connection
                .query_row("PRAGMA application_id", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        assert!(Authority::open(&path).await.is_err());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            SCHEMA_VERSION + 1
        );
    }

    #[tokio::test]
    async fn simultaneous_owners_initialize_once_and_serialize_project_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permissions.db");
        let (first, second) = tokio::join!(Authority::open(&path), Authority::open(&path));
        let first = first.unwrap().project("project".into()).unwrap();
        let second = second.unwrap().project("project".into()).unwrap();
        let writes = async {
            for index in 0..16 {
                let (left, right) = tokio::join!(
                    first.put(rule(&format!("left/{index}"))),
                    second.put(rule(&format!("right/{index}")))
                );
                left.unwrap();
                right.unwrap();
            }
        };
        let reads = async {
            for _ in 0..96 {
                let snapshot = second.snapshot().await.unwrap();
                assert_eq!(snapshot.rules.len() as u64, snapshot.revision);
            }
        };
        tokio::join!(writes, reads);
        let snapshot = first.snapshot().await.unwrap();
        assert_eq!(snapshot.rules.len(), 32);
        assert_eq!(snapshot.revision, 32);
        assert_eq!(second.snapshot().await.unwrap(), snapshot);
    }
    #[tokio::test]
    async fn missing_revisions_and_ambiguous_authority_metadata_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let statements = [
            "INSERT INTO permission_authority(id) VALUES('0c250a7d-cda0-4417-92ed-295ae629a4fd')",
            "UPDATE permission_authority SET id='broken'",
            "PRAGMA foreign_keys=OFF; DELETE FROM permission_project",
        ];
        for (index, statement) in statements.into_iter().enumerate() {
            let authority = Authority::open(dir.path().join(format!("corrupt-{index}.db")))
                .await
                .unwrap();
            let project = authority.project("project".into()).unwrap();
            let before = project.put(rule("public/**")).await.unwrap();
            authority
                .call(move |connection| {
                    connection.execute_batch(statement)?;
                    Ok(())
                })
                .await
                .unwrap();
            assert!(project.snapshot().await.is_err());
            assert!(project.put(rule("new")).await.is_err());
            assert!(project.remove(before.rules[0].id.clone()).await.is_err());
        }
    }
}
