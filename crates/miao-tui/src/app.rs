use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::Frame;
use serde_json::Value;

use crate::commands::{self, Builtin};
use crate::dialogs::{
    AccountInfo, Action as DialogAction, ConfirmKind, Dialog, ModelInfo, Row, TextDialog,
};
use crate::editor::{Action, Mode};
use crate::engine;
use crate::event::{AppEvent, Bus};
use crate::keybinds::{self, Keymap};
use crate::pane::{render_dialog, Home, Panel, PanelKind, Shell, StatusHint};
use crate::platform::attention::{self, Attention};
use crate::platform::{clipboard, editor, zed};
use crate::scroll::Scroll;
use crate::session::{Entry, Part, SessionState, SessionSummary};
use crate::state::{self, StashEntry};
use crate::status::UsageSummary;
use crate::theme::{self, Theme};
use crate::tool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// The Session list that opens the TUI.
    Home,
    /// One Session's transcript plus composer.
    Session,
}

/// How long the engine may stay quiet before the status says so. The engine
/// heartbeats every five seconds while it waits on a provider, so three missed
/// frames is a real gap rather than scheduler jitter.
const LIVE_SILENCE: Duration = Duration::from_secs(15);

/// Where the engine last said an active run was. Ephemeral: a client that
/// attaches mid-turn learns the run from the snapshot and the rest from the next
/// frame, so nothing here is persisted.
#[derive(Debug, Clone)]
pub struct Live {
    pub run_id: String,
    pub phase: LivePhase,
    /// When the current phase began, for the elapsed part of the status.
    pub since: Instant,
    /// The newest frame from the engine, which is the only proof it is working.
    pub signal: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LivePhase {
    /// The request is out and no token has come back yet.
    Waiting,
    /// A pause before another attempt, announced by the engine.
    Retrying { attempt: u64 },
    /// A tool call is executing. The engine is quiet here too, but naming the
    /// work is what makes a long command differ from a stuck turn.
    Tool { name: String },
}

impl Live {
    /// The engine has not reported anything for long enough that the wait is
    /// worth calling out. It says the client stopped hearing from the engine; it
    /// never claims the turn failed. Only a provider wait has a heartbeat to
    /// miss: a running tool can be silent for minutes by design.
    fn silent(&self, now: Instant) -> bool {
        matches!(self.phase, LivePhase::Waiting) && now.duration_since(self.signal) >= LIVE_SILENCE
    }

    fn describe(&self, now: Instant) -> String {
        let elapsed = waited(now.duration_since(self.since));
        match &self.phase {
            LivePhase::Waiting if self.silent(now) => format!(
                "waiting for model · {elapsed} · no engine signal {}",
                waited(now.duration_since(self.signal))
            ),
            LivePhase::Waiting => format!("waiting for model · {elapsed}"),
            LivePhase::Retrying { attempt } => format!("retrying attempt {attempt} · {elapsed}"),
            LivePhase::Tool { name } => format!("running {name} · {elapsed}"),
        }
    }
}

/// The answer being streamed. V2 commits one assistant message per provider
/// turn, so without this the transcript would stay silent for the whole stream.
/// The next projection replaces it with the committed message; it is never
/// persisted and never copied.
#[derive(Debug, Default)]
pub struct Draft {
    run_id: String,
    /// Assistant entries committed when the stream started. A projection that
    /// commits one more is the message this draft was standing in for.
    committed: usize,
    text: String,
    reasoning: String,
}

impl Draft {
    fn append(&mut self, delta: &Value) {
        let text = delta
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match delta.get("kind").and_then(Value::as_str) {
            Some("text.delta") => self.text.push_str(text),
            Some("reasoning.delta") => self.reasoning.push_str(text),
            // Tool arguments stream too, but they belong to a call the
            // transcript renders once it is committed.
            _ => {}
        }
    }
}

/// A tool name is engine-supplied and the status is one line, so keep the first
/// word of the first line and cap it.
fn tool_label(name: &str) -> String {
    let line = name.lines().next().unwrap_or_default().trim();
    let label = line.split_whitespace().next().unwrap_or("tool");
    label.chars().take(24).collect()
}

/// Whole seconds under a minute, then minutes and seconds. A count reads as
/// movement; a rounded-down minute reads as a stuck status.
fn waited(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        return format!("{seconds}s");
    }
    format!("{}m {:02}s", seconds / 60, seconds % 60)
}

/// What the process should open once the engine is attached. The launch flags
/// are intents rather than commands: each one is consumed at the point the
/// engine answers, so a failed `--session` never swallows a later `--prompt`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Startup {
    pub session: Option<String>,
    pub continue_last: bool,
    pub prompt: Option<String>,
}

pub struct App {
    pub shell: Shell,
    pub home: Home,
    pub screen: Screen,
    pub engine: Option<engine::Handle>,
    pub session: Option<SessionSummary>,
    pub state: SessionState,
    pub quit: bool,
    /// The home list owns the keyboard by default (filter, numbered slots,
    /// pin); `Tab` moves focus to the prompt and back, so a first prompt can
    /// still be typed from the landing screen.
    home_list_focus: bool,
    dialog: Option<Dialog>,
    permission_generation: u64,
    workspace_changes_generation: u64,
    /// `Ctrl+X` was pressed; the next key completes the chord.
    leader: bool,
    /// When the leader was armed, so a stale one expires instead of eating a
    /// keystroke minutes later.
    leader_since: Option<Instant>,
    /// How long an armed leader waits for its chord key.
    leader_timeout: Duration,
    keys: Keymap,
    workspace: PathBuf,
    /// What the engine was started with, shown by the debug dialog.
    settings: Option<engine::Settings>,
    models: Vec<ModelInfo>,
    accounts: Vec<AccountInfo>,
    usage: Option<UsageSummary>,
    stash: Vec<StashEntry>,
    /// Prompts this Session already sent, oldest first. Retrying a failed turn
    /// is the common reason to send one again, and retyping it is what makes
    /// recovery expensive.
    prompt_history: Vec<String>,
    /// One draft per Session, so a prompt typed in one Session never appears in
    /// another. Session removal drops its entry with the Session.
    drafts: HashMap<String, String>,
    /// Where a recall is standing; `prompt_history.len()` means "not recalling".
    history_index: usize,
    /// Every root Session, archived included, for the Session dialog.
    catalog: Vec<SessionSummary>,
    /// MCP servers the host exported for this workspace (name, transport).
    mcp: Vec<(String, String)>,
    /// Integrations the host reported a stored credential for (name, label).
    providers: Vec<(String, String)>,
    /// Skills the host discovered (name, description).
    skills: Vec<(String, String)>,
    /// Remote-control devices the engine serves, with the identity an approve
    /// or revoke call echoes.
    devices: Vec<DeviceRow>,
    /// Workspaces the engine serves (name, branch or type, directory).
    workspaces: Vec<(String, String, String)>,
    /// The model dialog waits for the catalog when nothing is cached yet.
    pending_models: bool,
    /// Same for the account dialog.
    pending_accounts: bool,
    /// Wheel speed and acceleration, from `tui.json`.
    scroll: Scroll,
    /// Template commands discovered at startup; a slash prompt naming one is
    /// rendered and admitted as a command instead of plain text.
    templates: Vec<commands::Template>,
    attention: Attention,
    /// Set once the engine is attached; clipboard reads report back through it.
    bus: Option<Bus>,
    pending_editor: Option<editor::Request>,
    redraw_requested: bool,
    suspend_requested: bool,
    terminal_title_enabled: bool,
    terminal_title_allowed: bool,
    /// Approval and question ids already announced.
    notified: Vec<String>,
    /// The Zed selection already sent with an earlier prompt.
    zed_selection_key: Option<String>,
    clipboard_busy: bool,
    startup: Startup,
    /// Built-in plus custom themes, in menu order.
    themes: theme::Catalog,
    /// Live provider activity for the open Session.
    live: Option<Live>,
    /// The answer streaming in ahead of its committed message.
    draft: Option<Draft>,
    /// Assistant entries in the last projection, so a draft can name the
    /// projection that supersedes it.
    committed: usize,
}

impl App {
    pub fn new(
        workspace: PathBuf,
        theme: Theme,
        themes: theme::Catalog,
        keys: Keymap,
        attention_config: crate::config::AttentionConfig,
        startup: Startup,
    ) -> Self {
        let home = Home::new(theme.clone());
        let templates = commands::templates(&workspace);
        let mut shell = Shell::new(&workspace, theme);
        shell
            .composer
            .set_commands(commands::completion_names(&templates));
        shell
            .composer
            .set_command_details(commands::completion_details(&templates));
        Self {
            shell,
            home,
            screen: Screen::Home,
            engine: None,
            session: None,
            state: SessionState::default(),
            quit: false,
            home_list_focus: true,
            dialog: None,
            permission_generation: 0,
            workspace_changes_generation: 0,
            leader: false,
            leader_since: None,
            leader_timeout: Duration::from_millis(2000),
            keys,
            workspace,
            settings: None,
            models: Vec::new(),
            mcp: parse_pairs(std::env::var("MIAO_TUI_MCP_JSON").ok().as_deref()),
            providers: parse_pairs(std::env::var("MIAO_TUI_PROVIDERS_JSON").ok().as_deref()),
            skills: parse_pairs(std::env::var("MIAO_TUI_SKILLS_JSON").ok().as_deref()),
            workspaces: Vec::new(),
            devices: Vec::new(),
            accounts: Vec::new(),
            usage: None,
            stash: Vec::new(),
            prompt_history: Vec::new(),
            drafts: HashMap::new(),
            history_index: 0,
            catalog: Vec::new(),
            pending_models: false,
            pending_accounts: false,
            scroll: Scroll::default(),
            templates,
            attention: Attention::new(attention_config),
            bus: None,
            pending_editor: None,
            redraw_requested: false,
            suspend_requested: false,
            terminal_title_enabled: true,
            terminal_title_allowed: true,
            notified: Vec::new(),
            zed_selection_key: None,
            clipboard_busy: false,
            startup,
            themes,
            live: None,
            draft: None,
            committed: 0,
        }
    }

    pub fn set_bus(&mut self, bus: Bus) {
        self.bus = Some(bus);
    }

    /// Act on the launch flags once the engine is attached. `--session` opens
    /// that Session directly; `--continue` asks for the catalog because only
    /// the engine knows which Session was updated last.
    pub fn start(&mut self) {
        let Some(engine) = self.engine.clone() else {
            return;
        };
        if let Some(session) = self.startup.session.clone() {
            engine.open(&session);
            return;
        }
        if self.startup.continue_last {
            engine.catalog();
            return;
        }
        if self.startup.prompt.is_some() {
            engine.new_session();
        }
    }

    /// The editor the drive loop should run after suspending the terminal.
    pub fn take_editor_request(&mut self) -> Option<editor::Request> {
        self.pending_editor.take()
    }

    pub fn take_suspend_request(&mut self) -> bool {
        std::mem::take(&mut self.suspend_requested)
    }

    pub fn take_redraw_request(&mut self) -> bool {
        std::mem::take(&mut self.redraw_requested)
    }

    pub fn configure_terminal_title(&mut self, enabled: bool, allowed: bool) {
        self.terminal_title_enabled = enabled;
        self.terminal_title_allowed = allowed;
    }

    /// How long the leader chord stays armed, from `tui.json`.
    pub fn configure_leader_timeout(&mut self, milliseconds: u64) {
        self.leader_timeout = Duration::from_millis(milliseconds);
    }

    /// Take the wheel speed and acceleration from `tui.json`. Both are read at
    /// startup only, so a change needs a restart, like the other terminal
    /// preferences.
    pub fn configure_scroll(&mut self, speed: f64, acceleration: bool) {
        self.scroll = Scroll::new(speed, acceleration);
    }

    pub fn terminal_title(&self) -> Option<String> {
        if !self.terminal_title_enabled || !self.terminal_title_allowed {
            return None;
        }
        if self.screen == Screen::Home {
            return Some("miao".into());
        }
        let prompt = self.shell.transcript().and_then(|transcript| {
            transcript.entries.iter().find_map(|entry| match entry {
                Entry::User { text, .. } => Some(text.as_str()),
                _ => None,
            })
        });
        Some(crate::terminal_title::tab(
            self.session
                .as_ref()
                .and_then(|session| session.title.as_deref()),
            prompt,
        ))
    }

    pub fn attach_engine(&mut self, engine: engine::Handle) {
        self.engine = Some(engine);
    }

    pub fn set_settings(&mut self, settings: engine::Settings) {
        self.settings = Some(settings);
    }

    pub fn render(&mut self, frame: &mut Frame) {
        // The status counts elapsed time, so it is recomputed per frame rather
        // than only when the projection changes.
        self.update_status();
        match self.screen {
            Screen::Home => {
                // No title row: the terminal tab already names the workspace,
                // and the list header carries the Session count. The row it
                // used to take goes back to the list.
                let [body, composer_area] = ratatui::layout::Layout::vertical([
                    ratatui::layout::Constraint::Min(1),
                    ratatui::layout::Constraint::Length(3),
                ])
                .areas(frame.area());
                crate::pane::render_home_composer(
                    frame,
                    composer_area,
                    &self.shell.composer,
                    &self.shell.theme().clone(),
                );
                self.home.render(frame, body);
            }
            Screen::Session => self.shell.render(frame),
        }
        if let Some(dialog) = self.dialog.as_ref() {
            render_dialog(frame, frame.area(), dialog, self.shell.theme());
        }
    }

