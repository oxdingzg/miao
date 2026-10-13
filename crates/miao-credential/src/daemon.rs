//! The daemon itself: a unix-socket loop that owns the read-refresh-write
//! critical region for the rows it serves.
//!
//! Concurrency model: the daemon is the only writer, so there is no
//! cross-process lock to get right. Concurrent requests for the same row
//! serialize on a per-row mutex and share the single refresh; the SQLite
//! `busy_timeout` only covers the migration window where the legacy broker
//! may still touch rows the daemon does not own yet.

use crate::protocol::{self, Frame, Request};
use crate::store;
use crate::{profile, Error, REFRESH_MARGIN_MS};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

pub struct Daemon {
    db: PathBuf,
    profile: profile::Profile,
    margin_ms: u64,
    user_agent: String,
    row_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Daemon {
    pub fn new(db: PathBuf, profile: profile::Profile, user_agent: String) -> Self {
        Self {
            db,
            profile,
            margin_ms: REFRESH_MARGIN_MS,
            user_agent,
            row_locks: Mutex::new(HashMap::new()),
        }
    }

    /// The CLI exposes the margin so a deployment can trade token lifetime
    /// against refresh traffic; tests tighten it to reach the auto-refresh
    /// branch with fixtures that are seconds from expiry.
    pub fn with_margin_ms(mut self, margin_ms: u64) -> Self {
        self.margin_ms = margin_ms;
        self
    }

    /// Serves until the listener fails. Each connection is handled to
    /// completion before the next is accepted: the protocol is one
    /// request/one reply per line, and clients are local trusted processes.
    pub async fn serve(self: Arc<Self>, listener: UnixListener) -> std::io::Result<()> {
        loop {
            let (stream, _address) = listener.accept().await?;
            let daemon = self.clone();
            tokio::spawn(async move {
                // A connection that dies mid-frame just goes away; the next
                // turn reconnects. Nothing is half-written: every SQLite
                // write is a single statement.
                let _ = daemon.handle_connection(stream).await;
            });
        }
    }

    async fn handle_connection(&self, stream: UnixStream) -> std::io::Result<()> {
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let reply = match protocol::parse(&line) {
                Ok(frame) => self.dispatch(frame).await,
                Err(error) => protocol::err(0, &error),
            };
            writer.write_all(reply.as_bytes()).await?;
            writer.flush().await?;
        }
        Ok(())
    }

    async fn dispatch(&self, frame: Frame) -> String {
        match frame.request {
            Request::Get {
                credential_id,
                integration,
            } => {
                let payload = self.get(&credential_id, &integration).await.map(
                    |value| serde_json::json!({ "credential": value, "integration": integration }),
                );
                reply(frame.id, payload)
            }
            Request::Refresh {
                credential_id,
                integration,
            } => {
                let payload = self
                    .refresh_row(&credential_id, &integration)
                    .await
                    .map(|expires| serde_json::json!({ "expires": expires }));
                reply(frame.id, payload)
            }
            Request::Discover => {
                let payload = store::discover(&self.db).map(|rows| {
                    serde_json::to_value(rows).unwrap_or_else(|_| serde_json::json!([]))
                });
                reply(frame.id, payload)
            }
        }
    }

    /// Returns the stored credential, refreshing it first when it sits inside
    /// the refresh margin. Callers re-read the row each turn exactly as the
    /// read-only bridge did; the daemon just guarantees what they read is
    /// fresh enough to survive a turn.
    async fn get(&self, credential_id: &str, integration: &str) -> Result<Value, Error> {
        let value = store::load(&self.db, credential_id, integration)?;
        let expires = value.get("expires").and_then(Value::as_u64);
        let due = matches!(expires, Some(expires) if expires <= now_ms() + self.margin_ms);
        if !due {
            return Ok(value);
        }
        let refresh_token = value.get("refresh").and_then(Value::as_str);
        match refresh_token {
            Some(token) if !token.is_empty() => {
                self.refresh_value(credential_id, integration, value).await
            }
            // Inside the margin with no refresh token the stored access is
            // all there is; hand it out and let the stored expiry speak.
            _ => Ok(value),
        }
    }

    /// Forces a refresh and reports the new expiry, never the secret.
    pub async fn refresh_row(&self, credential_id: &str, integration: &str) -> Result<u64, Error> {
        let value = store::load(&self.db, credential_id, integration)?;
        let refreshed = self
            .refresh_value(credential_id, integration, value)
            .await?;
        refreshed
            .get("expires")
            .and_then(Value::as_u64)
            .ok_or(Error::Invalid)
    }

    /// The critical region: at most one refresh per row at a time, the row is
    /// re-checked under the row lock, and the write is a single statement.
    async fn refresh_value(
        &self,
        credential_id: &str,
        integration: &str,
        value: Value,
    ) -> Result<Value, Error> {
        if integration != self.profile.integration {
            return Err(Error::Integration);
        }
        let refresh_token = value
            .get("refresh")
            .and_then(Value::as_str)
            .ok_or(Error::NotRefreshable)?
            .to_owned();
        if value.get("type").and_then(Value::as_str) != Some("oauth") {
            return Err(Error::NotRefreshable);
        }
        let lock = {
            let mut locks = self.row_locks.lock().await;
            locks
                .entry(credential_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        // Re-read under the row lock: another request may have rotated the
        // row while we waited, and replaying a one-time refresh token after a
        // rotation would invalidate the new one.
        let current = store::load(&self.db, credential_id, integration)?;
        if current.get("refresh").and_then(Value::as_str) != Some(&refresh_token) {
            return Ok(current);
        }
        if let Some(expires) = current.get("expires").and_then(Value::as_u64) {
            if expires > now_ms() + self.margin_ms {
                return Ok(current);
            }
        }
        let tokens = profile::refresh(&self.profile, &refresh_token, &self.user_agent).await?;
        let mut next = current;
        profile::apply_tokens(&mut next, &tokens, now_ms());
        store::store_refreshed(&self.db, credential_id, integration, next.clone())?;
        Ok(next)
    }
}

fn reply(id: u64, payload: Result<Value, Error>) -> String {
    match payload {
        Ok(value) => protocol::ok(id, value),
        Err(error) => protocol::err(id, &error),
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
