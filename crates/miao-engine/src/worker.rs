//! M3 extension compatibility worker (ADR-12). A process invoked through a fixed
//! capability interface, never an in-process script host: newline-delimited JSON
//! over stdio, a `hello` handshake that negotiates protocol 1, then `tool.list`,
//! `tool.call` and `shutdown`. Worker tools are External authority, bounded and
//! cancellable; a missing or crashed worker degrades only its capabilities.

use crate::{
    protocol::{Error, ToolDefinition},
    tools::ToolError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

const PROTOCOL: u64 = 1;
const MESSAGE_LIMIT: usize = 256 * 1024;
const CATALOG_LIMIT: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_TIMEOUT: Duration = Duration::from_millis(200);
const STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

struct Client {
    read: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    write: Box<dyn AsyncWrite + Unpin + Send>,
    next: u64,
    closed: bool,
    frame_bytes: Vec<u8>,
}
impl Client {
    fn new(
        read: impl AsyncRead + Unpin + Send + 'static,
        write: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        Self {
            read: BufReader::new(Box::new(read)),
            write: Box::new(write),
            next: 1,
            closed: false,
            frame_bytes: Vec::new(),
        }
    }
    async fn send(&mut self, message: &Value) -> Result<(), Error> {
        let mut body = serde_json::to_vec(message)?;
        if body.len() > MESSAGE_LIMIT {
            return Err(Error::Invalid("worker message exceeds bound".into()));
        }
        body.push(b'\n');
        self.write.write_all(&body).await?;
        self.write.flush().await?;
        Ok(())
    }
    async fn frame(&mut self) -> Result<Option<Value>, Error> {
        loop {
            let bytes = self.read.fill_buf().await?;
            if bytes.is_empty() {
                self.closed = true;
                if !self.frame_bytes.is_empty() {
                    return Err(Error::Invalid("incomplete worker frame".into()));
                }
                return Ok(None);
            }
            let end = bytes.iter().position(|byte| *byte == b'\n');
            let count = end.map_or(bytes.len(), |index| index + 1);
            if self.frame_bytes.len() + count > MESSAGE_LIMIT {
                self.closed = true;
                return Err(Error::Invalid("worker frame exceeds bound".into()));
            }
            self.frame_bytes.extend_from_slice(&bytes[..count]);
            self.read.consume(count);
            if end.is_none() {
                continue;
            }
            let line = std::mem::take(&mut self.frame_bytes);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            return Ok(Some(serde_json::from_slice(&line)?));
        }
    }
    /// Send a request and read until its reply, skipping notifications. Bounded by
    /// the caller's timeout.
    async fn round_trip(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            let frame = self
                .frame()
                .await?
                .ok_or_else(|| Error::Invalid("worker closed".into()))?;
            if frame["id"].as_u64() == Some(id) {
                if frame.get("error").is_some() {
                    return Err(Error::Invalid("worker returned an error".into()));
                }
                return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }
}

struct Tool {
    definition: ToolDefinition,
    native: String,
    validator: jsonschema::Validator,
}

/// One optional worker process. `connect` spawns it; `connect_io` attaches a
/// fake transport for tests. A failure here degrades the capabilities it serves.
pub struct Registry {
    authority: String,
    tools: BTreeMap<String, Tool>,
    client: Mutex<Client>,
    child: Mutex<Option<Child>>,
    available: AtomicBool,
}
impl Registry {
    pub(crate) fn authority(&self) -> &str {
        &self.authority
    }
    pub async fn connect(config: Config, workspace: &Path) -> Result<Self, Error> {
        if config.argv.is_empty()
            || config.argv.len() > 128
            || config.argv[0].is_empty()
            || config
                .argv
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 8192)
            || config.env.len() > 32
        {
            return Err(Error::Invalid("invalid worker configuration".into()));
        }
        let mut command = Command::new(&config.argv[0]);
        command
            .args(&config.argv[1..])
            .current_dir(workspace)
            .env_clear();
        for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(&config.env);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| Error::Invalid("worker could not start".into()))?;
        let read = child
            .stdout
            .take()
            .ok_or_else(|| Error::Invalid("worker stdout missing".into()))?;
        let write = child
            .stdin
            .take()
            .ok_or_else(|| Error::Invalid("worker stdin missing".into()))?;
        let mut registry = Self {
            authority: crate::permission::digest(&serde_json::to_vec(&config)?),
            tools: BTreeMap::new(),
            client: Mutex::new(Client::new(read, write)),
            child: Mutex::new(Some(child)),
            available: AtomicBool::new(true),
        };
        registry.initialize(workspace).await?;
        Ok(registry)
    }

    pub async fn connect_io<R, W>(read: R, write: W, workspace: &Path) -> Result<Self, Error>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let mut registry = Self {
            authority: uuid::Uuid::new_v4().to_string(),
            tools: BTreeMap::new(),
            client: Mutex::new(Client::new(read, write)),
            child: Mutex::new(None),
            available: AtomicBool::new(true),
        };
        registry.initialize(workspace).await?;
        Ok(registry)
    }

    async fn initialize(&mut self, workspace: &Path) -> Result<(), Error> {
        let workspace = workspace.to_string_lossy().replace('\\', "/");
        let mut client = self.client.lock().await;
        let hello = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            client.round_trip("hello", json!({"protocol":PROTOCOL,"workspace":workspace})),
        )
        .await
        .map_err(|_| Error::Invalid("worker handshake timed out".into()))??;
        if hello["protocol"].as_u64() != Some(PROTOCOL) {
            return Err(Error::Invalid("worker protocol mismatch".into()));
        }
        let catalog =
            tokio::time::timeout(HANDSHAKE_TIMEOUT, client.round_trip("tool.list", json!({})))
                .await
                .map_err(|_| Error::Invalid("worker catalog timed out".into()))??;
        if serde_json::to_vec(&catalog)?.len() > 65536 {
            return Err(Error::Invalid("worker catalog exceeds bound".into()));
        }
        let tools = catalog["tools"]
            .as_array()
            .cloned()
            .ok_or_else(|| Error::Invalid("worker catalog missing".into()))?;
        if tools.len() > CATALOG_LIMIT {
            return Err(Error::Invalid("worker tool limit".into()));
        }
        for tool in tools {
            let native = tool["name"].as_str().unwrap_or_default().to_owned();
            if native.is_empty() || native.len() > 256 || native.contains('\0') {
                return Err(Error::Invalid("invalid worker tool name".into()));
            }
            let input_schema = tool.get("input_schema").cloned().unwrap_or(json!({}));
            if input_schema["type"] != "object" || serde_json::to_vec(&input_schema)?.len() > 32768
            {
                return Err(Error::Invalid("unsupported worker tool schema".into()));
            }
            let validator = jsonschema::validator_for(&input_schema)
                .map_err(|_| Error::Invalid("unsupported worker validation schema".into()))?;
            let description = tool["description"].as_str().unwrap_or("").to_owned();
            if description.len() > 4096 {
                return Err(Error::Invalid("worker description limit".into()));
            }
            let alias = format!("worker__{native}");
            if self
                .tools
                .insert(
                    alias.clone(),
                    Tool {
                        definition: ToolDefinition {
                            name: alias,
                            description: format!(
                                "[extension worker; requires external-tool authorization] {description}"
                            ),
                            input_schema,
                        },
                        native,
                        validator,
                    },
                )
                .is_some()
            {
                return Err(Error::Invalid("duplicate worker tool".into()));
            }
        }
        Ok(())
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        if !self.available.load(Ordering::Acquire) {
            return Vec::new();
        }
        self.tools
            .values()
            .map(|tool| tool.definition.clone())
            .collect()
    }

    pub fn resource(&self, name: &str) -> Option<String> {
        if !self.available.load(Ordering::Acquire) {
            return None;
        }
        self.tools
            .get(name)
            .map(|tool| format!("@worker/{}", tool.native))
    }

    pub fn validate(&self, name: &str, input: &Value) -> Result<(), ToolError> {
        if !self.available.load(Ordering::Acquire) {
            return Err(ToolError::Unsupported);
        }
        let tool = self.tools.get(name).ok_or(ToolError::Unsupported)?;
        if !input.is_object() || !tool.validator.is_valid(input) {
            return Err(ToolError::InvalidInput);
        }
        Ok(())
    }

    pub async fn call(
        &self,
        name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        self.validate(name, &input)?;
        let native = self
            .tools
            .get(name)
            .ok_or(ToolError::Unsupported)?
            .native
            .clone();
        if serde_json::to_vec(&input)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > MESSAGE_LIMIT
        {
            return Err(ToolError::InvalidInput);
        }
        // The deadline covers queueing, sending, and reading. A peer that never
        // reads stdin must not make write_all uncancellable or unbounded.
        let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
        let mut client = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ToolError::Interrupted),
            client = tokio::time::timeout_at(deadline, self.client.lock()) => {
                client.map_err(|_| ToolError::External("worker queue timed out".into()))?
            },
        };
        if !self.available.load(Ordering::Acquire) {
            return Err(ToolError::Unsupported);
        }
        let id = client.next;
        client.next += 1;
        let message = json!({"id":id,"method":"tool.call","params":{"name":native,"input":input}});
        if serde_json::to_vec(&message)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > MESSAGE_LIMIT
        {
            return Err(ToolError::InvalidInput);
        }
        let mut healthy_reply = false;
        let result = {
            let operation = async {
                client
                    .send(&message)
                    .await
                    .map_err(|_| ToolError::External("worker transport failed".into()))?;
                loop {
                    let frame = client
                        .frame()
                        .await
                        .map_err(|_| ToolError::External("worker transport failed".into()))?
                        .ok_or_else(|| ToolError::External("worker closed".into()))?;
                    if frame["id"].as_u64() != Some(id) {
                        continue;
                    }
                    if frame.get("error").is_some_and(|error| !error.is_null()) {
                        healthy_reply = true;
                        return Err(ToolError::External("worker call failed".into()));
                    }
                    let result = frame
                        .get("result")
                        .cloned()
                        .ok_or_else(|| ToolError::External("worker reply has no result".into()))?;
                    let result = result.get("result").cloned().unwrap_or(result);
                    if serde_json::to_vec(&result)
                        .map_err(|_| ToolError::External("worker result invalid".into()))?
                        .len()
                        > MESSAGE_LIMIT
                    {
                        return Err(ToolError::External(
                            "worker result exceeds output budget".into(),
                        ));
                    }
                    healthy_reply = true;
                    return Ok(result);
                }
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(ToolError::Interrupted),
                result = tokio::time::timeout_at(deadline, operation) => {
                    result.unwrap_or_else(|_| Err(ToolError::External("worker call timed out".into())))
                },
            }
        };
        if result.is_err() && !healthy_reply {
            // A dropped write/read may leave a partial frame. Never reuse that
            // transport or replay an externally dispatched call.
            self.available.store(false, Ordering::Release);
            if matches!(&result, Err(ToolError::Interrupted)) {
                let _ = tokio::time::timeout(
                    CANCEL_TIMEOUT,
                    client.send(&json!({"method":"cancel","params":{"id":id}})),
                )
                .await;
            }
            client.closed = true;
            drop(client);
            self.terminate().await;
        }
        result
    }

    async fn terminate(&self) {
        let mut child = self.child.lock().await;
        if let Some(child) = child.as_mut() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(STOP_TIMEOUT, child.wait()).await;
        }
    }

    pub async fn shutdown(&self) {
        self.available.store(false, Ordering::Release);
        if let Ok(mut client) = tokio::time::timeout(CANCEL_TIMEOUT, self.client.lock()).await {
            if !client.closed {
                let _ = tokio::time::timeout(
                    CANCEL_TIMEOUT,
                    client.send(&json!({"method":"shutdown"})),
                )
                .await;
                client.closed = true;
            }
        }
        self.terminate().await;
    }
}
impl Drop for Registry {
    fn drop(&mut self) {
        if let Some(child) = self.child.get_mut().as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// A stable alias so `resources` never collide with native or MCP tool names.
pub fn owns(name: &str) -> bool {
    name.starts_with("worker__")
}