    pub fn handle(&mut self, event: AppEvent) {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Paste(text) => {
                if let Some(Dialog::SavedPermissions(dialog)) = self.dialog.as_mut() {
                    dialog.paste(&text);
                    return;
                }
                if self.screen == Screen::Session {
                    // Windows Terminal can surface an image-only clipboard as an
                    // empty bracketed paste; reading the clipboard is the only
                    // way to find out what it held.
                    if text.is_empty() {
                        self.read_clipboard();
                    } else {
                        self.shell.composer.paste(&text);
                    }
                }
            }
            AppEvent::Focus(focused) => self.attention.set_focus(focused),
            AppEvent::Mouse(mouse) => self.handle_mouse(mouse),
            AppEvent::Attention { kind, id } => self.announce(kind, id),
            AppEvent::Provider(frame) => self.provider(frame),
            AppEvent::Recalled {
                handle,
                text,
                total_bytes,
                truncated,
                next_offset,
            } => {
                let mut lines = vec![format!(
                    "{handle} · {total_bytes} bytes restored from the archive"
                )];
                lines.extend(text.lines().map(str::to_string));
                if truncated {
                    lines.push(match next_offset {
                        Some(offset) => format!(
                            "truncated; continue with /recall --offset-style request at {offset}"
                        ),
                        None => "truncated".to_string(),
                    });
                }
                self.open_dialog(Dialog::Message(TextDialog {
                    title: "Archived tool output",
                    lines,
                    scroll: 0,
                }));
            }
            AppEvent::RecallFailed(message) => self.notice(&format!("recall failed: {message}")),
            AppEvent::TagFailed(message) => self.notice(&format!("tag failed: {message}")),
            AppEvent::Clipboard(content) => {
                self.clipboard_busy = false;
                match content {
                    Some(clipboard::Content::Image { mime, data }) => {
                        let count = self.shell.composer.attach_image(&mime, &data);
                        self.notice(&format!("attached image {count}"));
                    }
                    Some(clipboard::Content::Text(text)) => self.shell.composer.paste(&text),
                    None => self.notice("the clipboard is empty"),
                }
            }
            AppEvent::EditorFinished(result) => match result {
                Ok(Some(text)) => {
                    self.shell.composer.restore(&text);
                    self.shell.composer.notice = None;
                }
                Ok(None) => {}
                Err(message) => self.notice(&message),
            },
            AppEvent::Resize { .. } => {}
            AppEvent::Sessions(rows) => {
                self.home.set_rows(rows);
                self.home.set_notice(None);
            }
            AppEvent::Catalog(rows) => {
                self.catalog = rows;
                if matches!(self.dialog, Some(Dialog::Sessions(_))) {
                    self.reopen_sessions_dialog();
                }
                self.continue_startup();
            }
            AppEvent::Models(models) => {
                self.models = models;
                if self.pending_models {
                    self.pending_models = false;
                    if self.dialog.is_none() {
                        self.open_dialog(Dialog::models(
                            &self.models,
                            self.session
                                .as_ref()
                                .and_then(|summary| summary.model.as_deref()),
                        ));
                    }
                }
            }
            AppEvent::Accounts(accounts) => {
                self.accounts = accounts;
                if self.pending_accounts {
                    self.pending_accounts = false;
                    if self.dialog.is_none() {
                        self.open_dialog(Dialog::accounts(&self.accounts));
                    }
                }
            }
            AppEvent::Devices(rows) => {
                self.devices = parse_devices(&rows);
                self.open_device_dialog();
            }
            // The engine answers the list, so the dialog opens on data rather
            // than on a placeholder that never fills.
            AppEvent::Jobs(rows) => {
                self.open_dialog(Dialog::jobs(&rows));
                self.preview_selected_job();
            }
            AppEvent::Schedule(rows) => {
                self.open_dialog(Dialog::schedule(&rows));
            }
            AppEvent::JobDetail { job_id, detail } => {
                if let Some(Dialog::Jobs(list)) = self.dialog.as_mut() {
                    list.set_detail(&job_id, detail);
                }
            }
            AppEvent::SessionMoved => {
                self.dialog = None;
                self.shell.composer.notice = Some("session moved".into());
            }
            AppEvent::HostResult { op, .. } if op == "workspace.create" => {
                self.shell.composer.notice = Some("workspace created".into());
            }
            // Other host calls answer in their own slice; the reply must still
            // be consumed so the stream stays ordered.
            AppEvent::HostResult { .. } => {}
            AppEvent::Workspaces(workspaces) => {
                self.workspaces = workspaces;
                let rows = self
                    .workspaces
                    .iter()
                    .map(|(name, detail, _)| (name.clone(), detail.clone()))
                    .collect::<Vec<_>>();
                self.open_dialog(Dialog::workspaces(&rows));
            }
            AppEvent::Usage(usage) => {
                self.usage = Some(usage);
                self.shell.set_usage(self.usage.as_ref());
                if matches!(self.dialog, Some(Dialog::Status(_))) {
                    let rows = self.status_rows();
                    self.open_dialog(Dialog::status(rows));
                }
            }
            AppEvent::SessionRemoved(id) => {
                if self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.id == id)
                {
                    self.leave_session();
                }
            }
            AppEvent::SessionOpened {
                summary,
                transcript,
                state,
            } => {
                self.swap_draft(summary.as_ref().map(|session| session.id.as_str()));
                self.shell.set_goal(state.goal.as_ref());
                self.shell.set_todos(&state.todos);
                self.session = summary;
                if let Some(summary) = &self.session {
                    match self.catalog.iter_mut().find(|row| row.id == summary.id) {
                        Some(row) => *row = summary.clone(),
                        None => self.catalog.push(summary.clone()),
                    }
                }
                self.state = state;
                // A live phase only ever describes the run it was announced for.
                if self.live.as_ref().is_some_and(|live| {
                    self.state.active_run.as_deref() != Some(live.run_id.as_str())
                }) {
                    self.live = None;
                }
                let committed = transcript
                    .entries
                    .iter()
                    .filter(|entry| matches!(entry, Entry::Assistant { .. }))
                    .count();
                // The draft is provisional. Only the projection that commits the
                // next assistant message replaces it — an unrelated projection
                // in the middle of the stream must not blank the text the user
                // is reading. A run that is no longer active never commits one.
                if self.draft.as_ref().is_some_and(|draft| {
                    committed > draft.committed || self.state.active_run.is_none()
                }) {
                    self.draft = None;
                    self.shell.set_draft("", "");
                }
                self.committed = committed;
                self.shell.set_session(self.session.as_ref());
                self.shell.set_usage(self.usage.as_ref());
                self.shell.set_transcript(&transcript);
                // Opening a Session shows its newest turn: `follow` survives
                // from whatever was scrolled before.
                self.shell.follow_transcript();
                self.screen = Screen::Session;
                self.sync_panel();
                self.update_status();
                self.continue_prompt();
            }
            AppEvent::RevertPreview {
                session_id,
                boundary_seq,
                plan,
            } => {
                // The engine answered a question asked about a Session that
                // may already have been left; a stale dialog is worse than
                // none.
                if self.session_id().as_deref() != Some(session_id.as_str()) {
                    return;
                }
                self.open_dialog(Dialog::confirm_revert(boundary_seq, &plan));
            }
            AppEvent::SavedPermissions { generation, result } => {
                if let Some(Dialog::SavedPermissions(dialog)) = self.dialog.as_mut() {
                    if dialog.generation == generation {
                        dialog.loaded(result);
                    }
                }
            }
            AppEvent::PermissionRevoked {
                generation,
                id,
                result,
            } => {
                if let Some(Dialog::SavedPermissions(dialog)) = self.dialog.as_mut() {
                    if dialog.generation == generation {
                        dialog.revoked(&id, result);
                    }
                }
            }
            AppEvent::WorkspaceChanges { generation, result } => {
                if let Some(Dialog::WorkspaceChanges(dialog)) = self.dialog.as_mut() {
                    if dialog.generation == generation {
                        dialog.loaded(result);
                    }
                }
            }
            AppEvent::ActionFailed(message) => {
                self.shell.composer.notice = Some(with_remedy(&message));
            }
            AppEvent::Notice(message) => self.notice(&message),
            AppEvent::PromptFailed {
                text,
                attachments,
                message,
            } => {
                self.shell.composer.restore_with(&text, attachments);
                self.shell.composer.notice = Some(message);
            }
            AppEvent::InputRetrieved { prompt, delivery } => {
                // The retrieved prompt is what the operator asked to edit, so a
                // draft already in the composer is stashed rather than dropped.
                if !self.shell.composer.editor.text().trim().is_empty() {
                    self.stash_current();
                }
                self.shell.composer.restore(&prompt);
                self.shell.composer.notice = Some(format!("retrieved {delivery} input"));
            }
            AppEvent::InputNotRetrieved { reason } => {
                // Nothing was cancelled, so the run is the only thing left that
                // Escape can act on; never report a take-back that did not happen.
                self.shell.composer.notice = Some(reason);
                self.interrupt_or_leave();
            }
            AppEvent::ShellFailed { command, message } => {
                self.shell.composer.restore_shell(&command);
                self.shell.composer.notice = Some(message);
            }
            AppEvent::EngineFailure(message) => {
                // A start failure leaves the operator looking at one line with
                // no way forward; the failures this TUI can actually explain
                // carry the next step with them.
                let message = with_remedy(&message);
                self.home.set_notice(Some(message.clone()));
                self.shell.set_message(&message);
            }
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            // Windows reports both Press and Release; handling both would
            // double every keystroke.
            return;
        }
        if self
            .keys
            .matches(keybinds::Action::TerminalTitleToggle, &key)
        {
            self.leader = false;
            self.run_builtin(Builtin::TerminalTitle);
            return;
        }
        if self.keys.matches(keybinds::Action::TerminalSuspend, &key) {
            self.leader = false;
            self.run_builtin(Builtin::Suspend);
            return;
        }
        if self.keys.matches(keybinds::Action::TerminalRedraw, &key) {
            self.redraw_requested = true;
            self.leader = false;
            return;
        }
        if self.dialog.is_some() {
            // Dialogs are modal: nothing reaches the page below, and Esc
            // closes the top layer. Ctrl+C still quits.
            if self.keys.matches(keybinds::Action::InputClear, &key) {
                self.quit = true;
                return;
            }
            self.handle_dialog_key(key);
            return;
        }
        if self.leader {
            let armed_for = self
                .leader_since
                .map(|since| since.elapsed())
                .unwrap_or(self.leader_timeout);
            self.leader = false;
            self.leader_since = None;
            // A window that has passed is not a chord: the operator pressed the
            // leader and moved on, so this key belongs to the active mode.
            if armed_for <= self.leader_timeout {
                self.handle_leader(key);
                return;
            }
        }
        if self.keys.is_leader(&key) {
            self.leader = true;
            self.leader_since = Some(Instant::now());
            return;
        }
        if self.keys.matches(keybinds::Action::CommandList, &key) {
            self.open_palette();
            return;
        }
        match self.screen {
            Screen::Home => self.handle_home_key(key),
            Screen::Session => self.handle_session_key(key),
        }
    }

    /// The wheel moves through the open dialog, the Session list, or the
    /// transcript. Buttons are ignored: text selection stays with the terminal.
    fn handle_mouse(&mut self, mouse: MouseEvent) {
        // A drag over the transcript copies what it covered, like the
        // TypeScript UI: cells, not logical lines, because the transcript is
        // wrapped.
        if self.dialog.is_none() && self.screen == Screen::Session {
            let position = ratatui::layout::Position::new(mouse.column, mouse.row);
            match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    self.leader = false;
                    self.shell.begin_selection(position);
                    return;
                }
                MouseEventKind::Drag(MouseButton::Left) => {
                    self.shell.update_selection(position);
                    return;
                }
                MouseEventKind::Up(MouseButton::Left) => {
                    if let Some(text) = self.shell.take_selection() {
                        crate::platform::clipboard::copy(&text);
                        self.notice(&format!("Copied {} characters", text.chars().count()));
                    }
                    return;
                }
                _ => {}
            }
        }
        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return,
        };
        if self.dialog.is_some() {
            if let Some(list) = self.dialog.as_mut().and_then(Dialog::list_mut) {
                list.move_cursor(delta);
            }
            self.preview_selected_job();
            return;
        }
        // A stray wheel event must not leave the leader armed.
        self.leader = false;
        match self.screen {
            Screen::Home => self.home.move_cursor(delta),
            Screen::Session => {
                // One notch moves `scroll_speed` rows, or more when the notches
                // arrive in a burst and acceleration is enabled.
                let rows = self.scroll.rows(Instant::now(), delta as i8) as i32;
                self.shell.scroll_transcript(delta * rows);
            }
        }
    }

    fn handle_dialog_key(&mut self, key: KeyEvent) {
        let Some(dialog) = self.dialog.as_mut() else {
            return;
        };
        let action = dialog.handle_key(key);
        self.dialog_action(action);
        // Moving to another job asks for its detail; the engine answers with
        // `JobDetail`, which fills that row only.
        self.preview_selected_job();
    }

    fn handle_leader(&mut self, key: KeyEvent) {
        match self.keys.leader_action(&key) {
            Some(keybinds::Action::ModelList) => self.run_builtin(Builtin::Models),
            Some(keybinds::Action::ThemeList) => self.run_builtin(Builtin::Theme),
            Some(keybinds::Action::SessionList) => self.run_builtin(Builtin::Sessions),
            Some(keybinds::Action::SessionNew) => self.run_builtin(Builtin::NewSession),
            Some(keybinds::Action::StatusView) => self.run_builtin(Builtin::Status),
            Some(keybinds::Action::DebugView) => self.run_builtin(Builtin::Debug),
            Some(keybinds::Action::Stash) => self.run_builtin(Builtin::Stash),
            Some(keybinds::Action::StashDraft) => self.run_builtin(Builtin::StashDraft),
            Some(keybinds::Action::EditorOpen) => self.run_builtin(Builtin::Editor),
            Some(keybinds::Action::CopyMessage) => self.copy_last_response(),
            Some(keybinds::Action::McpList) => self.open_mcp(),
            Some(keybinds::Action::ProviderList) => self.open_providers(),
            Some(keybinds::Action::SkillList) => self.open_skills(),
            Some(keybinds::Action::DeviceList) => self.open_devices(),
            Some(keybinds::Action::JobList) => self.open_jobs(),
            Some(keybinds::Action::ScheduleList) => self.open_schedule(),
            Some(keybinds::Action::WorkspaceList) => self.open_workspaces(),
            // Reviewing the working tree had no direct key: it was reachable
            // only through the command list or a slash command whose completion
            // swallows the first Enter.
            Some(keybinds::Action::WorkspaceChanges) => self.run_builtin(Builtin::WorkspaceChanges),
            Some(keybinds::Action::WorkspaceCreate) => self.create_workspace(),
            Some(keybinds::Action::MessageView) => self.open_message(),
            Some(keybinds::Action::ToolOutputToggle) => {
                let expanded = self.shell.toggle_tool_expansion();
                self.notice(if expanded {
                    "Tool output expanded"
                } else {
                    "Tool output folded"
                });
            }
            Some(keybinds::Action::AppExit) => self.run_builtin(Builtin::Quit),
            Some(keybinds::Action::TerminalRedraw) => self.redraw_requested = true,
            Some(keybinds::Action::TerminalSuspend) => self.run_builtin(Builtin::Suspend),
            Some(keybinds::Action::TerminalTitleToggle) => self.run_builtin(Builtin::TerminalTitle),
            _ => {}
        }
    }

    fn run_builtin(&mut self, builtin: Builtin) {
        match builtin {
            Builtin::Recall => {
                self.notice("/recall <tool_use_id> restores an archived tool output")
            }
            Builtin::Tag => match self.session.as_ref() {
                Some(session) => self.open_dialog(Dialog::tag(&session.id, "")),
                None => self.notice("open a Session to tag it"),
            },
            Builtin::Redraw => self.redraw_requested = true,
            Builtin::Suspend => {
                #[cfg(unix)]
                {
                    self.suspend_requested = true;
                }
                #[cfg(windows)]
                self.notice("Shell suspend is not supported on Windows");
            }
            Builtin::TerminalTitle => {
                if !self.terminal_title_allowed {
                    self.notice("Terminal titles are disabled by MIAO_DISABLE_TERMINAL_TITLE");
                    return;
                }
                self.terminal_title_enabled = !self.terminal_title_enabled;
                state::save_terminal_title(self.terminal_title_enabled);
                self.notice(if self.terminal_title_enabled {
                    "Terminal title enabled"
                } else {
                    "Terminal title disabled"
                });
            }
            Builtin::Models => self.open_models(),
            Builtin::Permissions => {
                self.permission_generation += 1;
                let generation = self.permission_generation;
                let mut dialog = crate::saved_permissions::Dialog::new(generation, &self.workspace);
                match self.engine.as_ref() {
                    Some(engine) => engine.saved_permissions(generation),
                    None => dialog.loaded(Err("Engine is not connected".into())),
                }
                self.open_dialog(Dialog::SavedPermissions(dialog));
            }
            Builtin::WorkspaceChanges => {
                let Some(session_id) = self.session_id() else {
                    self.update_status();
                    return;
                };
                self.workspace_changes_generation += 1;
                let generation = self.workspace_changes_generation;
                let mut dialog = crate::workspace_changes::Dialog::new(generation, &session_id);
                match self.engine.as_ref() {
                    Some(engine) => engine.vcs_changes(generation, &session_id),
                    None => dialog.loaded(Err("Engine is not connected".into())),
                }
                self.open_dialog(Dialog::WorkspaceChanges(dialog));
            }
            Builtin::Theme => self.open_theme(),
            Builtin::Sessions => self.open_sessions(),
            Builtin::NewSession => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.new_session();
                }
            }
            Builtin::Rename => match self.session.as_ref() {
                Some(session) => {
                    let dialog = Dialog::rename(&session.id, session.label());
                    self.open_dialog(dialog);
                }
                None => self.notice("open a Session to rename it"),
            },
            Builtin::Status => self.open_status(),
            Builtin::Accounts => self.open_accounts(),
            Builtin::Debug => self.open_debug(),
            Builtin::Stash => self.open_stash(),
            Builtin::StashDraft => self.stash_current(),
            Builtin::Timeline => self.open_timeline(),
            Builtin::Undo => self.undo(),
            Builtin::Redo => self.redo(),
            Builtin::Editor => self.open_editor(),
            Builtin::Help => self.open_help(),
            Builtin::Quit => self.quit = true,
        }
    }

    fn open_models(&mut self) {
        if let Some(engine) = self.engine.as_ref() {
            engine.catalog();
        }
        if self.models.is_empty() {
            self.pending_models = true;
            return;
        }
        self.open_dialog(Dialog::models(
            &self.models,
            self.session
                .as_ref()
                .and_then(|summary| summary.model.as_deref()),
        ));
    }

    fn open_theme(&mut self) {
        let current = self.shell.theme().name.clone();
        self.open_dialog(Dialog::theme(&current, &self.themes));
    }

    fn open_sessions(&mut self) {
        if let Some(engine) = self.engine.as_ref() {
            engine.refresh_sessions();
        }
        self.open_dialog(Dialog::sessions(&self.catalog));
    }

    /// The palette lists the same actions as the key chords, with the chord
    /// beside each label; template commands stay discoverable through slash
    /// completion because they still need their arguments typed.
    fn open_palette(&mut self) {
        let rows = Builtin::ALL
            .into_iter()
            .map(|builtin| Row {
                id: builtin.name().to_string(),
                label: builtin.label().to_string(),
                detail: builtin.keys().to_string(),
            })
            .collect();
        self.open_dialog(Dialog::command_palette(rows));
    }

    fn open_help(&mut self) {
        let mut rows = Builtin::ALL
            .into_iter()
            .map(|builtin| Row {
                id: format!("/{}", builtin.name()),
                label: format!("/{}", builtin.name()),
                detail: match builtin.keys() {
                    "" => builtin.label().to_string(),
                    keys => format!("{} · {keys}", builtin.label()),
                },
            })
            .collect::<Vec<_>>();
        // Keys come from the live keymap, not a hand-written summary: a help
        // list that names a stroke the keymap no longer binds is worse than no
        // list at all, because it sends the operator to the wrong key.
        rows.extend(
            self.keys
                .bindings()
                .into_iter()
                .map(|(action, strokes)| Row {
                    id: action.name().to_string(),
                    label: action.name().to_string(),
                    detail: if strokes.is_empty() {
                        "unbound".to_string()
                    } else {
                        strokes
                    },
                }),
        );
        rows.extend(self.templates.iter().map(|template| Row {
            id: format!("/{}", template.name),
            label: format!("/{}", template.name),
            detail: template.description.clone(),
        }));
        self.open_dialog(Dialog::help(rows));
    }

    fn open_dialog(&mut self, dialog: Dialog) {
        self.pending_models = false;
        self.shell.composer.dismiss_completion();
        self.dialog = Some(dialog);
    }

    fn reopen_sessions_dialog(&mut self) {
        let selected = match self.dialog.take() {
            Some(Dialog::Sessions(list)) => list.rows.get(list.selected).map(|row| row.id.clone()),
            _ => None,
        };
        let mut dialog = Dialog::sessions(&self.catalog);
        if let (Some(list), Some(id)) = (dialog.list_mut(), selected) {
            if let Some(index) = list.rows.iter().position(|row| row.id == id) {
                list.selected = index;
            }
        }
        self.dialog = Some(dialog);
    }

    fn dialog_action(&mut self, action: DialogAction) {
        match action {
            DialogAction::RefreshPermissions => {
                if let Some(Dialog::SavedPermissions(dialog)) = self.dialog.as_mut() {
                    if let Some(engine) = self.engine.as_ref() {
                        engine.saved_permissions(dialog.generation);
                    } else {
                        dialog.loaded(Err("Engine is not connected".into()));
                    }
                }
            }
            DialogAction::RefreshWorkspaceChanges(session_id) => {
                if let Some(Dialog::WorkspaceChanges(dialog)) = self.dialog.as_mut() {
                    if let Some(engine) = self.engine.as_ref() {
                        engine.vcs_changes(dialog.generation, &session_id);
                    } else {
                        dialog.loaded(Err("Engine is not connected".into()));
                    }
                }
            }
            DialogAction::RevokePermission(id) => {
                if let Some(Dialog::SavedPermissions(dialog)) = self.dialog.as_mut() {
                    if let Some(engine) = self.engine.as_ref() {
                        engine.revoke_permission(dialog.generation, id);
                    } else {
                        dialog.revoked(&id, Err("Engine is not connected".into()));
                    }
                }
            }
            DialogAction::None => {}
            DialogAction::Close => self.dialog = None,
            DialogAction::Chosen(index) => self.choose(index),
            DialogAction::CancelSchedule(entry) => {
                // The row names what it is (`kind:id`) so the cancel call can
                // reach `cancel_cron` or `cancel_wakeup`.
                let (kind, id) = entry
                    .split_once(':')
                    .map(|(kind, id)| (kind.to_string(), id.to_string()))
                    .unwrap_or_default();
                let session_id = self.session_id();
                self.dialog = None;
                if let (Some(session_id), Some(engine), false) =
                    (session_id, self.engine.as_ref(), id.is_empty())
                {
                    engine.cancel_schedule(&session_id, &kind, &id);
                }
            }
            DialogAction::CancelJob(job_id) => {
                let session_id = self.session_id();
                self.dialog = None;
                if let (Some(session_id), Some(engine)) = (session_id, self.engine.as_ref()) {
                    engine.cancel_job(&session_id, &job_id);
                }
            }
            DialogAction::DeviceChosen(index, action) => self.device_action(
                index,
                match action {
                    0 => DeviceAction::Approve,
                    1 => DeviceAction::Reject,
                    _ => DeviceAction::Revoke,
                },
            ),
            DialogAction::OpenSession(id) => {
                self.dialog = None;
                if let Some(engine) = self.engine.as_ref() {
                    engine.open(&id);
                }
            }
            DialogAction::Rename(id) => {
                let title = self.title_of(&id);
                self.open_dialog(Dialog::rename(&id, &title));
            }
            DialogAction::ToggleArchive(id) => {
                let archived = self
                    .catalog
                    .iter()
                    .find(|row| row.id == id)
                    .is_some_and(|row| row.archived_at_ms.is_some());
                self.dialog = None;
                if let Some(engine) = self.engine.as_ref() {
                    engine.archive(&id, !archived);
                }
            }
            DialogAction::TogglePin(id) => {
                let pinned = self
                    .catalog
                    .iter()
                    .find(|row| row.id == id)
                    .is_some_and(|row| row.pinned_at_ms.is_some());
                self.dialog = None;
                if let Some(engine) = self.engine.as_ref() {
                    engine.pin(&id, !pinned);
                }
            }
            DialogAction::Remove(id) => {
                let title = self.title_of(&id);
                self.open_dialog(Dialog::confirm_remove(&id, &title));
            }
            DialogAction::Submit(value) if matches!(self.dialog, Some(Dialog::Tag(_))) => {
                let Some(Dialog::Tag(tag)) = self.dialog.take() else {
                    return;
                };
                // An empty label clears the tag, the way an empty title is what
                // rename already accepts.
                if let Some(engine) = self.engine.as_ref() {
                    engine.tag(&tag.session_id, &value);
                }
            }
            DialogAction::Submit(title) => {
                let Some(Dialog::Rename(rename)) = self.dialog.take() else {
                    return;
                };
                if let Some(engine) = self.engine.as_ref() {
                    engine.rename(&rename.session_id, &title);
                }
                if self.session_id().as_deref() == Some(rename.session_id.as_str()) {
                    let mut summary = self.session.clone();
                    if let Some(summary) = summary.as_mut() {
                        summary.title = Some(title.clone());
                    }
                    self.session = summary;
                    self.shell.set_session(self.session.as_ref());
                    self.shell.set_usage(self.usage.as_ref());
                }
            }
            DialogAction::Confirmed(kind) => {
                self.dialog = None;
                let Some(engine) = self.engine.clone() else {
                    return;
                };
                match kind {
                    ConfirmKind::RemoveSession(id) => engine.remove(&id),
                    ConfirmKind::Revert {
                        boundary_seq,
                        files,
                    } => {
                        let Some(session_id) = self.session_id() else {
                            return;
                        };
                        engine.revert(&session_id, boundary_seq, files);
                        self.notice(&format!("reverted to #{boundary_seq}"));
                    }
                }
            }
            DialogAction::Revert(boundary_seq) => {
                self.dialog = None;
                self.preview_revert(boundary_seq);
            }
            DialogAction::StashRestore(index) => {
                self.dialog = None;
                if let Some(entry) = self.stash.get(index) {
                    self.shell.composer.editor.set_text(&entry.text);
                    self.shell.composer.notice = Some("restored from stash".into());
                }
                self.stash = state::stash_remove(index);
            }
            DialogAction::StashRemove(index) => {
                self.stash = state::stash_remove(index);
                let rows = self.stash_rows();
                self.open_dialog(Dialog::stash(rows));
            }
            DialogAction::Command(name) => {
                self.dialog = None;
                match Builtin::from_name(&name) {
                    Some(builtin) => self.run_builtin(builtin),
                    None => self.notice(&format!("unknown command: /{name}")),
                }
            }
        }
    }

    /// The model dialog returns an index into the last catalog, the account
    /// dialog an index into the accounts the same catalog named, and the theme
    /// dialog an index into the built-in names.
    fn choose(&mut self, index: usize) {
        match self.dialog.take() {
            Some(Dialog::Theme(_)) => {
                let name = self.themes.names().get(index).map(|name| name.to_string());
                if let Some(name) = name {
                    self.apply_theme(&name);
                }
            }
            Some(Dialog::Models(_)) => {
                let Some(binding) = self.models.get(index).map(ModelInfo::binding) else {
                    return;
                };
                let Some(session_id) = self.session_id() else {
                    self.shell.composer.notice = Some("open a Session to select a model".into());
                    return;
                };
                if let Some(engine) = self.engine.as_ref() {
                    engine.select_model(&session_id, binding);
                }
            }
            Some(Dialog::Workspaces(_)) => {
                let Some(directory) = self
                    .workspaces
                    .get(index)
                    .map(|(_, _, directory)| directory.clone())
                else {
                    return;
                };
                if directory.is_empty() {
                    self.shell.composer.notice = Some("that workspace has no directory".into());
                    return;
                }
                let Some(session_id) = self.session_id() else {
                    self.shell.composer.notice = Some("open a Session to move".into());
                    return;
                };
                if let Some(engine) = self.engine.as_ref() {
                    engine.move_session(&session_id, &directory);
                }
            }
            Some(Dialog::Accounts(_)) => {
                let Some(account) = self.accounts.get(index) else {
                    return;
                };
                let credential_id = account.credential_id.clone();
                let Some(session_id) = self.session_id() else {
                    self.shell.composer.notice = Some("open a Session to switch accounts".into());
                    return;
                };
                self.pin_account(&session_id, Some(credential_id.clone()));
                if let Some(engine) = self.engine.as_ref() {
                    engine.select_account(&session_id, Some(&credential_id));
                }
            }
            _ => {}
        }
    }

    /// Keep the open Session and the picker's copy in step until the next
    /// snapshot carries the engine's own answer.
    fn pin_account(&mut self, session_id: &str, credential_id: Option<String>) {
        if let Some(session) = self.session.as_mut() {
            if session.id == session_id {
                session.credential_id = credential_id.clone();
            }
        }
        if let Some(row) = self.catalog.iter_mut().find(|row| row.id == session_id) {
            row.credential_id = credential_id;
        }
        self.shell.set_session(self.session.as_ref());
        self.shell.set_usage(self.usage.as_ref());
    }

    /// Keep one draft per Session: stash what the composer holds under the
    /// Session being left, then restore whatever the next one had.
    fn swap_draft(&mut self, next: Option<&str>) {
        let text = self.shell.composer.editor.text().to_string();
        if let Some(current) = self.session.as_ref().map(|session| session.id.clone()) {
            if text.trim().is_empty() {
                self.drafts.remove(&current);
            } else {
                self.drafts.insert(current, text);
            }
        }
        let restored = next
            .and_then(|id| self.drafts.get(id).cloned())
            .unwrap_or_default();
        self.shell.composer.restore(&restored);
    }

    /// A background job belongs to the open Session; without one there is
    /// nothing to list, and saying so beats an empty dialog.
    fn open_jobs(&mut self) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to list background jobs");
            return;
        };
        let Some(engine) = self.engine.as_ref() else {
            self.notice("Engine is not connected");
            return;
        };
        engine.jobs(&session_id);
    }

    /// Preview the job under the cursor: the list only names its state, so the
    /// row shows what the job produced once the engine answers. Asked once per
    /// row, because the detail stays on the row until the list is rebuilt.
    fn preview_selected_job(&mut self) {
        let Some(Dialog::Jobs(list)) = self.dialog.as_ref() else {
            return;
        };
        let (Some(job_id), Some(session_id), Some(engine)) =
            (list.selected_id(), self.session_id(), self.engine.as_ref())
        else {
            return;
        };
        if list.detail_of(&job_id).is_some() {
            return;
        }
        engine.job_detail(&session_id, &job_id);
    }

    /// List what the Session has scheduled: wakeups and cron jobs both cancel
    /// through the same chord, and the engine owns both.
    fn open_schedule(&mut self) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to list scheduled tasks");
            return;
        };
        let Some(engine) = self.engine.as_ref() else {
            self.notice("Engine is not connected");
            return;
        };
        engine.schedule(&session_id);
    }

    fn open_mcp(&mut self) {
        self.open_dialog(Dialog::mcp(&self.mcp));
    }

    fn open_providers(&mut self) {
        self.open_dialog(Dialog::providers(&self.providers));
    }

    fn open_device_dialog(&mut self) {
        let list = self
            .devices
            .iter()
            .map(|row| (row.name.clone(), row.detail.clone()))
            .collect::<Vec<_>>();
        self.open_dialog(Dialog::devices(&list));
    }

    /// Approve, reject or revoke the selected device row. Each action is host
    /// authority, so it leaves as a host call.
    fn device_action(&mut self, index: usize, action: DeviceAction) {
        let Some(row) = self.devices.get(index).cloned() else {
            return;
        };
        let Some(engine) = self.engine.as_ref() else {
            return;
        };
        self.dialog = None;
        match (action, row.kind.as_str()) {
            (DeviceAction::Approve, "pending") => engine.host_call(
                "remote.approve",
                serde_json::json!({ "pairingID": row.id, "publicKey": row.pairing_key }),
            ),
            (DeviceAction::Reject, "pending") => {
                engine.host_call("remote.reject", serde_json::json!({ "pairingID": row.id }))
            }
            (DeviceAction::Revoke, "grant") => engine.host_call(
                "remote.revoke",
                serde_json::json!({ "grantID": row.id, "version": row.version }),
            ),
            _ => {}
        }
    }

    fn open_devices(&mut self) {
        match self.engine.as_ref() {
            Some(engine) => engine.devices(),
            None => self.open_device_dialog(),
        }
    }

    fn open_skills(&mut self) {
        self.open_dialog(Dialog::skills(&self.skills));
    }

    /// Ask the engine for the host's workspace list; the dialog opens when the
    /// answer arrives, so the panel never reads a second source.
    /// Create a workspace at the directory typed in the prompt. The host owns
    /// workspace authority, so the request is a host call, not an engine
    /// command.
    fn create_workspace(&mut self) {
        let directory = self.shell.composer.editor.text().trim().to_string();
        if directory.is_empty() {
            self.notice("type a directory for the new workspace");
            return;
        }
        let Some(engine) = self.engine.as_ref() else {
            self.notice("the engine is not connected");
            return;
        };
        engine.host_call(
            "workspace.create",
            serde_json::json!({ "directory": directory }),
        );
        self.shell.composer.editor.clear();
    }

    fn open_workspaces(&mut self) {
        match self.engine.as_ref() {
            Some(engine) => engine.workspaces(),
            None => {
                let rows = self
                    .workspaces
                    .iter()
                    .map(|(name, detail, _)| (name.clone(), detail.clone()))
                    .collect::<Vec<_>>();
                self.open_dialog(Dialog::workspaces(&rows));
            }
        }
    }

    /// The newest assistant reply as plain text: what the model said, how much
    /// thinking it did, and which tools it ran.
    fn open_message(&mut self) {
        let Some(transcript) = self.shell.transcript() else {
            self.notice("No message to show");
            return;
        };
        let entry = transcript
            .entries
            .iter()
            .rev()
            .find(|entry| matches!(entry, Entry::Assistant { .. }));
        let Some(Entry::Assistant {
            agent,
            model,
            parts,
        }) = entry
        else {
            self.notice("No message to show");
            return;
        };
        let mut lines = vec![format!(
            "agent: {}   model: {}",
            agent.as_deref().unwrap_or("-"),
            model.as_deref().unwrap_or("-")
        )];
        for part in parts {
            match part {
                Part::Text(text) => lines.extend(text.lines().map(str::to_string)),
                Part::Reasoning(text) => {
                    lines.push(format!("[thinking · {} chars]", text.chars().count()))
                }
                Part::Tool(call) => lines.push(format!(
                    "[tool {} · {}]",
                    tool::product_name(&call.name),
                    if call.failed { "failed" } else { "ok" }
                )),
            }
        }
        if lines.len() == 1 {
            lines.push("(no content)".to_string());
        }
        self.open_dialog(crate::dialogs::Dialog::message(lines));
    }

    fn open_status(&mut self) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to see status");
            return;
        };
        self.usage = None;
        self.shell.set_usage(None);
        if let Some(engine) = self.engine.as_ref() {
            engine.usage(&session_id);
        }
        let rows = self.status_rows();
        self.open_dialog(Dialog::status(rows));
    }

    fn status_rows(&self) -> Vec<Row> {
        let Some(session) = self.session.as_ref() else {
            return Vec::new();
        };
        let mut rows = vec![
            row("session", session.label()),
            row("id", &session.id),
            row(
                "model",
                session.model.as_deref().unwrap_or("engine default"),
            ),
            row(
                "account",
                session.credential_id.as_deref().unwrap_or("default"),
            ),
            row("run", self.state.active_run.as_deref().unwrap_or("idle")),
            row("queued", &self.state.pending.to_string()),
        ];
        let Some(usage) = self.usage.as_ref() else {
            rows.push(row("usage", "loading…"));
            return rows;
        };
        rows.push(row(
            "turns",
            &format!("{} ({} partial)", usage.turns, usage.partial_turns),
        ));
        rows.push(row(
            "tokens",
            &format!(
                "in {} · out {} · cache read {}",
                usage.input_tokens, usage.output_tokens, usage.cache_read_tokens
            ),
        ));
        rows.push(row(
            "tools",
            &format!(
                "{} calls · {} failures",
                usage.tool_calls, usage.tool_failures
            ),
        ));
        if let Some(ttft) = usage.ttft_avg_ms {
            rows.push(row("ttft", &format!("avg {ttft} ms")));
        }
        // Each recent turn on its own line: an average cannot show which turn
        // was slow, and COST-04 asks for the timings in one reviewable place.
        for timing in &usage.turn_timings {
            let turn = timing
                .turn_ms
                .map(|ms| format!("{:.1}s", ms as f64 / 1000.0))
                .unwrap_or_else(|| "no turn time".to_string());
            let ttft = timing
                .ttft_ms
                .map(|ms| format!(" · ttft {:.1}s", ms as f64 / 1000.0))
                .unwrap_or_default();
            let model = timing
                .model
                .as_deref()
                .map(|model| format!(" · {model}"))
                .unwrap_or_default();
            rows.push(row(
                &format!("turn {}", timing.step),
                &format!("{turn}{ttft}{model}"),
            ));
        }
        if !usage.lineage.is_empty() {
            rows.push(row("lineage", &usage.lineage.join(", ")));
        }
        rows
    }

    fn open_accounts(&mut self) {
        if self.session_id().is_none() {
            self.notice("open a Session to switch accounts");
            return;
        }
        if let Some(engine) = self.engine.as_ref() {
            engine.catalog();
        }
        if self.accounts.is_empty() {
            self.pending_accounts = true;
            return;
        }
        self.open_dialog(Dialog::accounts(&self.accounts));
    }

    fn open_debug(&mut self) {
        let mut rows = Vec::new();
        match &self.settings {
            Some(settings) => {
                rows.push(row("engine", &settings.spawn.program.display().to_string()));
                rows.push(row("database", &db_argument(&settings.spawn.args)));
                rows.push(row("model", &settings.model));
            }
            None => rows.push(row("engine", "not started")),
        }
        rows.push(row("workspace", &self.workspace.display().to_string()));
        rows.push(row("state dir", &state::dir().display().to_string()));
        rows.push(row("theme", &self.shell.theme().name));
        rows.push(row("version", env!("CARGO_PKG_VERSION")));
        self.open_dialog(Dialog::debug(rows));
    }

    fn open_stash(&mut self) {
        self.stash = state::stash();
        let rows = self.stash_rows();
        self.open_dialog(Dialog::stash(rows));
    }

    fn stash_rows(&self) -> Vec<Row> {
        self.stash
            .iter()
            .enumerate()
            .map(|(index, entry)| Row {
                id: index.to_string(),
                label: first_line(&entry.text),
                detail: match entry.text.lines().count() {
                    0 | 1 => String::new(),
                    lines => format!("{lines} lines"),
                },
            })
            .collect()
    }

    /// Set the current draft aside and clear the composer, the same trade a
    /// stash makes everywhere: the draft is safe, the input is free.
    fn stash_current(&mut self) {
        let text = self.shell.composer.editor.text();
        if text.trim().is_empty() {
            self.notice("nothing to stash");
            return;
        }
        self.stash = state::stash_push(text);
        self.shell.composer.editor.clear();
        self.shell.composer.dismiss_completion();
        if self.screen == Screen::Session {
            self.shell.composer.notice = Some("stashed".into());
        }
    }

    /// List the Session's user turns, newest first, so the nearest undo is the
    /// first row. The engine owns what each boundary restores; choosing a row
    /// only asks it to preview the change.
    fn open_timeline(&mut self) {
        let Some(transcript) = self.shell.transcript() else {
            self.notice("open a Session to see its timeline");
            return;
        };
        let mut rows = transcript
            .boundaries()
            .into_iter()
            .rev()
            .map(|(seq, text)| Row {
                id: seq.to_string(),
                label: first_line(&text),
                detail: format!("#{seq}"),
            })
            .collect::<Vec<_>>();
        if rows.is_empty() {
            self.notice("this Session has no message to rewind to");
            return;
        }
        rows.truncate(50);
        self.open_dialog(Dialog::timeline(rows));
    }

    /// Undo the last turn by rewinding to its user message, which removes that
    /// message and the work it started.
    fn undo(&mut self) {
        let Some(transcript) = self.shell.transcript() else {
            self.notice("open a Session to undo a turn");
            return;
        };
        let Some((boundary_seq, _)) = transcript.boundaries().last().cloned() else {
            self.notice("this Session has no turn to undo");
            return;
        };
        self.preview_revert(boundary_seq);
    }

    fn redo(&mut self) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to redo");
            return;
        };
        if self.state.reverted == 0 {
            self.notice("nothing to redo");
            return;
        }
        if let Some(engine) = self.engine.as_ref() {
            engine.redo(&session_id);
        }
    }

    fn preview_revert(&mut self, boundary_seq: u64) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to revert it");
            return;
        };
        if self.state.active_run.is_some() {
            self.notice("stop the running turn before reverting");
            return;
        }
        if let Some(engine) = self.engine.as_ref() {
            engine.revert_preview(&session_id, boundary_seq);
        }
    }

    fn notice(&mut self, message: &str) {
        match self.screen {
            Screen::Home => self.home.set_notice(Some(message.to_string())),
            Screen::Session => self.shell.composer.notice = Some(message.to_string()),
        }
    }

    /// Warn about a configuration problem that the next catalog load does not
    /// answer, so it has to survive that load.
    pub fn warn(&mut self, message: &str) {
        match self.screen {
            Screen::Home => self.home.set_warning(Some(message.to_string())),
            Screen::Session => self.shell.composer.notice = Some(message.to_string()),
        }
    }

    /// Tell the user about a Session event, at most once per pending request.
    fn announce(&mut self, kind: attention::Kind, id: Option<String>) {
        if let Some(id) = id {
            if self.notified.contains(&id) {
                return;
            }
            self.notified.push(id);
            if self.notified.len() > 64 {
                self.notified.remove(0);
            }
        }
        let title = self
            .session
            .as_ref()
            .map(|session| session.label().to_string())
            .unwrap_or_else(|| "miao".to_string());
        self.attention.notify(kind, &title);
    }

    /// Read the clipboard off the UI thread. Text goes into the composer; an
    /// image becomes a numbered attachment.
    fn read_clipboard(&mut self) {
        if self.clipboard_busy {
            return;
        }
        let Some(bus) = self.bus.clone() else {
            return;
        };
        self.clipboard_busy = true;
        let host_file = std::env::var_os("MTTY_CLIPBOARD_FILE").map(PathBuf::from);
        std::thread::spawn(move || {
            let content = clipboard::read(host_file.as_deref());
            bus.send(AppEvent::Clipboard(content));
        });
    }

    fn copy_last_response(&mut self) {
        let Some(text) = self.shell.last_response() else {
            self.notice("there is no response to copy");
            return;
        };
        clipboard::copy(&text);
        self.notice("copied the last response");
    }

    fn open_editor(&mut self) {
        if self.screen != Screen::Session {
            self.notice("open a Session to compose a prompt");
            return;
        }
        let text = self.shell.composer.editor.text().to_string();
        match editor::request(&self.workspace, text) {
            Ok(request) => self.pending_editor = Some(request),
            Err(message) => self.notice(&message),
        }
    }

    /// Prepend the current Zed selection once per selection. The engine sees
    /// one prompt string, so the context travels as text rather than a part.
    fn zed_context(&mut self) -> Option<String> {
        let selection = zed::selection(&self.workspace)?;
        let context = zed::context(&selection)?;
        let key = zed::key(&selection);
        if self.zed_selection_key.as_deref() == Some(key.as_str()) {
            return None;
        }
        self.zed_selection_key = Some(key);
        Some(context)
    }

    fn apply_theme(&mut self, name: &str) {
        let Some(palette) = self.themes.palette(name) else {
            return;
        };
        state::save_theme(name);
        let theme = Theme {
            name: name.to_string(),
            palette,
        };
        self.shell.set_theme(theme.clone());
        self.home.set_theme(theme);
    }

    fn session_id(&self) -> Option<String> {
        self.session.as_ref().map(|session| session.id.clone())
    }

    fn title_of(&self, id: &str) -> String {
        self.catalog
            .iter()
            .chain(self.home.rows.iter())
            .find(|row| row.id == id)
            .map(|row| row.label().to_string())
            .unwrap_or_else(|| "untitled".to_string())
    }

    fn handle_home_key(&mut self, key: KeyEvent) {
        if self.keys.matches(keybinds::Action::AppExit, &key) {
            self.quit = true;
            return;
        }
        // Tab moves between the prompt and the list; the prompt owns the rest of
        // the keys so a first prompt can be typed before any Session exists.
        if key.code == KeyCode::Tab {
            self.home_list_focus = !self.home_list_focus;
            return;
        }
        if !self.home_list_focus {
            match self.shell.composer.handle_key(key, &self.keys) {
                Action::None => {}
                Action::Quit => self.quit = true,
                // A shell command needs the Session whose location it runs in.
                Action::Shell { .. } => {
                    self.notice("open a Session to run a shell command");
                }
                Action::Submit { text, .. } => {
                    if text.trim().is_empty() {
                        return;
                    }
                    self.startup.prompt = Some(text);
                    if let Some(engine) = self.engine.as_ref() {
                        engine.new_session();
                    }
                }
            }
            return;
        }
        // Filter mode owns the keyboard: printable keys narrow the list, and
        // Escape leaves the mode before anything else can consume Escape.
        if self.home.filtering() {
            match key.code {
                KeyCode::Esc => {
                    self.home.stop_filter();
                    return;
                }
                KeyCode::Backspace => {
                    self.home.filter_backspace();
                    return;
                }
                KeyCode::Up => {
                    self.home.move_cursor(-1);
                    return;
                }
                KeyCode::Down => {
                    self.home.move_cursor(1);
                    return;
                }
                KeyCode::Enter => {
                    let selected = self.home.current().map(|row| row.id.clone());
                    if let (Some(id), Some(engine)) = (selected, self.engine.as_ref()) {
                        engine.open(&id);
                    }
                    return;
                }
                KeyCode::Char(c) if !c.is_ascii_control() => {
                    self.home.filter(c);
                    return;
                }
                _ => {}
            }
        }
        match (key.code, key.modifiers) {
            (KeyCode::Char('j'), KeyModifiers::NONE) | (KeyCode::Down, _) => {
                self.home.move_cursor(1);
            }
            (KeyCode::Char('k'), KeyModifiers::NONE) | (KeyCode::Up, _) => {
                self.home.move_cursor(-1);
            }
            (KeyCode::Enter, _) => {
                let selected = self.home.current().map(|row| row.id.clone());
                if let (Some(id), Some(engine)) = (selected, self.engine.as_ref()) {
                    engine.open(&id);
                }
            }
            (KeyCode::Char('r'), KeyModifiers::NONE) => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.refresh_sessions();
                }
            }
            // Space reveals the next page of history, the way a pager does:
            // the list opens at ten rows and grows while the operator asks.
            (KeyCode::Char(' '), KeyModifiers::NONE) => self.home.more(),
            (KeyCode::Char('n'), KeyModifiers::NONE) => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.new_session();
                }
            }
            // Numbered slots open the n-th row of the list as it is shown, so a
            // pinned Session keeps its number instead of needing a search.
            (KeyCode::Char(digit @ '1'..='9'), KeyModifiers::NONE) => {
                let slot = digit as usize - '1' as usize;
                let selected = self.home.slot(slot).map(|row| row.id.clone());
                if let (Some(id), Some(engine)) = (selected, self.engine.as_ref()) {
                    engine.open(&id);
                }
            }
            (KeyCode::Char('/'), KeyModifiers::NONE) => {
                self.home.start_filter();
            }
            (KeyCode::Char('p'), KeyModifiers::NONE) => {
                let selected = self
                    .home
                    .current()
                    .map(|row| (row.id.clone(), row.pinned_at_ms.is_none()));
                if let (Some((id, pinned)), Some(engine)) = (selected, self.engine.as_ref()) {
                    engine.pin(&id, pinned);
                }
            }
            _ => {}
        }
    }

    fn handle_session_key(&mut self, key: KeyEvent) {
        let action = |action| self.keys.matches(action, &key);
        if action(keybinds::Action::SessionInterrupt) {
            if self.shell.composer.dismiss_completion() {
                return;
            }
            // `!` mode owns Escape: leaving the command is cheaper than
            // leaving the Session, and the typed command survives.
            if self.shell.composer.mode() == Mode::Shell {
                self.shell.composer.set_mode(Mode::Normal);
                return;
            }
            if self.reject_question() {
                return;
            }
            // A queued prompt is cheaper to take back than a running turn is to
            // interrupt, so Escape cancels the newest queued input first and
            // only reaches the turn when the queue is empty.
            if self.state.pending > 0 {
                if let (Some(id), Some(engine)) = (
                    self.session.as_ref().map(|session| session.id.clone()),
                    self.engine.as_ref(),
                ) {
                    engine.cancel_last_input(&id);
                    return;
                }
            }
            self.interrupt_or_leave();
            return;
        }
        if action(keybinds::Action::InputClear) && !self.shell.composer.editor.is_empty() {
            self.shell.composer.editor.clear();
            self.shell.composer.dismiss_completion();
            return;
        }
        // `app_exit` shares `ctrl+d` with `input_delete`; like the TypeScript
        // host it only exits while the composer is empty, so `ctrl+d` still
        // deletes forward when there is a draft.
        if action(keybinds::Action::AppExit) && self.shell.composer.editor.is_empty() {
            self.quit = true;
            return;
        }
        if action(keybinds::Action::SessionRename) {
            if let Some(session) = self.session.as_ref() {
                let dialog = Dialog::rename(&session.id, session.label());
                self.open_dialog(dialog);
            }
            return;
        }
        if action(keybinds::Action::Accounts) {
            self.open_accounts();
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('v') {
            self.read_clipboard();
            return;
        }
        if action(keybinds::Action::CopyMessage) {
            self.copy_last_response();
            return;
        }
        if action(keybinds::Action::PageUp) {
            self.shell.scroll_transcript(-5);
            return;
        }
        if action(keybinds::Action::PageDown) {
            self.shell.scroll_transcript(5);
            return;
        }
        if action(keybinds::Action::LineUp) {
            self.shell.scroll_transcript(-1);
            return;
        }
        if action(keybinds::Action::LineDown) {
            self.shell.scroll_transcript(1);
            return;
        }
        if self.handle_panel_key(key) {
            return;
        }
        // Recall before the composer sees the key: recalling is what turns a
        // retry into one keystroke instead of a retype. While a recalled prompt
        // is in the composer the arrows keep walking the history, so "one more
        // back" works; any other key hands the composer back.
        let empty =
            self.shell.composer.editor.is_empty() && self.shell.composer.editor.line_count() == 1;
        let recalling = self.history_index < self.prompt_history.len();
        match key.code {
            KeyCode::Up | KeyCode::Down if empty || recalling => {
                let step = match key.code {
                    KeyCode::Up => -1i32,
                    _ => 1,
                };
                let next = (self.history_index as i32 + step)
                    .clamp(0, self.prompt_history.len() as i32) as usize;
                if next != self.history_index {
                    self.history_index = next;
                    let recalled = self.prompt_history.get(next).cloned().unwrap_or_default();
                    self.shell.composer.editor.set_text(&recalled);
                }
                return;
            }
            _ if recalling => self.history_index = self.prompt_history.len(),
            _ => {}
        }
        match self.shell.composer.handle_key(key, &self.keys) {
            Action::None => {}
            Action::Quit => self.quit = true,
            Action::Submit { text, attachments } => self.submit(text, attachments),
            Action::Shell { command } => self.run_shell(command),
        }
    }

    /// Panel keys are a closed vocabulary: a decision is blocking, so typing
    /// must not leak into the composer while one is on screen.
    fn handle_panel_key(&mut self, key: KeyEvent) -> bool {
        let Some(panel) = self.shell.panel.as_mut() else {
            return false;
        };
        let session_id = self.session.as_ref().map(|session| session.id.clone());
        let typing = panel.typing().is_some();
        match &mut panel.kind {
            PanelKind::Approval(view) => {
                let decision = match key.code {
                    KeyCode::Char('1') => Some(("allow", false)),
                    KeyCode::Char('2') => Some(("allow", true)),
                    KeyCode::Char('3') => Some(("deny", false)),
                    _ => None,
                };
                if let Some((decision, persistent)) = decision {
                    let response = view.response(decision);
                    if let (Some(session_id), Some(engine)) =
                        (session_id.as_deref(), self.engine.as_ref())
                    {
                        engine.approve(session_id, response, persistent);
                    }
                }
            }
            PanelKind::Question(_) if typing => match key.code {
                // While a custom answer is being typed, keys belong to it.
                KeyCode::Enter => {
                    panel.accept_typing();
                }
                KeyCode::Esc => {
                    panel.cancel_typing();
                }
                KeyCode::Backspace => panel.backspace_typing(),
                KeyCode::Char(character) => panel.type_char(character),
                _ => {}
            },
            PanelKind::Question(_) => match key.code {
                KeyCode::Up | KeyCode::Char('k') => panel.move_cursor(-1),
                KeyCode::Down | KeyCode::Char('j') => panel.move_cursor(1),
                KeyCode::Char(' ') => panel.toggle(),
                KeyCode::Enter => {
                    if panel.begin_typing() {
                        return true;
                    }
                    if let Some(answer) = panel.submit() {
                        if let (Some(session_id), Some(engine)) =
                            (session_id.as_deref(), self.engine.as_ref())
                        {
                            engine.answer(session_id, answer);
                        }
                    }
                }
                _ => {}
            },
        }
        true
    }

    /// Rejecting a pending question is the only Esc that is answered locally.
    fn reject_question(&mut self) -> bool {
        let Some(rejection) = self.shell.panel.as_ref().and_then(Panel::rejection) else {
            return false;
        };
        if let (Some(id), Some(engine)) = (
            self.session.as_ref().map(|session| session.id.clone()),
            self.engine.as_ref(),
        ) {
            engine.reject_question(&id, rejection);
        }
        true
    }

    fn sync_panel(&mut self) {
        let next = self
            .state
            .approvals
            .first()
            .map(|view| view.request_id.clone())
            .or_else(|| {
                self.state
                    .questions
                    .first()
                    .map(|view| view.question_id.clone())
            });
        let Some(request_id) = next else {
            self.shell.panel = None;
            return;
        };
        if self
            .shell
            .panel
            .as_ref()
            .is_some_and(|panel| panel.request_id() == request_id)
        {
            return;
        }
        self.shell.panel = self
            .state
            .approvals
            .first()
            .map(|view| Panel::approval(view.clone()))
            .or_else(|| {
                self.state
                    .questions
                    .first()
                    .map(|view| Panel::question(view.clone()))
            });
    }

    /// Fold one ephemeral provider frame into the live status. The transcript
    /// does not read this: it is replaced by every projection.
    fn provider(&mut self, frame: Value) {
        let Some(run_id) = self.state.active_run.clone() else {
            return;
        };
        // A late frame from an earlier run must not refresh the current status.
        if frame
            .get("run_id")
            .and_then(Value::as_str)
            .is_some_and(|id| id != run_id)
        {
            return;
        }
        let now = Instant::now();
        let phase = match frame
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            // A token reached the stream, so the wait is over and the answer
            // starts to show before it commits.
            "provider.delta" => {
                self.live = None;
                self.stream(&run_id, frame.get("data").unwrap_or(&Value::Null));
                return;
            }
            // The engine repeats this while it has no first token.
            "provider.waiting" => LivePhase::Waiting,
            "provider.retry" => LivePhase::Retrying {
                attempt: frame.get("attempt").and_then(Value::as_u64).unwrap_or(0) + 1,
            },
            // An attempt announcement proves the request is in flight, even
            // before the first heartbeat or right after a previous step.
            "provider.attempt" => match self.live.as_ref().map(|live| live.phase.clone()) {
                Some(phase) => phase,
                None => LivePhase::Waiting,
            },
            // A committed tool call names the work the run is doing.
            "tool.planned" => LivePhase::Tool {
                name: tool_label(
                    frame
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
            },
            // The call finished; the run's next phase is not known yet.
            "tool.completed" => {
                self.live = None;
                return;
            }
            _ => return,
        };
        // Only a phase change restarts the clock; a heartbeat must not restart
        // the elapsed time the user is already reading.
        let since = match self.live.as_ref() {
            Some(live) if live.run_id == run_id && live.phase == phase => live.since,
            _ => now,
        };
        self.live = Some(Live {
            run_id,
            phase,
            since,
            signal: now,
        });
    }

    /// Append one normalized provider delta to the draft the next projection
    /// will replace.
    fn stream(&mut self, run_id: &str, frame: &Value) {
        let delta = frame.get("delta").unwrap_or(&Value::Null);
        // A delta for a run other than the draft's starts a new draft; frames
        // for a finished run are filtered above, so this is a newer turn.
        if self
            .draft
            .as_ref()
            .is_none_or(|draft| draft.run_id != run_id)
        {
            self.draft = Some(Draft {
                run_id: run_id.to_string(),
                committed: self.committed,
                ..Draft::default()
            });
        }
        let draft = self.draft.as_mut().expect("draft just ensured");
        draft.append(delta);
        self.shell.set_draft(&draft.text, &draft.reasoning);
    }

    /// Whether the status line has something to count, which is also when the
    /// drive loop must repaint faster than the minute.
    pub fn busy(&self) -> bool {
        self.screen == Screen::Session && self.state.active_run.is_some()
    }

    /// How long the painted relative timestamps stay true, so an idle TUI wakes
    /// when a label would actually change instead of once a minute. `None` means
    /// nothing on screen is time-relative, so the loop may wait for events alone.
    pub fn next_repaint(&self) -> Option<Duration> {
        let now = crate::pane::now_ms();
        let stamps = match self.screen {
            Screen::Home => self
                .home
                .rows
                .iter()
                .filter_map(|row| row.updated_at_ms)
                .collect::<Vec<_>>(),
            Screen::Session => self
                .session
                .as_ref()
                .and_then(|session| session.updated_at_ms)
                .into_iter()
                .collect(),
        };
        stamps
            .into_iter()
            .map(|updated| crate::pane::next_relative_change(updated, now))
            .min()
    }

    fn update_status(&mut self) {
        // The composer mirrors the durable queue every frame so the count stays
        // live without the composer owning it.
        self.shell.composer.queued = self.state.pending;
        if self.screen != Screen::Session {
            self.shell.title.set_status(None);
            self.shell.title.set_status_alert(false);
            self.shell.composer.queued = 0;
            self.shell.composer.phase = None;
            self.shell.status.model = None;
            self.shell.status.usage = None;
            self.shell.status.hints.clear();
            return;
        }
        let now = Instant::now();
        let live = self
            .live
            .as_ref()
            .filter(|live| self.state.active_run.as_deref() == Some(live.run_id.as_str()));
        // Without a frame the run is still starting; saying so with the plain
        // "working" avoids claiming a phase the engine never announced.
        // A blocking approval or question means the turn waits on the operator
        // rather than on the engine, so it outranks whatever the last frame
        // said: a stale "running bash" would hide the only thing the operator
        // has to act on.
        let blocking = match (self.state.approvals.len(), self.state.questions.len()) {
            (0, 0) => None,
            (1, 0) => Some(format!("needs approval · {}", self.state.approvals[0].tool)),
            (approvals, 0) => Some(format!("needs approval · {approvals} waiting")),
            (0, 1) => Some("needs an answer".to_string()),
            (0, questions) => Some(format!("needs an answer · {questions} waiting")),
            (approvals, questions) => Some(format!(
                "needs you · {approvals} approval{} · {questions} question{}",
                plural(approvals),
                plural(questions)
            )),
        };
        let phase_needs_operator = blocking.is_some();
        let phase = match blocking {
            Some(blocking) => blocking,
            None => match (self.state.active_run.is_some(), live) {
                (true, Some(live)) => live.describe(now),
                (true, None) => "working".to_string(),
                (false, _) => "idle".to_string(),
            },
        };
        let status = match (&self.state.active_run, self.state.pending) {
            (Some(_), 0) => format!("{phase} · Esc interrupt"),
            (Some(_), queued) => format!("{phase} · {queued} queued · Esc interrupt"),
            (None, 0) => phase.clone(),
            (None, queued) => format!("{phase} · {queued} queued"),
        };
        self.shell
            .title
            .set_status_alert(phase_needs_operator || live.is_some_and(|live| live.silent(now)));
        // The same phase rides the composer title, so the operator does not
        // have to look away from the input to learn the run is working rather
        // than waiting on them. An idle Session says nothing there.
        self.shell.composer.phase =
            match self.state.active_run.is_some() || self.state.pending > 0 || phase_needs_operator
            {
                true => Some(phase.clone()),
                false => None,
            };
        // Which model answers, and what the Session has cost so far. A pin on
        // the Session wins over the engine default.
        self.shell.status.model = self
            .session
            .as_ref()
            .and_then(|session| session.model.clone())
            .or_else(|| {
                self.settings
                    .as_ref()
                    .map(|settings| settings.model.clone())
            });
        self.shell.status.usage =
            self.usage
                .as_ref()
                .filter(|usage| usage.turns > 0)
                .map(|usage| {
                    format!(
                        "{} turns · in {} · out {}",
                        usage.turns,
                        compact_tokens(usage.input_tokens),
                        compact_tokens(usage.output_tokens)
                    )
                });
        // What the run waits on, and what the next key does. An approval or a
        // question blocks the turn, so it reads as a warning; the interrupt key
        // is a fact about the run.
        let mut hints = Vec::new();
        // A blocking approval or question is already the phase line, so
        // repeating it here would say the same thing twice in the one strip the
        // operator scans.
        if self.state.active_run.is_some() {
            hints.push(StatusHint {
                text: "esc interrupt".to_string(),
                warning: false,
            });
        }
        self.shell.status.hints = hints;
        self.shell.title.set_status(Some(status));
    }

    /// `--continue` opens the Session the engine reports as most recently
    /// updated. The catalog also carries archived Sessions, which "continue"
    /// must not pick.
    fn continue_startup(&mut self) {
        if !self.startup.continue_last || self.screen != Screen::Home || self.dialog.is_some() {
            return;
        }
        self.startup.continue_last = false;
        match self.catalog.iter().find(|row| row.archived_at_ms.is_none()) {
            Some(row) => {
                let id = row.id.clone();
                if let Some(engine) = self.engine.clone() {
                    engine.open(&id);
                }
            }
            None => self.start_unsaved(),
        }
    }

    /// With no Session to continue, a launch prompt still gets a Session of its
    /// own; without one the TUI stays on the home list with an explanation.
    fn start_unsaved(&mut self) {
        if self.startup.prompt.is_some() {
            if let Some(engine) = self.engine.clone() {
                engine.new_session();
            }
            return;
        }
        self.notice("no Sessions to continue");
    }

    fn continue_prompt(&mut self) {
        let Some(text) = self.startup.prompt.take() else {
            return;
        };
        self.submit(text, Vec::new());
    }

    fn submit(&mut self, text: String, attachments: Vec<Value>) {
        let Some(session_id) = self.session.as_ref().map(|session| session.id.clone()) else {
            self.shell.composer.restore_with(&text, attachments);
            return;
        };
        let Some(engine) = self.engine.clone() else {
            self.shell.composer.restore_with(&text, attachments);
            return;
        };
        self.shell.composer.notice = None;
        if !text.trim().is_empty() && self.prompt_history.last() != Some(&text) {
            self.prompt_history.push(text.clone());
            // Fifty covers a session's recent work without keeping every prompt
            // alive for the life of the process.
            if self.prompt_history.len() > 50 {
                self.prompt_history.remove(0);
            }
        }
        self.history_index = self.prompt_history.len();
        // A first-word slash command the TUI knows runs here; a discovered
        // template is rendered and admitted with its command reference; any
        // other slash text is a plain prompt, like the TS composer.
        if let Some((name, arguments)) = commands::split(&text) {
            if Builtin::from_name(&name) == Some(Builtin::Tag) {
                // An argument sets the label straight away; a bare /tag opens
                // the dialog, which is also how an operator clears it.
                let label = arguments.trim();
                if label.is_empty() {
                    self.open_dialog(Dialog::tag(&session_id, ""));
                } else {
                    engine.tag(&session_id, label);
                }
                return;
            }
            if Builtin::from_name(&name) == Some(Builtin::Recall) {
                let handle = arguments.trim();
                if handle.is_empty() {
                    self.shell.composer.restore_with(&text, attachments);
                    self.shell.composer.notice =
                        Some("/recall needs the tool_use_id its elision marker named".to_string());
                    return;
                }
                engine.recall(&session_id, handle);
                return;
            }
            if let Some(builtin) = Builtin::from_name(&name) {
                self.run_builtin(builtin);
                return;
            }
            if let Some(template) = self.templates.iter().find(|item| item.name == name) {
                let prompt = commands::render_template(&template.template, &arguments);
                engine.command(&session_id, &prompt, &text, &name, &arguments);
                return;
            }
            // A failed command is an error, not a message: sending the text as
            // a plain prompt would silently hand a typo to the model.
            self.shell.composer.restore_with(&text, attachments);
            self.shell.composer.notice = Some(unknown_command_notice(&name));
            return;
        }
        // Editor context is a prompt prefix rather than a wire field: the
        // engine admits one text string, and the TS client does the same.
        let text = match self.zed_context() {
            Some(context) => format!("{context}\n\n{text}"),
            None => text,
        };
        engine.prompt(&session_id, &text, attachments);
        // The prompt left the composer, so its draft is gone too: keeping it
        // would restore text the Session already sent if the operator switched
        // away and back.
        self.drafts.remove(&session_id);
    }

    /// Interrupt the running turn, or leave the Session when nothing is
    /// running. Shared by Escape and by a take-back that found nothing to
    /// cancel, so both end in the same place.
    fn interrupt_or_leave(&mut self) {
        if self.state.active_run.is_some() {
            if let (Some(id), Some(engine)) = (
                self.session.as_ref().map(|session| session.id.clone()),
                self.engine.as_ref(),
            ) {
                engine.cancel(&id);
            }
            return;
        }
        if self.shell.panel.is_some() {
            return;
        }
        self.leave_session();
    }

    /// `!` runs on the Session's host shell through the engine. The engine
    /// records the command and its output in the Session, so it is visible to
    /// the operator without becoming model context.
    fn run_shell(&mut self, command: String) {
        let session_id = self.session.as_ref().map(|session| session.id.clone());
        let Some(engine) = self.engine.clone() else {
            self.shell.composer.restore_shell(&command);
            return;
        };
        let Some(session_id) = session_id else {
            self.shell.composer.restore_shell(&command);
            return;
        };
        self.shell.composer.notice = None;
        engine.shell(&session_id, &command);
    }

    fn leave_session(&mut self) {
        self.screen = Screen::Home;
        self.session = None;
        self.state = SessionState::default();
        self.live = None;
        self.draft = None;
        self.committed = 0;
        self.shell.set_draft("", "");
        self.usage = None;
        self.shell.set_usage(None);
        self.pending_accounts = false;
        self.shell.panel = None;
        self.shell.set_session(None);
        self.shell.title.set_status(None);
        self.shell.composer.clear();
        self.dialog = None;
        self.leader = false;
        if let Some(engine) = self.engine.as_ref() {
            engine.refresh_sessions();
        }
    }
}

