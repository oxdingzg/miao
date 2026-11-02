use crate::{
    protocol::Error,
    store::{APPLICATION_ID, SCHEMA_VERSION},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;

/// Host-requested diagnostics never claim the store lease, admit prompts or
/// reconcile executions. Inspection remains available while an owner is active.
pub fn report(path: Option<&Path>) -> Result<Value, Error> {
    let database = path.map(inspect).transpose()?;
    Ok(json!({
        "version":env!("MIAO_ENGINE_VERSION"),
        "platform":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},
        "sandbox":{"available":crate::process::enforced()},
        "provider_transports":["anthropic","openai-chat","openai-responses","subscription-responses","gemini","amazon-bedrock"],
        "database":database,
        "scope":"local diagnostics; network, credential validity and task quality are not probed",
    }))
}
fn inspect(path: &Path) -> Result<Value, Error> {
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    let tx = connection.transaction()?;
    let application_id: u32 = tx.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let schema: u32 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(Error::Invalid("not a miao-engine database".into()));
    }
    if schema > SCHEMA_VERSION {
        return Err(Error::Invalid(format!(
            "database schema {schema} was written by a newer miao-engine (this binary supports {SCHEMA_VERSION}); reinstall the newer release"
        )));
    }
    let integrity: String = tx.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    // A WAL ledger keeps recent commits beside the main file; the sidecar sizes
    // are the cheap signal that a checkpoint is overdue or an owner died with
    // the log unmerged, before anything more invasive is tried.
    let sidecar = |suffix: &str| -> u64 {
        std::fs::metadata(format!("{}{suffix}", path.display()))
            .map(|meta| meta.len())
            .unwrap_or(0)
    };
    // quick_check walks the b-trees only shallowly; the foreign-key sweep is
    // what catches a row pointing at a parent that a repair already deleted.
    let mut fk_examples: Vec<Value> = Vec::new();
    let mut fk_violations: u64 = 0;
    {
        let mut statement = tx.prepare("PRAGMA foreign_key_check")?;
        let rows = statement.query_map([], |row| {
            // The second column is the offending rowid, which SQLite hands
            // back as an integer even for TEXT-primary-key tables.
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.to_string(),
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (table, row_id, parent) = row?;
            fk_violations += 1;
            if fk_examples.len() < 5 {
                fk_examples.push(json!({"table":table,"row":row_id,"parent":parent}));
            }
        }
    }
    let count = |table: &str| -> Result<u64, Error> {
        Ok(
            tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })?,
        )
    };
    let states = |sql: &str| -> Result<Value, Error> {
        let mut stmt = tx.prepare(sql)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })?;
        let mut result = serde_json::Map::new();
        for row in rows {
            let (state, count) = row?;
            result.insert(state, json!(count));
        }
        Ok(Value::Object(result))
    };
    // Transfer bookkeeping arrived with its own migration, so an older ledger
    // simply lacks the tables; absence is reported, not an error.
    let has_table = |name: &str| -> Result<bool, Error> {
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )?)
    };
    let transfers = if has_table("engine_transfer_import")? {
        let imports = states("SELECT state,count(*) FROM engine_transfer_import GROUP BY state")?;
        json!({"imports":imports})
    } else {
        json!({"imports":"absent"})
    };
    let migrations = if has_table("engine_migration")? {
        states("SELECT state,count(*) FROM engine_migration GROUP BY state")?
    } else {
        json!("absent")
    };
    let report = json!({
        "application_id":application_id,"schema_version":schema,"upgrade_required":schema<SCHEMA_VERSION,
        "integrity":{"ok":integrity=="ok","detail":integrity.chars().take(200).collect::<String>()},
        "wal":{"bytes":sidecar("-wal"),"shm_bytes":sidecar("-shm")},
        "foreign_keys":{"ok":fk_violations==0,"violations":fk_violations,"examples":fk_examples},
        "sessions":count("engine_session")?,"events":count("engine_event")?,"messages":count("engine_message")?,
        "inputs":states("SELECT state,count(*) FROM engine_input GROUP BY state")?,
        "runs":states("SELECT state,count(*) FROM engine_run GROUP BY state")?,
        "tools":states("SELECT state,count(*) FROM engine_tool GROUP BY state")?,
        "transfers":transfers,"migrations":migrations,
    });
    tx.commit()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::report;
    use serde_json::Value;

    #[test]
    fn the_report_covers_the_wal_foreign_key_and_transfer_matrix() {
        // A real store, not a fixture of hand-written tables: the doctor's SQL
        // has to hold against the schema the engine actually migrates.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.db");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let _store = crate::store::Store::open(&path).await.expect("store");
        });
        let report = report(Some(&path)).expect("report");
        let database = report
            .get("database")
            .expect("database block")
            .as_object()
            .expect("object");

        let wal = database.get("wal").expect("wal block");
        assert!(wal.get("bytes").is_some() && wal.get("shm_bytes").is_some(), "{wal}");
        let foreign_keys = database.get("foreign_keys").expect("foreign key block");
        assert_eq!(
            foreign_keys.get("ok").and_then(Value::as_bool),
            Some(true),
            "a fresh store has no dangling rows: {foreign_keys}"
        );
        let transfers = database.get("transfers").expect("transfer block");
        assert!(transfers.get("imports").is_some(), "{transfers}");
        assert!(
            database.get("migrations").is_some_and(|value| !value.is_string()),
            "a migrated store has the engine_migration table: {database:?}"
        );
    }

    #[test]
    fn a_foreign_key_violation_is_reported_with_examples() {
        // quick_check passes a ledger whose rows point at deleted parents; the
        // foreign-key sweep is the check that must catch it, so the test walks
        // the real check against a deliberately broken store.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.db");
        {
            let connection = rusqlite::Connection::open(&path).expect("create");
            connection
                .execute_batch(&format!(
                    "PRAGMA application_id={};",
                    crate::store::APPLICATION_ID
                ))
                .expect("application id");
            // A live connection refuses the dangling insert, so the fixture
            // writes the way a broken ledger actually got that way: enforcement
            // off during a repair, row left behind.
            connection.execute_batch(
                    "CREATE TABLE engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'build'); \
                     CREATE TABLE engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq)); \
                     CREATE TABLE engine_message(session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(session_id,seq)); \
                     CREATE TABLE engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL); \
                     CREATE TABLE engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL); \
                     CREATE TABLE engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL); \
                     PRAGMA foreign_keys=OFF; \
                     INSERT INTO engine_event VALUES ('ghost', 1, 'orphan', '{}');",
                )
                .expect("seed a dangling event");
        }
        let report = report(Some(&path)).expect("report");
        let foreign_keys = report
            .get("database")
            .and_then(|database| database.get("foreign_keys"))
            .and_then(|block| block.as_object())
            .expect("foreign key block");
        assert_eq!(foreign_keys.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            foreign_keys.get("violations").and_then(Value::as_u64),
            Some(1),
            "{foreign_keys:?}"
        );
    }
}
