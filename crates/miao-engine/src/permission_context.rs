//! Directory standing rules share the project database without becoming project
//! grants. Runtime selection requires an explicit completed handoff binding.
use crate::{
    permission::digest,
    permission_patterns::{Origin, Pattern},
    permission_project::{self, Project},
    permission_rules::{Rule, MAX_RULES},
    protocol::Error,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone)]
pub struct Context {
    pub(crate) project: Project,
    pub(crate) directory: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) location: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    pub fingerprint: String,
    pub imported: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub project: permission_project::Snapshot,
    pub directory: String,
    pub workspace_id: Option<String>,
    pub revision: u64,
    pub migration: Option<Migration>,
    pub patterns: Vec<Pattern>,
}

/// A verified completed source/Root pairing. It carries no execution or grant
/// authority and never unfreezes the legacy source.
#[derive(Clone)]
pub struct HandoffBinding {
    context: Context,
    source: crate::store::Store,
    receipt: crate::permission_source::Record,
}

impl HandoffBinding {
    pub fn source_path(&self) -> &Path {
        self.source.path()
    }

    pub(crate) fn run_authority(&self, runtime: String) -> crate::permission_source::RunAuthority {
        crate::permission_source::RunAuthority {
            target: self.receipt.target.clone(),
            fingerprint: self.receipt.fingerprint.clone(),
            runtime,
            owner_pid: std::process::id(),
        }
    }

    pub(crate) async fn root_path(&self) -> Result<std::path::PathBuf, Error> {
        let path: String = self
            .context
            .project
            .authority
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT file FROM pragma_database_list WHERE name='main'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await?;
        Ok(tokio::fs::canonicalize(path).await?)
    }

    pub(crate) fn source(&self) -> crate::store::Store {
        self.source.clone()
    }

    pub(crate) fn context(&self) -> &Context {
        &self.context
    }

    /// Verify the captured execution claim, not a lease rediscovered after a
    /// takeover. The runtime UUID must be the process owner's actual identity.
    pub(crate) async fn require_run(
        &self,
        run: &str,
        runtime: &str,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        self.snapshot().await?;
        let run = run.to_owned();
        let runtime = runtime.to_owned();
        let lease = lease.clone();
        let receipt = self.receipt.clone();
        self.source.call(move |connection| {
            let transaction = connection.transaction()?;
            crate::store::require_lease(&transaction, &lease.session, &lease)?;
            let marker: Option<String> = transaction.query_row(
                "SELECT r.shared_permission FROM engine_run r JOIN engine_lease e ON e.session_id=r.session_id JOIN engine_location l ON l.session_id=r.session_id WHERE r.id=?1 AND r.session_id=?2 AND r.state='running' AND r.lease_epoch=?3 AND e.owner_pid=?4 AND l.root=?5",
                params![run,lease.session,lease.epoch,std::process::id(),receipt.workspace],
                |row|row.get(0),
            ).optional()?.flatten();
            let marker: crate::permission_source::RunAuthority = serde_json::from_str(
                &marker.ok_or_else(||Error::Invalid("shared run authority is missing".into()))?
            )?;
            if marker.target!=receipt.target || marker.fingerprint!=receipt.fingerprint || marker.runtime!=runtime || marker.owner_pid!=std::process::id() {
                return Err(Error::Invalid("shared run authority mismatch".into()));
            }
            transaction.commit()?;
            Ok(())
        }).await
    }

    pub(crate) async fn start_run_fenced(
        &self,
        session: &str,
        run: &str,
        lease: &crate::store::SessionLease,
        runtime: String,
    ) -> Result<(), Error> {
        self.snapshot().await?;
        self.source
            .start_run_inner(
                session,
                run,
                Some(lease.clone()),
                Some(self.run_authority(runtime)),
            )
            .await?;
        Ok(())
    }