/// The plural suffix for a count, so "1 approval" and "2 approvals" both read
/// as English.
fn plural(count: usize) -> &'static str {
    match count {
        1 => "",
        _ => "s",
    }
}

fn row(label: &str, detail: &str) -> Row {
    Row {
        id: label.to_string(),
        label: label.to_string(),
        detail: detail.to_string(),
    }
}

/// The debug dialog reads the database path back out of the engine arguments
/// rather than keeping a second copy that could disagree.
fn db_argument(args: &[String]) -> String {
    args.iter()
        .position(|arg| arg == "--db")
        .and_then(|index| args.get(index + 1))
        .cloned()
        .unwrap_or_else(|| "(none)".to_string())
}

/// Token counts as the status strip shows them: exact under a thousand,
/// one decimal above, so a long Session does not widen the row.
fn compact_tokens(tokens: u64) -> String {
    match tokens {
        0..=999 => tokens.to_string(),
        1_000..=999_999 => format!("{:.1}k", tokens as f64 / 1_000.0),
        _ => format!("{:.1}m", tokens as f64 / 1_000_000.0),
    }
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let mut label = line.chars().take(60).collect::<String>();
    if line.chars().count() > 60 {
        label.push('…');
    }
    label
}

/// A next step for a failure the operator can act on. The engine's own message
/// names what broke; this says what to try next, and stays silent rather than
/// guessing when the failure is unfamiliar — advice that does not fit costs the
/// operator a detour.
fn remedy(message: &str) -> Option<&'static str> {
    let message = message.to_lowercase();
    let rules = [
        ("miao_engine_db", "pass --db <path> or set MIAO_ENGINE_DB"),
        (
            "no model routes",
            "start the product with `miao`, or set MIAO_ENGINE_MODEL_ROUTES_CONFIG",
        ),
        (
            "api key",
            "set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY",
        ),
        (
            "miao-engine",
            "install the engine beside the TUI, or set MIAO_ENGINE_BIN",
        ),
        (
            "permission denied",
            "check the engine's --mode and the workspace permissions",
        ),
        (
            "timed out",
            "retry; a stalled engine shows as `no engine signal` in the status line",
        ),
    ];
    rules
        .iter()
        .find(|(needle, _)| message.contains(needle))
        .map(|(_, advice)| *advice)
}

