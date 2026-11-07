use crate::approval::now_ms;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{
    fmt,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("credential was not found")]
    Missing,
    #[error("invalid or unsupported credential data")]
    Invalid,
    #[error("credential integration does not match the requested binding")]
    Integration,
    #[error("credential is expired; its owning broker must refresh it")]
    Expired,
    #[error("credential {id} ({integration}) is expired; its owning broker must refresh it")]
    ExpiredCredential { id: String, integration: String },
    #[error("credential refresh was rejected by the provider; re-login required")]
    RefreshRejected,
    #[error("credential source IO failed")]
    Io,
    #[error("unsupported or unavailable credential database")]
    Database,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Key,
    #[serde(rename = "oauth")]
    OAuth,
}

/// Intentionally not Serialize, and Debug never contains secret/account bytes.
#[derive(Clone)]
pub struct Credential {
    kind: Kind,
    secret: String,
    account: Option<String>,
    expires: Option<u64>,
}
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("kind", &self.kind)
            .field("expires", &self.expires)
            .field("secret", &"[redacted]")
            .finish()
    }
}
impl Credential {
    pub fn key(secret: String) -> Self {
        Self {
            kind: Kind::Key,
            secret,
            account: None,
            expires: None,
        }
    }
    pub fn token(secret: String, account: Option<String>) -> Self {
        Self {
            kind: Kind::OAuth,
            secret,
            account,
            expires: None,
        }
    }
    pub fn kind(&self) -> Kind {
        self.kind
    }
    pub(crate) fn secret(&self) -> &str {
        &self.secret
    }
    pub(crate) fn account(&self) -> Option<&str> {
        self.account.as_deref()
    }
    pub(crate) fn header(&self) -> Result<reqwest::header::HeaderValue, Error> {
        let mut header =
            reqwest::header::HeaderValue::from_str(&self.secret).map_err(|_| Error::Invalid)?;
        header.set_sensitive(true);
        Ok(header)
    }
    fn validate(&self) -> Result<(), Error> {
        if self.secret.is_empty()
            || self.secret.len() > 16384
            || reqwest::header::HeaderValue::from_str(&self.secret).is_err()
            || self.account.as_ref().is_some_and(|v| {
                v.len() > 4096 || reqwest::header::HeaderValue::from_str(v).is_err()
            })
        {
            return Err(Error::Invalid);
        }
        if self.expires.is_some_and(|expires| expires <= now_ms()) {
            return Err(Error::Expired);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub enum Source {
    /// The AWS SDK owns identity resolution and credential refresh for this
    /// profile. It is not a bearer credential and generic adapters cannot load it.
    Aws {
        region: String,
        profile: Option<String>,
    },
    Static(Credential),
    Database {
        path: PathBuf,
        id: String,
        integration: String,
    },
    Legacy {
        path: PathBuf,
        integration: String,
    },
    /// The standalone credential daemon owns this row's refresh; the engine
    /// is a client that re-reads through the socket each turn.
    Daemon {
        socket: PathBuf,
        id: String,
        integration: String,
    },
}
impl Source {
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Static(_) | Self::Aws { .. } => None,
            Self::Database { path, .. } | Self::Legacy { path, .. } => Some(path),
            Self::Daemon { socket, .. } => Some(socket),
        }
    }
    pub async fn validate(&self) -> Result<(), Error> {
        if let Self::Aws { region, profile } = self {
            if region.is_empty()
                || region.len() > 64
                || !region
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || profile.as_ref().is_some_and(|profile| {
                    profile.is_empty()
                        || profile.len() > 256
                        || profile.chars().any(char::is_control)
                })
            {
                return Err(Error::Invalid);
            }
            return Ok(());
        }
        self.load().await.map(|_| ())
    }
    /// Re-read at every provider turn. An owned database row follows its
    /// durable daemon marker before validating the stale snapshot's expiry.
    /// Unowned database and legacy sources stay read-only and keep their
    /// existing broker as refresh writer; no fallback competes with an owner.
    pub async fn load(&self) -> Result<Credential, Error> {
        #[cfg(any(unix, windows))]
        if let Self::Daemon {
            socket,
            id,
            integration,
        } = self
        {
            return load_daemon(socket, id, integration).await;
        }
        let source = self.clone();
        let (credential, owner, identity) = tokio::task::spawn_blocking(move || {
            let loaded = match source {
                Self::Static(credential) => (credential, None, None),
                Self::Daemon { .. } | Self::Aws { .. } => return Err(Error::Invalid),
                Self::Database {
                    path,
                    id,
                    integration,
                } => {
                    let connection = open(&path)?;
                    let row: Option<(String, String)> = connection
                        .query_row(
                            "SELECT integration_id,value FROM credential WHERE id=?1",
                            [&id],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()
                        .map_err(|_| Error::Database)?;
                    let (stored, encoded) = row.ok_or(Error::Missing)?;
                    if stored != integration {
                        return Err(Error::Integration);
                    }
                    if encoded.len() > 131072 {
                        return Err(Error::Invalid);
                    }
                    let value: Value =
                        serde_json::from_str(&encoded).map_err(|_| Error::Invalid)?;
                    let parsed = parse_bound(&value, &integration)?;
                    let owner = value["metadata"]["miaoCredentialSocket"]
                        .as_str()
                        .filter(|name| !name.is_empty())
                        .map(|name| (PathBuf::from(name), id.clone(), integration.clone()));
                    (parsed, owner, Some((id.clone(), integration.clone())))
                }
                Self::Legacy { path, integration } => {
                    let values = legacy(&path)?;
                    (
                        parse_bound(
                            values.get(&integration).ok_or(Error::Missing)?,
                            &integration,
                        )?,
                        None,
                        Some((integration.clone(), integration.clone())),
                    )
                }
            };
            Ok::<_, Error>(loaded)
        })
        .await
        .map_err(|_| Error::Io)??;
        if let Some((socket, id, integration)) = owner {
            #[cfg(any(unix, windows))]
            return load_daemon(&socket, &id, &integration).await;
            #[cfg(not(any(unix, windows)))]
            {
                let _ = (socket, id, integration);
                return Err(Error::Invalid);
            }
        }
        credential.validate().map_err(|error| match error {
            Error::Expired => match identity {
                Some((id, integration)) => Error::ExpiredCredential { id, integration },
                None => Error::Expired,
            },
            error => error,
        })?;
        Ok(credential)
    }
}
#[cfg(any(unix, windows))]
async fn load_daemon(socket: &Path, id: &str, integration: &str) -> Result<Credential, Error> {
    let credential = miao_credential::client::get(socket, id, integration)
        .await
        .map_err(|error| match error {
            miao_credential::Error::Missing => Error::Missing,
            miao_credential::Error::Integration => Error::Integration,
            miao_credential::Error::Invalid => Error::Invalid,
            miao_credential::Error::RefreshRejected => Error::RefreshRejected,
            _ => Error::Io,
        })?;
    let value = parse_bound(&credential, integration)?;
    value.validate().map_err(|error| match error {
        Error::Expired => Error::ExpiredCredential {
            id: id.to_owned(),
            integration: integration.to_owned(),
        },
        error => error,
    })?;
    Ok(value)
}

fn parse_bound(value: &Value, integration: &str) -> Result<Credential, Error> {
    let mut credential = parse(value)?;
    if integration == "github-copilot" && credential.kind == Kind::OAuth {
        // The device grant stores the long-lived GitHub token as refresh;
        // Copilot accepts it directly, without a secondary token exchange.
        // Legacy access-only entries already contain that token.
        if let Some(token) = value["refresh"].as_str().filter(|token| !token.is_empty()) {
            credential.secret = token.into();
        }
        if credential.expires == Some(0) {
            credential.expires = None;
        }
    }
    Ok(credential)
}

fn parse(value: &Value) -> Result<Credential, Error> {
    let credential = match value["type"].as_str() {
        Some("key" | "api") => Credential::key(value["key"].as_str().ok_or(Error::Invalid)?.into()),
        Some("oauth") => Credential {
            kind: Kind::OAuth,
            secret: value["access"].as_str().ok_or(Error::Invalid)?.into(),
            account: value["metadata"]["accountID"]
                .as_str()
                .or_else(|| value["accountId"].as_str())
                .map(str::to_owned),
            expires: Some(value["expires"].as_u64().ok_or(Error::Invalid)?),
        },
        _ => return Err(Error::Invalid),
    };
    Ok(credential)
}
fn open(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| Error::Database)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| Error::Database)?;
    Ok(conn)
}
fn legacy(path: &Path) -> Result<Value, Error> {
    let file = std::fs::File::open(path).map_err(|_| Error::Io)?;
    if !file.metadata().map_err(|_| Error::Io)?.is_file() {
        return Err(Error::Invalid);
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Io)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::Invalid);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)
}

