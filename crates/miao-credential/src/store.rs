//! SQLite access for the daemon: read a credential row, write refreshed token
//! fields back in place.
//!
//! The row's `value` JSON is patched field-by-field (`access`, `expires`,
//! `refresh`) so fields the daemon does not understand (`methodID`,
//! `metadata`, future additions) survive a rotation untouched.

use crate::Error;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::path::Path;

/// Discovery row: normalized metadata only. Token, refresh, and account
/// fields are never serialized through this path, matching the engine's
/// read-only `credentials` listing.
#[derive(serde::Serialize)]
pub struct Metadata {
    pub id: String,
    pub integration: String,
    pub label: String,
    pub kind: String,
    pub expires_at_ms: Option<u64>,
    pub expired: bool,
}

/// Lists the daemon's rows with normalized type/expiry metadata. The hard
/// row and field-size caps mirror the engine's read-only bridge.
pub fn discover(path: &Path) -> Result<Vec<Metadata>, Error> {
    let connection = open(path)?;
    let mut statement = connection
        .prepare(
            "SELECT id,integration_id,label,value FROM credential \
             WHERE integration_id IS NOT NULL ORDER BY id LIMIT 1001",
        )
        .map_err(|_| Error::Database)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| Error::Database)?;
    let mut output = Vec::new();
    for row in rows {
        let (id, integration, label, value) = row.map_err(|_| Error::Database)?;
        if output.len() >= 1000 || id.len() > 256 || label.len() > 1024 || value.len() > 131072 {
            return Err(Error::Invalid);
        }
        let parsed: Value = serde_json::from_str(&value).unwrap_or(Value::Null);
        let kind = parsed.get("type").and_then(Value::as_str);
        let expires = parsed.get("expires").and_then(Value::as_u64);
        output.push(Metadata {
            id,
            integration: integration.clone(),
            label,
            kind: match kind {
                Some("key" | "api") => "key".into(),
                Some("oauth") => "oauth".into(),
                _ => "unsupported".into(),
            },
            expires_at_ms: expires,
            expired: expires.is_some_and(|expires| expires <= now_ms())
                && !(integration == "github-copilot" && expires == Some(0)),
        });
    }
    Ok(output)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Opened read-write: the daemon, not the client, decides when to write.
fn open(path: &Path) -> Result<Connection, Error> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| Error::Database)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| Error::Database)?;
    Ok(connection)
}

/// Reads the raw stored `value` for one row and checks the integration
/// binding, mirroring the engine's read-only bridge.
pub fn load(path: &Path, credential_id: &str, integration: &str) -> Result<Value, Error> {
    if credential_id.is_empty() || credential_id.len() > 256 {
        return Err(Error::Invalid);
    }
    let connection = open(path)?;
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT integration_id,value FROM credential WHERE id=?1",
            [credential_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| Error::Database)?;
    let (stored, value) = row.ok_or(Error::Missing)?;
    if stored != integration {
        return Err(Error::Integration);
    }
    if value.len() > 131072 {
        return Err(Error::Invalid);
    }
    let parsed = serde_json::from_str::<Value>(&value).map_err(|_| Error::Invalid)?;
    if !parsed.is_object() {
        return Err(Error::Invalid);
    }
    Ok(parsed)
}

