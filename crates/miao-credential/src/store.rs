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
            integration,
            label,
            kind: match kind {
                Some("key" | "api") => "key".into(),
                Some("oauth") => "oauth".into(),
                _ => "unsupported".into(),
            },
            expires_at_ms: expires,
            expired: expires.is_some_and(|expires| expires <= now_ms()),
        });
    }
    Ok(output)
}

fn now_ms() -> u64 {
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
    let connection = open(path)?;
    let changed = connection
        .execute(
            "UPDATE credential SET value=?1 WHERE id=?2 AND integration_id=?3",
            rusqlite::params![encoded, credential_id, integration],
        )
        .map_err(|_| Error::Database)?;
    if changed == 0 {
        return Err(Error::Missing);
    }
    Ok(())
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
}
