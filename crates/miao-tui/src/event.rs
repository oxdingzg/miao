use crossterm::event::Event as TerminalEvent;
use crossterm::event::{KeyEvent, MouseEvent};
use serde_json::Value;

use crate::dialogs::{AccountInfo, ModelInfo};
use crate::platform::attention;
use crate::platform::clipboard;
use crate::session::{RevertPlan, SessionState, SessionSummary, Transcript};
use crate::status::UsageSummary;

/// One row of the jobs dialog: a background job of the Session, or, when
/// `subagent` is set, one of the Session's subagent runs. A subagent row
/// carries an empty `id`, so `x` — which stops jobs — walks over it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobRow {
    pub id: String,
    /// The Session that owns the row, in the short form the dialog shows.
    pub owner: String,
    pub state: String,
    /// What the row is about: a job's command, a subagent's description.
    pub detail: String,
    pub subagent: bool,
}

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
    /// One archived tool output an operator asked to restore with `/recall`.
    Recalled {
        handle: String,
        text: String,
        total_bytes: u64,
        truncated: bool,
        next_offset: Option<u64>,
    },
    /// A restore that did not produce a window; shown as a notice.
    RecallFailed(String),
    /// A tag the engine refused; shown as a notice so the operator does not
    /// believe the label was stored.
    TagFailed(String),
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
    /// The engine's full provider directory; the picker lists the
    /// un-configured rest as "needs auth" rows under the served models.
    ProviderCatalog(serde_json::Value),
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
    WorkspaceDiff {
        generation: u64,
        path: String,
        result: Result<crate::workspace_changes::DiffView, String>,
    },
    /// The selectable accounts named by the same catalog.
    Accounts(Vec<AccountInfo>),
    /// The open Session's billed usage, for the status dialog.
    Usage(UsageSummary),
    UsageHourly(crate::status::HourlyUsage),
    /// The host's workspace list, served by the engine.
    Workspaces(Vec<(String, String, String)>),
    /// The host answered a call the engine does not own.
    HostResult {
        op: String,
        result: serde_json::Value,
    },
    /// The host's remote-control devices, served by the engine.
    Devices(serde_json::Value),
    /// Background jobs of the open Session, newest first, each row naming the
    /// Session that owns it; the Session's subagent runs follow the jobs.
    Jobs(Vec<JobRow>),
    /// The git worktrees of the checkout the open Session works in, the
    /// checkout itself first.
    Worktrees(Vec<crate::worktrees::Worktree>),
    /// The Session's scheduled wakeups and cron jobs, as
    /// `(kind:id, label, detail)` newest first.
    Schedule(Vec<(String, String, String)>),
    /// One background job's detail, for the row the operator selected.
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
        state: Box<SessionState>,
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

/// How many events may wait for the render loop before backpressure applies.
///
/// A streaming turn emits one event per token and the loop paints once per
/// frame, so the queue exists to absorb a burst, not to be unbounded. With no
/// ceiling a producer that outruns the renderer — a slow terminal, a huge
/// pasted block — grows the heap until the process is killed.
const BUS_CAPACITY: usize = 1_024;

#[derive(Clone)]
pub struct Bus {
    tx: tokio::sync::mpsc::Sender<AppEvent>,
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl Bus {
    /// Queue an event, dropping it if the render loop is far enough behind.
    ///
    /// Dropping is safe for events that carry the *latest* state rather than a
    /// transition and that another event will carry again: a status frame is
    /// replaced by the next, and a catalog row arrives again on the following
    /// refresh. Events the operator cannot recover from — a keystroke, a failed
    /// prompt, an engine failure — are awaited instead, because losing them
    /// would change what the answer means.
    ///
    /// A Session projection is awaited for that same reason even though it
    /// carries the latest state: the projection it supersedes is already gone,
    /// so dropping it is not coalescing, it is losing the only copy. The last
    /// projection of a turn is the one most likely to meet a full queue — a
    /// finished run has no later frame to trigger another — and it is the one
    /// that would have cleared the queue count, the pending prompts and
    /// `active_run`.
    pub fn send(&self, event: AppEvent) {
        match self.tx.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                if requires_delivery(&event) {
                    // The bounded send would block the producer; this is the
                    // one place where waiting is correct.
                    //
                    // The producer is not always a Tokio task: the terminal
                    // input reader is a plain thread (`input::spawn`), so
                    // `tokio::spawn` there panicked with "there is no reactor
                    // running" and took the reader down with it. Every later
                    // keystroke was then lost — Enter included, which read as
                    // "the prompt will not submit". Wait inline when there is
                    // no runtime to hand the wait to.
                    let tx = self.tx.clone();
                    match tokio::runtime::Handle::try_current() {
                        Ok(handle) => {
                            handle.spawn(async move {
                                let _ = tx.send(event).await;
                            });
                        }
                        Err(_) => {
                            let _ = tx.blocking_send(event);
                        }
                    }
                    return;
                }
                self.dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            // The receiver is gone: the TUI is shutting down.
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {}
        }
    }