#[derive(Serialize)]
pub struct Metadata {
    pub id: String,
    pub integration: String,
    pub label: String,
    pub kind: String,
    pub expires_at_ms: Option<u64>,
    pub expired: bool,
}
fn metadata(id: String, integration: String, label: String, value: &Value) -> Metadata {
    let parsed = parse_bound(value, &integration).ok();
    let expires = parsed.as_ref().and_then(|value| value.expires);
    Metadata {
        id,
        integration,
        label,
        kind: match parsed.as_ref().map(|c| c.kind) {
            Some(Kind::Key) => "key",
            Some(Kind::OAuth) => "oauth",
            None => "unsupported",
        }
        .into(),
        expires_at_ms: expires,
        expired: expires.is_some_and(|expires| expires <= now_ms()),
    }
}
/// Safe discovery: SQL/key values are consumed only for normalized type/expiry
/// metadata. There is no CLI/API that serializes raw Credential objects.
pub fn list_database(path: &Path) -> Result<Vec<Metadata>, Error> {
    let connection = open(path)?;
    let mut stmt=connection.prepare("SELECT id,integration_id,label,value FROM credential WHERE integration_id IS NOT NULL ORDER BY id LIMIT 1001").map_err(|_|Error::Database)?;
    let rows = stmt
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
        output.push(metadata(
            id,
            integration,
            label,
            &serde_json::from_str(&value).unwrap_or(Value::Null),
        ));
    }
    Ok(output)
}
pub fn list_legacy(path: &Path) -> Result<Vec<Metadata>, Error> {
    let values = legacy(path)?;
    let values = values.as_object().ok_or(Error::Invalid)?;
    if values.len() > 1000 {
        return Err(Error::Invalid);
    }
    Ok(values
        .iter()
        .map(|(id, value)| metadata(id.clone(), id.clone(), "legacy".into(), value))
        .collect())
}

