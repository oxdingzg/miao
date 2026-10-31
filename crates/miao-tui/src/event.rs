use crossterm::event::Event as TerminalEvent;
use crossterm::event::{KeyEvent, MouseEvent};
use serde_json::Value;

use crate::dialogs::{AccountInfo, ModelInfo};
use crate::platform::attention;
use crate::platform::clipboard;
use crate::session::{RevertPlan, SessionState, SessionSummary, Transcript};
use crate::status::UsageSummary;

#[derive(Debug)]
pub enum AppEvent {
    Key(KeyEvent),
    /// Bracketed paste, delivered as one chunk so line breaks stay literal.
    Paste(String),
    /// Terminal focus change, which gates desktop notifications.
    Focus(bool),
    /// Wheel and click reports; only wheel movement does anything.
    Mouse(MouseEvent),
    /// A watched Session event worth telling the user about.
    Attention {
        kind: attention::Kind,
        /// Approval or question id, deduplicated while it stays pending.
        id: Option<String>,
    },
    /// A clipboard read that ran off the UI thread.
    Clipboard(Option<clipboard::Content>),
    /// The external editor exited; `Ok(None)` means it saved an empty file.
    EditorFinished(Result<Option<String>, String>),
    Resize {
        width: u16,
        height: u16,
    },
    /// The home list, already filtered and ordered by the engine task.
    Sessions(Vec<SessionSummary>),
    /// Every root Session, archived included, for the Session dialog.
    Catalog(Vec<SessionSummary>),
    /// The engine's model catalog, one entry per selectable binding.
    Models(Vec<ModelInfo>),
    SavedPermissions {
        generation: u64,
        result: Result<Vec<crate::saved_permissions::Rule>, String>,
    },
    PermissionRevoked {
        generation: u64,
        id: String,
        result: Result<(), String>,
    },
    WorkspaceChanges {
        generation: u64,
        result: Result<crate::workspace_changes::VcsState, String>,
    },
    /// The selectable accounts named by the same catalog.
    Accounts(Vec<AccountInfo>),
    /// The open Session's billed usage, for the status dialog.
    Usage(UsageSummary),
    /// The host's workspace list, served by the engine.
    Workspaces(Vec<(String, String, String)>),
    /// The host's remote-control devices, served by the engine.
    Devices(Vec<(String, String)>),
    /// The open Session moved to another workspace.
    SessionMoved,
    /// What a revert at one boundary would change, for the confirm dialog.
    RevertPreview {
        session_id: String,
        boundary_seq: u64,
        plan: RevertPlan,
    },
    /// The Session currently open was deleted.
    SessionRemoved(String),
    /// One ephemeral provider fact for the open Session: a progress frame or a
    /// journaled retry. It never belongs to the transcript, only to the live
    /// status line.
    Provider(Value),
    /// A fresh projection of the open Session.
    SessionOpened {
        summary: Option<SessionSummary>,
        transcript: Box<Transcript>,
        state: SessionState,
    },
    /// A control action (cancel, approve, answer) the engine refused. Shown as
    /// a composer notice; it never ends the transport.
    ActionFailed(String),
    /// Something the user should know that is not a failure, such as the engine
    /// reloading its configuration. Shown as a composer notice.
    Notice(String),
    /// A prompt the engine refused. The UI puts `text` and its attachments
    /// back in the composer so the draft is never lost.
    PromptFailed {
        text: String,
        attachments: Vec<Value>,
        message: String,
    },
    /// The newest queued input was cancelled and handed back, so the operator
    /// can edit and resend it instead of retyping it.
    InputRetrieved {
        prompt: String,
        delivery: String,
    },
    /// Nothing was cancellable: the newest input was already promoted, or the
    /// queue drained while the request was in flight. The caller may interrupt
    /// the run instead, but it must not claim the input was cancelled.
    InputNotRetrieved {
        reason: String,
    },
    /// A `!` command the engine refused. The UI restores the command in shell
    /// mode so it can be edited and retried.
    ShellFailed {
        command: String,
        message: String,
    },
    /// A terminal engine failure; the task stops after sending it.
    EngineFailure(String),
}

#[derive(Clone)]
pub struct Bus {
    tx: tokio::sync::mpsc::UnboundedSender<AppEvent>,
}

impl Bus {
    pub fn send(&self, event: AppEvent) {
        let _ = self.tx.send(event);
    }
}

pub type Rx = tokio::sync::mpsc::UnboundedReceiver<AppEvent>;

pub fn bus() -> (Bus, Rx) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (Bus { tx }, rx)
}

pub fn from_terminal(event: TerminalEvent) -> Option<AppEvent> {
    Some(match event {
        TerminalEvent::Key(key) => AppEvent::Key(key),
        TerminalEvent::Paste(text) => AppEvent::Paste(text),
        TerminalEvent::FocusGained => AppEvent::Focus(true),
        TerminalEvent::FocusLost => AppEvent::Focus(false),
        TerminalEvent::Resize(width, height) => AppEvent::Resize { width, height },
        TerminalEvent::Mouse(mouse) => AppEvent::Mouse(mouse),
        _ => return None,
    })
}