    /// How many coalescible events were dropped because the loop was behind.
    /// Exposed for the status line and tests; zero in ordinary operation.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Whether losing this event would change what the operator sees or can do.
///
/// Everything not listed here repeats: a later projection, status frame, or
/// catalog reply replaces it before the loop could have drawn twice.
///
/// `Provider` is not one of those. Each frame carries one streamed delta and
/// the next frame carries the next piece of text, not the whole transcript, so
/// dropping one leaves a hole nothing replaces. Dropping a burst of them left
/// the screen frozen on an older paint — the operator saw nothing appear until
/// their next keystroke produced a fresh event, which is exactly the "the
/// answer only shows up after I type again" report. Waiting for a slot is the
/// right trade here: the render loop is the only consumer and it drains every
/// queued event before painting.
fn requires_delivery(event: &AppEvent) -> bool {
    matches!(
        event,
        AppEvent::Key(_)
            | AppEvent::Paste(_)
            | AppEvent::EngineFailure(_)
            | AppEvent::PromptFailed { .. }
            | AppEvent::ActionFailed(_)
            | AppEvent::InputRetrieved { .. }
            | AppEvent::ShellFailed { .. }
            | AppEvent::Attention { .. }
            | AppEvent::Provider(_)
            | AppEvent::SessionOpened { .. }
    )
}

pub type Rx = tokio::sync::mpsc::Receiver<AppEvent>;

pub fn bus() -> (Bus, Rx) {
    let (tx, rx) = tokio::sync::mpsc::channel(BUS_CAPACITY);
    (
        Bus {
            tx,
            dropped: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        },
        rx,
    )
}

/// The event kind crossterm's reader produces, or `None` when it is one this
/// TUI has nothing to do with.
///
/// The `_` arm is required, not defensive: `TerminalEvent` is
/// `#[non_exhaustive]`, so a crossterm upgrade may add a variant and this
/// match has to keep compiling. With today's variant set every arm is
/// reachable and the fallback is dead, which is why the lint fires — the
/// `allow` records that the arm is there for the next version, not for this
/// one.
#[allow(unreachable_patterns)]
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

#[cfg(test)]
mod backpressure_tests {
    use super::{bus, AppEvent, BUS_CAPACITY};
    use crate::session::{SessionState, Transcript};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    /// A producer that outruns the loop must not grow the heap without bound.
    /// Coalescible events are dropped once the queue is full, and the count
    /// makes that visible instead of silent.
    #[tokio::test]
    async fn coalescible_events_are_dropped_when_the_loop_is_behind() {
        let (bus, mut rx) = bus();
        // Fill the queue without reading, as a slow renderer would.
        for _ in 0..BUS_CAPACITY * 2 {
            bus.send(AppEvent::Resize {
                width: 80,
                height: 24,
            });
        }
        assert!(
            bus.dropped() >= BUS_CAPACITY as u64,
            "dropped {}",
            bus.dropped()
        );
        // The receiver still gets exactly what fits, and nothing is lost from
        // the queue's own view.
        let mut received = 0;
        while rx.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(received, BUS_CAPACITY, "queue held more than its capacity");
    }

