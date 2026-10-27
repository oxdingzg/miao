use crossterm::event::Event as TerminalEvent;
use crossterm::event::KeyEvent;

use crate::dialogs::{AccountInfo, ModelInfo};
use crate::session::{SessionState, SessionSummary, Transcript};
use crate::status::UsageSummary;

#[derive(Debug)]
pub enum AppEvent {
    Key(KeyEvent),
    /// Bracketed paste, delivered as one chunk so line breaks stay literal.
    Paste(String),
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
    /// A fresh projection of the open Session.
    SessionOpened {
        summary: Option<SessionSummary>,
        transcript: Box<Transcript>,
        state: SessionState,
    },
    /// A control action (cancel, approve, answer) the engine refused. Shown as
    /// a composer notice; it never ends the transport.
    ActionFailed(String),
    /// A prompt the engine refused. The UI puts `text` back in the composer so
    /// the draft is never lost.
    PromptFailed {
        text: String,
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
    match event {
        TerminalEvent::Key(key) => Some(AppEvent::Key(key)),
        TerminalEvent::Paste(text) => Some(AppEvent::Paste(text)),
        TerminalEvent::Resize(width, height) => Some(AppEvent::Resize { width, height }),
        _ => None,
    }
}