    /// Admit a run explicitly marked for the shared Runtime backend.
    /// Existing legacy run entry points remain fenced after handoff.
    pub async fn start_run_with_inputs_fenced(
        &self,
        session: &str,
        run: &str,
        force: bool,
        lease: &crate::store::SessionLease,
        runtime: String,
    ) -> Result<Option<Vec<crate::protocol::Event>>, Error> {
        uuid::Uuid::parse_str(&runtime)
            .map_err(|_| Error::Invalid("invalid shared Runtime identity".into()))?;
        self.snapshot().await?;
        self.source
            .start_run_with_shared_authority(
                session,
                run,
                force,
                lease,
                Some(crate::permission_source::RunAuthority {
                    target: self.receipt.target.clone(),
                    fingerprint: self.receipt.fingerprint.clone(),
                    runtime,
                    owner_pid: std::process::id(),
                }),
            )
            .await
    }

    /// Read current rules while rechecking both original migration receipts.
    /// Revoked imported patterns need not remain in the current rule set.
    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        let source = self
            .source
            .directory_permission_source(self.context.directory.clone())
            .await?
            .ok_or_else(|| {
                Error::Invalid("completed permission source receipt is missing".into())
            })?;
        if source != self.receipt {
            return Err(Error::Invalid("permission source binding changed".into()));
        }
        let snapshot = self.context.snapshot().await?;
        source.require_destination(&snapshot)?;
        Ok(snapshot)
    }
}

impl Project {
    /// Explicit workspace identity is isolated; omission remains implicit-local.
    pub async fn context(
        &self,
        directory: impl AsRef<Path>,
        workspace_id: Option<String>,
    ) -> Result<Context, Error> {
        if let Some(id) = &workspace_id {
            crate::permission_migration::require_rules(id, &[])?;
        }
        let directory = tokio::fs::canonicalize(directory).await?;
        if !tokio::fs::metadata(&directory).await?.is_dir() {
            return Err(Error::Invalid(
                "permission context requires a directory".into(),
            ));
        }
        let directory = directory
            .into_os_string()
            .into_string()
            .map_err(|_| Error::Invalid("permission directory must be UTF-8".into()))?;
        crate::permission_patterns::require_workspace(&directory)?;
        let location = serde_json::to_string(&(&directory, &workspace_id))?;
        Ok(Context {
            project: self.clone(),
            directory,
            workspace_id,
            location,
        })
    }
}

impl Context {
    /// Bind a real completed source to this exact Root/project/directory before
    /// a shared Runtime is constructed. No cached caller snapshot is accepted.
    pub async fn bind_handoff(
        &self,
        source: &crate::store::Store,
    ) -> Result<HandoffBinding, Error> {
        let receipt = source
            .directory_permission_source(self.directory.clone())
            .await?
            .ok_or_else(|| Error::Invalid("permission source handoff is missing".into()))?;
        if receipt.state != crate::permission_source::State::Completed {
            return Err(Error::Invalid(
                "permission source handoff is not completed".into(),
            ));
        }
        receipt.require_destination(&self.snapshot().await?)?;
        Ok(HandoffBinding {
            context: self.clone(),
            source: source.clone(),
            receipt,
        })
    }

