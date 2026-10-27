//! The TUI's one engine child and the projection work it asks for.
//!
//! The UI thread never awaits the engine: it sends a [`Request`] and receives
//! [`AppEvent`]s on the same bus as terminal input. A Session is re-projected
//! from a fresh snapshot after committed activity, so the transcript always
//! matches the engine's own projection instead of a second reducer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::dialogs::{AccountInfo, ModelInfo};
use crate::event::{AppEvent, Bus};
use crate::session::{
    catalog_rows, home_rows, DisplayFile, SessionState, SessionSummary, Transcript,
};
use crate::status::UsageSummary;
use crate::transport::{self, EngineClient, EngineSpawn, TransportEvent};

/// Committed events that change what the transcript shows. Coalesced so one
/// assistant turn does not trigger a snapshot per event.
const REFRESH_DEBOUNCE: Duration = Duration::from_millis(150);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const EVENTS_PAGE: usize = 100;

pub enum Request {
    RefreshSessions,
    Open(String),
    Refresh,
    /// Admit one prompt into a Session and wake it.
    Prompt {
        session_id: String,
        text: String,
    },
    /// Admit a rendered template command: the engine captures the reference,
    /// prepares its placeholders after promotion, and records the command.
    Command {
        session_id: String,
        text: String,
        /// The text the composer held, restored if admission fails.
        original: String,
        command: Value,
    },
    NewSession,
    /// Interrupt the active run; idle Sessions answer `accepted: false`.
    Cancel {
        session_id: String,
    },
    /// Resolve one pending approval, optionally remembering the decision.
    Approve {
        session_id: String,
        response: Value,
        persistent: bool,
    },
    Answer {
        session_id: String,
        answer: Value,
    },
    RejectQuestion {
        session_id: String,
        rejection: Value,
    },
    /// Read the engine's model catalog for the model dialog.
    Catalog,
    SelectModel {
        session_id: String,
        binding: Value,
    },
    /// Read the open Session's billed usage for the status dialog.
    Usage {
        session_id: String,
    },
    /// Pin the account every turn of this Session runs on; `None` restores the
    /// engine default.
    SelectAccount {
        session_id: String,
        credential_id: Option<String>,
    },
    Rename {
        session_id: String,
        title: String,
    },
    Archive {
        session_id: String,
        archived: bool,
    },
    Remove {
        session_id: String,
    },
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Request>,
}

#[cfg(test)]
impl Handle {
    /// A handle with no engine task behind it. Sends are dropped, which is
    /// enough for tests that only assert the UI's own state.
    pub fn inert() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self { tx }
    }
}

impl Handle {
    pub fn refresh_sessions(&self) {
        let _ = self.tx.send(Request::RefreshSessions);
    }

    pub fn open(&self, session_id: &str) {
        let _ = self.tx.send(Request::Open(session_id.to_string()));
    }

    pub fn refresh(&self) {
        let _ = self.tx.send(Request::Refresh);
    }

    pub fn prompt(&self, session_id: &str, text: &str) {
        let _ = self.tx.send(Request::Prompt {
            session_id: session_id.to_string(),
            text: text.to_string(),
        });
    }

    pub fn command(
        &self,
        session_id: &str,
        prompt: &str,
        original: &str,
        name: &str,
        arguments: &str,
    ) {
        let _ = self.tx.send(Request::Command {
            session_id: session_id.to_string(),
            text: prompt.to_string(),
            original: original.to_string(),
            command: json!({ "name": name, "arguments": arguments }),
        });
    }

    pub fn new_session(&self) {
        let _ = self.tx.send(Request::NewSession);
    }

    pub fn cancel(&self, session_id: &str) {
        let _ = self.tx.send(Request::Cancel {
            session_id: session_id.to_string(),
        });
    }

    pub fn approve(&self, session_id: &str, response: Value, persistent: bool) {
        let _ = self.tx.send(Request::Approve {
            session_id: session_id.to_string(),
            response,
            persistent,
        });
    }

    pub fn answer(&self, session_id: &str, answer: Value) {
        let _ = self.tx.send(Request::Answer {
            session_id: session_id.to_string(),
            answer,
        });
    }

    pub fn reject_question(&self, session_id: &str, rejection: Value) {
        let _ = self.tx.send(Request::RejectQuestion {
            session_id: session_id.to_string(),
            rejection,
        });
    }

    pub fn catalog(&self) {
        let _ = self.tx.send(Request::Catalog);
    }

    pub fn select_model(&self, session_id: &str, binding: Value) {
        let _ = self.tx.send(Request::SelectModel {
            session_id: session_id.to_string(),
            binding,
        });
    }

