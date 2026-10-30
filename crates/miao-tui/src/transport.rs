//! The TUI's stdio client for `miao-engine serve`.
//!
//! Mirrors the transport contract of the product host client
//! (`packages/miao/src/engine/client.ts`): newline-delimited JSON frames,
//! id-correlated replies, durable `event` notifications that carry a
//! per-session cursor, ephemeral `progress`, and one terminal failure that
//! rejects every pending request. The TUI holds no session state of its own;
//! it renders what this transport delivers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};

/// Catalog reads that a timeout must not take the whole transport down with:
/// their durable outcome needs no inspection before a retry. A timed-out
/// mutation retires the transport, exactly like the TS host client.
const READ_ONLY_METHODS: [&str; 7] = [
    "snapshot",
    "sessions",
    "history",
    "events",
    "usage",
    "timer_sessions",
    "permission_pattern_list",
];

/// One durable committed event, in the vocabulary of the engine's `event`
/// frames. `recorded_at_ms` can be absent on older engine stores.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EngineEvent {
    pub session_id: String,
    pub seq: u64,
    pub kind: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub recorded_at_ms: Option<u64>,
}

/// What the TUI reads off the transport. `Failure` is terminal and delivered
/// once per client.
#[derive(Debug)]
pub enum TransportEvent {
    Event(EngineEvent),
    Progress(Value),
    /// The engine reloaded part of its configuration, whoever asked for it.
    Config(Value),
    Resync(String),
    Failure(EngineFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    /// The engine answered one request with an error. The transport itself
    /// stays usable, exactly like the TS host client's per-call rejection.
    Rejected(EngineFailure),
    /// The transport is gone; every later call fails the same way.
    Closed(EngineFailure),
    Timeout {
        method: String,
        millis: u64,
    },
    Protocol(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "engine transport io: {error}"),
            Self::Rejected(failure) => write!(f, "engine {}: {}", failure.code, failure.message),
            Self::Closed(failure) => write!(f, "engine {}: {}", failure.code, failure.message),
            Self::Timeout { method, millis } => {
                write!(f, "engine {method} request timed out after {millis} ms")
            }
            Self::Protocol(message) => write!(f, "engine protocol: {message}"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Everything needed to (re)spawn the engine child. The connection replays
/// durable cursors across a respawn, so the descriptor must stay stable.
#[derive(Clone, Debug)]
pub struct EngineSpawn {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, TransportError>>>>>;
type Cursors = Arc<Mutex<HashMap<String, u64>>>;
type Shared = Arc<Mutex<Option<EngineFailure>>>;
type EventTx = mpsc::UnboundedSender<TransportEvent>;
pub type EventRx = mpsc::UnboundedReceiver<TransportEvent>;

pub struct EngineClient {
    child: Arc<Mutex<Child>>,
    outbound: mpsc::UnboundedSender<Value>,
    pending: Pending,
    cursors: Cursors,
    events: EventTx,
    failure: Shared,
    closed: Arc<AtomicBool>,
    next_id: AtomicU64,
    request_timeout: Duration,
    exited: watch::Receiver<bool>,
}

impl EngineClient {
    /// Spawn the engine child and start its writer, reader, stderr, and reaper
    /// tasks. The receiver delivers durable events, ephemeral progress, config
    /// reload notices, resync notices, and the one terminal failure. Must run
    /// inside a Tokio runtime.
    pub fn start(
        spawn: &EngineSpawn,
        request_timeout: Duration,
    ) -> Result<(Self, EventRx), TransportError> {
        spawn_engine(spawn, request_timeout, Cursors::default())
    }

    pub fn available(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.failure.lock().expect("failure").is_none()
    }

    /// The last durable event cursor observed per subscribed session. A respawn
    /// replays from these so no committed event is skipped or repeated.
    pub fn cursors(&self) -> HashMap<String, u64> {
        self.cursors.lock().expect("cursors").clone()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, TransportError> {
        self.call(frame(0, method, Some(params)), method).await
    }

    /// A command the engine declares as a unit variant (`sessions`,
    /// `model_catalog`) takes no `params` key at all: its envelope is adjacently
    /// tagged, so `{"method":"sessions","params":{}}` is rejected as an
    /// `invalid_request` instead of reading the empty object as no arguments.
    pub async fn command(&self, method: &str) -> Result<Value, TransportError> {
        self.call(frame(0, method, None), method).await
    }

    async fn call(&self, mut frame: Value, method: &str) -> Result<Value, TransportError> {
        if let Some(failure) = self.failure.lock().expect("failure").clone() {
            return Err(TransportError::Closed(failure));
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(TransportError::Closed(EngineFailure {
                code: "engine_closed".into(),
                message: "miao-engine client is closed".into(),
            }));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().expect("pending").insert(id, reply_tx);
        frame
            .as_object_mut()
            .expect("request frame object")
            .insert("id".into(), json!(id));
        if self.outbound.send(frame).is_err() {
            self.pending.lock().expect("pending").remove(&id);
            return Err(TransportError::Closed(EngineFailure {
                code: "engine_closed".into(),
                message: "miao-engine input stream closed".into(),
            }));
        }
        match tokio::time::timeout(self.request_timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self
                .failure
                .lock()
                .expect("failure")
                .clone()
                .map(TransportError::Closed)
                .unwrap_or_else(|| {
                    TransportError::Protocol("the transport dropped a pending reply".into())
                })),
            Err(_) => {
                self.pending.lock().expect("pending").remove(&id);
                let error = TransportError::Timeout {
                    method: method.to_string(),
                    millis: self.request_timeout.as_millis() as u64,
                };
                if READ_ONLY_METHODS.contains(&method) {
                    return Err(error);
                }
                // A mutation whose durable outcome is unknown must not be
                // retried over a transport that could replay it twice.
                let failure = EngineFailure {
                    code: "engine_request_timeout".into(),
                    message: format!(
                        "miao-engine {method} request timed out after {} ms; inspect its durable receipt before retrying",
                        self.request_timeout.as_millis()
                    ),
                };
                let _ = self.child.lock().expect("child lock").start_kill();
                self.publish_failure(failure);
                Err(error)
            }
        }
    }

    /// Register a durable subscription and seed its replay cursor. Events for
    /// the session arrive as `event` frames until it is unsubscribed.
    pub async fn subscribe(&self, session_id: &str, after: u64) -> Result<Value, TransportError> {
        self.cursors
            .lock()
            .expect("cursors")
            .insert(session_id.to_string(), after);
        self.request(
            "subscribe",
            json!({ "session_id": session_id, "after": after }),
        )
        .await
    }

    pub async fn unsubscribe(&self, session_id: &str) -> Result<Value, TransportError> {
        self.request("unsubscribe", json!({ "session_id": session_id }))
            .await
    }

    pub async fn initialize(&self, session_id: &str, title: &str) -> Result<Value, TransportError> {
        self.request(
            "initialize",
            json!({ "session_id": session_id, "title": title }),
        )
        .await
    }

    pub async fn admit(
        &self,
        input: Value,
        resume: bool,
        attachments: Vec<Value>,
    ) -> Result<Value, TransportError> {
        self.request(
            "admit",
            json!({ "input": input, "resume": resume, "attachments": attachments }),
        )
        .await
    }

    pub async fn cancel(&self, session_id: &str) -> Result<Value, TransportError> {
        self.request("cancel", json!({ "session_id": session_id }))
            .await
    }

    pub async fn approve(
        &self,
        session_id: &str,
        response: Value,
    ) -> Result<Value, TransportError> {
        self.request(
            "approve",
            json!({ "session_id": session_id, "response": response }),
        )
        .await
    }

    pub async fn answer_question(
        &self,
        session_id: &str,
        answer: Value,
    ) -> Result<Value, TransportError> {
        self.request(
            "answer_question",
            json!({ "session_id": session_id, "answer": answer }),
        )
        .await
    }

    pub async fn history(&self, session_id: &str, selected: bool) -> Result<Value, TransportError> {
        self.request(
            "history",
            json!({ "session_id": session_id, "selected": selected }),
        )
        .await
    }

    pub async fn snapshot(&self, session_id: &str) -> Result<Value, TransportError> {
        self.request("snapshot", json!({ "session_id": session_id }))
            .await
    }

    /// Shut the child down gracefully, then kill it if it lingers. No failure
    /// notice is emitted: an explicit close is not a transport fault.
    pub async fn close(mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.drain_pending(EngineFailure {
            code: "engine_closed".into(),
            message: "miao-engine client is closed".into(),
        });
        let shutdown =
            json!({ "id": self.next_id.fetch_add(1, Ordering::Relaxed), "method": "shutdown" });
        let _ = self.outbound.send(shutdown);
        if !*self.exited.borrow() {
            let stopped = tokio::time::timeout(Duration::from_secs(1), self.exited.changed()).await;
            if stopped.is_err() {
                let _ = self.child.lock().expect("child lock").start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(1), self.exited.changed()).await;
            }
        }
    }

    fn publish_failure(&self, failure: EngineFailure) {
        let mut slot = self.failure.lock().expect("failure");
        if slot.is_some() || self.closed.load(Ordering::SeqCst) {
            return;
        }
        *slot = Some(failure.clone());
        drop(slot);
        self.drain_pending(failure.clone());
        let _ = self.events.send(TransportEvent::Failure(failure));
    }

    fn drain_pending(&self, failure: EngineFailure) {
        for (_, reply) in self.pending.lock().expect("pending").drain() {
            let _ = reply.send(Err(TransportError::Closed(failure.clone())));
        }
    }
}

/// A client whose cursors outlive it, so a respawn can replay from them.
fn spawn_engine(
    spawn: &EngineSpawn,
    request_timeout: Duration,
    cursors: Cursors,
) -> Result<(EngineClient, EventRx), TransportError> {
    let mut child = Command::new(&spawn.program)
        .args(&spawn.args)
        .envs(spawn.env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let child = Arc::new(Mutex::new(child));
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
    let (events_tx, events_rx) = mpsc::unbounded_channel::<TransportEvent>();
    let (exited_tx, exited_rx) = watch::channel(false);
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let failure: Shared = Arc::new(Mutex::new(None));
    let closed = Arc::new(AtomicBool::new(false));
    let stderr_tail: Arc<Mutex<Stderr>> = Arc::new(Mutex::new(Stderr::default()));
    let (stderr_done_tx, stderr_done_rx) = watch::channel(false);

    let mut writer = stdin;
    tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            // One frame per line, as the engine's `read_line` expects.
            let mut line = frame.to_string();
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });

    let reap = Reap {
        pending: pending.clone(),
        cursors: cursors.clone(),
        events: events_tx.clone(),
        failure: failure.clone(),
        closed: closed.clone(),
        outbound: outbound_tx.clone(),
    };
    let reader_reap = reap.clone();
    let reader_child = child.clone();
    let reader_tail = stderr_tail.clone();
    let mut reader_stderr_done = stderr_done_rx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                reap.dispatch(&line);
            }
        }
        // EOF usually means the child exited, and its status plus stderr name
        // the reason. Wait briefly for that status so the message reports the
        // engine's own words instead of losing a race with the stream closing.
        // A child that closed its output but keeps running is still a failure.
        let status = exit_status(&reader_child, EXIT_STATUS_GRACE).await;
        // Exit status and stdout EOF do not mean the stderr task has drained.
        // Bound the wait because a descendant can inherit the stderr pipe.
        let _ = tokio::time::timeout(EXIT_STATUS_GRACE, reader_stderr_done.changed()).await;
        reap.publish(engine_failure(status, &reader_tail));
    });

    let tail = stderr_tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut buffer = tail.lock().expect("stderr tail");
            buffer.push(&line);
        }
        let _ = stderr_done_tx.send(true);
    });

    let reaped_child = child.clone();
    let mut reaper_stderr_done = stderr_done_rx;
    tokio::spawn(async move {
        loop {
            let status = {
                let mut guard = reaped_child.lock().expect("child lock");
                guard.try_wait().ok().flatten()
            };
            if let Some(status) = status {
                let _ = tokio::time::timeout(EXIT_STATUS_GRACE, reaper_stderr_done.changed()).await;
                reader_reap.publish(engine_failure(Some(status), &stderr_tail));
                let _ = exited_tx.send(true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let client = EngineClient {
        child,
        outbound: outbound_tx,
        pending,
        cursors,
        events: events_tx,
        failure,
        closed,
        next_id: AtomicU64::new(1),
        request_timeout,
        exited: exited_rx,
    };
    Ok((client, events_rx))
}

/// How long the reader waits for the exit status once the engine's output
/// closes. The child normally exits just before EOF, so this covers the gap.
const EXIT_STATUS_GRACE: Duration = Duration::from_millis(500);

/// The most stderr to quote back in one status line.
const STDERR_DETAIL_CHARS: usize = 300;

#[derive(Default)]
struct Stderr {
    tail: String,
    diagnostic: Option<String>,
}

impl Stderr {
    fn push(&mut self, line: &str) {
        let summary = line.trim();
        if summary.starts_with("miao engine-shim: ")
            || summary.starts_with("Error: ")
            || summary.starts_with("error: ")
        {
            self.diagnostic = Some(summary.chars().take(STDERR_DETAIL_CHARS).collect());
        }
        self.tail.push_str(line);
        self.tail.push('\n');
        if self.tail.len() > 8192 {
            let excess = self.tail.len() - 8192;
            // A byte budget may fall inside a Unicode path or diagnostic.
            let boundary = self
                .tail
                .char_indices()
                .map(|(offset, _)| offset)
                .find(|offset| *offset >= excess)
                .unwrap_or(self.tail.len());
            self.tail.drain(..boundary);
        }
    }
}

/// Keep the actionable refusal even if its stack fills the bounded tail.
fn stderr_detail(tail: &Mutex<Stderr>) -> String {
    let buffer = tail.lock().expect("stderr tail");
    if let Some(diagnostic) = &buffer.diagnostic {
        return diagnostic.clone();
    }
    let lines: Vec<&str> = buffer
        .tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(3)..]
        .join(" | ")
        .chars()
        .take(STDERR_DETAIL_CHARS)
        .collect()
}

/// Why the engine stopped, in the words the user needs. The exit code alone
/// cannot tell a storage fence from a refusal to start, and off the engine's
/// own stderr every startup failure reads as a bare stream closure.
fn engine_failure(status: Option<ExitStatus>, stderr_tail: &Mutex<Stderr>) -> EngineFailure {
    // `Error: Busy` on stderr means another engine owns this storage.
    let busy = {
        let buffer = stderr_tail.lock().expect("stderr tail");
        buffer.diagnostic.as_deref() == Some("Error: Busy")
            || buffer.tail.lines().any(|line| line.trim() == "Error: Busy")
    };
    if busy {
        return EngineFailure {
            code: "engine_busy".into(),
            message: "miao-engine exited: native storage is owned by another running engine".into(),
        };
    }
    let detail = stderr_detail(stderr_tail);
    let reason = match status {
        Some(status) => format!("miao-engine exited ({status})"),
        None => "miao-engine output stream closed".into(),
    };
    EngineFailure {
        code: "engine_closed".into(),
        message: if detail.is_empty() {
            reason
        } else {
            format!("{reason}: {detail}")
        },
    }
}

/// Poll for the child's exit status for at most `within`.
async fn exit_status(child: &Mutex<Child>, within: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + within;
    loop {
        let status = {
            let mut guard = child.lock().expect("child lock");
            guard.try_wait().ok().flatten()
        };
        if status.is_some() {
            return status;
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Frame routing plus the terminal-failure bookkeeping shared by the reader
/// task and the child reaper, which can each discover the engine's death.
#[derive(Clone)]
struct Reap {
    pending: Pending,
    cursors: Cursors,
    events: EventTx,
    failure: Shared,
    closed: Arc<AtomicBool>,
    outbound: mpsc::UnboundedSender<Value>,
}

impl Reap {
    fn dispatch(&self, line: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return;
        };
        // Reverse-dispatched product and hook tools are the host's job. This
        // host runs none, so a bridge frame gets an error reply instead of
        // leaving the engine waiting forever for an answer. The cancel notice
        // has no reply slot; the engine ignores a stray refusal for it.
        if let Some(bridge_id) = frame.get("bridge_id").and_then(Value::as_u64) {
            let refusal =
                json!({ "bridge_id": bridge_id, "error": "tools are not available on this host" });
            let _ = self.outbound.send(refusal);
            return;
        }
        if frame.get("method").is_none() {
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                // A late reply after its timeout was already retired: the
                // pending entry is gone and the frame is dropped.
                if let Some(reply) = self.pending.lock().expect("pending").remove(&id) {
                    let result = match frame.get("error") {
                        Some(error) if !error.is_null() => Err(TransportError::Rejected(
                            failure_of("engine_error", "miao-engine error", error),
                        )),
                        _ => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = reply.send(result);
                }
            } else if let Some(error) = frame.get("error") {
                // An id-less error frame: every caller waits forever otherwise.
                // The engine reports one here when it cannot decode a request.
                self.publish(failure_of("engine_error", "miao-engine error", error));
            }
            return;
        }
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        match frame.get("method").and_then(Value::as_str) {
            Some("event") => {
                let Ok(event) = serde_json::from_value::<EngineEvent>(params) else {
                    return;
                };
                let mut cursors = self.cursors.lock().expect("cursors");
                let cursor = cursors.entry(event.session_id.clone()).or_insert(0);
                *cursor = (*cursor).max(event.seq);
                drop(cursors);
                let _ = self.events.send(TransportEvent::Event(event));
            }
            Some("progress") => {
                let _ = self.events.send(TransportEvent::Progress(params));
            }
            Some("config") => {
                let _ = self.events.send(TransportEvent::Config(params));
            }
            Some("resync") => {
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let _ = self.events.send(TransportEvent::Resync(reason));
            }
            _ => {}
        }
    }

    /// Publish the terminal failure exactly once, rejecting every pending call.
    fn publish(&self, failure: EngineFailure) {
        let mut slot = self.failure.lock().expect("failure");
        if slot.is_some() || self.closed.load(Ordering::SeqCst) {
            return;
        }
        *slot = Some(failure.clone());
        drop(slot);
        for (_, reply) in self.pending.lock().expect("pending").drain() {
            let _ = reply.send(Err(TransportError::Closed(failure.clone())));
        }
        let _ = self.events.send(TransportEvent::Failure(failure));
    }
}

/// One request frame. A unit command carries no `params` key: the engine's
/// `Command` enum is adjacently tagged, and `params: {}` on a unit variant is a
/// typed deserialization failure rather than "no arguments".
fn frame(id: u64, method: &str, params: Option<Value>) -> Value {
    match params {
        Some(params) => json!({ "id": id, "method": method, "params": params }),
        None => json!({ "id": id, "method": method }),
    }
}

fn failure_of(code: &str, fallback: &str, error: &Value) -> EngineFailure {
    EngineFailure {
        code: error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(code)
            .to_string(),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
    }
}

/// A connection keeps its cursor map and event channel across respawns, so the
/// replay→live handoff stays gapless after the engine dies.
pub struct Connection {
    spawn: EngineSpawn,
    request_timeout: Duration,
    cursors: Cursors,
    events: EventTx,
    client: Option<EngineClient>,
}

impl Connection {
    pub fn start(
        spawn: EngineSpawn,
        request_timeout: Duration,
    ) -> Result<(Self, EventRx), TransportError> {
        let (events, events_rx) = mpsc::unbounded_channel();
        let mut connection = Self {
            spawn,
            request_timeout,
            cursors: Cursors::default(),
            events,
            client: None,
        };
        connection.spawn()?;
        Ok((connection, events_rx))
    }

    /// The live client, spawning the engine again (and replaying every
    /// subscribed session from its cursor) when the previous one failed.
    pub async fn connect(&mut self) -> Result<&EngineClient, TransportError> {
        if self.client.as_ref().is_some_and(EngineClient::available) {
            return Ok(self.client.as_ref().expect("connected"));
        }
        self.client = None;
        self.spawn()?;
        let replay: Vec<(String, u64)> = self
            .cursors
            .lock()
            .expect("cursors")
            .iter()
            .map(|(session_id, seq)| (session_id.clone(), *seq))
            .collect();
        let client = self.client.as_ref().expect("just spawned");
        for (session_id, after) in replay {
            client.subscribe(&session_id, after).await?;
        }
        Ok(client)
    }

    pub fn client(&self) -> Option<&EngineClient> {
        self.client.as_ref()
    }

    /// Shut the engine down. No failure notice follows an explicit close.
    pub async fn close(mut self) {
        if let Some(client) = self.client.take() {
            client.close().await;
        }
    }

    fn spawn(&mut self) -> Result<(), TransportError> {
        let (client, events) =
            spawn_engine(&self.spawn, self.request_timeout, self.cursors.clone())?;
        let sink = self.events.clone();
        tokio::spawn(async move {
            let mut events = events;
            while let Some(event) = events.recv().await {
                if sink.send(event).is_err() {
                    break;
                }
            }
        });
        self.client = Some(client);
        Ok(())
    }
}
