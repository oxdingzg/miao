use crossterm::event::Event as TerminalEvent;
use crossterm::event::{KeyEvent, MouseEvent};
use serde_json::Value;

use crate::dialogs::{AccountInfo, ModelInfo};
use crate::platform::attention;
use crate::platform::clipboard;
use crate::session::{SessionState, SessionSummary, Transcript};
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
    /// The selectable accounts named by the same catalog.
    Accounts(Vec<AccountInfo>),
    /// The open Session's billed usage, for the status dialog.
    Usage(UsageSummary),
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
    /// A prompt the engine refused. The UI puts `text` and its attachments
    /// back in the composer so the draft is never lost.
    PromptFailed {
        text: String,
        attachments: Vec<Value>,
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

pub fn from_terminal(event: TerminalEvent) -> AppEvent {
    match event {
        TerminalEvent::Key(key) => AppEvent::Key(key),
        TerminalEvent::Paste(text) => AppEvent::Paste(text),
        TerminalEvent::FocusGained => AppEvent::Focus(true),
        TerminalEvent::FocusLost => AppEvent::Focus(false),
        TerminalEvent::Resize(width, height) => AppEvent::Resize { width, height },
        TerminalEvent::Mouse(mouse) => AppEvent::Mouse(mouse),
    }
}