/// Ownership is durable. Ordinary writers cannot update/delete an owned row;
/// the daemon temporarily releases the guard only inside its write transaction.
pub fn ensure_ownership(path: &Path) -> Result<(), Error> {
    open(path)?.execute_batch("CREATE TABLE IF NOT EXISTS credential_daemon_owner(credential_id TEXT PRIMARY KEY, socket TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS credential_daemon_update_guard BEFORE UPDATE ON credential
        WHEN EXISTS(SELECT 1 FROM credential_daemon_owner WHERE credential_id=OLD.id)
        BEGIN SELECT RAISE(ABORT,'credential is daemon-owned'); END;
        CREATE TRIGGER IF NOT EXISTS credential_daemon_delete_guard BEFORE DELETE ON credential
        WHEN EXISTS(SELECT 1 FROM credential_daemon_owner WHERE credential_id=OLD.id)
        BEGIN SELECT RAISE(ABORT,'credential is daemon-owned'); END;")
        .map_err(|_| Error::Database)?;
    Ok(())
}

pub fn claim(path: &Path, id: &str, integration: &str, socket: &str) -> Result<(), Error> {
    ensure_ownership(path)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Database)?;
    let (stored, encoded): (String, String) = transaction
        .query_row(
            "SELECT integration_id,value FROM credential WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| Error::Database)?
        .ok_or(Error::Missing)?;
    if stored != integration {
        return Err(Error::Integration);
    }
    let mut value: Value = serde_json::from_str(&encoded).map_err(|_| Error::Invalid)?;
    if !value.is_object() {
        return Err(Error::Invalid);
    }
    if value.get("metadata").is_none_or(Value::is_null) {
        value["metadata"] = serde_json::json!({});
    }
    if !value["metadata"].is_object() {
        return Err(Error::Invalid);
    }
    value["metadata"]["miaoCredentialSocket"] = socket.into();
    transaction
        .execute(
            "DELETE FROM credential_daemon_owner WHERE credential_id=?1",
            [id],
        )
        .map_err(|_| Error::Database)?;
    transaction
        .execute(
            "UPDATE credential SET value=?1 WHERE id=?2",
            rusqlite::params![value.to_string(), id],
        )
        .map_err(|_| Error::Database)?;
    transaction
        .execute(
            "INSERT INTO credential_daemon_owner VALUES(?1,?2)",
            rusqlite::params![id, socket],
        )
        .map_err(|_| Error::Database)?;
    transaction.commit().map_err(|_| Error::Database)
}

/// Writes refreshed token fields back into one row's stored JSON. Unknown
/// fields are preserved; `metadata` is never touched.
pub fn store_refreshed(
    path: &Path,
    credential_id: &str,
    integration: &str,
    value: Value,
) -> Result<(), Error> {
    let encoded = serde_json::to_string(&value).map_err(|_| Error::Invalid)?;
    if encoded.len() > 131072 {
        return Err(Error::Invalid);
    }
    ensure_ownership(path)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Database)?;
    let owner: Option<String> = transaction
        .query_row(
            "SELECT socket FROM credential_daemon_owner WHERE credential_id=?1",
            [credential_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| Error::Database)?;
    if let Some(socket) = &owner {
        if value["metadata"]["miaoCredentialSocket"].as_str() != Some(socket) {
            return Err(Error::Invalid);
        }
        transaction
            .execute(
                "DELETE FROM credential_daemon_owner WHERE credential_id=?1",
                [credential_id],
            )
            .map_err(|_| Error::Database)?;
    }
    let changed = transaction
        .execute(
            "UPDATE credential SET value=?1 WHERE id=?2 AND integration_id=?3",
            rusqlite::params![encoded, credential_id, integration],
        )
        .map_err(|_| Error::Database)?;
    if changed == 0 {
        return Err(Error::Missing);
    }
    if let Some(socket) = owner {
        transaction
            .execute(
                "INSERT INTO credential_daemon_owner VALUES(?1,?2)",
                rusqlite::params![credential_id, socket],
            )
            .map_err(|_| Error::Database)?;
    }
    transaction.commit().map_err(|_| Error::Database)
}

/// Insert a newly authorized credential; never overwrite an existing identity.
pub fn insert_login(
    path: &Path,
    id: &str,
    integration: &str,
    label: &str,
    value: &Value,
    socket: &str,
) -> Result<(), Error> {
    if id.is_empty() || id.len() > 256 || label.len() > 1024 {
        return Err(Error::Invalid);
    }
    let mut value = value.clone();
    if value.get("metadata").is_none_or(Value::is_null) {
        value["metadata"] = serde_json::json!({});
    }
    if !value["metadata"].is_object() {
        return Err(Error::Invalid);
    }
    value["metadata"]["miaoCredentialSocket"] = socket.into();
    let encoded = serde_json::to_string(&value).map_err(|_| Error::Invalid)?;
    if encoded.len() > 131072 {
        return Err(Error::Invalid);
    }
    ensure_ownership(path)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Database)?;
    transaction.execute("INSERT INTO credential(id,integration_id,label,value,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?5)",
        rusqlite::params![id,integration,label,encoded,now_ms()]).map_err(|_| Error::Database)?;
    transaction
        .execute(
            "INSERT INTO credential_daemon_owner VALUES(?1,?2)",
            rusqlite::params![id, socket],
        )
        .map_err(|_| Error::Database)?;
    transaction.commit().map_err(|_| Error::Database)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("miao.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO credential VALUES ('cred_1','openai','Work','{\"type\":\"oauth\",\"access\":\"a1\",\"refresh\":\"r1\",\"expires\":1,\"methodID\":\"chatgpt-browser\",\"metadata\":{\"accountID\":\"acct\"}}')",
                [],
            )
            .unwrap();
        (dir, path)
    }

    #[test]
    fn load_checks_integration_and_returns_value() {
        let (_dir, path) = setup();
        let value = load(&path, "cred_1", "openai").unwrap();
        assert_eq!(value["access"], "a1");
        assert_eq!(load(&path, "cred_1", "anthropic"), Err(Error::Integration));
        assert_eq!(load(&path, "cred_missing", "openai"), Err(Error::Missing));
    }

    #[test]
    fn store_refreshed_patches_token_fields_and_keeps_the_rest() {
        let (_dir, path) = setup();
        let mut value = load(&path, "cred_1", "openai").unwrap();
        value["access"] = "a2".into();
        value["expires"] = 4_000.into();
        value["refresh"] = "r2".into();
        store_refreshed(&path, "cred_1", "openai", value).unwrap();

        let reread = load(&path, "cred_1", "openai").unwrap();
        assert_eq!(reread["access"], "a2");
        assert_eq!(reread["refresh"], "r2");
        assert_eq!(reread["expires"], 4_000);
        // Fields the daemon does not manage survive a rotation.
        assert_eq!(reread["methodID"], "chatgpt-browser");
        assert_eq!(reread["metadata"]["accountID"], "acct");
    }

    #[test]
    fn store_refreshed_requires_the_row_to_still_exist() {
        let (_dir, path) = setup();
        let missing = serde_json::json!({"type": "oauth"});
        assert_eq!(
            store_refreshed(&path, "cred_gone", "openai", missing),
            Err(Error::Missing)
        );
    }

    #[test]
    fn handoff_blocks_plain_writers_but_allows_owner_rotation() {
        let (_dir, path) = setup();
        claim(&path, "cred_1", "openai", "/tmp/owner.sock").unwrap();
        let connection = Connection::open(&path).unwrap();
        assert!(connection
            .execute("UPDATE credential SET value='{}' WHERE id='cred_1'", [])
            .is_err());
        assert!(connection
            .execute("DELETE FROM credential WHERE id='cred_1'", [])
            .is_err());
        let mut value = load(&path, "cred_1", "openai").unwrap();
        assert_eq!(value["metadata"]["accountID"], "acct");
        assert_eq!(value["metadata"]["miaoCredentialSocket"], "/tmp/owner.sock");
        value["access"] = "rotated".into();
        store_refreshed(&path, "cred_1", "openai", value.clone()).unwrap();
        assert_eq!(
            load(&path, "cred_1", "openai").unwrap()["access"],
            "rotated"
        );
        // A failed update must restore the durable guard on rollback.
        assert_eq!(
            store_refreshed(&path, "cred_1", "wrong", value),
            Err(Error::Missing)
        );
        assert!(connection
            .execute("DELETE FROM credential WHERE id='cred_1'", [])
            .is_err());
    }
}