/// The message with its next step appended, when there is one and it is not
/// already part of the message.
fn with_remedy(message: &str) -> String {
    match remedy(message) {
        Some(advice) if !message.contains(advice) => format!("{message} — {advice}"),
        _ => message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Entry, RevertPlan, Transcript};
    use crate::theme::{self, DEFAULT_THEME};
    use std::collections::BTreeMap;

    fn app() -> App {
        app_with(Startup::default())
    }

    fn app_with(startup: Startup) -> App {
        let palette = theme::builtin(DEFAULT_THEME).expect("default theme is built in");
        App::new(
            PathBuf::from("."),
            Theme {
                name: DEFAULT_THEME.to_string(),
                palette,
            },
            theme::Catalog::builtin(),
            Keymap::default(),
            crate::config::AttentionConfig::default(),
            startup,
        )
    }

    /// An app whose keymap was overridden, so a test can prove the help view
    /// follows live bindings instead of a written-down copy.
    fn app_with_overrides(overrides: &BTreeMap<String, Option<Vec<String>>>) -> App {
        let palette = theme::builtin(DEFAULT_THEME).expect("default theme is built in");
        App::new(
            PathBuf::from("."),
            Theme {
                name: DEFAULT_THEME.to_string(),
                palette,
            },
            theme::Catalog::builtin(),
            Keymap::from_overrides(overrides),
            crate::config::AttentionConfig::default(),
            Startup::default(),
        )
    }

    fn session_app() -> App {
        let mut app = app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        assert_eq!(app.screen, Screen::Session);
        app
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> AppEvent {
        AppEvent::Key(KeyEvent::new(code, modifiers))
    }

    fn summary(id: &str, updated_at_ms: u64) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            title: Some(id.to_string()),
            parent_id: None,
            updated_at_ms: Some(updated_at_ms),
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: None,
            model: None,
            credential_id: None,
            preview: None,
        }
    }

    fn wheel(kind: MouseEventKind) -> AppEvent {
        AppEvent::Mouse(MouseEvent::new(kind, 0, 0, KeyModifiers::NONE))
    }

    #[test]
    fn the_wheel_moves_the_configured_scroll_speed_in_the_transcript() {
        let mut app = session_app();
        // One row per notch, so the offset moves by exactly one.
        app.configure_scroll(1.0, false);
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(forty_messages()),
            state: SessionState::default(),
        });
        draw(&mut app);
        let tail = app.shell.transcript_scroll();
        assert!(app.shell.following());
        app.handle(wheel(MouseEventKind::ScrollUp));
        assert_eq!(app.shell.transcript_scroll(), tail - 1);
        assert!(!app.shell.following(), "one notch up detaches");
        app.handle(wheel(MouseEventKind::ScrollDown));
        assert_eq!(app.shell.transcript_scroll(), tail);
        assert!(
            app.shell.following(),
            "the last visible row is the tail, so one notch back follows again"
        );
    }

    #[test]
    fn a_wheel_notch_moves_the_default_three_rows() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(forty_messages()),
            state: SessionState::default(),
        });
        draw(&mut app);
        let tail = app.shell.transcript_scroll();
        app.handle(wheel(MouseEventKind::ScrollUp));
        assert_eq!(app.shell.transcript_scroll(), tail - 3);
        app.handle(wheel(MouseEventKind::ScrollDown));
        assert!(
            app.shell.following(),
            "scrolling back to the visible tail follows again instead of              needing an overshoot past it"
        );
    }

    /// Paint one frame. The tail offset is computed while rendering, so a wheel
    /// test that scrolls up has to render before the first notch.
    fn draw(app: &mut App) {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 10)).expect("terminal");
        terminal.draw(|frame| app.render(frame)).expect("draw");
    }

    /// A transcript long enough that the viewport cannot show all of it, so
    /// scrolling has rows to move through.
    fn forty_messages() -> Transcript {
        let mut transcript = Transcript::default();
        for index in 0..40 {
            transcript.entries.push(crate::session::Entry::User {
                text: format!("message {index}"),
                seq: index as u64 + 1,
            });
        }
        transcript
    }

    #[test]
    fn a_leader_chord_inside_its_window_still_fires() {
        let mut app = app();
        app.configure_leader_timeout(60_000);
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char('t'), KeyModifiers::NONE));
        assert!(
            matches!(app.dialog, Some(Dialog::Theme(_))),
            "the chord fires while the window is open"
        );
    }

    #[test]
    fn an_expired_leader_does_not_eat_the_next_key() {
        // INP-07: press the leader, walk away, come back — the next key belongs
        // to the mode that is active now, not to a chord armed minutes ago.
        let mut app = app();
        app.configure_leader_timeout(1);
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        std::thread::sleep(Duration::from_millis(5));
        app.handle(key(KeyCode::Char('t'), KeyModifiers::NONE));
        assert!(
            app.dialog.is_none(),
            "a chord whose window passed must not open the theme dialog"
        );
    }

    #[test]
    fn a_failure_the_operator_can_fix_carries_its_next_step() {
        // UX-05: a raw engine message names the breakage but not the way out.
        let cases = [
            (
                "pass --db <engine.db> or set MIAO_ENGINE_DB",
                "MIAO_ENGINE_DB",
            ),
            ("no model routes", "MIAO_ENGINE_MODEL_ROUTES_CONFIG"),
            ("missing api key for the provider", "ANTHROPIC_API_KEY"),
            (
                "cannot start /usr/local/bin/miao-engine: not found",
                "MIAO_ENGINE_BIN",
            ),
            ("permission denied opening the workspace", "--mode"),
            ("engine timed out after 30s", "no engine signal"),
        ];
        for (message, expected) in cases {
            let advice = remedy(message).unwrap_or_default();
            assert!(
                advice.contains(expected),
                "{message} should suggest {expected}, got {advice:?}"
            );
        }

        // An unfamiliar failure stays as it is: invented advice sends the
        // operator down the wrong path.
        assert_eq!(remedy("something the TUI never saw"), None);
        assert_eq!(
            with_remedy("something the TUI never saw"),
            "something the TUI never saw"
        );
        // A message that already names its own fix is not repeated.
        let already = "pass --db <path> or set MIAO_ENGINE_DB";
        assert_eq!(with_remedy(already), already);
    }

    #[test]
    fn a_start_failure_shows_the_next_step_in_the_ui() {
        let mut app = app();
        app.handle(AppEvent::EngineFailure(
            "pass --db <engine.db> or set MIAO_ENGINE_DB".into(),
        ));
        let notice = app.home.notice().expect("notice");
        assert!(notice.contains("MIAO_ENGINE_DB"), "{notice}");
        assert!(
            notice.contains("pass --db"),
            "the message keeps the engine's own words: {notice}"
        );
    }

    #[test]
    fn an_idle_screen_waits_for_its_next_label_change() {
        // Two hours old: the sidebar reads "2h ago" and must sleep for the rest
        // of that hour rather than wake every minute.
        let mut app = session_app();
        let now = crate::pane::now_ms();
        app.session = Some(SessionSummary {
            updated_at_ms: Some(now.saturating_sub(2 * 3_600_000)),
            ..summary("ses_a", 1)
        });
        let wait = app.next_repaint().expect("the sidebar shows a timestamp");
        assert!(
            wait > Duration::from_secs(3_000) && wait <= Duration::from_secs(3_600),
            "{wait:?} is the wait until \"2h ago\" becomes \"3h ago\""
        );
    }

    #[test]
    fn a_home_screen_without_timestamps_never_repaints_on_its_own() {
        let mut app = app();
        app.home.rows = vec![summary("ses_a", 1)];
        app.home.rows[0].updated_at_ms = None;
        assert!(
            app.next_repaint().is_none(),
            "nothing on screen is relative, so only events can repaint"
        );
    }

    #[test]
    fn the_wheel_moves_the_home_selection_and_ignores_buttons() {
        let mut app = app();
        app.home.rows = vec![summary("a", 2), summary("b", 1)];

        app.handle(wheel(MouseEventKind::ScrollDown));
        assert_eq!(app.home.selected, 1);
        app.handle(wheel(MouseEventKind::ScrollDown));
        assert_eq!(app.home.selected, 1, "the selection stops at the end");
        app.handle(wheel(MouseEventKind::ScrollUp));
        assert_eq!(app.home.selected, 0);

        app.handle(wheel(MouseEventKind::Moved));
        assert_eq!(app.home.selected, 0, "only the wheel does anything");
    }

    /// A row that `--continue` must skip.
    fn archived(id: &str, updated_at_ms: u64) -> SessionSummary {
        SessionSummary {
            archived_at_ms: Some(1),
            ..summary(id, updated_at_ms)
        }
    }

    #[test]
    fn a_launch_session_opens_directly() {
        let mut app = app_with(Startup {
            session: Some("ses_known".into()),
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Open(id)) if id == "ses_known"
        ));
        assert!(requests.try_recv().is_err(), "nothing else is requested");
    }

    #[test]
    fn a_startup_warning_survives_the_session_catalog() {
        let mut app = app_with(Startup::default());
        app.warn("no model routes");
        assert_eq!(app.home.warning(), Some("no model routes"));
        // The catalog answers "which Sessions exist", not "is this Session
        // routed", so it must not make the warning disappear.
        app.handle(AppEvent::Sessions(vec![summary("ses_known", 1)]));
        assert_eq!(app.home.warning(), Some("no model routes"));
    }

    #[test]
    fn continue_opens_the_newest_session_that_is_not_archived() {
        let mut app = app_with(Startup {
            continue_last: true,
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        assert!(matches!(requests.try_recv(), Ok(engine::Request::Catalog)));
        // The engine answers the catalog most recently updated first, so the
        // newest unarchived row is the one right after the archived ones.
        app.handle(AppEvent::Catalog(vec![
            archived("ses_archived", 300),
            summary("ses_new", 200),
            summary("ses_old", 100),
        ]));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Open(id)) if id == "ses_new"
        ));
    }

    #[test]
    fn continue_without_sessions_explains_instead_of_opening_anything() {
        let mut app = app_with(Startup {
            continue_last: true,
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        app.handle(AppEvent::Catalog(Vec::new()));
        assert!(requests.try_recv().is_ok(), "the catalog request");
        assert!(requests.try_recv().is_err(), "nothing is opened");
        assert_eq!(
            app.home.notice().map(str::to_string),
            Some("no Sessions to continue".into())
        );
    }

    #[test]
    fn pin_toggles_the_engine_owned_pin() {
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.catalog = vec![summary("ses_a", 10)];
        app.dialog = Some(Dialog::sessions(&app.catalog));
        app.dialog_action(DialogAction::TogglePin("ses_a".into()));
        assert!(app.dialog.is_none(), "the list closes on the action");
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Pin { session_id, pinned })
                if session_id == "ses_a" && pinned
        ));
        // The same key unpins a Session the engine already reports as pinned.
        let mut pinned = summary("ses_a", 10);
        pinned.pinned_at_ms = Some(5);
        app.catalog = vec![pinned];
        app.dialog = Some(Dialog::sessions(&app.catalog));
        app.dialog_action(DialogAction::TogglePin("ses_a".into()));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Pin { pinned: false, .. })
        ));
    }

    #[test]
    fn a_launch_prompt_creates_a_session_and_is_sent_once_it_opens() {
        let mut app = app_with(Startup {
            prompt: Some("hello".into()),
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::NewSession)
        ));
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_new", 1)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Prompt { session_id, text, .. })
                if session_id == "ses_new" && text == "hello"
        ));
        // A second open must not resend the launch prompt.
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_other", 2)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn terminal_titles_follow_the_admitted_session_and_honor_disabled_preferences() {
        let mut app = app();
        assert_eq!(app.terminal_title().as_deref(), Some("miao"));
        let mut session = summary("named", 1);
        session.title = Some("New session".into());
        app.handle(AppEvent::SessionOpened {
            summary: Some(session),
            transcript: Box::new(Transcript {
                entries: vec![Entry::User {
                    text: "repair\x07 this test".into(),
                    seq: 1,
                }],
                ..Default::default()
            }),
            state: SessionState::default(),
        });
        assert_eq!(app.terminal_title().as_deref(), Some("repair this test"));
        app.configure_terminal_title(false, true);
        assert_eq!(app.terminal_title(), None);
        app.configure_terminal_title(true, false);
        assert_eq!(app.terminal_title(), None);
    }

    #[test]
    fn redraw_preserves_the_draft_and_dialog_and_honors_key_overrides() {
        let mut app = session_app();
        app.handle(AppEvent::Paste("keep this draft".into()));
        app.open_palette();
        app.handle(key(KeyCode::Char('l'), KeyModifiers::CONTROL));
        assert!(app.take_redraw_request());
        assert!(!app.take_redraw_request());
        assert!(app.dialog.is_some());
        assert_eq!(app.shell.composer.editor.text(), "keep this draft");
        assert!(!app.quit);
        app.dialog = None;
        app.keys = Keymap::from_overrides(
            &[("terminal_redraw".into(), Some(vec!["<leader>r".into()]))].into(),
        );
        app.handle(key(KeyCode::Char('l'), KeyModifiers::CONTROL));
        assert!(!app.take_redraw_request());
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char('r'), KeyModifiers::NONE));
        assert!(app.take_redraw_request());
        assert_eq!(app.shell.composer.editor.text(), "keep this draft");
        app.run_builtin(Builtin::from_name("redraw").unwrap());
        assert!(app.take_redraw_request());
        assert_eq!(app.shell.composer.editor.text(), "keep this draft");
    }

    #[test]
    fn ctrl_c_clears_non_empty_input_before_quitting() {
        let mut app = session_app();
        app.handle(key(KeyCode::Char('h'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(!app.quit);
        assert!(app.shell.composer.editor.is_empty());
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }

    #[test]
    fn ctrl_d_deletes_forward_before_it_quits() {
        let mut app = session_app();
        app.handle(key(KeyCode::Char('h'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('i'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Left, KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert!(!app.quit);
        assert_eq!(app.shell.composer.editor.text(), "h");
        app.handle(key(KeyCode::Backspace, KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }

    #[test]
    fn typing_q_goes_into_the_composer_instead_of_quitting() {
        let mut app = session_app();
        app.handle(key(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(!app.quit);
        assert_eq!(app.shell.composer.editor.text(), "q");
    }

    #[test]
    fn a_configured_keybind_replaces_the_default_stroke() {
        let mut app = app_with(Startup::default());
        app.keys = Keymap::from_overrides(&std::collections::BTreeMap::from([(
            "command_list".to_string(),
            Some(vec!["ctrl+space".to_string()]),
        )]));
        app.handle(key(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert!(app.dialog.is_none());
        app.handle(key(KeyCode::Char(' '), KeyModifiers::CONTROL));
        assert!(app.dialog.is_some());
    }

    #[test]
    fn a_configured_leader_chord_runs_its_action() {
        let mut app = app();
        app.keys = Keymap::from_overrides(&std::collections::BTreeMap::from([(
            "theme_list".to_string(),
            Some(vec!["<leader>c".to_string()]),
        )]));
        leader(&mut app, 't');
        assert!(app.dialog.is_none());
        leader(&mut app, 'c');
        assert!(app.dialog.is_some());
    }

    #[test]
    fn shift_enter_inserts_a_newline_and_enter_submits() {
        let mut app = session_app();
        app.handle(key(KeyCode::Char('h'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('i'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::SHIFT));
        app.handle(key(KeyCode::Char('x'), KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "hi\nx");
        // Without an engine the prompt cannot be sent, so the draft is handed
        // back rather than dropped.
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "hi\nx");
    }

    #[test]
    fn release_events_are_ignored() {
        let mut app = session_app();
        let mut event = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        event.kind = KeyEventKind::Release;
        app.handle(AppEvent::Key(event));
        assert!(!app.quit);
        assert!(app.shell.composer.editor.is_empty());
    }

    #[test]
    fn a_prompt_typed_on_home_starts_a_session_with_it() {
        let mut app = app();
        // The list owns the keyboard until Tab hands it to the prompt.
        app.handle(key(KeyCode::Tab, KeyModifiers::NONE));
        for character in "hello".chars() {
            app.handle(key(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.startup.prompt.as_deref(), Some("hello"));
        // The prompt is consumed by the Session it starts, not left on the home
        // screen for the next one.
        assert!(app.shell.composer.editor.is_empty());
    }

    #[test]
    fn the_home_list_moves_with_j_and_k_and_clamps() {
        let mut app = app();
        app.handle(AppEvent::Sessions(vec![
            summary("ses_b", 30),
            summary("ses_a", 10),
        ]));
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_b"));
        app.handle(key(KeyCode::Char('j'), KeyModifiers::NONE));
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_a"));
        app.handle(key(KeyCode::Char('j'), KeyModifiers::NONE));
        assert_eq!(app.home.selected, 1);
        app.handle(key(KeyCode::Char('k'), KeyModifiers::NONE));
        assert_eq!(app.home.selected, 0);
    }

    fn approval_state() -> SessionState {
        SessionState {
            todos: Vec::new(),
            goal: None,
            active_run: None,
            pending: 0,
            approvals: vec![crate::session::ApprovalView {
                request_id: "run-1/call_1".into(),
                tool: "bash".into(),
                resource: "ls".into(),
                input: serde_json::json!({"command": "ls"}),
                input_hash: "a".repeat(64),
                policy_revision: "rev-1".into(),
                matcher: None,
                expires_at_ms: None,
            }],
            questions: Vec::new(),
            reverted: 0,
        }
    }

    #[test]
    fn a_blocking_prompt_outranks_a_running_phase() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            ..approval_state()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        app.update_status();
        // A stale "working" or a tool phase would hide the only thing the
        // operator has to act on, so the approval wins over the run phase.
        assert_eq!(
            app.shell.title.status(),
            Some("needs approval · bash · Esc interrupt")
        );
        assert!(app.shell.title.status_alert());
    }

    #[test]
    fn a_pending_question_reads_as_needing_an_answer() {
        let mut app = session_app();
        let state = SessionState {
            questions: vec![crate::session::QuestionView {
                question_id: "run-1/q1".into(),
                input_hash: "b".repeat(64),
                questions: vec![crate::session::QuestionItem {
                    question: "Ship it?".into(),
                    header: "confirm".into(),
                    options: Vec::new(),
                    multi_select: false,
                    custom: true,
                }],
            }],
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("needs an answer"));
        assert_eq!(app.shell.composer.phase.as_deref(), Some("needs an answer"));
    }

    #[test]
    fn a_pending_approval_opens_a_panel_and_blocks_typing() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: approval_state(),
        });
        assert!(app.shell.panel.is_some());
        app.handle(key(KeyCode::Char('x'), KeyModifiers::NONE));
        assert!(app.shell.composer.editor.is_empty());
    }

    #[test]
    fn the_composer_mirrors_the_queued_count_every_frame() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        assert_eq!(app.shell.composer.queued, 0);
        app.state.pending = 3;
        app.update_status();
        assert_eq!(app.shell.composer.queued, 3);
        app.state.pending = 0;
        app.update_status();
        assert_eq!(app.shell.composer.queued, 0);
    }

    #[test]
    fn the_composer_shows_the_run_phase_beside_the_input() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        assert_eq!(app.shell.composer.phase.as_deref(), Some("working"));
        app.state.active_run = None;
        app.update_status();
        assert!(
            app.shell.composer.phase.is_none(),
            "an idle Session keeps the composer title quiet"
        );
    }

    #[test]
    fn the_status_strip_names_what_blocks_the_run() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            approvals: vec![crate::session::ApprovalView {
                request_id: "req_1".into(),
                tool: "bash".into(),
                resource: "rm -rf /tmp/x".into(),
                input: serde_json::json!({}),
                input_hash: "hash".into(),
                policy_revision: "rev-1".into(),
                matcher: None,
                expires_at_ms: None,
            }],
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        app.update_status();
        let hints = app
            .shell
            .status
            .hints
            .iter()
            .map(|hint| hint.text.as_str())
            .collect::<Vec<_>>();
        // The blocking approval is the phase line itself, not a separate hint:
        // one statement, in the place the operator already reads.
        assert_eq!(
            app.shell.title.status(),
            Some("needs approval · bash · Esc interrupt")
        );
        // The approval is the phase, so the strip carries only the key fact and
        // never repeats the approval as a second line.
        assert!(
            !hints.iter().any(|hint| hint.contains("approval")),
            "{hints:?}"
        );
        assert!(hints.contains(&"esc interrupt"), "{hints:?}");
        assert!(app.shell.title.status_alert());
        app.state.approvals.clear();
        app.state.active_run = None;
        app.update_status();
        assert!(app.shell.status.hints.is_empty());
    }

    #[test]
    fn opening_a_session_follows_its_newest_turn_again() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        assert!(app.shell.following(), "a fresh Session follows");
        // Scrolling up detaches, which is how reading history works. It needs
        // rows to scroll through: an empty transcript is always at the bottom.
        let mut long = Transcript::default();
        for index in 0..40 {
            long.entries.push(crate::session::Entry::User {
                text: format!("message {index}"),
                seq: index as u64 + 1,
            });
        }
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(long),
            state: SessionState::default(),
        });
        app.shell.scroll_transcript(-3);
        assert!(!app.shell.following(), "scrolling up detaches");
        // Opening a Session must not inherit that: it shows the newest turn.
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        assert!(app.shell.following(), "opening follows again");
    }

    #[test]
    fn editor_results_never_lose_the_draft() {
        let mut app = session_app();
        app.shell.composer.restore("keep original draft");
        // An editor that died by a signal reports an error; the draft it was
        // handed must still be in the composer afterwards.
        app.handle(AppEvent::EditorFinished(Err(
            "editor was terminated by a signal".into(),
        )));
        assert_eq!(app.shell.composer.editor.text(), "keep original draft");
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("editor was terminated by a signal")
        );
        // A saved buffer replaces the draft, and clearing the notice is the
        // signal that the handoff completed.
        app.handle(AppEvent::EditorFinished(Ok(Some("rewritten".into()))));
        assert_eq!(app.shell.composer.editor.text(), "rewritten");
        assert!(app.shell.composer.notice.is_none());
    }

    #[test]
    fn esc_interrupts_an_active_run_instead_of_leaving() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state,
        });
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Session);
    }

    fn running_app(run_id: &str) -> App {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: SessionState {
                active_run: Some(run_id.into()),
                ..SessionState::default()
            },
        });
        app
    }

    fn provider_frame(kind: &str) -> AppEvent {
        AppEvent::Provider(serde_json::json!({
            "kind": kind,
            "session_id": "ses_1",
            "run_id": "run-1",
            "attempt": 1,
            "elapsed_ms": 0,
        }))
    }

    #[test]
    fn a_waiting_run_counts_the_wait_instead_of_showing_a_static_working() {
        let mut app = running_app("run-1");
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("working · Esc interrupt"));
        app.handle(provider_frame("provider.waiting"));
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("waiting for model · 0s · Esc interrupt")
        );
        // A token ends the wait; committed content carries the turn from here.
        app.handle(provider_frame("provider.delta"));
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("working · Esc interrupt"));
    }

    #[test]
    fn a_heartbeat_does_not_restart_the_elapsed_time() {
        let mut app = running_app("run-1");
        app.handle(provider_frame("provider.waiting"));
        let since = app.live.as_ref().expect("live wait").since;
        app.handle(provider_frame("provider.waiting"));
        assert_eq!(app.live.as_ref().expect("live wait").since, since);
    }

    #[test]
    fn an_announced_retry_is_visible_while_it_waits() {
        let mut app = running_app("run-1");
        app.handle(provider_frame("provider.retry"));
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("retrying attempt 2 · 0s · Esc interrupt")
        );
    }

    #[test]
    fn a_silent_engine_is_called_out_without_claiming_failure() {
        let mut app = running_app("run-1");
        let now = Instant::now();
        app.live = Some(Live {
            run_id: "run-1".into(),
            phase: LivePhase::Waiting,
            since: now - Duration::from_secs(40),
            signal: now - Duration::from_secs(20),
        });
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("waiting for model · 40s · no engine signal 20s · Esc interrupt")
        );
        assert!(app.shell.title.status_alert());
    }

    #[test]
    fn a_frame_from_another_run_does_not_refresh_the_status() {
        let mut app = running_app("run-1");
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "provider.waiting",
            "run_id": "run-0",
        })));
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("working · Esc interrupt"));
    }

    #[test]
    fn a_projection_for_another_run_drops_the_live_phase() {
        let mut app = running_app("run-1");
        app.handle(provider_frame("provider.waiting"));
        assert!(app.live.is_some());
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: SessionState {
                active_run: Some("run-2".into()),
                ..SessionState::default()
            },
        });
        assert!(app.live.is_none());
    }

    #[test]
    fn a_running_tool_is_named_in_the_status() {
        let mut app = running_app("run-1");
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "tool.planned",
            "run_id": "run-1",
            "name": "bash",
        })));
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("running bash · 0s · Esc interrupt")
        );
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "tool.completed",
            "run_id": "run-1",
        })));
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("working · Esc interrupt"));
    }

    #[test]
    fn a_running_tool_is_not_reported_as_a_silent_engine() {
        let mut app = running_app("run-1");
        let now = Instant::now();
        app.live = Some(Live {
            run_id: "run-1".into(),
            phase: LivePhase::Tool {
                name: "bash".into(),
            },
            since: now - Duration::from_secs(300),
            signal: now - Duration::from_secs(300),
        });
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("running bash · 5m 00s · Esc interrupt")
        );
        assert!(!app.shell.title.status_alert());
    }

    #[test]
    fn a_tool_name_is_one_short_line() {
        assert_eq!(tool_label("bash"), "bash");
        assert_eq!(tool_label("read_file\nsecond"), "read_file");
        assert_eq!(tool_label(&"x".repeat(40)).chars().count(), 24);
        assert_eq!(tool_label(""), "tool");
    }

    #[test]
    fn a_wait_reads_in_seconds_then_minutes() {
        assert_eq!(waited(Duration::from_secs(9)), "9s");
        assert_eq!(waited(Duration::from_secs(65)), "1m 05s");
    }

    fn delta_frame(run_id: &str, kind: &str, text: &str) -> AppEvent {
        AppEvent::Provider(serde_json::json!({
            "kind": "provider.delta",
            "session_id": "ses_1",
            "run_id": run_id,
            "data": {"kind": "delta", "delta": {"kind": kind, "text": text}},
        }))
    }

    fn drafted(app: &mut App) -> String {
        app.shell
            .draft()
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn opened(transcript: Transcript, active_run: Option<&str>) -> AppEvent {
        AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(transcript),
            state: SessionState {
                active_run: active_run.map(str::to_string),
                ..SessionState::default()
            },
        }
    }

    #[test]
    fn a_streamed_answer_appears_before_the_turn_commits() {
        let mut app = running_app("run-1");
        app.handle(delta_frame("run-1", "text.delta", "Hel"));
        app.handle(delta_frame("run-1", "text.delta", "lo"));
        let draft = app.draft.as_ref().expect("a streaming draft");
        assert_eq!(draft.text, "Hello");
        assert!(
            drafted(&mut app).contains("Hello"),
            "the transcript shows the streamed answer: {:?}",
            drafted(&mut app)
        );
    }

    #[test]
    fn reasoning_and_text_stream_into_separate_channels() {
        let mut app = running_app("run-1");
        app.handle(delta_frame("run-1", "reasoning.delta", "weighing"));
        let draft = app.draft.as_ref().expect("a streaming draft");
        assert_eq!(draft.reasoning, "weighing");
        assert!(draft.text.is_empty(), "reasoning is not the answer");
        assert_eq!(drafted(&mut app), "▸ thinking · 8 chars");
        app.handle(delta_frame("run-1", "text.delta", "the answer"));
        let shown = drafted(&mut app);
        assert!(shown.starts_with("▸ thinking · 8 chars"));
        assert!(shown.contains("the answer"));
    }

    #[test]
    fn only_the_projection_that_commits_the_answer_replaces_the_draft() {
        let mut app = running_app("run-1");
        app.handle(delta_frame("run-1", "text.delta", "Hello"));
        // A snapshot taken for an unrelated event carries no new message, so
        // the stream keeps showing rather than blinking away mid-answer.
        app.handle(opened(Transcript::default(), Some("run-1")));
        assert!(app
            .draft
            .as_ref()
            .is_some_and(|draft| draft.text == "Hello"));
        assert!(drafted(&mut app).contains("Hello"));
        let committed = Transcript::from_snapshot(&serde_json::json!({
            "messages": [{"role": "assistant", "content": [{"type": "text", "text": "Hello"}]}],
        }));
        app.handle(opened(committed, Some("run-1")));
        assert!(app.draft.is_none());
        assert!(app.shell.draft().is_empty());
    }

    #[test]
    fn a_finished_run_drops_an_uncommitted_draft() {
        let mut app = running_app("run-1");
        app.handle(delta_frame("run-1", "text.delta", "partial"));
        app.handle(opened(Transcript::default(), None));
        assert!(app.draft.is_none());
        assert!(app.shell.draft().is_empty());
    }

    fn home_with(rows: Vec<SessionSummary>) -> App {
        let mut app = app();
        // The home list is fed by `Sessions`; `Catalog` only fills the session
        // catalog and answers `--continue`.
        app.handle(AppEvent::Sessions(rows));
        app
    }

    #[test]
    fn numbered_slots_open_the_row_the_list_shows() {
        let mut app = home_with(vec![
            summary("ses_first", 300),
            summary("ses_second", 200),
            summary("ses_third", 100),
        ]);
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Char('3'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Open(id)) if id == "ses_third"
        ));
        // A slot past the end opens nothing instead of opening the last row.
        app.handle(key(KeyCode::Char('9'), KeyModifiers::NONE));
        assert!(requests.try_recv().is_err());
    }

    fn home_with_named(rows: &[(&str, &str, Option<&str>)]) -> App {
        let mut app = app();
        app.handle(AppEvent::Sessions(
            rows.iter()
                .map(|(id, title, directory)| SessionSummary {
                    id: id.to_string(),
                    title: Some(title.to_string()),
                    parent_id: None,
                    updated_at_ms: Some(100),
                    archived_at_ms: None,
                    pinned_at_ms: None,
                    directory: directory.map(str::to_string),
                    model: None,
                    credential_id: None,
                    preview: None,
                })
                .collect(),
        ));
        app
    }

    #[test]
    fn slash_starts_a_filter_and_enter_opens_the_match() {
        let mut app = home_with_named(&[
            ("ses_a", "fix the parser", Some("/work/parser")),
            ("ses_b", "write docs", Some("/work/docs")),
        ]);
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Char('/'), KeyModifiers::NONE));
        assert!(app.home.filtering());
        for c in ['d', 'o', 'c'] {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.home.query(), "doc");
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_b"));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Open(id)) if id == "ses_b"
        ));
    }

    #[test]
    fn a_filter_matches_the_directory_too_and_backspace_widens_it() {
        let mut app = home_with_named(&[
            ("ses_a", "fix the parser", Some("/work/parser")),
            ("ses_b", "write docs", Some("/work/docs")),
        ]);
        // `p` and `r` are commands outside filter mode; inside it they are
        // just letters, which is the whole reason the mode is explicit.
        app.handle(key(KeyCode::Char('/'), KeyModifiers::NONE));
        for c in ['p', 'a', 'r'] {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.home.query(), "par");
        // `par` matches only the parser Session: by title and by directory.
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_a"));
        app.handle(key(KeyCode::Backspace, KeyModifiers::NONE));
        assert_eq!(app.home.query(), "pa");
        app.handle(key(KeyCode::Backspace, KeyModifiers::NONE));
        app.handle(key(KeyCode::Backspace, KeyModifiers::NONE));
        assert_eq!(app.home.query(), "");
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_a"));
    }

    #[test]
    fn escape_leaves_filter_mode_instead_of_leaving_the_list() {
        let mut app = home_with_named(&[("ses_a", "fix the parser", None)]);
        app.handle(key(KeyCode::Char('/'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('z'), KeyModifiers::NONE));
        assert_eq!(app.home.query(), "z");
        // Nothing matches, so there is no current Session while filtering.
        assert!(app.home.current().is_none());
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.home.query(), "");
        assert!(!app.home.filtering());
        assert_eq!(app.home.current().map(|row| row.id.as_str()), Some("ses_a"));
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn commands_still_work_when_no_filter_is_open() {
        let mut app = home_with_named(&[("ses_a", "fix the parser", None)]);
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        // `p` pins rather than typing a filter character.
        app.handle(key(KeyCode::Char('p'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Pin { pinned: true, .. })
        ));
        assert_eq!(app.home.query(), "");
        assert!(!app.home.filtering());
    }

    #[test]
    fn p_toggles_the_pin_of_the_selected_row() {
        let mut app = home_with(vec![summary("ses_pin", 100)]);
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Char('p'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Pin { session_id, pinned: true }) if session_id == "ses_pin"
        ));
        // A pinned row unpins, so the key is a toggle rather than pin-only.
        let mut pinned = summary("ses_pinned", 200);
        pinned.pinned_at_ms = Some(1);
        let mut app = home_with(vec![pinned]);
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Char('p'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Pin { session_id, pinned: false }) if session_id == "ses_pinned"
        ));
    }

    #[test]
    fn help_lists_the_bindings_the_keymap_actually_uses() {
        let mut overrides = BTreeMap::new();
        overrides.insert(
            "session_rename".to_string(),
            Some(vec!["ctrl+n".to_string()]),
        );
        let mut app = app_with_overrides(&overrides);
        app.run_builtin(Builtin::Help);
        let Some(Dialog::Help(list)) = app.dialog.as_ref() else {
            panic!("help dialog");
        };
        let row_for = |name: &str| {
            list.rows
                .iter()
                .find(|row| row.label == name)
                .map(|row| row.detail.clone())
        };
        // The override is what help shows; the default would be a lie.
        assert_eq!(row_for("session_rename").as_deref(), Some("ctrl+n"));
        // A leader chord prints the real leader key, not the placeholder.
        assert_eq!(row_for("session_new").as_deref(), Some("ctrl+x+n"));
        // The hand-written summary is gone: no row claims an unknown group.
        assert!(list.rows.iter().all(|row| row.label != "keys"));
    }

    #[test]
    fn esc_leaves_shell_mode_before_it_leaves_the_session() {
        let mut app = session_app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.shell.composer.set_mode(Mode::Shell);
        app.shell.composer.editor.set_text("ls");
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Session);
        assert_eq!(app.shell.composer.mode(), Mode::Normal);
        // The typed command survives leaving the mode.
        assert_eq!(app.shell.composer.editor.text(), "ls");
        assert!(requests.try_recv().is_err(), "no interrupt was requested");
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn a_bang_command_runs_through_the_engine_instead_of_the_model() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_shell", 10)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        let session = app.session.as_ref().expect("session").id.clone();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        for c in ['!', 'e', 'c', 'h', 'o', ' ', 'h', 'i'] {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.shell.composer.mode(), Mode::Shell);
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        let mut sent = Vec::new();
        while let Ok(request) = requests.try_recv() {
            sent.push(request);
        }
        assert!(
            sent.iter().any(|request| matches!(
                request,
                engine::Request::Shell { session_id, command }
                    if session_id == &session && command == "echo hi"
            )),
            "expected one shell request for the Session"
        );
        assert!(
            !sent
                .iter()
                .any(|request| matches!(request, engine::Request::Prompt { .. })),
            "shell mode must not admit a prompt"
        );
    }

    #[test]
    fn escape_takes_back_the_newest_queued_input_before_interrupting() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            pending: 2,
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_queue", 10)),
            transcript: Box::new(Transcript::default()),
            state,
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        let sent: Vec<_> = std::iter::from_fn(|| requests.try_recv().ok()).collect();
        assert!(
            sent.iter()
                .any(|request| matches!(request, engine::Request::CancelLastInput { .. })),
            "Escape takes back the queued input first"
        );
        assert!(
            !sent
                .iter()
                .any(|request| matches!(request, engine::Request::Cancel { .. })),
            "the running turn is not interrupted while input is queued"
        );
        assert_eq!(app.screen, Screen::Session);
    }

    #[test]
    fn a_retrieved_input_returns_to_the_composer_and_keeps_the_draft() {
        let mut app = session_app();
        app.shell.composer.editor.set_text("draft in progress");
        app.handle(AppEvent::InputRetrieved {
            prompt: "queued question".into(),
            delivery: "queue".into(),
        });
        assert_eq!(app.shell.composer.editor.text(), "queued question");
        assert!(
            app.stash
                .iter()
                .any(|entry| entry.text == "draft in progress"),
            "the draft already in the composer is stashed, not dropped"
        );
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("retrieved queue input")
        );
    }

    #[test]
    fn a_promoted_input_is_never_reported_as_cancelled() {
        let mut app = session_app();
        let state = SessionState {
            active_run: Some("run-1".into()),
            pending: 0,
            ..SessionState::default()
        };
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_promoted", 10)),
            transcript: Box::new(Transcript::default()),
            state,
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(AppEvent::InputNotRetrieved {
            reason: "already promoted".into(),
        });
        // The turn is interrupted instead, and the composer stays empty: no
        // text was handed back, so nothing pretends it was.
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Cancel { .. })
        ));
        assert!(app.shell.composer.editor.is_empty());
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("already promoted")
        );
    }

    #[test]
    fn esc_returns_from_a_session_to_the_home_list() {
        let mut app = session_app();
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Home);
        assert!(app.session.is_none());
    }

    fn leader(app: &mut App, letter: char) {
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char(letter), KeyModifiers::NONE));
    }

    #[test]
    fn saved_permissions_ignore_closed_dialog_results_and_keep_paste_out_of_the_prompt() {
        let mut app = session_app();
        let (engine, mut requests) = engine::Handle::recording();
        app.attach_engine(engine);
        app.run_builtin(Builtin::Permissions);
        let engine::Request::SavedPermissions { generation: first } = requests.try_recv().unwrap()
        else {
            panic!("list");
        };
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        app.run_builtin(Builtin::Permissions);
        let engine::Request::SavedPermissions { generation: second } = requests.try_recv().unwrap()
        else {
            panic!("second list");
        };
        assert_ne!(first, second);
        app.handle(AppEvent::SavedPermissions {
            generation: first,
            result: Err("stale".into()),
        });
        let Some(Dialog::SavedPermissions(dialog)) = app.dialog.as_mut() else {
            panic!("dialog");
        };
        assert!(matches!(
            dialog.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            DialogAction::None
        ));
        app.handle(AppEvent::SavedPermissions {
            generation: second,
            result: Ok(Vec::new()),
        });
        app.handle(AppEvent::Paste("private-target".into()));
        assert!(app.shell.composer.editor.is_empty());
        let Some(Dialog::SavedPermissions(dialog)) = app.dialog.as_mut() else {
            panic!("dialog");
        };
        assert!(matches!(
            dialog.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            DialogAction::RefreshPermissions
        ));
    }

    #[test]
    fn workspace_changes_opens_with_generation_and_tracks_the_session() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_vcs", 1)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        let (engine, mut requests) = engine::Handle::recording();
        app.attach_engine(engine);
        app.run_builtin(Builtin::WorkspaceChanges);
        let engine::Request::VcsChanges {
            generation,
            session_id,
        } = requests.try_recv().unwrap()
        else {
            panic!("vcs_status request");
        };
        assert_eq!(session_id, "ses_vcs");
        app.handle(AppEvent::WorkspaceChanges {
            generation,
            result: Ok(crate::workspace_changes::VcsState {
                branch: Some("main".into()),
                detached: false,
                ahead: Some(1),
                behind: None,
                files: vec![crate::workspace_changes::Change {
                    path: "src/lib.rs".into(),
                    original_path: None,
                    kind: "modified".into(),
                }],
                truncated: false,
                file_count: Some(1),
                repository: true,
            }),
        });
        let Some(Dialog::WorkspaceChanges(dialog)) = app.dialog.as_mut() else {
            panic!("workspace changes dialog");
        };
        assert!(matches!(
            dialog.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            DialogAction::RefreshWorkspaceChanges(_)
        ));
    }

    #[test]
    fn the_leader_opens_the_theme_dialog_and_keeps_typing_out_of_the_composer() {
        let mut app = session_app();
        leader(&mut app, 't');
        assert!(matches!(app.dialog, Some(Dialog::Theme(_))));
        assert!(app.shell.composer.editor.is_empty());
        // Modal: a printable key goes nowhere, and Esc closes the dialog
        // without leaving the Session.
        app.handle(key(KeyCode::Char('z'), KeyModifiers::NONE));
        assert!(app.shell.composer.editor.is_empty());
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert_eq!(app.screen, Screen::Session);
    }

    #[test]
    fn the_leader_q_quits_and_an_unknown_chord_does_nothing() {
        let mut app = session_app();
        leader(&mut app, 'z');
        assert!(!app.quit);
        assert!(app.shell.composer.editor.is_empty());
        leader(&mut app, 'q');
        assert!(app.quit);
    }

    #[test]
    fn a_draft_belongs_to_the_session_it_was_typed_in() {
        let mut app = session_app();
        open_session(&mut app, "ses_a");
        app.shell.composer.restore("half-written in A");

        open_session(&mut app, "ses_b");
        assert!(
            app.shell.composer.editor.text().is_empty(),
            "B must not inherit A's draft: {:?}",
            app.shell.composer.editor.text()
        );
        app.shell.composer.restore("half-written in B");

        open_session(&mut app, "ses_a");
        assert_eq!(app.shell.composer.editor.text(), "half-written in A");
        open_session(&mut app, "ses_b");
        assert_eq!(app.shell.composer.editor.text(), "half-written in B");
    }

    #[test]
    fn the_session_dialog_reaches_rename_and_delete_confirmation() {
        let mut app = app();
        app.handle(AppEvent::Catalog(vec![summary("ses_a", 10)]));
        leader(&mut app, 'l');
        assert!(matches!(app.dialog, Some(Dialog::Sessions(_))));
        app.handle(key(KeyCode::Char('r'), KeyModifiers::NONE));
        assert!(matches!(app.dialog, Some(Dialog::Rename(_))));
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        leader(&mut app, 'l');
        app.handle(key(KeyCode::Char('d'), KeyModifiers::NONE));
        let Some(Dialog::Confirm(confirm)) = &app.dialog else {
            panic!("expected a delete confirmation");
        };
        assert!(!confirm.confirmed, "delete must start on cancel");
    }

    #[test]
    fn ctrl_r_renames_the_open_session_from_its_current_title() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_a", 10)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
        app.handle(key(KeyCode::Char('r'), KeyModifiers::CONTROL));
        let Some(Dialog::Rename(rename)) = &app.dialog else {
            panic!("expected the rename dialog");
        };
        assert_eq!(rename.session_id, "ses_a");
        assert_eq!(rename.input.text(), "ses_a");
    }

    fn open_session(app: &mut App, id: &str) {
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary(id, 10)),
            transcript: Box::new(Transcript::default()),
            state: SessionState::default(),
        });
    }

    #[test]
    fn the_leader_s_opens_the_status_dialog_and_usage_fills_it() {
        let mut app = session_app();
        open_session(&mut app, "ses_a");
        leader(&mut app, 's');
        assert!(matches!(app.dialog, Some(Dialog::Status(_))));
        let loading = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert!(loading
            .rows
            .iter()
            .any(|row| row.label == "usage" && row.detail == "loading…"));
        app.handle(AppEvent::Usage(UsageSummary::from_value(
            &serde_json::json!({
                "turns": 3,
                "partialTurns": 1,
                "tokens": {"input": 1200, "output": 300, "cacheRead": 900},
                "tools": {"calls": 5, "failures": 1},
                "ttftMs": {"count": 3, "avg": 812},
                "lineage": [{"protocol": "chat", "model": "glm-5", "turns": 3}],
            }),
        )));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "turns" && row.detail == "3 (1 partial)"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "ttft" && row.detail == "avg 812 ms"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "lineage" && row.detail.contains("glm-5 · chat ×3")));
    }

    #[test]
    fn ctrl_o_waits_for_the_catalog_and_picks_an_account() {
        let mut app = session_app();
        open_session(&mut app, "ses_a");
        app.handle(key(KeyCode::Char('o'), KeyModifiers::CONTROL));
        assert!(app.pending_accounts);
        app.handle(AppEvent::Accounts(vec![
            AccountInfo {
                credential_id: "cred_a".into(),
                detail: "glm-5".into(),
            },
            AccountInfo {
                credential_id: "cred_b".into(),
                detail: "gpt-5".into(),
            },
        ]));
        assert!(matches!(app.dialog, Some(Dialog::Accounts(_))));
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|s| s.credential_id.as_deref()),
            Some("cred_b")
        );
    }

    #[test]
    fn the_leader_d_shows_the_engine_settings() {
        let mut app = app();
        leader(&mut app, 'd');
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "state dir" && !row.detail.is_empty()));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "version" && row.detail == env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn the_leader_p_opens_the_stash_dialog() {
        let mut app = session_app();
        leader(&mut app, 'p');
        assert!(matches!(app.dialog, Some(Dialog::Stash(_))));
    }

    fn engine_session_app() -> App {
        let mut app = session_app();
        app.engine = Some(engine::Handle::inert());
        open_session(&mut app, "ses_a");
        app
    }

    #[test]
    fn ctrl_p_opens_the_palette_and_runs_the_chosen_action() {
        let mut app = engine_session_app();
        app.handle(key(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert!(matches!(app.dialog, Some(Dialog::Palette(_))));
        for c in "theme".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        let palette = app
            .dialog
            .as_ref()
            .and_then(Dialog::palette)
            .expect("palette");
        assert_eq!(palette.visible.len(), 1);
        assert!(
            app.shell.composer.editor.is_empty(),
            "typing filters, not the composer"
        );
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(app.dialog, Some(Dialog::Theme(_))));
    }

    #[test]
    fn an_empty_composer_recalls_the_last_prompt() {
        // A failed turn is the common reason to send a prompt again; recalling
        // it turns the recovery into keystrokes instead of a retype. The history
        // is set directly so the test covers the recall, not the submit path.
        let mut app = engine_session_app();
        app.prompt_history = vec!["first prompt".into(), "second prompt".into()];
        app.history_index = app.prompt_history.len();
        app.shell.composer.editor.clear();
        app.handle(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "second prompt");
        app.handle(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "first prompt");
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "second prompt");
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        assert!(app.shell.composer.editor.is_empty());
    }

    #[test]
    fn the_leader_chord_opens_the_workspace_changes_view() {
        // Reviewing the working tree had no direct key: it was reachable only
        // through the command list or a slash command with a completion step.
        // One leader chord now opens it.
        let mut app = engine_session_app();
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char('g'), KeyModifiers::NONE));
        assert!(
            matches!(app.dialog, Some(Dialog::WorkspaceChanges(_))),
            "the chord did not open the changes view"
        );
    }

    #[test]
    fn a_slash_builtin_runs_its_action_instead_of_prompting() {
        let mut app = engine_session_app();
        app.shell.composer.editor.set_text("/status");
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(app.dialog, Some(Dialog::Status(_))));
        assert!(app.shell.composer.editor.is_empty());
    }

    #[test]
    fn slash_help_lists_the_builtins_and_discovered_templates() {
        let mut app = engine_session_app();
        app.templates = vec![commands::Template {
            name: "review".into(),
            description: "Read a diff".into(),
            template: "Review $1".into(),
        }];
        app.shell.composer.editor.set_text("/help");
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        let list = app
            .dialog
            .as_ref()
            .and_then(Dialog::list)
            .expect("help list");
        assert_eq!(list.title, "help");
        assert!(list.rows.iter().any(|row| row.label == "/status"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "/review" && row.detail == "Read a diff"));
    }

    #[test]
    fn an_unknown_slash_command_is_reported_instead_of_sent_as_a_prompt() {
        let mut app = engine_session_app();
        app.shell.composer.editor.set_text("/nope plain text");
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        // The draft stays editable, and the notice names the typo: the text was
        // never handed to the model.
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("unknown command: /nope")
        );
        assert!(!app.shell.composer.editor.is_empty());
    }

    /// An open Session whose transcript holds two user turns, with a handle
    /// that records what the UI asks the engine to do.
    fn revert_session_app() -> (App, tokio::sync::mpsc::UnboundedReceiver<engine::Request>) {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_a", 10)),
            transcript: Box::new(Transcript {
                entries: vec![
                    Entry::User {
                        text: "first".into(),
                        seq: 3,
                    },
                    Entry::User {
                        text: "second".into(),
                        seq: 9,
                    },
                ],
                ..Transcript::default()
            }),
            state: SessionState::default(),
        });
        let (handle, requests) = engine::Handle::recording();
        app.attach_engine(handle);
        (app, requests)
    }

    #[test]
    fn the_jobs_chord_asks_the_engine_for_the_open_session() {
        // `<leader>j` lists the open Session's background jobs: the operator's
        // only way to see work the model started.
        let (mut app, mut requests) = revert_session_app();
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char('j'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Jobs { session_id }) if session_id == "ses_a"
        ));
    }

    #[test]
    fn opening_the_jobs_dialog_previews_the_selected_job() {
        // The list only names each job's state, so the row the cursor is on asks
        // for its detail as soon as the dialog has rows.
        let (mut app, mut requests) = revert_session_app();
        app.handle(AppEvent::Jobs(vec![
            ("job_1".into(), "running".into()),
            ("job_2".into(), "finished".into()),
        ]));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::JobDetail { session_id, job_id })
                if session_id == "ses_a" && job_id == "job_1"
        ));
    }

    #[test]
    fn a_job_detail_answer_lands_on_its_own_row() {
        let (mut app, _requests) = revert_session_app();
        app.handle(AppEvent::Jobs(vec![
            ("job_1".into(), "finished".into()),
            ("job_2".into(), "running".into()),
        ]));
        app.handle(AppEvent::JobDetail {
            job_id: "job_2".into(),
            detail: "running · no result yet".into(),
        });
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("jobs");
        assert_eq!(list.rows[0].detail, "");
        assert_eq!(list.rows[1].detail, "running · no result yet");
    }

    #[test]
    fn moving_between_jobs_previews_each_row_once() {
        let (mut app, mut requests) = revert_session_app();
        app.handle(AppEvent::Jobs(vec![
            ("job_1".into(), "finished".into()),
            ("job_2".into(), "running".into()),
        ]));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::JobDetail { job_id, .. }) if job_id == "job_1"
        ));
        app.handle(AppEvent::JobDetail {
            job_id: "job_1".into(),
            detail: "finished · {\"exit_code\":0}".into(),
        });
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::JobDetail { job_id, .. }) if job_id == "job_2"
        ));
        app.handle(AppEvent::JobDetail {
            job_id: "job_2".into(),
            detail: "running · no result yet".into(),
        });
        // Both rows know their detail, so walking back up asks for nothing.
        app.handle(key(KeyCode::Up, KeyModifiers::NONE));
        assert!(
            requests.try_recv().is_err(),
            "a known detail is not asked for twice"
        );
    }

    #[test]
    fn the_schedule_chord_asks_the_engine_for_the_open_session() {
        let (mut app, mut requests) = revert_session_app();
        app.handle(key(KeyCode::Char('x'), KeyModifiers::CONTROL));
        app.handle(key(KeyCode::Char('S'), KeyModifiers::SHIFT));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Schedule { session_id }) if session_id == "ses_a"
        ));
    }

    #[test]
    fn cancelling_a_scheduled_row_names_its_kind_to_the_engine() {
        let (mut app, mut requests) = revert_session_app();
        app.handle(AppEvent::Schedule(vec![(
            "cron:c1".into(),
            "cron c1 · scheduled".into(),
            "*/5 * * * * · 2 fired · 0 skipped".into(),
        )]));
        assert!(matches!(app.dialog, Some(Dialog::Schedule(_))));
        app.handle(key(KeyCode::Char('x'), KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::CancelSchedule { session_id, kind, id })
                if session_id == "ses_a" && kind == "cron" && id == "c1"
        ));
    }

    #[test]
    fn undo_previews_the_newest_user_turn() {
        let (mut app, mut requests) = revert_session_app();
        app.run_builtin(Builtin::Undo);
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::RevertPreview {
                boundary_seq: 9,
                ..
            })
        ));
        assert!(app.dialog.is_none(), "the preview opens the dialog");
    }

    #[test]
    fn undo_waits_for_the_running_turn_to_stop() {
        let (mut app, mut requests) = revert_session_app();
        app.state.active_run = Some("run-1".into());
        app.run_builtin(Builtin::Undo);
        assert!(requests.try_recv().is_err());
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("stop the running turn before reverting")
        );
    }

    #[test]
    fn the_timeline_lists_turns_newest_first_and_previews_the_chosen_one() {
        let (mut app, mut requests) = revert_session_app();
        app.run_builtin(Builtin::Timeline);
        let Some(Dialog::Timeline(list)) = &app.dialog else {
            panic!("expected a timeline dialog");
        };
        assert_eq!(list.rows[0].detail, "#9");
        assert_eq!(list.rows[1].detail, "#3");
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::RevertPreview {
                boundary_seq: 3,
                ..
            })
        ));
    }

    #[test]
    fn a_revert_confirm_names_the_outside_edits_it_overwrites() {
        let (mut app, mut requests) = revert_session_app();
        app.handle(AppEvent::RevertPreview {
            session_id: "ses_a".into(),
            boundary_seq: 9,
            plan: RevertPlan::from_value(&serde_json::json!({
                "available": true,
                "restore": ["a.txt"],
                "remove": [],
                "conflicts": [{ "path": "a.txt", "action": "restore", "disk": "modified" }]
            })),
        });
        let Some(Dialog::Confirm(confirm)) = &app.dialog else {
            panic!("expected a confirm dialog");
        };
        assert_eq!(confirm.action_label(), "revert");
        assert!(
            confirm.message.contains("a.txt (modified)"),
            "{}",
            confirm.message
        );
        app.handle(key(KeyCode::Char('y'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Revert {
                boundary_seq: 9,
                files: true,
                ..
            })
        ));
    }

    #[test]
    fn a_revert_without_a_file_record_leaves_the_workspace_alone() {
        let (mut app, mut requests) = revert_session_app();
        app.handle(AppEvent::RevertPreview {
            session_id: "ses_a".into(),
            boundary_seq: 9,
            plan: RevertPlan::from_value(&serde_json::json!({
                "available": false,
                "reason": "no-file-snapshot"
            })),
        });
        app.handle(key(KeyCode::Char('y'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Revert { files: false, .. })
        ));
    }

    #[test]
    fn a_preview_for_a_session_that_is_no_longer_open_is_dropped() {
        let (mut app, _requests) = revert_session_app();
        app.handle(AppEvent::RevertPreview {
            session_id: "ses_other".into(),
            boundary_seq: 9,
            plan: RevertPlan::default(),
        });
        assert!(app.dialog.is_none());
    }

    #[test]
    fn redo_only_asks_the_engine_when_something_is_hidden() {
        let (mut app, mut requests) = revert_session_app();
        app.run_builtin(Builtin::Redo);
        assert!(requests.try_recv().is_err());
        assert_eq!(
            app.shell.composer.notice.as_deref(),
            Some("nothing to redo")
        );

        app.state.reverted = 2;
        app.run_builtin(Builtin::Redo);
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Redo { session_id }) if session_id == "ses_a"
        ));
    }
}