    pub async fn observe(
        &self,
    ) -> Result<crate::permission_changefeed::Observation<Snapshot>, Error> {
        let context = self.clone();
        self.project
            .authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let snapshot = context.view(&transaction)?;
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
        let context = self.clone();
        self.project
            .authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let page = crate::permission_changefeed::page(
                    &transaction,
                    &context.project.project,
                    Some(&context.location),
                    input,
                )?;
                transaction.commit()?;
                Ok(page)
            })
            .await
    }

    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        let context = self.clone();
        self.project
            .authority
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let result = context.view(&transaction)?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn put(&self, rule: Rule) -> Result<Snapshot, Error> {
        crate::permission_patterns::require_rule(&rule)?;
        let context = self.clone();
        self.project
            .authority
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let before = context.view(&transaction)?;
                let id = pattern_id(&context.directory, &rule)?;
                if before.patterns.iter().any(|item| item.id == id) {
                    return Ok(before);
                }
                context.ensure(&transaction)?;
                context.insert(
                    &transaction,
                    &Pattern {
                        id,
                        workspace: context.directory.clone(),
                        rule,
                        source: Origin::Native,
                        created_at_ms: crate::approval::now_ms(),
                    },
                )?;
                context.bump(&transaction)?;
                let result = context.view(&transaction)?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn remove(&self, id: String) -> Result<bool, Error> {
        let context = self.clone();
        self.project.authority.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before=context.view(&transaction)?;
            if !before.patterns.iter().any(|item| item.id==id) { return Ok(false); }
            transaction.execute("DELETE FROM permission_directory_rule WHERE project=?1 AND location=?2 AND id=?3",params![context.project.project,context.location,id])?;
            context.bump(&transaction)?;
            transaction.commit()?;
            Ok(true)
        }).await
    }

    pub async fn migrate(&self, patterns: Vec<Pattern>) -> Result<Snapshot, Error> {
        self.migrate_bound(None, patterns).await
    }

    /// Frozen sources name a durable destination, not merely a database path.
    pub async fn handoff(
        &self,
        authority: String,
        patterns: Vec<Pattern>,
    ) -> Result<Snapshot, Error> {
        self.migrate_bound(Some(authority), patterns).await
    }

    async fn migrate_bound(
        &self,
        authority: Option<String>,
        mut patterns: Vec<Pattern>,
    ) -> Result<Snapshot, Error> {
        patterns.sort_by(|left, right| left.id.cmp(&right.id));
        self.require_patterns(&patterns)?;
        let fingerprint = self.fingerprint(&patterns)?;
        let context = self.clone();
        self.project.authority.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before=context.view(&transaction)?;
            if authority.as_ref().is_some_and(|expected| expected != &before.project.authority) {
                return Err(Error::Invalid("directory permission handoff destination mismatch".into()));
            }
            if let Some(receipt)=&before.migration {
                if receipt.fingerprint!=fingerprint { return Err(Error::Invalid("directory permission migration input changed".into())); }
                return Ok(before);
            }
            context.ensure(&transaction)?;
            transaction.execute("INSERT INTO permission_directory_migration(project,location,fingerprint,patterns) VALUES(?1,?2,?3,?4)",params![context.project.project,context.location,fingerprint,serde_json::to_string(&patterns)?])?;
            for pattern in patterns { context.insert(&transaction,&pattern)?; }
            context.bump(&transaction)?;
            let result=context.view(&transaction)?;
            transaction.commit()?;
            Ok(result)
        }).await
    }

    pub(crate) fn ensure(&self, connection: &Connection) -> Result<(), Error> {
        permission_project::ensure_project(connection, &self.project.project)?;
        connection.execute(
            "INSERT OR IGNORE INTO permission_directory(project,location) VALUES(?1,?2)",
            params![self.project.project, self.location],
        )?;
        Ok(())
    }
    pub(crate) fn bump(&self, connection: &Connection) -> Result<(), Error> {
        connection.execute(
            "UPDATE permission_directory SET revision=revision+1 WHERE project=?1 AND location=?2",
            params![self.project.project, self.location],
        )?;
        Ok(())
    }
    pub(crate) fn insert(&self, connection: &Connection, pattern: &Pattern) -> Result<(), Error> {
        connection.execute("INSERT OR IGNORE INTO permission_directory_rule(project,location,id,rule,digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",params![self.project.project,self.location,pattern.id,serde_json::to_string(&pattern.rule)?,permission_project::rule_hash(&pattern.rule)?,pattern.created_at_ms])?;
        Ok(())
    }
    fn require_patterns(&self, patterns: &[Pattern]) -> Result<(), Error> {
        if patterns.len() > MAX_RULES {
            return Err(Error::Invalid(
                "directory permission identity budget exceeded".into(),
            ));
        }
        for (index, pattern) in patterns.iter().enumerate() {
            crate::permission_patterns::require_rule(&pattern.rule)?;
            if pattern.workspace != self.directory
                || pattern.id != pattern_id(&self.directory, &pattern.rule)?
                || pattern.created_at_ms > 9007199254740991
                || (index > 0 && patterns[index - 1].id >= pattern.id)
            {
                return Err(Error::Invalid(
                    "directory permission identity or scope mismatch".into(),
                ));
            }
        }
        Ok(())
    }
    fn fingerprint(&self, patterns: &[Pattern]) -> Result<String, Error> {
        migration_fingerprint(&self.project.project, &self.location, patterns)
    }
    pub(crate) fn view(&self, connection: &Connection) -> Result<Snapshot, Error> {
        let project = permission_project::view(connection, &self.project.project)?;
        let revision: Option<u64> = connection
            .query_row(
                "SELECT revision FROM permission_directory WHERE project=?1 AND location=?2",
                params![self.project.project, self.location],
                |row| row.get(0),
            )
            .optional()?;
        let migration=connection.query_row("SELECT fingerprint,patterns FROM permission_directory_migration WHERE project=?1 AND location=?2",params![self.project.project,self.location],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional()?;
        let migration = if let Some((fingerprint, encoded)) = migration {
            let patterns: Vec<Pattern> = serde_json::from_str(&encoded)
                .map_err(|_| Error::Invalid("corrupt directory permission migration".into()))?;
            self.require_patterns(&patterns)?;
            if self.fingerprint(&patterns)? != fingerprint {
                return Err(Error::Invalid(
                    "directory permission migration receipt mismatch".into(),
                ));
            }
            Some(Migration {
                fingerprint,
                imported: patterns.len(),
            })
        } else {
            None
        };
        let mut statement=connection.prepare("SELECT id,rule,digest,created_at_ms FROM permission_directory_rule WHERE project=?1 AND location=?2 ORDER BY id LIMIT ?3")?;
        let rows = statement.query_map(
            params![self.project.project, self.location, MAX_RULES + 1],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            },
        )?;
        let mut patterns = Vec::new();
        for row in rows {
            let (id, encoded, hash, created_at_ms) = row?;
            let rule: Rule = serde_json::from_str(&encoded)
                .map_err(|_| Error::Invalid("corrupt directory permission rule".into()))?;
            if permission_project::rule_hash(&rule)? != hash {
                return Err(Error::Invalid(
                    "directory permission digest mismatch".into(),
                ));
            }
            patterns.push(Pattern {
                id,
                workspace: self.directory.clone(),
                rule,
                source: Origin::Native,
                created_at_ms,
            });
        }
        self.require_patterns(&patterns)?;
        if revision.is_none() && (!patterns.is_empty() || migration.is_some()) {
            return Err(Error::Invalid(
                "directory permission revision missing".into(),
            ));
        }
        combined_budget(connection, &self.project.project, &self.location)?;
        Ok(Snapshot {
            project,
            directory: self.directory.clone(),
            workspace_id: self.workspace_id.clone(),
            revision: revision.unwrap_or(0),
            migration,
            patterns,
        })
    }
}

