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
use crate::platform::attention;
use crate::session::{
    catalog_rows, home_rows, DisplayFile, RevertPlan, SessionState, SessionSummary, Transcript,
};
use crate::status::UsageSummary;
use crate::transport::{self, EngineClient, EngineSpawn, TransportEvent};

/// Committed events that change what the transcript shows. Coalesced so one
/// assistant turn does not trigger a snapshot per event. The first pending
/// event fixes the deadline; sustained activity must not postpone progress.
const REFRESH_DELAY: Duration = Duration::from_millis(150);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const EVENTS_PAGE: usize = 100;
/// Inputs read per `pending_inputs` page while looking for the newest one.
const PENDING_INPUT_PAGE: usize = 100;

pub enum Request {
    VcsChanges {
        generation: u64,
        session_id: String,
    },
    SavedPermissions {
        generation: u64,
    },
    RevokePermission {
        generation: u64,
        id: String,
    },
    RefreshSessions,
    Open(String),
    Refresh,
    /// Admit one prompt with its inline media attachments into a Session and
    /// wake it.
    Prompt {
        session_id: String,
        text: String,
        attachments: Vec<Value>,
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
    /// Cancel the newest still-pending input and hand its text back. Escape
    /// uses this before it touches the running turn: a queued prompt is cheaper
    /// to take back than an interrupted turn is to resume.
    CancelLastInput {
        session_id: String,
    },
    /// One `!` command for the host shell. It records in the Session without
    /// starting a provider turn, so nothing here touches the model.
    Shell {
        session_id: String,
        command: String,
    },
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
    /// The host's workspace list, served by the engine (TUI-09).
    Workspaces,
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
    Pin {
        session_id: String,
        pinned: bool,
    },
    /// Ask what a revert at this boundary would change, without changing it.
    RevertPreview {
        session_id: String,
        boundary_seq: u64,
    },
    /// Stage and commit a revert: the file set (when the engine has one) and
    /// the conversation rewind land together.
    Revert {
        session_id: String,
        boundary_seq: u64,
        files: bool,
    },
    /// Restore the messages the last revert hid.
    Redo {
        session_id: String,
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

    /// A handle that keeps the channel open so a test can assert what the UI
    /// asked the engine to do.
    pub fn recording() -> (Self, mpsc::UnboundedReceiver<Request>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }
}

impl Handle {
    pub fn vcs_changes(&self, generation: u64, session_id: &str) {
        let _ = self.tx.send(Request::VcsChanges {
            generation,
            session_id: session_id.into(),
        });
    }

    pub fn saved_permissions(&self, generation: u64) {
        let _ = self.tx.send(Request::SavedPermissions { generation });
    }
    pub fn revoke_permission(&self, generation: u64, id: String) {
        let _ = self.tx.send(Request::RevokePermission { generation, id });
    }
    pub fn refresh_sessions(&self) {
        let _ = self.tx.send(Request::RefreshSessions);
    }

    pub fn open(&self, session_id: &str) {
        let _ = self.tx.send(Request::Open(session_id.to_string()));
    }

    pub fn refresh(&self) {
        let _ = self.tx.send(Request::Refresh);
    }

    pub fn prompt(&self, session_id: &str, text: &str, attachments: Vec<Value>) {
        let _ = self.tx.send(Request::Prompt {
            session_id: session_id.to_string(),
            text: text.to_string(),
            attachments,
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

    pub fn cancel_last_input(&self, session_id: &str) {
        let _ = self.tx.send(Request::CancelLastInput {
            session_id: session_id.to_string(),
        });
    }

    pub fn shell(&self, session_id: &str, command: &str) {
        let _ = self.tx.send(Request::Shell {
            session_id: session_id.to_string(),
            command: command.to_string(),
        });
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

    pub fn workspaces(&self) {
        let _ = self.tx.send(Request::Workspaces);
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

    /// Pin or unpin a Session. The engine records the timestamp, so the list
    /// order survives a restart and is shared with every other client.
    pub fn pin(&self, session_id: &str, pinned: bool) {
        let _ = self.tx.send(Request::Pin {
            session_id: session_id.to_string(),
            pinned,
        });
    }

    pub fn remove(&self, session_id: &str) {
        let _ = self.tx.send(Request::Remove {
            session_id: session_id.to_string(),
        });
    }

    pub fn revert_preview(&self, session_id: &str, boundary_seq: u64) {
        let _ = self.tx.send(Request::RevertPreview {
            session_id: session_id.to_string(),
            boundary_seq,
        });
    }

    pub fn revert(&self, session_id: &str, boundary_seq: u64, files: bool) {
        let _ = self.tx.send(Request::Revert {
            session_id: session_id.to_string(),
            boundary_seq,
            files,
        });
    }

    pub fn redo(&self, session_id: &str) {
        let _ = self.tx.send(Request::Redo {
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

/// The stand-in model a Session uses when nothing supplied a route. The engine
/// resolves it to whatever provider its defaults name, so a turn through it
/// fails on the upstream instead of on the missing route.
pub const UNROUTED_MODEL: &str = "unavailable/model";

/// A startup notice for a Session that has no model route. The product launcher
/// runs the engine through a shim (`MIAO_ENGINE_REAL_BIN`) that builds the
/// product's routes and credentials, so only a TUI started directly is
/// unrouted — and it would otherwise fail its first prompt with an
/// authentication error from a provider the operator never chose.
pub fn unrouted_notice(args: &[String], model: &str, supplied_by_shim: bool) -> Option<String> {
    if supplied_by_shim || model != UNROUTED_MODEL {
        return None;
    }
    if args.iter().any(|arg| arg == "--model-routes-config") {
        return Some("no model selected: choose one with /model".to_string());
    }
    Some(
        "no model routes: start the product with `miao`, or set MIAO_ENGINE_MODEL_ROUTES_CONFIG"
            .to_string(),
    )
}

pub fn settings(
    workspace: &Path,
    db: Option<PathBuf>,
    model: Option<String>,
    config_dir: Option<PathBuf>,
) -> Result<Settings, String> {
    let db = db
        .or_else(|| std::env::var_os("MIAO_ENGINE_DB").map(PathBuf::from))
        .ok_or("pass --db <engine.db> or set MIAO_ENGINE_DB")?;
    // The engine creates and migrates the database on first use. A freshly
    // installed product has no database yet, and requiring one here would make
    // the first launch of the Rust TUI fail before the engine can initialize.
    let model = model
        .or_else(|| std::env::var("MIAO_TUI_MODEL").ok())
        .unwrap_or_else(|| UNROUTED_MODEL.to_string());
    let config_dir = config_dir.or_else(crate::config::global_dir);
    let spawn = EngineSpawn {
        program: engine_binary(),
        args: launch_args(
            args(&db, workspace, &model, config_dir.as_deref(), |name| {
                std::env::var(name).ok()
            }),
            std::env::var("MIAO_ENGINE_LAUNCH_PREFIX").ok().as_deref(),
        )?,
        env: Vec::new(),
    };
    Ok(Settings { spawn, model })
}

// The product passes a literal executable prefix on Windows, where a POSIX
// wrapper cannot stand in for the engine. Never interpret it through a shell.
fn launch_args(args: Vec<String>, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let mut prefix: Vec<String> = match prefix {
        Some(value) => serde_json::from_str(value)
            .map_err(|_| "MIAO_ENGINE_LAUNCH_PREFIX must be a JSON array of strings")?,
        None => return Ok(args),
    };
    if prefix.iter().any(|argument| argument.contains('\0')) {
        return Err("MIAO_ENGINE_LAUNCH_PREFIX arguments cannot contain NUL".into());
    }
    prefix.extend(args);
    Ok(prefix)
}

/// The argv the engine is started with. Mirrors the product host's
/// `engineArgs` and `nativeEngineOptions` mapping: the TypeScript host passes
/// the configuration directory plus the operator's `MIAO_ENGINE_*` knobs to the
/// engine, and a Rust-run Session has to read the same configuration or it
/// would run with a different policy, provider route, or tool set.
fn args(
    db: &Path,
    workspace: &Path,
    model: &str,
    config_dir: Option<&Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut args = vec![
        "serve".into(),
        "--db".into(),
        db.display().to_string(),
        "--workspace".into(),
        workspace.display().to_string(),
        "--model".into(),
        model.to_string(),
    ];
    if let Some(dir) = config_dir {
        push(&mut args, "--config-dir", dir.display().to_string());
    }
    // Every name in this table is accepted by `miao-engine serve`; a flag the
    // engine does not know would end the child process at startup.
    for (variable, flag) in [
        ("MIAO_ENGINE_PROVIDER", "--provider"),
        ("MIAO_ENGINE_ENDPOINT", "--endpoint"),
        ("MIAO_ENGINE_POLICY", "--policy"),
        ("MIAO_ENGINE_CREDENTIAL_DB", "--credential-db"),
        ("MIAO_ENGINE_CREDENTIAL_ID", "--credential-id"),
        (
            "MIAO_ENGINE_CREDENTIAL_INTEGRATION",
            "--credential-integration",
        ),
        ("MIAO_ENGINE_CONTEXT_CONFIG", "--context-config"),
        ("MIAO_ENGINE_MCP_CONFIG", "--mcp-config"),
        ("MIAO_ENGINE_LSP_CONFIG", "--lsp-config"),
        ("MIAO_ENGINE_FORMATTER_CONFIG", "--formatter-config"),
        ("MIAO_ENGINE_SKILLS_CONFIG", "--skills-config"),
        ("MIAO_ENGINE_REFERENCES_CONFIG", "--references-config"),
        ("MIAO_ENGINE_HOOKS_CONFIG", "--hooks-config"),
        ("MIAO_ENGINE_FALLBACK_MODEL", "--fallback-model"),
        ("MIAO_ENGINE_TOOL_DISCLOSURE", "--tool-disclosure"),
        ("MIAO_ENGINE_PROMPT_CACHE", "--prompt-cache"),
        ("MIAO_ENGINE_VERIFY_COMMAND", "--verify-command"),
        ("MIAO_CONTEXT_LIMITS", "--context-limits"),
    ] {
        if let Some(value) = env(variable) {
            push(&mut args, flag, value);
        }
    }
    // The explicit route config wins over the resolved convenience variable,
    // matching `nativeEngineOptions`.
    if let Some(routes) =
        env("MIAO_ENGINE_MODEL_ROUTES_CONFIG").or_else(|| env("MIAO_ENGINE_MODEL_ROUTES"))
    {
        push(&mut args, "--model-routes-config", routes);
    }
    args
}

fn push(args: &mut Vec<String>, flag: &str, value: String) {
    args.push(flag.to_string());
    args.push(value);
}

/// Prefer the operator override, then the engine retained beside this TUI,
/// then installed locations and `PATH`.
fn engine_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("MIAO_ENGINE_BIN") {
        return PathBuf::from(explicit);
    }
    let name = if cfg!(windows) {
        "miao-engine.exe"
    } else {
        "miao-engine"
    };
    if let Some(paired) = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(|dir| dir.join(name)))
        .filter(|candidate| candidate.is_file())
    {
        return paired;
    }
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
    /// Committed sequence covered by the last snapshot. Events at or below it
    /// are replay, not news, so they must not fire attention sounds.
    live_after: u64,
    displays: HashMap<String, Vec<DisplayFile>>,
    /// The newest `stop_failure`, carried the same way: the snapshot has no
    /// assistant message for a failed turn.
    failure: Option<(u64, String)>,
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
        let deadline = dirty.map(|start| start + REFRESH_DELAY);
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
                Some(Request::Prompt {
                    session_id,
                    text,
                    attachments,
                }) => {
                    let input = json!({
                        "session_id": session_id.clone(),
                        "input_id": new_id("in"),
                        "prompt": text,
                        "delivery": "steer",
                    });
                    match client.admit(input, true, attachments.clone()).await {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty.get_or_insert_with(Instant::now);
                            }
                        }
                        Err(error) => bus.send(AppEvent::PromptFailed {
                            text,
                            attachments,
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
                                dirty.get_or_insert_with(Instant::now);
                            }
                        }
                        Err(error) => bus.send(AppEvent::PromptFailed {
                            text: original,
                            attachments: Vec::new(),
                            message: format!("command failed: {error}"),
                        }),
                    }
                }
                Some(Request::CancelLastInput { session_id }) => {
                    match cancel_last_input(&client, &session_id).await {
                        Ok(Some(retrieved)) => {
                            dirty.get_or_insert_with(Instant::now);
                            let text = |key: &str| {
                                retrieved
                                    .get(key)
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string()
                            };
                            bus.send(AppEvent::InputRetrieved {
                                prompt: text("prompt"),
                                delivery: text("delivery"),
                            });
                        }
                        Ok(None) => bus.send(AppEvent::InputNotRetrieved {
                            reason: "no queued input to take back".into(),
                        }),
                        Err(error) => bus.send(AppEvent::InputNotRetrieved {
                            reason: format!("could not read the queue: {error}"),
                        }),
                    }
                }
                Some(Request::Shell {
                    session_id,
                    command,
                }) => match client.shell(&session_id, &new_id("sh"), &command).await {
                    Ok(_) => {
                        if open.as_ref().is_some_and(|state| state.id == session_id) {
                            dirty.get_or_insert_with(Instant::now);
                        }
                    }
                    Err(error) => bus.send(AppEvent::ShellFailed {
                        command,
                        message: format!("shell failed: {error}"),
                    }),
                },
                Some(Request::Cancel { session_id }) => {
                    match client.cancel(&session_id).await {
                        Ok(_) => {
                            dirty.get_or_insert_with(Instant::now);
                        }
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
                        Ok(_) => {
                            dirty.get_or_insert_with(Instant::now);
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("approval failed: {error}")))
                        }
                    }
                }
                Some(Request::Answer { session_id, answer }) => {
                    match client.answer_question(&session_id, answer).await {
                        Ok(_) => {
                            dirty.get_or_insert_with(Instant::now);
                        }
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
                        Ok(_) => {
                            dirty.get_or_insert_with(Instant::now);
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("reject failed: {error}")))
                        }
                    }
                }
                Some(Request::VcsChanges { generation, session_id }) => {
                    let result = client
                        .request("vcs_status", json!({ "session_id": session_id }))
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(crate::workspace_changes::decode);
                    bus.send(AppEvent::WorkspaceChanges { generation, result });
                }
                Some(Request::SavedPermissions { generation }) => {
                    let result = client.command("permission_pattern_list").await
                        .map_err(|error| error.to_string())
                        .and_then(crate::saved_permissions::decode);
                    bus.send(AppEvent::SavedPermissions { generation, result });
                }
                Some(Request::RevokePermission { generation, id }) => {
                    let result = client.request("permission_pattern_remove", json!({ "rule_id": id })).await
                        .map_err(|error| error.to_string())
                        .and_then(|value| match value.get("removed").and_then(Value::as_bool) {
                            Some(_) => Ok(()),
                            None => Err("Invalid permission revocation response".into()),
                        });
                    bus.send(AppEvent::PermissionRevoked { generation, id, result });
                }
                Some(Request::Catalog) => {
                    match client.command("model_catalog").await {
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
                                dirty.get_or_insert_with(Instant::now);
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("select failed: {error}")))
                        }
                    }
                }
                Some(Request::Workspaces) => {
                    let result = client.request("workspaces", json!({})).await;
                    match result {
                        Ok(value) => bus.send(AppEvent::Workspaces(pairs(&value))),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("workspaces failed: {error}")))
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
                                dirty.get_or_insert_with(Instant::now);
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
                                dirty.get_or_insert_with(Instant::now);
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
                Some(Request::Pin {
                    session_id,
                    pinned,
                }) => {
                    let result = client
                        .request(
                            "pin",
                            json!({ "session_id": session_id, "pinned": pinned }),
                        )
                        .await;
                    match result {
                        Ok(_) => refresh_sessions(&client, &bus).await,
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("pin failed: {error}")))
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
                Some(Request::RevertPreview {
                    session_id,
                    boundary_seq,
                }) => {
                    let result = client
                        .request(
                            "revert_preview",
                            json!({ "session_id": session_id, "boundary_seq": boundary_seq }),
                        )
                        .await;
                    match result {
                        Ok(value) => bus.send(AppEvent::RevertPreview {
                            session_id,
                            boundary_seq,
                            plan: RevertPlan::from_value(&value),
                        }),
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("preview failed: {error}")))
                        }
                    }
                }
                Some(Request::Revert {
                    session_id,
                    boundary_seq,
                    files,
                }) => {
                    let staged = client
                        .request(
                            "revert_stage",
                            json!({
                                "session_id": session_id,
                                "boundary_seq": boundary_seq,
                                "files": files,
                            }),
                        )
                        .await;
                    // A stage that never commits would leave the workspace
                    // restored with no visible rewind, so the two land
                    // together or not at all.
                    let result = match staged {
                        Ok(_) => client
                            .request("revert_commit", json!({ "session_id": session_id }))
                            .await
                            .map(|_| ()),
                        Err(error) => Err(error),
                    };
                    match result {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty.get_or_insert_with(Instant::now);
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("revert failed: {error}")))
                        }
                    }
                }
                Some(Request::Redo { session_id }) => {
                    let result = client
                        .request("unrevert", json!({ "session_id": session_id }))
                        .await;
                    match result {
                        Ok(_) => {
                            if open.as_ref().is_some_and(|state| state.id == session_id) {
                                dirty.get_or_insert_with(Instant::now);
                            }
                        }
                        Err(error) => {
                            bus.send(AppEvent::ActionFailed(format!("redo failed: {error}")))
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
                    if watched && open.as_ref().is_some_and(|state| event.seq > state.live_after) {
                        // Replay stops at the snapshot cursor: only events past
                        // it describe something that just happened.
                        if let Some((kind, id)) = attention_event(&event) {
                            bus.send(AppEvent::Attention { kind, id });
                        }
                        // Retries and tool calls are durable, so the live status
                        // reads them from the journal rather than the ephemeral
                        // progress channel.
                        match event.kind.as_str() {
                            "provider.retry" | "tool.planned" | "tool.completed" => {
                                bus.send(AppEvent::Provider(json!({
                                    "kind": event.kind.as_str(),
                                    "run_id": event.data.get("run_id").cloned().unwrap_or(Value::Null),
                                    "attempt": event.data.get("attempt").cloned().unwrap_or(Value::Null),
                                    "name": event.data.get("name").cloned().unwrap_or(Value::Null),
                                })));
                            }
                            _ => {}
                        }
                    }
                    // Anything that changes run status, the transcript, or a
                    // pending decision settles into the next snapshot.
                    if watched
                        && matches!(
                            event.kind.as_str(),
                            "message.committed"
                                | "tool.completed"
                                | "run.started"
                                | "run.finished"
                                | "stop_failure"
                                | "run.cancel_requested"
                                | "approval.requested"
                                | "approval.resolved"
                                | "question.requested"
                                | "question.resolved"
                        )
                    {
                        dirty.get_or_insert_with(Instant::now);
                    }
                }
                Some(TransportEvent::Failure(failure)) => {
                    bus.send(AppEvent::EngineFailure(format!(
                        "engine {}: {}",
                        failure.code, failure.message
                    )));
                    return;
                }
                Some(TransportEvent::Progress(params)) => {
                    // Ephemeral provider progress is what keeps a waiting status
                    // honest; a frame for another Session has no status to update.
                    if open.as_ref().is_some_and(|state| {
                        state.id == params.get("session_id").and_then(Value::as_str).unwrap_or_default()
                    }) {
                        bus.send(AppEvent::Provider(params));
                    }
                }
                Some(TransportEvent::Config(report)) => {
                    // The engine reloads its own files in standalone mode, so
                    // this arrives without any user action.
                    if let Some(notice) = config_notice(&report) {
                        bus.send(AppEvent::Notice(notice));
                    }
                }
                Some(TransportEvent::Resync(_)) => {}
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

/// What a `config` frame means for the user: the sections that moved, or why
/// the engine refused the reload. A frame with nothing changed says nothing.
fn config_notice(report: &Value) -> Option<String> {
    if let Some(error) = report.get("error").and_then(Value::as_str) {
        return Some(format!("configuration reload failed: {error}"));
    }
    let changed = report.get("changed")?.as_array()?;
    let names = changed.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    if names.is_empty() {
        return None;
    }
    Some(format!("configuration reloaded: {}", names.join(", ")))
}

async fn refresh_sessions(client: &EngineClient, bus: &Bus) {
    let ids = match client.command("sessions").await {
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
        live_after: 0,
        displays: HashMap::new(),
        failure: None,
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
    transcript.failure = state.failure.clone();
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
            let seq = item.get("seq").and_then(Value::as_u64).unwrap_or(0);
            transcript.apply_event(seq, kind, item.get("data").unwrap_or(&Value::Null));
        }
        state.seen = state.seen.max(last);
        if items.len() < EVENTS_PAGE {
            break;
        }
    }
    state.displays = transcript.displays.clone();
    state.failure = transcript.failure.clone();
    transcript.push_failure();
    let cursor = snapshot.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    state.live_after = cursor.max(state.live_after);
    let _ = client.subscribe(&state.id, cursor).await;
    bus.send(AppEvent::SessionOpened {
        summary: SessionSummary::from_snapshot(&snapshot),
        transcript: Box::new(transcript),
        state: SessionState::from_snapshot(&snapshot),
    });
}

/// An event the user should hear about if attention is enabled. Approval and
/// question ids deduplicate repeated notifications for one pending request.
fn attention_event(event: &transport::EngineEvent) -> Option<(attention::Kind, Option<String>)> {
    match event.kind.as_str() {
        "approval.requested" => Some((
            attention::Kind::Permission,
            event
                .data
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "question.requested" => Some((
            attention::Kind::Question,
            event
                .data
                .get("question_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "run.finished" => match event.data.get("reason").and_then(Value::as_str) {
            Some("failed") => Some((attention::Kind::Error, None)),
            Some("interrupted") => None,
            _ => Some((attention::Kind::Done, None)),
        },
        _ => None,
    }
}

/// Session and input ids are only opaque keys to the engine; hex keeps them
/// readable and sorted by creation.
/// Take back the newest input that is still waiting for promotion.
///
/// The inbox pages oldest first, so this walks to the end before choosing the
/// last row. The cancel then decides: only an accepted cancel hands the text
/// back, because an input that was promoted meanwhile is the running turn's
/// history, not a draft.
async fn cancel_last_input(
    client: &EngineClient,
    session_id: &str,
) -> Result<Option<Value>, transport::TransportError> {
    let mut after = None;
    let mut newest: Option<Value> = None;
    loop {
        let page = client
            .pending_inputs(session_id, after, PENDING_INPUT_PAGE)
            .await?;
        let inputs = page
            .get("inputs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(last) = inputs.last() else { break };
        let next = last.get("admitted_seq").and_then(Value::as_u64);
        newest = Some(last.clone());
        let has_more = page
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // A page that cannot advance would loop forever; stop instead.
        if !has_more || next.is_none() || next == after {
            break;
        }
        after = next;
    }
    let Some(newest) = newest else {
        return Ok(None);
    };
    let input_id = newest.get("id").and_then(Value::as_str).unwrap_or_default();
    let receipt = client.cancel_input(session_id, input_id).await?;
    if receipt.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    Ok(Some(newest))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        move |name| pairs.get(name).cloned()
    }

    #[test]
    fn an_unrouted_model_is_announced_unless_the_product_supplied_routes() {
        let bare = vec![
            "serve".to_string(),
            "--model".to_string(),
            UNROUTED_MODEL.to_string(),
        ];
        assert_eq!(
            unrouted_notice(&bare, UNROUTED_MODEL, false).as_deref(),
            Some("no model routes: start the product with `miao`, or set MIAO_ENGINE_MODEL_ROUTES_CONFIG")
        );
        // The product's shim replaces the engine's model with the default route,
        // so the placeholder in argv says nothing about this Session.
        assert_eq!(unrouted_notice(&bare, UNROUTED_MODEL, true), None);
        // A manifest makes the picker usable; the Session just has no model yet.
        let mut routed = bare.clone();
        routed.extend([
            "--model-routes-config".to_string(),
            "/routes.json".to_string(),
        ]);
        assert_eq!(
            unrouted_notice(&routed, UNROUTED_MODEL, false).as_deref(),
            Some("no model selected: choose one with /model")
        );
        assert_eq!(
            unrouted_notice(&routed, "google/gemini-3.8-flash", false),
            None
        );
    }

    #[test]
    fn the_engine_argv_carries_the_configuration_directory() {
        let args = args(
            Path::new("/data/miao.db"),
            Path::new("/work"),
            "openai/gpt-5",
            Some(Path::new("/config")),
            environment(&[]),
        );
        assert_eq!(
            args,
            [
                "serve",
                "--db",
                "/data/miao.db",
                "--workspace",
                "/work",
                "--model",
                "openai/gpt-5",
                "--config-dir",
                "/config",
            ]
        );
    }

    #[test]
    fn launcher_prefix_preserves_literal_arguments_and_engine_flags() {
        let args = vec![
            "serve".into(),
            "--db".into(),
            "C:\\profile dir\\engine.db".into(),
        ];
        assert_eq!(launch_args(args.clone(), None).unwrap(), args);
        assert_eq!(launch_args(args.clone(), Some("[]")).unwrap(), args);
        let mut expected = vec!["C:\\source dir\\index.ts".into(), "__engine-shim".into()];
        expected.extend(args.clone());
        assert_eq!(
            launch_args(
                args.clone(),
                Some(r#"["C:\\source dir\\index.ts","__engine-shim"]"#)
            )
            .unwrap(),
            expected
        );
        for invalid in ["{}", "[1]", "not-json", r#"["bad\u0000argument"]"#] {
            assert!(launch_args(args.clone(), Some(invalid)).is_err());
        }
    }

    #[test]
    fn operator_environment_reaches_the_engine_as_flags() {
        let args = args(
            Path::new("/data/miao.db"),
            Path::new("/work"),
            "openai/gpt-5",
            None,
            environment(&[
                ("MIAO_ENGINE_CREDENTIAL_DB", "/data/miao.db"),
                ("MIAO_ENGINE_CREDENTIAL_ID", "cred_1"),
                ("MIAO_ENGINE_PROVIDER", "openai-chat"),
                ("MIAO_ENGINE_PROMPT_CACHE", "on"),
                ("MIAO_ENGINE_MODEL_ROUTES", "/routes.json"),
                ("MIAO_ENGINE_MODEL_ROUTES_CONFIG", "/explicit.json"),
            ]),
        );
        // `serve` is a lone leading word; every option after it is a pair.
        let pairs: Vec<(&str, &str)> = args[1..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| (pair[0].as_str(), pair[1].as_str()))
            .collect();
        assert!(!pairs.iter().any(|(flag, _)| *flag == "--config-dir"));
        assert!(pairs.contains(&("--credential-db", "/data/miao.db")));
        assert!(pairs.contains(&("--credential-id", "cred_1")));
        assert!(pairs.contains(&("--provider", "openai-chat")));
        assert!(pairs.contains(&("--prompt-cache", "on")));
        assert!(pairs.contains(&("--model-routes-config", "/explicit.json")));
        assert!(!pairs.iter().any(|(flag, _)| *flag == "--model-routes"));
    }

    #[test]
    fn unset_options_never_appear() {
        let args = args(
            Path::new("/data/miao.db"),
            Path::new("/work"),
            "m",
            None,
            environment(&[]),
        );
        assert_eq!(args.len(), 7);
        assert!(!args.iter().any(|arg| arg == "--credential-db"));
    }
}

/// Name plus detail from the host's export, the shape every read-only panel
/// uses. Anything else is dropped rather than shown as a broken row.
fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some((
                        row.get("name")?.as_str()?.to_string(),
                        row.get("detail")?.as_str().unwrap_or_default().to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}