    /// A keystroke is not coalescible: dropping it would change the answer.
    /// It is delivered even while the queue is full.
    #[tokio::test]
    async fn operator_input_is_delivered_even_when_the_queue_is_full() {
        let (bus, mut rx) = bus();
        for _ in 0..BUS_CAPACITY {
            bus.send(AppEvent::Notice("filler".into()));
        }
        assert_eq!(
            bus.dropped(),
            0,
            "filling the queue must not drop notices yet"
        );
        bus.send(AppEvent::Key(KeyEvent::new(
            KeyCode::Char('x'),
            KeyModifiers::NONE,
        )));
        // The key waits for a slot rather than being discarded. Draining one
        // event lets it through.
        let first = rx.recv().await.unwrap();
        assert!(matches!(first, AppEvent::Notice(_)));
        // Drain until the key arrives; it must be in the queue, not dropped.
        let mut saw_key = false;
        while let Ok(event) = rx.try_recv() {
            if matches!(event, AppEvent::Key(_)) {
                saw_key = true;
                break;
            }
        }
        if !saw_key {
            // The spawned forwarder may still be running; give it a turn.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            while let Ok(event) = rx.try_recv() {
                if matches!(event, AppEvent::Key(_)) {
                    saw_key = true;
                    break;
                }
            }
        }
        assert!(saw_key, "a keystroke was dropped instead of delivered");
    }

    /// A Session projection is the only event that carries the Session's own
    /// state — the queue count, the pending prompts, `active_run` — so it
    /// cannot be coalesced away: the projection it supersedes is already gone,
    /// and the last one of a turn has no later frame to replace it. Losing that
    /// one left the footer reporting `queued (1)` for a prompt the engine had
    /// already promoted and answered.
    #[tokio::test]
    async fn a_session_projection_is_delivered_even_when_the_queue_is_full() {
        let (bus, mut rx) = bus();
        for _ in 0..BUS_CAPACITY {
            bus.send(AppEvent::Notice("filler".into()));
        }
        assert_eq!(
            bus.dropped(),
            0,
            "filling the queue must not drop notices yet"
        );
        bus.send(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        // The projection waits for a slot rather than being discarded, so it
        // arrives behind whatever still fits.
        let projection = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                match rx.recv().await {
                    Some(event @ AppEvent::SessionOpened { .. }) => return event,
                    Some(_) => {}
                    None => panic!("the bus closed before the projection arrived"),
                }
            }
        })
        .await;
        assert!(
            projection.is_ok(),
            "the Session projection was dropped instead of delivered"
        );
        assert_eq!(bus.dropped(), 0, "a projection was counted as dropped");
    }

    /// The terminal reader is a plain thread, not a Tokio task, so the
    /// "must be delivered" path used to call `tokio::spawn` where no runtime
    /// exists and panic with "there is no reactor running". The thread died
    /// with it and every later keystroke was lost — Enter included, which the
    /// operator read as "the prompt will not submit".
    #[test]
    fn a_keystroke_from_a_plain_thread_is_delivered_without_a_runtime() {
        let (bus, mut rx) = bus();
        for _ in 0..BUS_CAPACITY {
            bus.send(AppEvent::Notice("filler".into()));
        }
        let reader = {
            let bus = bus.clone();
            std::thread::spawn(move || {
                bus.send(AppEvent::Key(KeyEvent::new(
                    KeyCode::Enter,
                    KeyModifiers::NONE,
                )));
            })
        };
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        // Drain until the key arrives; the sender is blocked on a slot until
        // it does.
        for _ in 0..BUS_CAPACITY + 1 {
            match rx.try_recv() {
                Ok(event) => received.lock().expect("received").push(event),
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            if received
                .lock()
                .expect("received")
                .iter()
                .any(|event| matches!(event, AppEvent::Key(_)))
            {
                break;
            }
        }
        reader.join().expect("the reader thread must not panic");
        assert!(
            received
                .lock()
                .expect("received")
                .iter()
                .any(|event| matches!(event, AppEvent::Key(_))),
            "the keystroke was lost instead of delivered"
        );
        assert_eq!(bus.dropped(), 0, "a keystroke was counted as dropped");
    }
}