/// Where an install keeps its credential store: the same data home and the same
/// file the engine falls back to when no host passes a credential source. A
/// client that offers to store a key has to write the file a plain engine start
/// will read, or the provider it just added stays unconfigured.
pub fn default_database() -> Option<PathBuf> {
    let root = std::env::var_os("MIAO_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(|dir| PathBuf::from(dir).join("miao")))
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/miao"))
        })?;
    Some(root.join("miao.db"))
}

/// Store one API-key credential and answer the metadata a listing shows. The
/// same integration and label are replaced rather than piling rows up, which is
/// what re-entering a key means.
pub fn store_key(
    path: &Path,
    integration: &str,
    key: &str,
    account: Option<&str>,
) -> Result<Metadata, Error> {
    let integration = integration.trim();
    if integration.is_empty()
        || integration.len() > 128
        || !integration
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(Error::Invalid);
    }
    if key.trim().is_empty() || key.len() > 65_536 {
        return Err(Error::Invalid);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| Error::Io)?;
    }
    let label = account
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("default")
        .to_string();
    let id = credential_id();
    let value = serde_json::json!({ "type": "key", "key": key }).to_string();
    let now = now_ms() as i64;
    let connection = Connection::open(path).map_err(|_| Error::Database)?;
    // A fresh machine has no store yet: storing has to be able to create it, the
    // same way `miao auth login` bootstraps the first credential.
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS credential(id text primary key, integration_id text, label text, value text, active integer, time_created integer, time_updated integer)",
            [],
        )
        .map_err(|_| Error::Database)?;
    connection
        .execute(
            "DELETE FROM credential WHERE integration_id=?1 AND label=?2",
            rusqlite::params![integration, label],
        )
        .map_err(|_| Error::Database)?;
    connection
        .execute(
            "INSERT INTO credential(id,integration_id,label,value,active,time_created,time_updated) VALUES(?1,?2,?3,?4,1,?5,?5)",
            rusqlite::params![id, integration, label, value, now],
        )
        .map_err(|_| Error::Database)?;
    Ok(Metadata {
        id,
        integration: integration.to_string(),
        label,
        kind: "key".into(),
        expires_at_ms: None,
        expired: false,
    })
}

