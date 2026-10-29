//! Explicit retirement of one implicit-local directory's legacy authority.
//! Source preparation and destination import are separate durable operations.
use crate::{permission_context, permission_patterns::Pattern, protocol::Error, store::Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub authority: String,
    pub project: String,
    pub directory: String,
    pub workspace_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Prepared,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub workspace: String,
    pub target: Target,
    pub patterns: Vec<Pattern>,
    pub fingerprint: String,
    pub state: State,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS engine_permission_handoff(workspace TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('prepared','completed')),data TEXT NOT NULL);")?;
    for (table, name) in [
        ("engine_permission_rule_legacy", "projected"),
        ("engine_owned_permission_rule_legacy", "native"),
    ] {
        connection.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_{name}_insert BEFORE INSERT ON {table}
             WHEN EXISTS(SELECT 1 FROM engine_permission_handoff WHERE workspace=NEW.workspace)
             BEGIN SELECT RAISE(ABORT,'permission source is frozen'); END;
             CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_{name}_delete BEFORE DELETE ON {table}
             WHEN EXISTS(SELECT 1 FROM engine_permission_handoff WHERE workspace=OLD.workspace)
             BEGIN SELECT RAISE(ABORT,'permission source is frozen'); END;
             CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_{name}_update BEFORE UPDATE ON {table}
             WHEN EXISTS(SELECT 1 FROM engine_permission_handoff WHERE workspace=OLD.workspace OR workspace=NEW.workspace)
             BEGIN SELECT RAISE(ABORT,'permission source is frozen'); END;"
        ))?;
    }
    let frozen_run = "EXISTS(SELECT 1 FROM engine_permission_handoff h WHERE
             NOT EXISTS(SELECT 1 FROM engine_location l WHERE l.session_id=NEW.session_id)
             OR EXISTS(SELECT 1 FROM engine_location l WHERE l.session_id=NEW.session_id AND l.root=h.workspace))";
    connection.execute_batch(&format!(
        "CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_run BEFORE INSERT ON engine_run
         WHEN {frozen_run}
         BEGIN SELECT RAISE(ABORT,'permission source is frozen; shared execution backend required'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_run_update BEFORE UPDATE OF session_id,state ON engine_run
         WHEN NEW.state='running' AND {frozen_run}
         BEGIN SELECT RAISE(ABORT,'permission source is frozen; shared execution backend required'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_location_insert BEFORE INSERT ON engine_location
         WHEN EXISTS(SELECT 1 FROM engine_permission_handoff WHERE workspace=NEW.root)
              AND EXISTS(SELECT 1 FROM engine_run WHERE session_id=NEW.session_id AND state='running')
         BEGIN SELECT RAISE(ABORT,'permission source is frozen; shared execution backend required'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_location_update BEFORE UPDATE ON engine_location
         WHEN EXISTS(SELECT 1 FROM engine_permission_handoff WHERE workspace=NEW.root)
              AND EXISTS(SELECT 1 FROM engine_run WHERE session_id=NEW.session_id AND state='running')
         BEGIN SELECT RAISE(ABORT,'permission source is frozen; shared execution backend required'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_no_delete BEFORE DELETE ON engine_permission_handoff
         BEGIN SELECT RAISE(ABORT,'permission source handoff cannot be aborted'); END;
         CREATE TRIGGER IF NOT EXISTS engine_permission_handoff_immutable BEFORE UPDATE ON engine_permission_handoff
         WHEN OLD.state!='prepared' OR NEW.state!='completed' OR NEW.workspace!=OLD.workspace
              OR json_remove(NEW.data,'$.state')!=json_remove(OLD.data,'$.state')
         BEGIN SELECT RAISE(ABORT,'permission source handoff identity is immutable'); END;"
    ))?;
    Ok(())
}

impl Store {
    pub async fn directory_permission_source(
        &self,
        workspace: String,
    ) -> Result<Option<Record>, Error> {
        self.call(move |connection| load(connection, &workspace))
            .await
    }

    pub async fn prepare_directory_permission_source(
        &self,
        workspace: String,
        target: Target,
    ) -> Result<Record, Error> {
        require_target(&workspace, &target)?;
        let canonical = tokio::fs::canonicalize(&workspace).await?;
        if canonical.to_str() != Some(workspace.as_str())
            || !tokio::fs::metadata(canonical).await?.is_dir()
        {
            return Err(Error::Invalid(
                "permission source requires its canonical directory".into(),
            ));
        }
        self.call(move |connection| {
            let transaction = crate::store::write_tx(connection)?;
            if let Some(record) = load(&transaction, &workspace)? {
                if record.target != target { return Err(Error::Invalid("permission source destination changed".into())); }
                return Ok(record);
            }
            require_quiescent(&transaction, &workspace)?;
            let mut patterns = crate::permission_patterns::raw_records(&transaction, &workspace)?;
            patterns.sort_by(|left, right| left.id.cmp(&right.id));
            let fingerprint = fingerprint(&target, &patterns)?;
            let record = Record { workspace, target, patterns, fingerprint, state: State::Prepared };
            transaction.execute("INSERT INTO engine_permission_handoff(workspace,state,data) VALUES(?1,'prepared',?2)", params![record.workspace, serde_json::to_string(&record)?])?;
            transaction.commit()?;
            Ok(record)
        }).await
    }

    pub async fn complete_directory_permission_source(
        &self,
        workspace: String,
        snapshot: permission_context::Snapshot,
    ) -> Result<Record, Error> {
        self.call(move |connection| {
            let transaction = crate::store::write_tx(connection)?;
            let mut record = load(&transaction, &workspace)?
                .ok_or_else(|| Error::Invalid("permission source was not prepared".into()))?;
            record.require_destination(&snapshot)?;
            if record.state == State::Completed {
                return Ok(record);
            }
            record.state = State::Completed;
            transaction.execute(
                "UPDATE engine_permission_handoff SET state='completed',data=?2 WHERE workspace=?1",
                params![workspace, serde_json::to_string(&record)?],
            )?;
            transaction.commit()?;
            Ok(record)
        })
        .await
    }
}

impl Record {
    pub(crate) fn require_destination(
        &self,
        snapshot: &permission_context::Snapshot,
    ) -> Result<(), Error> {
        if snapshot.project.authority != self.target.authority
            || snapshot.project.project != self.target.project
            || snapshot.directory != self.target.directory
            || snapshot.workspace_id != self.target.workspace_id
            || snapshot.migration.as_ref().is_none_or(|receipt| {
                receipt.fingerprint != self.fingerprint || receipt.imported != self.patterns.len()
            })
        {
            return Err(Error::Invalid(
                "permission source destination receipt mismatch".into(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn require_legacy(connection: &Connection, workspace: &str) -> Result<(), Error> {
    let present: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_permission_handoff')", [], |row| row.get(0))?;
    if present && load(connection, workspace)?.is_some() {
        return Err(Error::Invalid(
            "permission source is frozen; use its shared destination".into(),
        ));
    }
    Ok(())
}

fn load(connection: &Connection, workspace: &str) -> Result<Option<Record>, Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT state,data FROM engine_permission_handoff WHERE workspace=?1",
            [workspace],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((state, data)) = row else {
        return Ok(None);
    };
    let record: Record = serde_json::from_str(&data)
        .map_err(|_| Error::Invalid("corrupt permission source handoff".into()))?;
    require_target(workspace, &record.target)?;
    let mut patterns = crate::permission_patterns::raw_records(connection, workspace)?;
    patterns.sort_by(|left, right| left.id.cmp(&right.id));
    let expected_state = match record.state {
        State::Prepared => "prepared",
        State::Completed => "completed",
    };
    if record.workspace != workspace
        || state != expected_state
        || record.patterns != patterns
        || record.fingerprint != fingerprint(&record.target, &patterns)?
    {
        return Err(Error::Invalid(
            "permission source handoff facts changed".into(),
        ));
    }
    Ok(Some(record))
}

fn require_target(workspace: &str, target: &Target) -> Result<(), Error> {
    crate::permission_patterns::require_workspace(workspace)?;
    crate::permission_migration::require_rules(&target.authority, &[])?;
    crate::permission_migration::require_rules(&target.project, &[])?;
    if target.directory != workspace || target.workspace_id.is_some() {
        return Err(Error::Invalid(
            "permission source requires matching implicit-local placement".into(),
        ));
    }
    Ok(())
}

fn fingerprint(target: &Target, patterns: &[Pattern]) -> Result<String, Error> {
    let location = serde_json::to_string(&(&target.directory, &target.workspace_id))?;
    permission_context::migration_fingerprint(&target.project, &location, patterns)
}

fn require_quiescent(connection: &Connection, workspace: &str) -> Result<(), Error> {
    let mut statement = connection.prepare("SELECT e.owner_pid FROM engine_run r LEFT JOIN engine_location l ON l.session_id=r.session_id LEFT JOIN engine_lease e ON e.session_id=r.session_id WHERE r.state='running' AND (l.root=?1 OR l.root IS NULL)")?;
    let owners = statement
        .query_map([workspace], |row| row.get::<_, Option<u32>>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if owners
        .into_iter()
        .any(|owner| owner.is_none_or(crate::store::pid_alive))
    {
        return Err(Error::Invalid(
            "permission source has an active or unowned run; wait for it to finish".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{State, Target};
    use crate::store::Store;
    use crate::{
        permission::Decision,
        permission_project::Authority,
        permission_rules::Rule,
        protocol::{Delivery, Input},
    };
    use rusqlite::Connection;

    fn rule(resource: &str) -> Rule {
        Rule {
            action: "read".into(),
            resource: resource.into(),
            effect: Decision::Allow,
        }
    }

    async fn fixture() -> (tempfile::TempDir, Store, String) {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let workspace = workspace
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let store = Store::open(directory.path().join("engine.db"))
            .await
            .unwrap();
        (directory, store, workspace)
    }

    fn target(workspace: &str) -> Target {
        Target {
            authority: "fixture-authority".into(),
            project: "project".into(),
            directory: workspace.into(),
            workspace_id: None,
        }
    }

    fn input(session: &str) -> Input {
        Input {
            session_id: session.into(),
            input_id: format!("{session}-input"),
            prompt: "durable only".into(),
            delivery: Delivery::Steer,
            command: None,
            agent_references: Default::default(),
        }
    }

    #[tokio::test]
    async fn source_prepare_destination_import_and_complete_survive_revocation_and_restart() {
        let (directory, source, workspace) = fixture().await;
        let first = source
            .put_permission_pattern(workspace.clone(), rule("a/**"))
            .await
            .unwrap();
        source
            .put_permission_pattern(workspace.clone(), rule("b/**"))
            .await
            .unwrap();
        let context = Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(&workspace, None)
            .await
            .unwrap();
        let initial = context.snapshot().await.unwrap();
        let target = Target {
            authority: initial.project.authority.clone(),
            ..target(&workspace)
        };
        let prepared = source
            .prepare_directory_permission_source(workspace.clone(), target.clone())
            .await
            .unwrap();
        assert_eq!(prepared.state, State::Prepared);
        assert_eq!(prepared.patterns.len(), 2);
        assert!(source
            .complete_directory_permission_source(workspace.clone(), initial)
            .await
            .is_err());
        let imported = context
            .handoff(target.authority.clone(), prepared.patterns.clone())
            .await
            .unwrap();
        assert_eq!(
            imported.migration.as_ref().unwrap().fingerprint,
            prepared.fingerprint
        );
        assert!(context.remove(first.id).await.unwrap());
        let revoked = context.snapshot().await.unwrap();
        // The destination committed but the source has not acknowledged it.
        source.close().await.unwrap();
        let source = Store::open(directory.path().join("engine.db"))
            .await
            .unwrap();
        assert_eq!(
            source
                .directory_permission_source(workspace.clone())
                .await
                .unwrap(),
            Some(prepared.clone())
        );
        assert_eq!(
            context
                .handoff(target.authority.clone(), prepared.patterns.clone())
                .await
                .unwrap(),
            revoked
        );
        let completed = source
            .complete_directory_permission_source(workspace.clone(), revoked.clone())
            .await
            .unwrap();
        assert_eq!(completed.state, State::Completed);
        assert_eq!(completed.patterns, prepared.patterns);
        assert_eq!(
            source
                .prepare_directory_permission_source(workspace.clone(), target.clone())
                .await
                .unwrap(),
            completed
        );
        assert_eq!(
            source
                .complete_directory_permission_source(workspace.clone(), revoked.clone())
                .await
                .unwrap(),
            completed
        );
        let mut wrong = revoked;
        wrong.project.authority = "replacement".into();
        assert!(source
            .complete_directory_permission_source(workspace.clone(), wrong)
            .await
            .is_err());
        assert!(source
            .prepare_directory_permission_source(
                workspace.clone(),
                Target {
                    authority: "replacement".into(),
                    ..target
                }
            )
            .await
            .is_err());
        source.close().await.unwrap();
        let reopened = Store::open(directory.path().join("engine.db"))
            .await
            .unwrap();
        assert_eq!(
            reopened
                .directory_permission_source(workspace.clone())
                .await
                .unwrap(),
            Some(completed)
        );
        assert!(reopened.permission_patterns(workspace).await.is_err());
        assert_eq!(context.snapshot().await.unwrap().patterns.len(), 1);
        reopened.close().await.unwrap();
    }

    #[tokio::test]
    async fn frozen_reads_writes_and_execution_refuse_while_other_scopes_and_admission_remain_available(
    ) {
        let (directory, source, workspace) = fixture().await;
        let other = directory.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let other = other.canonicalize().unwrap().to_str().unwrap().to_owned();
        let pattern = source
            .put_permission_pattern(workspace.clone(), rule("a/**"))
            .await
            .unwrap();
        source
            .project_saved_rules(workspace.clone(), vec![rule("project/**")])
            .await
            .unwrap();
        let prepared = source
            .prepare_directory_permission_source(workspace.clone(), target(&workspace))
            .await
            .unwrap();
        assert!(source.permission_patterns(workspace.clone()).await.is_err());
        assert!(source
            .permission_pattern_snapshot(workspace.clone())
            .await
            .is_err());
        assert!(source
            .permission_import_snapshot(workspace.clone())
            .await
            .is_err());
        assert!(source
            .put_permission_pattern(workspace.clone(), rule("b/**"))
            .await
            .is_err());
        assert!(source
            .remove_permission_pattern(workspace.clone(), pattern.id)
            .await
            .is_err());
        assert!(source
            .project_saved_rules(workspace.clone(), Vec::new())
            .await
            .is_err());
        for rules in [Vec::new(), vec![rule("late/**")]] {
            assert!(source
                .replace_saved_rules(workspace.clone(), rules)
                .await
                .is_err());
        }
        assert!(source
            .legacy_permission_migration(workspace.clone())
            .await
            .is_err());
        source
            .put_permission_pattern(other.clone(), rule("b/**"))
            .await
            .unwrap();
        source
            .replace_saved_rules(other.clone(), vec![rule("other/**")])
            .await
            .unwrap();
        source
            .admit_at(input("frozen"), Some(workspace.clone()))
            .await
            .unwrap();
        assert!(source.start_run("frozen", "frozen-run").await.is_err());
        source.admit_at(input("other"), Some(other)).await.unwrap();
        source.start_run("other", "other-run").await.unwrap();
        let connection = Connection::open(source.path()).unwrap();
        assert!(connection
            .execute(
                "UPDATE engine_owned_permission_rule_legacy SET created_at_ms=0 WHERE workspace=?1",
                [&workspace]
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM engine_permission_rule_legacy WHERE workspace=?1",
                [&workspace]
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE engine_location SET root=?1 WHERE session_id='other'",
                [&workspace]
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM engine_permission_handoff WHERE workspace=?1",
                [&workspace]
            )
            .is_err());
        assert!(connection.execute("UPDATE engine_permission_handoff SET state='completed',data='{}' WHERE workspace=?1", [&workspace]).is_err());
        assert_eq!(
            source.directory_permission_source(workspace).await.unwrap(),
            Some(prepared)
        );
        drop(connection);
        source.close().await.unwrap();
    }

    #[tokio::test]
    async fn active_and_unknown_run_owners_block_preparation_without_freezing_any_rules() {
        let (_directory, source, workspace) = fixture().await;
        source
            .put_permission_pattern(workspace.clone(), rule("a/**"))
            .await
            .unwrap();
        source
            .admit_at(input("s"), Some(workspace.clone()))
            .await
            .unwrap();
        source.start_run("s", "run").await.unwrap();
        assert!(source
            .prepare_directory_permission_source(workspace.clone(), target(&workspace))
            .await
            .is_err());
        let connection = Connection::open(source.path()).unwrap();
        connection.execute("INSERT INTO engine_lease(session_id,interval_ms,last_ms,epoch,owner_pid) VALUES('s',1,0,1,?1)", [std::process::id()]).unwrap();
        assert!(source
            .prepare_directory_permission_source(workspace.clone(), target(&workspace))
            .await
            .is_err());
        assert!(source
            .directory_permission_source(workspace.clone())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            source.permission_patterns(workspace).await.unwrap().len(),
            1
        );
        drop(connection);
        source.close().await.unwrap();
    }

    #[tokio::test]
    async fn failed_prepare_rolls_back_freeze_and_failed_complete_keeps_the_source_frozen() {
        let (directory, source, workspace) = fixture().await;
        source
            .put_permission_pattern(workspace.clone(), rule("a/**"))
            .await
            .unwrap();
        let context = Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap()
            .project("project".into())
            .unwrap()
            .context(&workspace, None)
            .await
            .unwrap();
        let target = Target {
            authority: context.snapshot().await.unwrap().project.authority,
            ..target(&workspace)
        };
        let connection = Connection::open(source.path()).unwrap();
        connection.execute_batch("CREATE TRIGGER fixture_fail_prepare BEFORE INSERT ON engine_permission_handoff BEGIN SELECT RAISE(ABORT,'fixture prepare failure'); END;").unwrap();
        assert!(source
            .prepare_directory_permission_source(workspace.clone(), target.clone())
            .await
            .is_err());
        assert!(source
            .directory_permission_source(workspace.clone())
            .await
            .unwrap()
            .is_none());
        source
            .put_permission_pattern(workspace.clone(), rule("b/**"))
            .await
            .unwrap();
        connection
            .execute_batch("DROP TRIGGER fixture_fail_prepare;")
            .unwrap();
        let prepared = source
            .prepare_directory_permission_source(workspace.clone(), target.clone())
            .await
            .unwrap();
        let imported = context
            .handoff(target.authority, prepared.patterns.clone())
            .await
            .unwrap();
        connection.execute_batch("CREATE TRIGGER fixture_fail_complete BEFORE UPDATE ON engine_permission_handoff BEGIN SELECT RAISE(ABORT,'fixture complete failure'); END;").unwrap();
        assert!(source
            .complete_directory_permission_source(workspace.clone(), imported.clone())
            .await
            .is_err());
        assert_eq!(
            source
                .directory_permission_source(workspace.clone())
                .await
                .unwrap(),
            Some(prepared)
        );
        assert!(source.permission_patterns(workspace.clone()).await.is_err());
        connection
            .execute_batch("DROP TRIGGER fixture_fail_complete;")
            .unwrap();
        assert_eq!(
            source
                .complete_directory_permission_source(workspace, imported)
                .await
                .unwrap()
                .state,
            State::Completed
        );
        drop(connection);
        source.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_frozen_source_retains_durable_input_without_starting_a_provider() {
        use crate::{
            permission::{Config, Policy},
            protocol::ModelRequest,
            provider::{Provider, ProviderError, Reply},
            runtime::Runtime,
            tools::Tools,
        };
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::sync::mpsc;
        use tokio_util::sync::CancellationToken;
        struct Counter(Arc<AtomicUsize>);
        #[async_trait::async_trait]
        impl Provider for Counter {
            async fn stream(
                &self,
                _: ModelRequest,
                _: mpsc::Sender<serde_json::Value>,
                _: CancellationToken,
            ) -> Result<Reply, ProviderError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(Reply {
                    content: serde_json::json!([]),
                    usage: serde_json::json!({}),
                    needs_tools: false,
                })
            }
        }
        let (_directory, source, workspace) = fixture().await;
        source
            .prepare_directory_permission_source(workspace.clone(), target(&workspace))
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let runtime = Runtime::with_policy(
            source.clone(),
            Arc::new(Counter(calls.clone())),
            Tools::new(&workspace).await.unwrap(),
            Policy::new(Config::default()).unwrap(),
        )
        .await
        .unwrap();
        let mut progress = runtime.progress();
        runtime.admit(input("frozen"), true).await.unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = progress.recv().await.unwrap();
                if event["kind"] == "runtime.error" {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("permission source is frozen"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let connection = Connection::open(source.path()).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM engine_input WHERE id='frozen-input'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM engine_message", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        runtime.shutdown().await;
        drop(runtime);
        source.close().await.unwrap();
    }
}
