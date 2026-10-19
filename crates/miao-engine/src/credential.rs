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
        let (credential, owner) = tokio::task::spawn_blocking(move || {
            let loaded = match source {
                Self::Static(credential) => (credential, None),
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
                        .map(|name| (PathBuf::from(name), id, integration));
                    (parsed, owner)
                }
                Self::Legacy { path, integration } => {
                    let values = legacy(&path)?;
                    (
                        parse_bound(
                            values.get(&integration).ok_or(Error::Missing)?,
                            &integration,
                        )?,
                        None,
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
        credential.validate()?;
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
    value.validate()?;
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