    pub fn usage(&self, session_id: &str) {
        let _ = self.tx.send(Request::Usage {
            session_id: session_id.to_string(),
        });
    }

    pub fn select_account(&self, session_id: &str, credential_id: Option<&str>) {
        let _ = self.tx.send(Request::SelectAccount {
            session_id: session_id.to_string(),
            credential_id: credential_id.map(str::to_string),
        });
    }

    pub fn rename(&self, session_id: &str, title: &str) {
        let _ = self.tx.send(Request::Rename {
            session_id: session_id.to_string(),
            title: title.to_string(),
        });
    }

    pub fn archive(&self, session_id: &str, archived: bool) {
        let _ = self.tx.send(Request::Archive {
            session_id: session_id.to_string(),
            archived,
        });
    }

    pub fn remove(&self, session_id: &str) {
        let _ = self.tx.send(Request::Remove {
            session_id: session_id.to_string(),
        });
    }
}

/// Where the engine binary, its database, and the requested model come from.
/// The TUI refuses to guess a database: the product's location-hashed storage
/// path is host-side knowledge and a wrong guess would read another profile.
#[derive(Debug, Clone)]
pub struct Settings {
    pub spawn: EngineSpawn,
    pub model: String,
}

pub fn settings(
    workspace: &Path,
    db: Option<PathBuf>,
    model: Option<String>,
) -> Result<Settings, String> {
    let db = db
        .or_else(|| std::env::var_os("MIAO_ENGINE_DB").map(PathBuf::from))
        .ok_or("pass --db <engine.db> or set MIAO_ENGINE_DB")?;
    if !db.is_file() {
        return Err(format!("engine database not found: {}", db.display()));
    }
    let model = model
        .or_else(|| std::env::var("MIAO_TUI_MODEL").ok())
        .unwrap_or_else(|| "unavailable/model".to_string());
    let spawn = EngineSpawn {
        program: engine_binary(),
        args: vec![
            "serve".into(),
            "--db".into(),
            db.display().to_string(),
            "--workspace".into(),
            workspace.display().to_string(),
            "--model".into(),
            model.clone(),
        ],
        env: Vec::new(),
    };
    Ok(Settings { spawn, model })
}

/// `MIAO_ENGINE_BIN` first, then the installed locations the product uses,
/// then `PATH`.
fn engine_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("MIAO_ENGINE_BIN") {
        return PathBuf::from(explicit);
    }
    let name = if cfg!(windows) {
        "miao-engine.exe"
    } else {
        "miao-engine"
    };
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .into_iter()
        .flat_map(|home| {
            [
                home.join(".miao/bin").join(name),
                home.join(".local/share/miao-engine/bin").join(name),
                home.join(".local/bin").join(name),
            ]
        })
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn attach(settings: &Settings, bus: Bus) -> Result<Handle, String> {
    let (client, events) = EngineClient::start(&settings.spawn, REQUEST_TIMEOUT)
        .map_err(|error| format!("cannot start the engine: {error}"))?;
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(run(client, events, rx, bus));
    Ok(Handle { tx })
}

/// What the TUI remembers about the open Session between snapshots: the last
/// replayed event and the display diffs that only events carry. Message content
/// is always re-read from the snapshot, so nothing here can drift from the
/// journal.
struct Opened {
    id: String,
    seen: u64,
    displays: HashMap<String, Vec<DisplayFile>>,
}

