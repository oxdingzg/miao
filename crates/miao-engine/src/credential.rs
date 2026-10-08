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
}
impl Source {
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Static(_) => None,
            Self::Database { path, .. } | Self::Legacy { path, .. } => Some(path),
        }
    }
    /// Read again at each provider turn. The existing broker remains the only
    /// refresh writer; no rotation, migration or in-place credential mutation.
    pub async fn load(&self) -> Result<Credential, Error> {
        let source = self.clone();
        tokio::task::spawn_blocking(move || {
            let credential = match source {
                Self::Static(credential) => credential,
                Self::Database {
                    path,
                    id,
                    integration,
                } => {
                    let connection = open(&path)?;
                    let row: Option<(String, String)> = connection
                        .query_row(
                            "SELECT integration_id,value FROM credential WHERE id=?1",
                            [id],
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
                    parse(&serde_json::from_str::<Value>(&value).map_err(|_| Error::Invalid)?)?
                }
                Self::Legacy { path, integration } => {
                    let values = legacy(&path)?;
                    parse(values.get(&integration).ok_or(Error::Missing)?)?
                }
            };
            credential.validate()?;
            Ok(credential)
        })
        .await
        .map_err(|_| Error::Io)?
    }
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
    let parsed = parse(value).ok();
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