pub(crate) fn migration_fingerprint(
    project: &str,
    location: &str,
    patterns: &[Pattern],
) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(&(
        "directory-permissions-v1",
        project,
        location,
        patterns,
    ))?))
}

pub(crate) fn pattern_id(directory: &str, rule: &Rule) -> Result<String, Error> {
    Ok(format!(
        "prule_{}",
        crate::permission_patterns::rule_digest(directory, rule)?
    ))
}
fn combined_budget(connection: &Connection, project: &str, location: &str) -> Result<(), Error> {
    let count:usize=connection.query_row("SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=?1 AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=?1 AND location=?2)",params![project,location],|row|row.get(0))?;
    if count > MAX_RULES {
        return Err(Error::Invalid(
            "combined project and directory permission budget exceeded".into(),
        ));
    }
    Ok(())
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE permission_directory(project TEXT NOT NULL REFERENCES permission_project(project),location TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),PRIMARY KEY(project,location));
      CREATE TABLE permission_directory_migration(project TEXT NOT NULL,location TEXT NOT NULL,fingerprint TEXT NOT NULL,patterns TEXT NOT NULL,PRIMARY KEY(project,location),FOREIGN KEY(project,location) REFERENCES permission_directory(project,location));
      CREATE TABLE permission_directory_rule(project TEXT NOT NULL,location TEXT NOT NULL,id TEXT NOT NULL,rule TEXT NOT NULL,digest TEXT NOT NULL,created_at_ms INTEGER NOT NULL,PRIMARY KEY(project,location,id),FOREIGN KEY(project,location) REFERENCES permission_directory(project,location));")?;
    // Schema guards preserve the combined budget even for an already-open v1
    // project controller, which does not know directory tables exist yet.
    for event in ["INSERT", "UPDATE"] {
        connection.execute_batch(&format!(
            "CREATE TRIGGER permission_project_directory_budget_{event} AFTER {event} ON permission_project_rule
             WHEN EXISTS(SELECT 1 FROM permission_directory d WHERE d.project=NEW.project AND (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=d.location))>{MAX_RULES})
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;
             CREATE TRIGGER permission_directory_project_budget_{event} AFTER {event} ON permission_directory_rule
             WHEN (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=NEW.location))>{MAX_RULES}
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;"
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{permission::Decision, permission_project::Authority, store::Store};

    fn rule(resource: &str) -> Rule {
        Rule {
            action: "read".into(),
            resource: resource.into(),
            effect: Decision::Allow,
        }
    }

    #[tokio::test]
    async fn handoff_checks_the_destination_before_import_and_before_receipt_retry() {
        let directory = tempfile::tempdir().unwrap();
        let canonical = directory
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let source = Store::open(directory.path().join("source.db"))
            .await
            .unwrap();
        let pattern = source
            .put_permission_pattern(canonical, rule("public/**"))
            .await
            .unwrap();
        let first = Authority::open(directory.path().join("first.db"))
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        let other = Authority::open(directory.path().join("other.db"))
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        let initial = first.snapshot().await.unwrap();
        let foreign = other.snapshot().await.unwrap();
        assert_ne!(initial.project.authority, foreign.project.authority);
        assert!(other
            .handoff(initial.project.authority.clone(), vec![pattern.clone()])
            .await
            .is_err());
        assert_eq!(other.snapshot().await.unwrap(), foreign);
        assert!(first
            .handoff(foreign.project.authority.clone(), vec![pattern.clone()])
            .await
            .is_err());
        assert_eq!(first.snapshot().await.unwrap(), initial);
        let imported = first
            .handoff(initial.project.authority.clone(), vec![pattern.clone()])
            .await
            .unwrap();
        assert_eq!(imported.patterns, vec![pattern.clone()]);
        assert!(first.remove(pattern.id.clone()).await.unwrap());
        let revoked = first.snapshot().await.unwrap();
        assert_eq!(
            first
                .handoff(initial.project.authority, vec![pattern.clone()])
                .await
                .unwrap(),
            revoked
        );
        assert!(first
            .handoff(foreign.project.authority, vec![pattern])
            .await
            .is_err());
        assert_eq!(first.snapshot().await.unwrap(), revoked);
    }

    #[tokio::test]
    async fn actual_v1_fixture_upgrades_without_changing_identity_rules_or_revocations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("permissions.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../tests/fixtures/permission_project_v1.sql"))
            .unwrap();
        drop(connection);
        let authority = Authority::open(&path).await.unwrap();
        let project = authority.project("fixture-project".into()).unwrap();
        let provenance: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/permission_project_v1.json"))
                .unwrap();
        assert_eq!(
            serde_json::to_value(project.snapshot().await.unwrap()).unwrap(),
            provenance["expected"]
        );
        let context = project.context(directory.path(), None).await.unwrap();
        let snapshot = context.snapshot().await.unwrap();
        assert_eq!(snapshot.project.revision, 3);
        assert!(snapshot.patterns.is_empty());
        assert_eq!(snapshot.revision, 0);
        assert!(snapshot.migration.is_none());
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            5
        );
    }

    #[tokio::test]
    async fn project_directory_and_explicit_workspace_scopes_stay_distinct() {
        let directory = tempfile::tempdir().unwrap();
        let a = directory.path().join("a");
        let b = directory.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let path = directory.path().join("permissions.db");
        let authority = Authority::open(&path).await.unwrap();
        let project = authority.project("project".into()).unwrap();
        let first = project.context(&a, None).await.unwrap();
        let other = project.context(&b, None).await.unwrap();
        let explicit = project
            .context(&a, Some("workspace-future".into()))
            .await
            .unwrap();
        project.put(rule("project/**")).await.unwrap();
        let saved = first.put(rule("directory/**")).await.unwrap();
        assert_eq!(saved.project.rules.len(), 1);
        assert_eq!(saved.patterns.len(), 1);
        assert!(other.snapshot().await.unwrap().patterns.is_empty());
        assert!(explicit.snapshot().await.unwrap().patterns.is_empty());
        assert_eq!(other.snapshot().await.unwrap().project, saved.project);
        let foreign = authority
            .project("foreign".into())
            .unwrap()
            .context(&a, None)
            .await
            .unwrap()
            .snapshot()
            .await
            .unwrap();
        assert!(foreign.patterns.is_empty());
        assert!(foreign.project.rules.is_empty());
        let peer = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(&a, None)
            .await
            .unwrap();
        assert_eq!(peer.snapshot().await.unwrap(), saved);
        assert!(!other.remove(saved.patterns[0].id.clone()).await.unwrap());
        assert!(!first
            .remove(saved.project.rules[0].id.clone())
            .await
            .unwrap());
        assert_eq!(first.put(rule("directory/**")).await.unwrap(), saved);
        assert!(peer.remove(saved.patterns[0].id.clone()).await.unwrap());
        assert!(!peer.remove(saved.patterns[0].id.clone()).await.unwrap());
        assert!(first.snapshot().await.unwrap().patterns.is_empty());
    }

    #[tokio::test]
    async fn actual_local_native_patterns_keep_ids_timestamps_and_revocation_on_handoff() {
        let directory = tempfile::tempdir().unwrap();
        let canonical = directory
            .path()
            .canonicalize()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        let local = Store::open(directory.path().join("local.db"))
            .await
            .unwrap();
        let first = local
            .put_permission_pattern(canonical.clone(), rule("a/**"))
            .await
            .unwrap();
        let second = local
            .put_permission_pattern(canonical, rule("b/**"))
            .await
            .unwrap();
        let path = directory.path().join("permissions.db");
        let authority = Authority::open(&path).await.unwrap();
        let project = authority.project("project".into()).unwrap();
        let context = project.context(directory.path(), None).await.unwrap();
        let independent = context.put(rule("independent/**")).await.unwrap();
        let input = vec![first.clone(), second.clone()];
        let imported = context.migrate(input.clone()).await.unwrap();
        assert_eq!(imported.patterns.len(), 3);
        assert_eq!(imported.migration.as_ref().unwrap().imported, 2);
        assert!(imported.patterns.contains(&first));
        assert!(imported.patterns.contains(&second));
        assert!(imported.patterns.contains(&independent.patterns[0]));
        assert_eq!(imported.project.revision, 0);
        assert!(context.remove(first.id.clone()).await.unwrap());
        let revoked = context.snapshot().await.unwrap();
        assert_eq!(
            context
                .migrate(input.into_iter().rev().collect())
                .await
                .unwrap(),
            revoked
        );
        let reopened = Authority::open(path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        assert_eq!(reopened.snapshot().await.unwrap(), revoked);
        assert!(reopened.migrate(vec![second]).await.is_err());
    }

    #[tokio::test]
    async fn combined_budget_blocks_project_writes_atomically_without_widening_directory_grants() {
        let directory = tempfile::tempdir().unwrap();
        let authority = Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap();
        let project = authority.project("project".into()).unwrap();
        let context = project.context(directory.path(), None).await.unwrap();
        for index in 0..MAX_RULES {
            context.put(rule(&format!("public/{index}"))).await.unwrap();
        }
        let full = context.snapshot().await.unwrap();
        assert!(project.put(rule("extra")).await.is_err());
        assert_eq!(context.snapshot().await.unwrap(), full);
        assert!(project
            .migrate(vec![crate::permission_migration::LegacyRule {
                id: "legacy".into(),
                rule: rule("extra")
            }])
            .await
            .is_err());
        assert_eq!(context.snapshot().await.unwrap(), full);
        project.put(rule("public/0")).await.unwrap();
        let combined = context.snapshot().await.unwrap();
        assert_eq!(combined.patterns.len(), MAX_RULES);
        assert_eq!(combined.project.rules.len(), 1);
        assert_eq!(context.put(rule("public/0")).await.unwrap(), combined);
        assert!(context.put(rule("extra")).await.is_err());
        assert_eq!(context.snapshot().await.unwrap(), combined);
        // Exercise the schema guard directly, as an already-open v1 writer would.
        project.authority.call(|connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            assert!(transaction.execute("INSERT INTO permission_project_rule(project,id,origin,rule,digest) VALUES('project','psv_native_project_stale','native','{}','stale-writer')",[]).is_err());
            Ok(())
        }).await.unwrap();
        assert_eq!(context.snapshot().await.unwrap(), combined);
    }

    #[tokio::test]
    async fn directory_revision_failures_roll_back_rules_and_migration_receipts() {
        let directory = tempfile::tempdir().unwrap();
        let authority = Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap();
        let project = authority.project("project".into()).unwrap();
        let context = project.context(directory.path(), None).await.unwrap();
        let before = context.put(rule("existing")).await.unwrap();
        authority.call(|connection| {connection.execute_batch("CREATE TRIGGER fail_directory_revision BEFORE UPDATE ON permission_directory BEGIN SELECT RAISE(ABORT,'injected failure'); END;")?;Ok(())}).await.unwrap();
        assert!(context.put(rule("new")).await.is_err());
        assert_eq!(context.snapshot().await.unwrap(), before);
        assert!(context.migrate(Vec::new()).await.is_err());
        assert_eq!(context.snapshot().await.unwrap(), before);
        assert!(context.remove(before.patterns[0].id.clone()).await.is_err());
        assert_eq!(context.snapshot().await.unwrap(), before);
    }

    #[tokio::test]
    async fn concurrent_project_and_directory_changes_have_one_snapshot_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("permissions.db");
        let project = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap();
        let context = Authority::open(&path)
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        let writes = async {
            for index in 0..16 {
                let (a, b) = tokio::join!(
                    project.put(rule(&format!("project/{index}"))),
                    context.put(rule(&format!("directory/{index}")))
                );
                a.unwrap();
                b.unwrap();
            }
        };
        let reads = async {
            for _ in 0..96 {
                let value = context.snapshot().await.unwrap();
                assert_eq!(value.project.rules.len() as u64, value.project.revision);
                assert_eq!(value.patterns.len() as u64, value.revision);
            }
        };
        tokio::join!(writes, reads);
        let result = context.snapshot().await.unwrap();
        assert_eq!(result.project.revision, 16);
        assert_eq!(result.revision, 16);
    }

    #[tokio::test]
    async fn invalid_bindings_and_corrupt_directory_state_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let authority = Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap();
        let project = authority.project("project".into()).unwrap();
        assert!(project
            .context(directory.path(), Some("".into()))
            .await
            .is_err());
        let context = project.context(directory.path(), None).await.unwrap();
        let pattern = context
            .put(rule("public/**"))
            .await
            .unwrap()
            .patterns
            .remove(0);
        let mut foreign = pattern.clone();
        foreign.workspace = "/foreign".into();
        assert!(context.migrate(vec![foreign]).await.is_err());
        assert!(context
            .migrate(vec![pattern.clone(), pattern])
            .await
            .is_err());
        context.migrate(Vec::new()).await.unwrap();
        authority
            .call(|connection| {
                connection.execute(
                    "UPDATE permission_directory_migration SET fingerprint='forged'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(context.snapshot().await.is_err());
        assert!(context.put(rule("new")).await.is_err());
        assert!(project.snapshot().await.unwrap().rules.is_empty());
    }
    #[tokio::test]
    async fn completed_source_binding_reads_real_receipts_and_preserves_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let source = Store::open(directory.path().join("source.db"))
            .await
            .unwrap();
        source
            .put_permission_pattern(workspace.clone(), rule("public/**"))
            .await
            .unwrap();
        let context = Authority::open(directory.path().join("root.db"))
            .await
            .unwrap()
            .project("fixture".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        assert!(context.bind_handoff(&source).await.is_err());
        let initial = context.snapshot().await.unwrap();
        let prepared = source
            .prepare_directory_permission_source(
                workspace.clone(),
                crate::permission_source::Target {
                    authority: initial.project.authority.clone(),
                    project: initial.project.project.clone(),
                    directory: workspace.clone(),
                    workspace_id: None,
                },
            )
            .await
            .unwrap();
        assert!(context.bind_handoff(&source).await.is_err());
        let imported = context
            .handoff(initial.project.authority, prepared.patterns.clone())
            .await
            .unwrap();
        assert!(context.bind_handoff(&source).await.is_err());
        source
            .complete_directory_permission_source(workspace.clone(), imported.clone())
            .await
            .unwrap();
        let binding = context.bind_handoff(&source).await.unwrap();
        assert_eq!(binding.source_path(), source.path());
        assert_eq!(binding.snapshot().await.unwrap(), imported);
        context
            .remove(imported.patterns[0].id.clone())
            .await
            .unwrap();
        let revoked = binding.snapshot().await.unwrap();
        assert!(revoked.patterns.is_empty());
        assert_eq!(revoked.migration.unwrap().imported, 1);
        assert!(
            source.saved_rules(workspace).await.is_err(),
            "binding unfreezes the legacy permission source"
        );
        let reopened = Authority::open(directory.path().join("root.db"))
            .await
            .unwrap()
            .project("fixture".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        assert!(reopened
            .bind_handoff(&source)
            .await
            .unwrap()
            .snapshot()
            .await
            .unwrap()
            .patterns
            .is_empty());
    }

    #[tokio::test]
    async fn source_binding_refuses_another_root_scope_and_a_lost_destination_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let source = Store::open(directory.path().join("source.db"))
            .await
            .unwrap();
        let authority = Authority::open(directory.path().join("root.db"))
            .await
            .unwrap();
        let project = authority.project("fixture".into()).unwrap();
        let context = project.context(directory.path(), None).await.unwrap();
        let initial = context.snapshot().await.unwrap();
        let prepared = source
            .prepare_directory_permission_source(
                workspace.clone(),
                crate::permission_source::Target {
                    authority: initial.project.authority.clone(),
                    project: "fixture".into(),
                    directory: workspace.clone(),
                    workspace_id: None,
                },
            )
            .await
            .unwrap();
        let imported = context
            .handoff(initial.project.authority, prepared.patterns.clone())
            .await
            .unwrap();
        source
            .complete_directory_permission_source(workspace, imported)
            .await
            .unwrap();
        let binding = context.bind_handoff(&source).await.unwrap();
        let replacement = Authority::open(directory.path().join("replacement.db"))
            .await
            .unwrap()
            .project("fixture".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        replacement.migrate(prepared.patterns).await.unwrap();
        assert!(replacement.bind_handoff(&source).await.is_err());
        let other_project = authority
            .project("other-project".into())
            .unwrap()
            .context(directory.path(), None)
            .await
            .unwrap();
        assert!(other_project.bind_handoff(&source).await.is_err());
        let explicit = project
            .context(directory.path(), Some("reserved".into()))
            .await
            .unwrap();
        assert!(explicit.bind_handoff(&source).await.is_err());
        let other = directory.path().join("other");
        std::fs::create_dir(&other).unwrap();
        assert!(project
            .context(other, None)
            .await
            .unwrap()
            .bind_handoff(&source)
            .await
            .is_err());
        authority
            .call(|connection| {
                connection.execute("DELETE FROM permission_directory_migration", [])?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(binding.snapshot().await.is_err());
        assert!(context.bind_handoff(&source).await.is_err());
    }
}