async fn run(
    client: EngineClient,
    mut events: transport::EventRx,
    mut requests: mpsc::UnboundedReceiver<Request>,
    bus: Bus,
) {
    let mut open: Option<Opened> = None;
    let mut dirty: Option<Instant> = None;
    refresh_sessions(&client, &bus).await;
    loop {
        let deadline = dirty.map(|start| start + REFRESH_DEBOUNCE);
        tokio::select! {
            request = requests.recv() => match request {
                None => {
                    client.close().await;
                    return;
                }
                Some(Request::RefreshSessions) => refresh_sessions(&client, &bus).await,
                Some(Request::Refresh) => {
                    dirty = None;
                    if let Some(state) = open.as_mut() {
                        project(&client, &bus, state).await;
                    }
                }
                Some(Request::Open(session_id)) => {
                    dirty = None;
                    open_session(&client, &bus, &mut open, session_id).await;
                }
                Some(Request::Prompt { session_id, text }) => {
                    let input = json!({
                        "session_id": session_id.clone(),
                        "input_id": new_id("in"),
                        "prompt": text,
                        "delivery": "steer",
                    });
                    match client.admit(input, true, Vec::new()).await {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty = Some(Instant::now());
                            }
                        }
                        Err(error) => bus.send(AppEvent::PromptFailed {
                            text,
                            message: format!("send failed: {error}"),
                        }),
                    }
                }
                Some(Request::Command {
                    session_id,
                    text,
                    original,
                    command,
                }) => {
                    let input = json!({
                        "session_id": session_id.clone(),
                        "input_id": new_id("in"),
                        "prompt": text,
                        "delivery": "steer",
                        "command": command,
                    });
                    match client.admit(input, true, Vec::new()).await {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty = Some(Instant::now());
                            }
                        }
                        Err(error) => bus.send(AppEvent::PromptFailed {
                            text: original,
                            message: format!("command failed: {error}"),
                        }),
                    }
                }
                Some(Request::Cancel { session_id }) => {
                    match client.cancel(&session_id).await {
                        Ok(_) => dirty = Some(Instant::now()),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("interrupt failed: {error}")))
                        }
                    }
                }
                Some(Request::Approve {
                    session_id,
                    response,
                    persistent,
                }) => {
                    let method = if persistent { "approve_persistent" } else { "approve" };
                    let result = client
                        .request(method, json!({ "session_id": session_id, "response": response }))
                        .await;
                    match result {
                        Ok(_) => dirty = Some(Instant::now()),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("approval failed: {error}")))
                        }
                    }
                }
                Some(Request::Answer { session_id, answer }) => {
                    match client.answer_question(&session_id, answer).await {
                        Ok(_) => dirty = Some(Instant::now()),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("answer failed: {error}")))
                        }
                    }
                }
                Some(Request::RejectQuestion {
                    session_id,
                    rejection,
                }) => {
                    let result = client
                        .request(
                            "reject_question",
                            json!({ "session_id": session_id, "rejection": rejection }),
                        )
                        .await;
                    match result {
                        Ok(_) => dirty = Some(Instant::now()),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("reject failed: {error}")))
                        }
                    }
                }
                Some(Request::Catalog) => {
                    match client.request("model_catalog", json!({})).await {
                        Ok(value) => {
                            bus.send(AppEvent::Accounts(AccountInfo::catalog(&value)));
                            bus.send(AppEvent::Models(ModelInfo::catalog(&value)));
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("models failed: {error}")))
                        }
                    }
                }
                Some(Request::SelectModel {
                    session_id,
                    binding,
                }) => {
                    let result = client
                        .request(
                            "select_model",
                            json!({ "session_id": session_id, "binding": binding }),
                        )
                        .await;
                    match result {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty = Some(Instant::now());
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("select failed: {error}")))
                        }
                    }
                }
                Some(Request::Usage { session_id }) => {
                    let result = client
                        .request("usage", json!({ "session_id": session_id }))
                        .await;
                    match result {
                        Ok(value) => bus.send(AppEvent::Usage(UsageSummary::from_value(&value))),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("usage failed: {error}")))
                        }
                    }
                }
                Some(Request::SelectAccount {
                    session_id,
                    credential_id,
                }) => {
                    let result = client
                        .request(
                            "select_account",
                            json!({ "session_id": session_id, "credential_id": credential_id }),
                        )
                        .await;
                    match result {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty = Some(Instant::now());
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("account failed: {error}")))
                        }
                    }
                }
                Some(Request::Rename { session_id, title }) => {
                    let result = client
                        .request(
                            "rename",
                            json!({ "session_id": session_id, "title": title }),
                        )
                        .await;
                    match result {
                        Ok(_) => {
                            refresh_sessions(&client, &bus).await;
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty = Some(Instant::now());
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("rename failed: {error}")))
                        }
                    }
                }
                Some(Request::Archive {
                    session_id,
                    archived,
                }) => {
                    let result = client
                        .request(
                            "archive",
                            json!({ "session_id": session_id, "archived": archived }),
                        )
                        .await;
                    match result {
                        Ok(_) => refresh_sessions(&client, &bus).await,
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("archive failed: {error}")))
                        }
                    }
                }
                Some(Request::Remove { session_id }) => {
                    match client
                        .request("remove", json!({ "session_id": session_id }))
                        .await
                    {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                open = None;
                                bus.send(AppEvent::SessionRemoved(session_id));
                            }
                            refresh_sessions(&client, &bus).await;
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("delete failed: {error}")))
                        }
                    }
                }
                Some(Request::NewSession) => {
                    dirty = None;
                    let id = new_id("ses");
                    match client.initialize(&id, "New session").await {
                        Ok(_) => open_session(&client, &bus, &mut open, id).await,
                        Err(error) => {
                            bus.send(AppEvent::EngineFailure(format!(
                                "cannot create a Session: {error}"
                            )));
                        }
                    }
                }
            },
            event = events.recv() => match event {
                None => {
                    bus.send(AppEvent::EngineFailure("engine transport closed".into()));
                    return;
                }
                Some(TransportEvent::Event(event)) => {
                    let watched = open.as_ref().is_some_and(|state| state.id == event.session_id);
                    // Anything that changes run status, the transcript, or a
                    // pending decision settles into the next snapshot.
                    if watched
                        && matches!(
                            event.kind.as_str(),
                            "message.committed"
                                | "tool.completed"
                                | "run.started"
                                | "run.finished"
                                | "run.cancel_requested"
                                | "approval.requested"
                                | "approval.resolved"
                                | "question.requested"
                                | "question.resolved"
                        )
                    {
                        dirty = Some(Instant::now());
                    }
                }
                Some(TransportEvent::Failure(failure)) => {
                    bus.send(AppEvent::EngineFailure(format!(
                        "engine {}: {}",
                        failure.code, failure.message
                    )));
                    return;
                }
                Some(TransportEvent::Resync(_)) | Some(TransportEvent::Progress(_)) => {}
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                dirty = None;
                if let Some(state) = open.as_mut() {
                    project(&client, &bus, state).await;
                }
            }
        }
    }
}

