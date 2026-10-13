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
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::Mutex;

struct Login {
    profile: profile::Profile,
    pending: crate::login::Pending,
    id: String,
    label: String,
}

pub struct Daemon {
    db: PathBuf,
    profiles: HashMap<String, profile::Profile>,
    margin_ms: u64,
    user_agent: String,
    row_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    logins: Mutex<HashMap<String, Login>>,
    socket: Mutex<Option<PathBuf>>,
}

impl Daemon {
    pub fn new(db: PathBuf, profile: profile::Profile, user_agent: String) -> Self {
        Self {
            db,
            profiles: HashMap::from([(profile.integration.clone(), profile)]),
            margin_ms: REFRESH_MARGIN_MS,
            user_agent,
            row_locks: Mutex::new(HashMap::new()),
            logins: Mutex::new(HashMap::new()),
            socket: Mutex::new(None),
        }
    }

    pub fn with_profile(mut self, profile: profile::Profile) -> Self {
        self.profiles.insert(profile.integration.clone(), profile);
        self
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
    #[cfg(unix)]
    pub async fn serve(self: Arc<Self>, listener: UnixListener) -> std::io::Result<()> {
        let _lease = self.lease()?;
        self.run(listener).await
    }

    /// Acquire ownership before removing a stale socket: another daemon must
    /// never be disconnected while it still owns the database.
    #[cfg(unix)]
    pub async fn bind_and_serve(self: Arc<Self>, socket: &std::path::Path) -> std::io::Result<()> {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};
        let _lease = self.lease()?;
        if let Ok(metadata) = std::fs::symlink_metadata(socket) {
            if !metadata.file_type().is_socket() {
                return Err(std::io::Error::other("socket path is not a socket"));
            }
            std::fs::remove_file(socket)?;
        }
        let listener = UnixListener::bind(socket)?;
        std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
        self.run(listener).await
    }

    fn lease(&self) -> std::io::Result<std::fs::File> {
        use fs2::FileExt;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let path = std::fs::canonicalize(&self.db)?;
        let mut lock = path.into_os_string();
        lock.push(".credential-owner.lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(lock)?;
        file.try_lock_exclusive()?;
        Ok(file)
    }

    #[cfg(unix)]
    async fn run(self: Arc<Self>, listener: UnixListener) -> std::io::Result<()> {
        store::ensure_ownership(&self.db).map_err(std::io::Error::other)?;
        let path = listener
            .local_addr()?
            .as_pathname()
            .ok_or_else(|| std::io::Error::other("unnamed credential socket"))?
            .to_path_buf();
        *self.socket.lock().await = Some(std::fs::canonicalize(path)?);
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

    #[cfg(windows)]
    pub async fn bind_and_serve(self: Arc<Self>, name: &std::path::Path) -> std::io::Result<()> {
        let _lease = self.lease()?;
        store::ensure_ownership(&self.db).map_err(std::io::Error::other)?;
        *self.socket.lock().await = Some(name.to_path_buf());
        let mut server = crate::windows_pipe::create(name, true)?;
        loop {
            server.connect().await?;
            // Create the waiting instance before serving the connected one,
            // so another client does not have to wait for this request to end.
            let next = crate::windows_pipe::create(name, false)?;
            let connected = std::mem::replace(&mut server, next);
            let daemon = self.clone();
            tokio::spawn(async move {
                let _ = daemon.handle_connection(connected).await;
            });
        }
    }

    async fn handle_connection<S>(&self, stream: S) -> std::io::Result<()>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        let (reader, mut writer) = tokio::io::split(stream);
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
            Request::LoginStart {
                integration,
                credential_id,
                label,
            } => reply(
                frame.id,
                self.login_start(credential_id, label, integration).await,
            ),
            Request::LoginPoll { handle } => reply(frame.id, self.login_poll(&handle).await),
            Request::Adopt {
                credential_id,
                integration,
            } => {
                let result = self
                    .adopt(&credential_id, &integration)
                    .await
                    .map(|()| serde_json::json!({"status":"owned", "credential_id":credential_id}));
                reply(frame.id, result)
            }
            Request::Discover => {
                let payload = store::discover(&self.db).map(|rows| {
                    serde_json::to_value(rows).unwrap_or_else(|_| serde_json::json!([]))
                });
                reply(frame.id, payload)
            }
        }
    }

    async fn adopt(&self, id: &str, integration: &str) -> Result<(), Error> {
        if !self.profiles.contains_key(integration) {
            return Err(Error::Integration);
        }
        let lock = {
            let mut locks = self.row_locks.lock().await;
            locks
                .entry(id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        let socket = self.socket.lock().await.clone().ok_or(Error::Io)?;
        store::claim(
            &self.db,
            id,
            integration,
            socket.to_str().ok_or(Error::Invalid)?,
        )
    }

    async fn login_start(
        &self,
        id: String,
        label: String,
        integration: String,
    ) -> Result<Value, Error> {
        let profile = self
            .profiles
            .get(&integration)
            .ok_or(Error::Integration)?
            .clone();
        if id.is_empty() || id.len() > 256 || label.len() > 1024 {
            return Err(Error::Invalid);
        }
        // Holding this mutex through the start request enforces the admission
        // cap even when multiple clients start authorization together.
        let mut pending = self.logins.lock().await;
        pending.retain(|_, login| !login.pending.expired());
        if pending.len() >= 32 {
            return Err(Error::LoginRejected);
        }
        let (state, mut public) = crate::login::begin(&profile, &self.user_agent).await?;
        let handle = uuid::Uuid::new_v4().to_string();
        public["handle"] = handle.clone().into();
        pending.insert(
            handle,
            Login {
                profile,
                pending: state,
                id,
                label,
            },
        );
        Ok(public)
    }

    async fn login_poll(&self, handle: &str) -> Result<Value, Error> {
        let mut pending = self.logins.lock().await;
        let login = pending.get_mut(handle).ok_or(Error::LoginRejected)?;
        match crate::login::poll(&mut login.pending, &login.profile, &self.user_agent).await {
            Ok(None) => Ok(serde_json::json!({"status":"pending"})),
            Ok(Some(value)) => {
                // The code can only be exchanged once. Remove the pending
                // handle even if insertion fails; never replay that code.
                let login = pending.remove(handle).ok_or(Error::LoginRejected)?;
                let socket = self.socket.lock().await.clone().ok_or(Error::Io)?;
                store::insert_login(
                    &self.db,
                    &login.id,
                    &login.profile.integration,
                    &login.label,
                    &value,
                    socket.to_str().ok_or(Error::Invalid)?,
                )?;
                Ok(serde_json::json!({"status":"complete", "credential_id":login.id}))
            }
            Err(error) => {
                pending.remove(handle);
                Err(error)
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
        if !due || (integration == "github-copilot" && expires == Some(0)) {
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
        if !self.profiles.contains_key(integration) {
            return Err(Error::Integration);
        }
        let socket = self.socket.lock().await.clone().ok_or(Error::Io)?;
        if value["metadata"]["miaoCredentialSocket"].as_str() != socket.to_str() {
            return Err(Error::NotRefreshable);
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
        let profile = self.profiles.get(integration).ok_or(Error::Integration)?;
        if integration == "opencode"
            && value["metadata"]["server"]
                .as_str()
                .is_some_and(|server| server != profile.issuer)
        {
            return Err(Error::Integration);
        }
        let tokens = profile::refresh(profile, &refresh_token, &self.user_agent).await?;
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