/// Remove the credentials stored for an integration — every account, or the
/// one label — and answer how many rows went away.
///
/// Updating a key is `store_key` under the same label, so it replaces rather
/// than piles up; deleting is this. Both live beside the store so a UI and
/// `miao auth logout` cannot disagree about what "delete the key" means.
pub fn remove_key(path: &Path, integration: &str, label: Option<&str>) -> Result<usize, Error> {
    let integration = integration.trim();
    if integration.is_empty()
        || integration.len() > 128
        || !integration
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(Error::Invalid);
    }
    // Deleting from a store that was never created must not create one.
    if !path.is_file() {
        return Ok(0);
    }
    let connection = Connection::open(path).map_err(|_| Error::Database)?;
    let removed = match label.map(str::trim).filter(|label| !label.is_empty()) {
        Some(label) => connection.execute(
            "DELETE FROM credential WHERE integration_id=?1 AND label=?2",
            rusqlite::params![integration, label],
        ),
        None => connection.execute(
            "DELETE FROM credential WHERE integration_id=?1",
            rusqlite::params![integration],
        ),
    }
    .map_err(|_| Error::Database)?;
    Ok(removed)
}

/// A credential identity in the shape the store already uses.
fn credential_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    // Two keys stored inside one clock tick would otherwise hash the same
    // identifier and the second insert would collide on the primary key.
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut seed = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32)
        .wrapping_add(sequence.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let mut id = String::from("cred_");
    for _ in 0..26 {
        id.push(ALPHABET[(seed % ALPHABET.len() as u64) as usize] as char);
        seed = (seed / ALPHABET.len() as u64) ^ seed.rotate_left(7);
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Storing a key has to leave the store readable by the engine: one row per
    /// (integration, label), replaced rather than piled up, and the same
    /// metadata a listing shows.
    #[test]
    fn a_stored_key_is_listed_and_replaces_the_same_label() {
        let dir = std::env::temp_dir().join(format!("miao-credential-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("miao.db");
        let first = store_key(&path, "commandcode", "sk-one", None).expect("store");
        assert_eq!(first.label, "default");
        assert_eq!(first.kind, "key");
        let named = store_key(&path, "commandcode", "sk-two", Some("work")).expect("store");
        assert_eq!(named.label, "work");
        let replaced = store_key(&path, "commandcode", "sk-three", None).expect("store");
        assert_ne!(
            replaced.id, first.id,
            "a re-entered key is a new credential"
        );
        let listed = list_database(&path).expect("list");
        assert_eq!(listed.len(), 2, "one default and one named account");
        assert_eq!(
            listed
                .iter()
                .filter(|entry| entry.label == "default")
                .count(),
            1
        );
        assert!(listed
            .iter()
            .all(|entry| entry.integration == "commandcode"));
        assert!(store_key(&path, "bad integration", "sk", None).is_err());
        assert!(store_key(&path, "commandcode", "   ", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting is the counterpart of storing: one label goes on its own, the
    /// integration goes whole, and a store that was never created stays absent
    /// instead of being conjured up empty.
    #[test]
    fn a_removed_key_leaves_the_other_accounts_alone() {
        let dir = std::env::temp_dir().join(format!("miao-credential-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("miao.db");
        assert_eq!(
            remove_key(&path, "zhipuai-coding-plan", None).expect("absent store"),
            0
        );
        assert!(!path.exists(), "deleting must not create the store");
        store_key(&path, "zhipuai-coding-plan", "sk-one", None).expect("store");
        store_key(&path, "zhipuai-coding-plan", "sk-two", Some("work")).expect("store");
        store_key(&path, "deepseek", "sk-three", None).expect("store");
        assert_eq!(
            remove_key(&path, "zhipuai-coding-plan", Some("work")).expect("remove"),
            1
        );
        let listed = list_database(&path).expect("list");
        assert_eq!(listed.len(), 2, "one zhipu account and one deepseek key");
        assert_eq!(
            remove_key(&path, "zhipuai-coding-plan", None).expect("remove"),
            1
        );
        assert_eq!(
            remove_key(&path, "zhipuai-coding-plan", None).expect("gone"),
            0
        );
        assert_eq!(list_database(&path).expect("list").len(), 1);
        assert!(remove_key(&path, "bad integration", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