async fn refresh_sessions(client: &EngineClient, bus: &Bus) {
    let ids = match client.request("sessions", json!({})).await {
        Ok(Value::Array(ids)) => ids,
        Ok(_) => {
            bus.send(AppEvent::EngineFailure(
                "engine answered sessions with a non-array".into(),
            ));
            return;
        }
        Err(error) => {
            bus.send(AppEvent::EngineFailure(error.to_string()));
            return;
        }
    };
    let mut rows = Vec::new();
    for id in ids.iter().filter_map(Value::as_str) {
        let snapshot = client
            .request(
                "snapshot",
                json!({ "session_id": id, "metadata_only": true }),
            )
            .await;
        if let Ok(snapshot) = snapshot {
            if let Some(row) = SessionSummary::from_snapshot(&snapshot) {
                rows.push(row);
            }
        }
    }
    bus.send(AppEvent::Catalog(catalog_rows(rows.clone())));
    bus.send(AppEvent::Sessions(home_rows(rows)));
}

async fn open_session(
    client: &EngineClient,
    bus: &Bus,
    open: &mut Option<Opened>,
    session_id: String,
) {
    if let Some(previous) = open.take() {
        let _ = client.unsubscribe(&previous.id).await;
    }
    let mut state = Opened {
        id: session_id,
        seen: 0,
        displays: HashMap::new(),
    };
    project(client, bus, &mut state).await;
    *open = Some(state);
}

/// Re-read the Session snapshot and replay only the events not yet seen. The
/// snapshot loses display diffs (they live on `tool.completed`, not on message
/// content), so the previously replayed diffs are carried over instead of
/// paging the whole journal again on every refresh.
async fn project(client: &EngineClient, bus: &Bus, state: &mut Opened) {
    let snapshot = match client.snapshot(&state.id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            bus.send(AppEvent::EngineFailure(error.to_string()));
            return;
        }
    };
    let mut transcript = Transcript::from_snapshot(&snapshot);
    transcript.displays = state.displays.clone();
    loop {
        let page = client
            .request(
                "events",
                json!({ "session_id": state.id, "after": state.seen }),
            )
            .await;
        let Ok(Value::Array(items)) = page else { break };
        let Some(last) = items
            .last()
            .and_then(|item| item.get("seq"))
            .and_then(Value::as_u64)
        else {
            break;
        };
        for item in &items {
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
            transcript.apply_event(kind, item.get("data").unwrap_or(&Value::Null));
        }
        state.seen = state.seen.max(last);
        if items.len() < EVENTS_PAGE {
            break;
        }
    }
    state.displays = transcript.displays.clone();
    let cursor = snapshot.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    let _ = client.subscribe(&state.id, cursor).await;
    bus.send(AppEvent::SessionOpened {
        summary: SessionSummary::from_snapshot(&snapshot),
        transcript: Box::new(transcript),
        state: SessionState::from_snapshot(&snapshot),
    });
}

/// Session and input ids are only opaque keys to the engine; hex keeps them
/// readable and sorted by creation.
fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{prefix}_{nanos:x}{:x}{:x}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
