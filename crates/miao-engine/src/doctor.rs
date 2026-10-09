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
        "provider_transports":["anthropic","openai-chat","openai-responses","subscription-responses","gemini"],
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
        return Err(Error::Invalid("unsupported database schema version".into()));
    }
    let integrity: String = tx.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
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
    let report = json!({
        "application_id":application_id,"schema_version":schema,"upgrade_required":schema<SCHEMA_VERSION,
        "integrity":{"ok":integrity=="ok","detail":integrity.chars().take(200).collect::<String>()},
        "sessions":count("engine_session")?,"events":count("engine_event")?,"messages":count("engine_message")?,
        "inputs":states("SELECT state,count(*) FROM engine_input GROUP BY state")?,
        "runs":states("SELECT state,count(*) FROM engine_run GROUP BY state")?,
        "tools":states("SELECT state,count(*) FROM engine_tool GROUP BY state")?,
    });
    tx.commit()?;
    Ok(report)
}