/// The composer notice for a first-word command neither built in nor
/// discovered. The draft stays in the composer so the typo can be fixed.
fn unknown_command_notice(name: &str) -> String {
    format!("unknown command: /{name}")
}

/// One device-panel row: what the operator sees plus the identity an approve or
/// revoke must echo.
#[derive(Clone)]
struct DeviceRow {
    name: String,
    detail: String,
    id: String,
    version: i64,
    pairing_key: String,
    kind: String,
}

#[derive(Clone, Copy)]
enum DeviceAction {
    Approve,
    Reject,
    Revoke,
}

/// Rows without a name are dropped rather than drawn as broken lines.
fn parse_devices(rows: &serde_json::Value) -> Vec<DeviceRow> {
    rows.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|row| {
                    Some(DeviceRow {
                        name: row.get("name")?.as_str()?.to_string(),
                        detail: row
                            .get("detail")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        id: row
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        version: row
                            .get("version")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0),
                        pairing_key: row
                            .get("pairingKey")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: row
                            .get("kind")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("grant")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod command_notice_tests {
    use super::unknown_command_notice;

    #[test]
    fn an_unknown_command_is_named_in_the_notice() {
        assert_eq!(unknown_command_notice("nope"), "unknown command: /nope");
    }
}

/// Parse the host's MCP export. A missing or malformed value means "no servers
/// to show", never a startup failure: the TUI is a read-only client here.
fn parse_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    Some((
                        server.get("name")?.as_str()?.to_string(),
                        server
                            .get("detail")?
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod host_panel_tests {
    use super::parse_pairs;

    #[test]
    fn the_host_export_is_read_as_name_and_transport() {
        let parsed = parse_pairs(Some(
            r#"[{"name":"everything","detail":"npx -y server-everything"},{"name":"remote","detail":"https://example.com/mcp"}]"#,
        ));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "everything");
        assert_eq!(parsed[1].1, "https://example.com/mcp");
    }

    #[test]
    fn a_missing_or_malformed_export_is_empty() {
        assert!(parse_pairs(None).is_empty());
        assert!(parse_pairs(Some("not json")).is_empty());
        assert!(parse_pairs(Some("{}")).is_empty());
    }
}
