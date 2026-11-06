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
    AccountInfo, Action as DialogAction, ConfirmKind, Dialog, ModelInfo, ProviderEntry, Row,
    TextDialog,
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
use crate::status::{compact_tokens, UsageSummary};
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

/// How long a transient notice stays on screen. Long enough to read a
/// sentence, short enough that it does not outlive its own event.
const NOTICE_LIFETIME: Duration = Duration::from_secs(5);

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

    /// The state half of the TS compact activity row: what the run is doing,
    /// capitalized the way the TS row spells it. The elapsed time is not part
    /// of it — the TS row right-aligns that value — and neither is the escape
    /// hint, which lives in the status strip.
    fn state(&self, now: Instant) -> String {
        let elapsed = now.duration_since(self.since);
        match &self.phase {
            LivePhase::Waiting if self.silent(now) => format!(
                "Waiting for model · no engine signal {}",
                crate::pane::duration_ms(now.duration_since(self.signal).as_millis() as u64)
            ),
            // A reasoning model can legitimately think for minutes before the
            // first token; past half a minute of waiting, say so instead of
            // leaving the operator to read the silence as a stall.
            LivePhase::Waiting if elapsed >= Duration::from_secs(30) => {
                "Waiting for model · the model may reason before the first token".to_string()
            }
            LivePhase::Waiting => "Waiting for model".to_string(),
            LivePhase::Retrying { attempt } => format!("Retrying · attempt {attempt}"),
            LivePhase::Tool { name } => format!("Running {}", tool_label(name)),
        }
    }

    /// The wait has gone long enough that the TS row turns its spinner
    /// warning-colored.
    fn alert(&self, now: Instant) -> bool {
        matches!(self.phase, LivePhase::Waiting)
            && now.duration_since(self.since) >= Duration::from_secs(30)
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
    /// The turn's parts in the order the engine produced them. A provider turn
    /// is prose, a call, more prose, another call — interleaved, not grouped —
    /// so keeping text and calls in separate fields painted every call after
    /// every paragraph. Both Claude Code and codex show the transcript in the
    /// order the work happened; this is the same order the committed message
    /// carries, which is why the draft has to match it or the screen rearranges
    /// itself the moment the turn commits.
    parts: Vec<DraftPart>,
}

/// One piece of the streaming answer, in arrival order.
#[derive(Debug)]
enum DraftPart {
    Reasoning(String),
    Text(String),
    Call(DraftCall),
}

/// One tool call opening during the stream.
#[derive(Debug, Default)]
struct DraftCall {
    name: String,
    /// The `arguments` fragments as they arrived. They are a JSON string split
    /// at arbitrary byte boundaries, so the caller re-reads the field it wants
    /// from the joined text rather than parsing a fragment.
    arguments: String,
}

impl Draft {
    fn append(&mut self, delta: &Value) {
        let text = delta
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match delta.get("kind").and_then(Value::as_str) {
            Some("text.delta") => match self.parts.last_mut() {
                Some(DraftPart::Text(open)) => open.push_str(text),
                _ => self.parts.push(DraftPart::Text(text.to_string())),
            },
            Some("reasoning.delta") => match self.parts.last_mut() {
                Some(DraftPart::Reasoning(open)) => open.push_str(text),
                _ => self.parts.push(DraftPart::Reasoning(text.to_string())),
            },
            Some("tool.start") => self.parts.push(DraftPart::Call(DraftCall {
                name: delta
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: String::new(),
            })),
            Some("tool.input.delta") => {
                // The arguments belong to the call the engine just opened, so
                // they attach to the newest call rather than to whatever part
                // happens to be last.
                let fragment = delta
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(DraftPart::Call(call)) = self
                    .parts
                    .iter_mut()
                    .rev()
                    .find(|part| matches!(part, DraftPart::Call(_)))
                {
                    call.arguments.push_str(fragment);
                }
            }
            _ => {}
        }
    }

    /// The reasoning this draft has, joined, for the status/thinking header.
    #[cfg(test)]
    fn reasoning(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                DraftPart::Reasoning(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Whether any text has arrived, so the commit check can tell an answer
    /// from a reasoning-only step.
    /// The visible answer text, joined, for tests and the commit check.
    #[cfg(test)]
    fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                DraftPart::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// A tool name is engine-supplied and the status is one line, so keep the first
/// word of the first line and cap it.
fn tool_label(name: &str) -> String {
    let line = name.lines().next().unwrap_or_default().trim();
    let label = line.split_whitespace().next().unwrap_or("tool");
    // MCP tools are spelled `mcp__<server>__<tool>`; truncating that leaves
    // `mcp__github__create_issu`, which names neither the server cleanly nor
    // the work. `server/tool` survives the clip and still identifies the call.
    let label = match label
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
    {
        Some((server, tool)) => format!("{server}/{tool}"),
        None => label.to_string(),
    };
    label.chars().take(24).collect()
}

/// Whole seconds under a minute, then minutes and seconds. A count reads as
/// The wait spelled the way the TS Locale spells it (`2.0s`, `1m 5s`).
#[cfg(test)]
fn waited(duration: Duration) -> String {
    crate::pane::duration_ms(duration.as_millis() as u64)
}

/// What the process should open once the engine is attached. The launch flags
/// are intents rather than commands: each one is consumed at the point the
/// engine answers, so a failed `--session` never swallows a later `--prompt`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Startup {
    pub session: Option<String>,
    pub continue_last: bool,
    pub prompt: Option<String>,
    /// Media that rode the landing prompt: the composer shows `[Image N]`
    /// markers in the text, and the bytes they stand for travel beside it into
    /// the Session the landing screen starts.
    pub attachments: Vec<Value>,
    /// `--fork`: the resolved Session (named, or the newest for `--continue`)
    /// is copied into a fresh Session before it opens, so the resumed work
    /// never appends onto the original.
    pub fork: bool,
    /// `--auto`: asks the policy raises settle through the engine's
    /// classifier instead of a host approval. The operator needs to see this —
    /// a Session that stops asking is a policy change, not a quiet default.
    pub auto: bool,
}

pub struct App {
    pub shell: Shell,
    pub home: Home,
    pub screen: Screen,
    pub engine: Option<engine::Handle>,
    pub session: Option<SessionSummary>,
    pub state: SessionState,
    pub quit: bool,
    /// The prompt owns the keyboard on the landing screen, the way every other
    /// agent CLI behaves: the first thing typed is the first prompt. `Tab`
    /// moves focus to the home list (filter, numbered slots, pin) and back.
    /// Sessions this client has already named, so a snapshot arriving before the
    /// rename lands does not name them again.
    named_sessions: std::collections::HashSet<String>,
    dialog: Option<Dialog>,
    permission_generation: u64,
    workspace_changes_generation: u64,
    /// A provider key was stored while a turn was running: the engine restarts
    /// to serve its models as soon as that turn ends, because a restart cancels
    /// whatever the engine is running.
    pending_routes_reload: bool,
    /// `Ctrl+X` was pressed; the next key completes the chord.
    leader: bool,
    /// When the leader was armed, so a stale one expires instead of eating a
    /// keystroke minutes later.
    leader_since: Option<Instant>,
    /// The row and moment of the last click on the landing list, so a
    /// second click on the same row is a double click rather than two
    /// selections.
    /// When a transient notice stops being true. A notice reports something
    /// that already happened ("copied 120 characters"); leaving it on screen
    /// until the next event turns it into permanent clutter.
    notice_until: Option<Instant>,
    /// How long an armed leader waits for its chord key.
    leader_timeout: Duration,
    keys: Keymap,
    workspace: PathBuf,
    /// What the engine was started with, shown by the debug dialog.
    settings: Option<engine::Settings>,
    models: Vec<ModelInfo>,
    accounts: Vec<AccountInfo>,
    usage: Option<UsageSummary>,
    /// The trailing 24 hours the sidebar paints, workspace-wide.
    usage_hourly: Option<crate::status::HourlyUsage>,
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
    /// Every provider the engine's catalog names, ready ones first.
    providers: Vec<ProviderEntry>,
    /// Skills the host discovered (name, description).
    skills: Vec<(String, String)>,
    /// Remote-control devices the engine serves, with the identity an approve
    /// or revoke call echoes.
    devices: Vec<DeviceRow>,
    /// Workspaces the engine serves (name, branch or type, directory).
    workspaces: Vec<(String, String, String)>,
    /// The model dialog waits for the catalog when nothing is cached yet.
    pending_models: bool,
    /// The provider the model picker is narrowed to; `None` lists everything.
    models_filter: Option<String>,
    /// The provider the account list is narrowed to; `None` lists every
    /// credential, the flat list ctrl+o showed before it had a provider level.
    accounts_filter: Option<String>,
    /// Elapsed time captured the moment the provider stream ended. Claude
    /// Code and Codex tie the spinner to the local stream lifecycle, so the
    /// clock stops the instant the answer finishes instead of counting until
    /// a durable projection (which can stall) retires the run.
    stream_ended: Option<Duration>,
    /// Providers the snapshot knows but this engine does not serve yet, as
    /// (id, display name). Fed to the model picker's needs-auth tail.
    /// Providers with no stored credential: the picker says "needs a key".
    providers_needing_auth: Vec<(String, String)>,
    /// Providers holding a credential the manifest serves with no route: the
    /// picker has to say that instead, or the operator stores a key that
    /// changes nothing.
    providers_without_route: Vec<(String, String)>,
    /// Routes the operator starred, most recently starred first.
    favorites: Vec<String>,
    /// Where the pointer last moved, so a hovered sidebar row can show the
    /// text its cell clipped. Nothing is in flight while it sits still.
    mouse_pos: Option<(u16, u16)>,
    /// Where a key typed into the sign-in prompt is stored. The engine falls
    /// back to the same file on a single-binary start, so a key stored here is
    /// the one a restarted engine reads.
    credential_store: Option<std::path::PathBuf>,
    /// The model last chosen in this install. The home screen has no Session
    /// pin and no assistant message to read an answer from, and the engine's
    /// settings hold the `unavailable/model` sentinel, so without this the
    /// status strip under the landing prompt named nothing.
    remembered_model: Option<String>,
    /// Same for the account dialog.
    pending_accounts: bool,
    /// Same for the provider list: it opens when the catalog answers.
    pending_providers: bool,
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
    /// When the current run was first seen active, and which run it was.
    ///
    /// A run can be active before any `provider.*` frame arrives — the engine
    /// admits the input, the snapshot reports the run, and the first frame is
    /// still in flight. Without this the status fell back to a bare "Working"
    /// with no clock and no colour, so a run that was demonstrably moving
    /// looked exactly like one that had wedged.
    run_since: Option<(String, Instant)>,
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
        // The folded-output hint names the operator's own chord, so a remap or
        // an unbound action cannot leave the transcript promising a dead key.
        shell.set_toggle_chord(keys.chord(keybinds::Action::ToolOutputToggle));
        Self {
            shell,
            home,
            screen: Screen::Home,
            engine: None,
            session: None,
            state: SessionState::default(),
            quit: false,
            // The list owns the keyboard first: the landing screen opens to
            // pick a Session, so the arrows move the selection instead of
            // walking the prompt's history. Tab hands the keys to the prompt.
            named_sessions: std::collections::HashSet::new(),
            dialog: None,
            permission_generation: 0,
            workspace_changes_generation: 0,
            pending_routes_reload: false,
            leader: false,
            leader_since: None,
            notice_until: None,
            leader_timeout: Duration::from_millis(2000),
            keys,
            workspace,
            settings: None,
            models: Vec::new(),
            mcp: parse_pairs(std::env::var("MIAO_TUI_MCP_JSON").ok().as_deref()),
            providers: seed_providers(std::env::var("MIAO_TUI_PROVIDERS_JSON").ok().as_deref()),
            skills: parse_pairs(std::env::var("MIAO_TUI_SKILLS_JSON").ok().as_deref()),
            workspaces: Vec::new(),
            devices: Vec::new(),
            accounts: Vec::new(),
            usage: None,
            usage_hourly: None,
            stash: Vec::new(),
            prompt_history: Vec::new(),
            drafts: HashMap::new(),
            history_index: 0,
            catalog: Vec::new(),
            pending_models: false,
            models_filter: None,
            accounts_filter: None,
            stream_ended: None,
            providers_needing_auth: Vec::new(),
            providers_without_route: Vec::new(),
            favorites: crate::state::favorites(),
            mouse_pos: None,
            credential_store: miao_engine::credential::default_database(),
            remembered_model: crate::state::preferences().model,
            pending_accounts: false,
            pending_providers: false,
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
            run_since: None,
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
            if self.startup.fork {
                engine.fork_session(&session);
            } else {
                engine.open(&session);
            }
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

    /// `prompt.max_width` from `tui.json`: the landing prompt's width cap.
    /// The Session's prompt fills its column, like the TS session route, so
    /// only the Home pane reads this.
    pub fn configure_prompt_width(&mut self, width: crate::config::PromptWidth) {
        self.home.set_prompt_width(width);
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
        self.expire_notice();
        // A leader that is still waiting paints its menu, so the chords are
        // discoverable instead of memorised. Both screens carry it: the landing
        // footer and the Session's status row.
        let leader_hint = self.armed_leader_hint();
        self.shell.set_leader_hint(leader_hint);
        match self.screen {
            Screen::Home => {
                // The launcher fills the window above the status strip: the
                // strip keeps naming the model and the run state here, the
                // same way it does on a Session screen.
                let [home_area, status_area] = ratatui::layout::Layout::vertical([
                    ratatui::layout::Constraint::Min(1),
                    ratatui::layout::Constraint::Length(1),
                ])
                .areas(frame.area());
                self.home.render(frame, home_area, &mut self.shell.composer);
                crate::pane::render_status(
                    frame,
                    status_area,
                    &self.shell.status,
                    &self.shell.theme().clone(),
                );
            }
            Screen::Session => {
                self.shell.render(frame);
                if let (Some(at), Some(sidebar)) = (self.mouse_pos, self.shell.sidebar.as_ref()) {
                    if let Some((_, text)) = sidebar.hover_rows.iter().find(|(row, _)| *row == at.1)
                    {
                        crate::pane::render_hover_tip(frame, at, text, &self.shell.theme().clone());
                    }
                }
            }
        }
        if let Some(dialog) = self.dialog.as_ref() {
            render_dialog(frame, frame.area(), dialog, self.shell.theme());
        }
    }

    /// The armed leader's menu, while it still waits for its chord.
    fn armed_leader_hint(&self) -> Option<String> {
        let since = self.leader_since?;
        (self.leader && since.elapsed() <= self.leader_timeout).then(|| self.keys.leader_hint())
    }

    pub fn handle(&mut self, event: AppEvent) {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Paste(text) => {
                // A dialog that owns a text field takes the paste. Keystrokes
                // are already modal, but a paste carries its own event: the
                // provider prompt opened, the key was pasted, and it landed in
                // the composer underneath instead of the prompt.
                if self
                    .dialog
                    .as_mut()
                    .is_some_and(|dialog| dialog.paste(&text))
                {
                    return;
                }
                // The landing screen paints the same composer, so a paste that
                // arrives before any Session exists still belongs in the draft
                // the operator can submit from there.
                // Windows Terminal can surface an image-only clipboard as an
                // empty bracketed paste; reading the clipboard is the only way
                // to find out what it held.
                if text.is_empty() {
                    self.read_clipboard();
                } else {
                    self.shell.composer.paste(&text);
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
                    Some(clipboard::Content::Text(text)) => {
                        // The clipboard is the second half of an empty paste,
                        // so it has to reach the same place that paste would
                        // have: a dialog's own field while one is open.
                        let taken = self
                            .dialog
                            .as_mut()
                            .is_some_and(|dialog| dialog.paste(&text));
                        if !taken {
                            self.shell.composer.paste(&text);
                        }
                    }
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
                self.sync_open_session(&rows);
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
                        self.open_models_dialog();
                    }
                }
            }
            AppEvent::ProviderCatalog(catalog) => {
                // The same answer feeds the picker's `needs auth` tail and the
                // provider list, so one request serves both.
                self.providers = ProviderEntry::catalog(&catalog);
                let unserved = self
                    .providers
                    .iter()
                    .filter(|provider| !provider.configured)
                    .map(|provider| {
                        (
                            provider.id.clone(),
                            provider.name.clone(),
                            provider.accounts > 0,
                        )
                    });
                self.providers_needing_auth = unserved
                    .clone()
                    .filter(|entry| !entry.2)
                    .map(|(id, name, _)| (id, name))
                    .collect();
                self.providers_without_route = unserved
                    .filter(|entry| entry.2)
                    .map(|(id, name, _)| (id, name))
                    .collect();
                if self.pending_providers {
                    self.pending_providers = false;
                    if self.dialog.is_none() {
                        self.open_dialog(Dialog::providers(&self.providers));
                    }
                }
                // An already-open list catches up to the answer instead of
                // keeping the host's seed rows on screen.
                if matches!(self.dialog, Some(Dialog::Providers(_))) {
                    self.open_dialog(Dialog::providers(&self.providers));
                }
                // The picker carries the needs-auth tail, and it is built before
                // this answer arrives: without this, the first /models of a
                // session listed only the served models and the row that adds a
                // provider appeared only after closing and reopening it.
                if matches!(self.dialog, Some(Dialog::Models(_))) {
                    self.reopen_models_dialog();
                }
            }
            AppEvent::Accounts(accounts) => {
                self.accounts = accounts;
                if self.pending_accounts {
                    self.pending_accounts = false;
                    if self.dialog.is_none() {
                        if self.accounts.is_empty() {
                            self.open_providers();
                        } else {
                            self.open_provider_accounts();
                        }
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
                // Usage arrives on every settled step, which is also when the
                // hourly strip can have grown: refresh it from the same signal
                // instead of polling a clock of its own.
                if let Some(engine) = self.engine.as_ref() {
                    engine.usage_hourly(24);
                }
                if matches!(self.dialog, Some(Dialog::Status(_))) {
                    let rows = self.status_rows();
                    self.open_dialog(Dialog::status(rows));
                }
            }
            AppEvent::UsageHourly(hourly) => {
                self.usage_hourly = Some(hourly);
                self.shell.set_usage_hourly(self.usage_hourly.as_ref());
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
                mut transcript,
                state,
            } => {
                self.swap_draft(summary.as_ref().map(|session| session.id.as_str()));
                self.shell.set_goal(state.goal.as_ref());
                self.shell.set_todos(&state.todos);
                // The TS prompt re-rolls its placeholder example when a
                // different Session opens; the same Session refreshing must
                // not change it.
                if self.session.as_ref().map(|session| session.id.as_str())
                    != summary.as_ref().map(|session| session.id.as_str())
                {
                    self.shell.composer.reroll_placeholder();
                }
                self.session = summary;
                if let Some(summary) = &self.session {
                    match self.catalog.iter_mut().find(|row| row.id == summary.id) {
                        Some(row) => *row = summary.clone(),
                        None => self.catalog.push(summary.clone()),
                    }
                }
                self.state = *state;
                self.stream_ended = None;
                // A run that is already over settles the calls it left
                // unanswered, so a finished transcript stops showing rows that
                // only look like they are still running.
                if self.state.active_run.is_none() {
                    transcript.settle_unreturned();
                }
                // What this Session changed, counted once per file: the sidebar
                // answers "what did it touch" without opening a diff.
                let mut touched: std::collections::HashSet<&str> = std::collections::HashSet::new();
                let mut added = 0u64;
                let mut removed = 0u64;
                for file in transcript.displays.values().flatten() {
                    touched.insert(file.path.as_str());
                    added += file.additions;
                    removed += file.deletions;
                }
                self.shell.set_changes((!touched.is_empty()).then_some((
                    touched.len(),
                    added,
                    removed,
                )));
                self.shell
                    .set_mode(self.startup.auto.then_some("auto-approve"));
                // A stored provider key waits for the Session to stop running:
                // the restart that serves its models also cancels an in-flight
                // turn, and that turn is worth more than a few seconds saved.
                if self.pending_routes_reload && self.state.active_run.is_none() {
                    self.pending_routes_reload = false;
                    if let Some(engine) = self.engine.as_ref() {
                        engine.reload_provider_routes();
                    }
                }
                // A Session that already holds prompts may still be unnamed —
                // resuming one must not leave the sidebar reading "New session".
                if let Some((id, first)) = self
                    .session
                    .as_ref()
                    .map(|session| session.id.clone())
                    .zip(transcript.entries.iter().find_map(|entry| match entry {
                        Entry::User { text, .. } if !text.trim().is_empty() => Some(text.clone()),
                        _ => None,
                    }))
                {
                    self.name_session_from_prompt(&id, &first);
                }
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
                    self.shell.set_draft(&[]);
                    self.shell.set_running_tool(None);
                }
                self.committed = committed;
                self.shell.set_session(self.session.as_ref());
                self.shell.set_usage(self.usage.as_ref());
                self.shell.set_transcript(&transcript);
                self.shell.set_pending_prompts(&self.state.pending_prompts);
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
                        // The box is sized from the change set, so the layout taken while the
                        // reply was in flight is the wrong height for it. Without a redraw the
                        // header lands in that smaller rect and the rows below it never paint (#2240).
                        self.redraw_requested = true;
                    }
                }
            }
            AppEvent::WorkspaceDiff {
                generation,
                path,
                result,
            } => {
                if let Some(Dialog::WorkspaceChanges(dialog)) = self.dialog.as_mut() {
                    if dialog.generation == generation {
                        dialog.diff_loaded(&path, result);
                        self.redraw_requested = true;
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
        // Both screens paint the same composer, so the clipboard keystroke
        // belongs to it on either one: the landing screen used to ignore it.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('v') {
            self.read_clipboard();
            return;
        }
        match self.screen {
            Screen::Home => self.handle_home_key(key),
            Screen::Session => self.handle_session_key(key),
        }
    }

    /// The wheel moves through the open dialog, the Session list, or the
    /// transcript. Apart from naming a landing row, buttons stay out of the
    /// way: text selection belongs to the terminal.
    ///
    fn handle_mouse(&mut self, mouse: MouseEvent) {
        // Hover only paints a tip; the row under the pointer is resolved at
        // render time from the sidebar's own row map, so moving off it clears
        // the tip without any state to reset.
        if let MouseEventKind::Moved = mouse.kind {
            self.mouse_pos = Some((mouse.column, mouse.row));
            return;
        }
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
        // A stray wheel event must not leave the leader armed.
        self.leader = false;
        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return,
        };
        match self.screen {
            Screen::Session => {
                // One notch moves `scroll_speed` rows, or more when the notches
                // arrive in a burst and acceleration is enabled.
                let rows = self.scroll.rows(Instant::now(), delta as i8) as i32;
                self.shell.scroll_transcript(delta * rows);
            }
            // The launcher has no scrollable surface.
            Screen::Home => {}
        }
    }

    fn handle_dialog_key(&mut self, key: KeyEvent) {
        // ctrl+f stars the row under the cursor, the chord the product's
        // picker binds: the starred models come back at the top of the list.
        if key.kind == KeyEventKind::Press
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('f')
        {
            if let Some(Dialog::Models(list)) = self.dialog.as_ref() {
                let position = list
                    .visible
                    .get(list.selected)
                    .and_then(|row| list.rows.get(*row))
                    .and_then(|row| row.id.parse::<usize>().ok());
                if let Some(position) = position {
                    if let Some(route) = self.models.get(position).map(ModelInfo::route) {
                        let starred = self.favorites.iter().any(|favorite| favorite == &route);
                        self.favorites.retain(|favorite| favorite != &route);
                        if !starred {
                            self.favorites.insert(0, route);
                        }
                        crate::state::save_favorites(&self.favorites);
                        self.reopen_models_dialog();
                        return;
                    }
                }
            }
        }
        // ctrl+o narrows the model picker to one provider and backs out of the
        // provider list; Esc on that list returns to the models too.
        if key.kind == KeyEventKind::Press
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('o')
        {
            match self.dialog.as_ref() {
                Some(Dialog::Models(_)) => {
                    self.open_model_provider_filter();
                    return;
                }
                Some(Dialog::ModelProviders(_)) => {
                    self.reopen_models_dialog();
                    return;
                }
                _ => {}
            }
        }
        if let Some(Dialog::Accounts(_)) = self.dialog.as_ref() {
            // The account list is one level below the provider list, so Esc
            // steps back there instead of closing both.
            if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                self.open_provider_accounts();
                return;
            }
        }
        if let Some(Dialog::ModelProviders(_)) = self.dialog.as_ref() {
            if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                self.reopen_models_dialog();
                return;
            }
        }
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
        self.open_models_dialog();
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
                detail: builtin
                    .action()
                    .and_then(|action| self.keys.chord(action))
                    .unwrap_or_default(),
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
                detail: match builtin.action().and_then(|action| self.keys.chord(action)) {
                    Some(chord) => format!("{} · {chord}", builtin.label()),
                    None => builtin.label().to_string(),
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

    /// Rebuild the open Session dialog around a refreshed catalog.
    ///
    /// The rows are replaced, but what the operator typed is not: a catalog
    /// refresh mid-search — a rename landing, a title model answering, a pin —
    /// would otherwise wipe the query and jump the list back to the full
    /// history under the cursor the operator was reading.
    fn reopen_sessions_dialog(&mut self) {
        let Some(Dialog::Sessions(previous)) = self.dialog.take() else {
            self.dialog = Some(Dialog::sessions(&self.catalog));
            return;
        };
        let selected = previous
            .rows
            .get(previous.selected)
            .map(|row| row.id.clone());
        let mut dialog = Dialog::sessions(&self.catalog);
        if let Some(list) = dialog.list_mut() {
            list.restore_search(previous.filter.text(), previous.search);
            // `restore_search` refilters, so a hit is looked up in the rows and
            // then mapped to its place in the filtered view.
            if let Some(row) = selected.and_then(|id| list.rows.iter().position(|row| row.id == id))
            {
                if let Some(index) = list.visible.iter().position(|visible| *visible == row) {
                    list.selected = index;
                }
            }
        }
        self.dialog = Some(dialog);
    }

    /// The ctrl+o provider list over the current catalog.
    fn open_model_provider_filter(&mut self) {
        let providers = ModelInfo::providers(&self.models);
        self.open_dialog(Dialog::model_provider_filter(&providers));
    }

    /// Back to the model picker, narrowed to the remembered provider.
    fn reopen_models_dialog(&mut self) {
        self.open_models_dialog();
    }

    /// The model picker over the current catalog, narrowed to the remembered
    /// provider and carrying the needs-auth tail from the last catalog.
    fn open_models_dialog(&mut self) {
        let current = self
            .session
            .as_ref()
            .and_then(|summary| summary.model.as_deref());
        // One tail list, flagged by whether a key is already stored: the two
        // lines of advice it can print are different, so the picker needs to
        // tell them apart rather than send everyone to `auth login`.
        let unserved: Vec<(String, String, bool)> = self
            .providers_needing_auth
            .iter()
            .map(|(id, name)| (id.clone(), name.clone(), false))
            .chain(
                self.providers_without_route
                    .iter()
                    .map(|(id, name)| (id.clone(), name.clone(), true)),
            )
            .collect();
        let recents = self.recent_models();
        let favorites = self.favorites.clone();
        self.open_dialog(Dialog::models_with_needs_auth(
            &self.models,
            current,
            self.models_filter.as_deref(),
            &unserved,
            &recents,
            &favorites,
        ));
    }

    /// Models this install used most recently, newest Session first. The
    /// product's picker leads with its recents for the same reason: the answer
    /// an operator wants is usually one they already gave.
    fn recent_models(&self) -> Vec<String> {
        let mut recents: Vec<String> = Vec::new();
        for model in self.remembered_model.iter().chain(
            self.catalog
                .iter()
                .filter_map(|session| session.model.as_ref()),
        ) {
            // A Session pin may carry a route id (`provider/model@account`).
            let name = model
                .rsplit_once('/')
                .map(|(_, name)| name)
                .unwrap_or(model)
                .split('@')
                .next()
                .unwrap_or(model);
            if !recents.iter().any(|known| known == name) {
                recents.push(name.to_string());
            }
        }
        recents
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
            DialogAction::OpenWorkspaceDiff(path) => {
                if let Some(Dialog::WorkspaceChanges(dialog)) = self.dialog.as_mut() {
                    let session_id = dialog.session_id.clone();
                    let generation = dialog.generation;
                    dialog.open_diff(path.clone());
                    match self.engine.as_ref() {
                        Some(engine) => engine.vcs_diff(generation, &session_id, &path),
                        None => dialog.diff_loaded(&path, Err("Engine is not connected".into())),
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
            DialogAction::Submit(key) if matches!(self.dialog, Some(Dialog::SignIn(_))) => {
                let Some(Dialog::SignIn(sign_in)) = self.dialog.take() else {
                    return;
                };
                self.store_provider_key(&sign_in.provider, &key);
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
            Some(Dialog::ModelProviders(list)) => {
                // Row "all" restores the unfiltered picker; any other row names
                // the provider to narrow to.
                let provider = list.rows.get(index).map(|row| row.id.clone());
                self.models_filter = match provider.as_deref() {
                    Some("all") | None => None,
                    Some(named) => Some(named.to_string()),
                };
                self.reopen_models_dialog();
            }
            Some(Dialog::Models(list)) => {
                // A needs-auth row names a provider this engine does not serve
                // yet; selecting it surfaces the way in instead of failing the
                // parse silently.
                if let Some(row) = list.rows.get(index) {
                    if let Some(provider) = row.id.strip_prefix("accounts:") {
                        // The row names one provider, so the list it opens is
                        // that provider's credentials instead of the full one
                        // again: the point of the row is "look at why this key
                        // serves no model".
                        self.accounts_filter = Some(provider.to_string());
                        self.open_account_list();
                        return;
                    }
                    if let Some(provider) = row.id.strip_prefix("auth:") {
                        let name = self
                            .providers
                            .iter()
                            .find(|entry| entry.id == provider)
                            .map(|entry| entry.name.clone())
                            .unwrap_or_else(|| provider.to_string());
                        self.open_dialog(Dialog::sign_in_prompt(provider, &name));
                        return;
                    }
                }
                // The chosen row's id is its position in the catalog; a
                // provider header never reaches here because the cursor
                // skips headers, so an unparseable id is simply ignored.
                let Some(position) = list
                    .rows
                    .get(index)
                    .and_then(|row| row.id.parse::<usize>().ok())
                else {
                    return;
                };
                let Some(binding) = self.models.get(position).map(ModelInfo::binding) else {
                    return;
                };
                // Remember the choice before the Session check: the landing
                // screen names the model the next prompt will use, and a
                // Session that is opened later starts from this selection.
                // The row's id is its position in the catalog, which the
                // favorites and recents sections made different from the row
                // index: reading `index` here remembered the wrong model.
                self.remembered_model = self
                    .models
                    .get(position)
                    .map(|info| info.model.clone())
                    .or(self.remembered_model.clone());
                if let Some(model) = self.remembered_model.as_deref() {
                    crate::state::save_model(model);
                }
                let Some(session_id) = self.session_id() else {
                    self.shell.composer.notice = Some("open a Session to select a model".into());
                    self.update_status();
                    return;
                };
                if let Some(engine) = self.engine.as_ref() {
                    engine.select_model(&session_id, binding);
                }
            }
            Some(Dialog::Providers(list)) => {
                // A provider narrows the model picker to its own models, which
                // is the step ctrl+o takes when the account catalog is empty. A
                // provider this engine does not serve yet has no models to
                // narrow to, so it says how to add one instead.
                let Some(provider) = list
                    .rows
                    .get(index)
                    .map(|row| row.id.clone())
                    .filter(|id| !id.is_empty())
                else {
                    return;
                };
                if !self
                    .models
                    .iter()
                    .any(|model| model.provider.as_deref() == Some(provider.as_str()))
                {
                    // The same way in as the picker's needs-auth row: the key
                    // prompt, not a shell command the running engine could not
                    // have reflected.
                    let name = self
                        .providers
                        .iter()
                        .find(|entry| entry.id == provider)
                        .map(|entry| entry.name.clone())
                        .unwrap_or_else(|| provider.clone());
                    self.open_dialog(Dialog::sign_in_prompt(&provider, &name));
                    return;
                }
                self.dialog = None;
                self.models_filter = Some(provider);
                self.reopen_models_dialog();
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
            Some(Dialog::ProviderAccounts(list)) => {
                // Row "all" keeps the flat list; any other row names the
                // provider whose accounts it lists.
                let provider = list.rows.get(index).map(|row| row.id.clone());
                self.accounts_filter = match provider.as_deref() {
                    Some("all") | None => None,
                    Some(named) => Some(named.to_string()),
                };
                self.open_account_list();
            }
            Some(Dialog::Accounts(list)) => {
                // The row id is the credential, so a narrowed list still picks
                // the account the operator pointed at.
                let Some(credential_id) = list
                    .rows
                    .get(index)
                    .map(|row| row.id.clone())
                    .filter(|id| !id.is_empty())
                else {
                    return;
                };
                let Some(session_id) = self.session_id() else {
                    self.notice("open a Session to switch accounts");
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

    /// The full provider catalog, ready ones first and the rest marked as
    /// needing auth. The engine owns the list; the TUI only renders it.
    fn open_providers(&mut self) {
        if let Some(engine) = self.engine.as_ref() {
            engine.catalog();
        }
        if self.providers.is_empty() {
            self.pending_providers = true;
            return;
        }
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
                Part::Reasoning(reasoning) => lines.push(format!(
                    "[thinking · {} chars]",
                    reasoning.text.chars().count()
                )),
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
        self.usage_hourly = None;
        self.shell.set_usage_hourly(None);
        if let Some(engine) = self.engine.as_ref() {
            engine.usage(&session_id);
            engine.usage_hourly(24);
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

    /// ctrl+o: the providers that hold an account, the level `provider.accounts`
    /// opens in the TypeScript UI. Reading the catalog needs no Session;
    /// switching an account still does.
    ///
    /// Accounts only exist for catalog routes that carry a credential, so a
    /// configuration that authenticates per provider (`auth.json` keys, OAuth)
    /// names none and would show an empty table. The provider list answers
    /// there and is never empty, so an empty account catalog falls back to it.
    fn open_accounts(&mut self) {
        if let Some(engine) = self.engine.as_ref() {
            engine.catalog();
        }
        if self.accounts.is_empty() {
            self.pending_accounts = true;
            return;
        }
        self.open_provider_accounts();
    }

    /// Store the key an operator typed for a provider the engine does not serve
    /// yet, then restart the engine so its routes include that provider.
    ///
    /// A running engine keeps the routes it built at startup, so storing a key
    /// alone served nothing and the operator had to restart miao. The engine's
    /// spawn re-prepares those routes, which makes restarting it the whole fix.
    /// A turn that is still running defers the restart, because shutting an
    /// engine down ends the work it is doing.
    fn store_provider_key(&mut self, provider: &str, key: &str) {
        let Some(store) = self.credential_store.clone() else {
            self.notice("no credential store: set MIAO_DATA_HOME, XDG_DATA_HOME or HOME");
            return;
        };
        match miao_engine::credential::store_key(&store, provider, key, None) {
            Ok(stored) => {
                let label = format!("{} ({})", stored.label, stored.id);
                // The restart that makes the key usable also stops whatever the
                // engine is running, so a busy Session defers it instead.
                if self.state.active_run.is_some() {
                    self.pending_routes_reload = true;
                    self.notice(&format!(
                        "stored the {provider} key as {label}; its models load when this turn finishes"
                    ));
                    return;
                }
                self.notice(&format!(
                    "stored the {provider} key as {label}; restarting the engine to load its models"
                ));
                if let Some(engine) = self.engine.as_ref() {
                    engine.reload_provider_routes();
                }
            }
            Err(error) => self.notice(&format!("could not store the {provider} key: {error}")),
        }
    }

    fn open_provider_accounts(&mut self) {
        self.accounts_filter = None;
        let mut providers: Vec<(String, usize)> = Vec::new();
        for account in &self.accounts {
            let Some(provider) = account.provider.as_deref() else {
                continue;
            };
            match providers
                .iter_mut()
                .find(|(known, _)| known.as_str() == provider)
            {
                Some((_, count)) => *count += 1,
                None => providers.push((provider.to_string(), 1)),
            }
        }
        // `all` keeps every credential reachable in one flat list, which is
        // what ctrl+o opened before it grew a provider level.
        let mut rows = vec![Row {
            id: "all".to_string(),
            label: "all accounts".to_string(),
            detail: accounts_label(self.accounts.len()),
        }];
        rows.extend(providers.iter().map(|(provider, count)| {
            Row {
                id: provider.clone(),
                label: self
                    .providers
                    .iter()
                    .find(|entry| &entry.id == provider)
                    .map(|entry| entry.name.clone())
                    .unwrap_or_else(|| provider.clone()),
                detail: accounts_label(*count),
            }
        }));
        self.open_dialog(Dialog::provider_accounts(rows));
    }

    /// The accounts of the provider the ctrl+o list narrowed to; no filter means
    /// the flat list.
    fn open_account_list(&mut self) {
        let accounts = match self.accounts_filter.as_deref() {
            Some(provider) => self
                .accounts
                .iter()
                .filter(|account| account.provider.as_deref() == Some(provider))
                .cloned()
                .collect::<Vec<_>>(),
            None => self.accounts.clone(),
        };
        self.open_dialog(Dialog::accounts(&accounts));
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
        self.notice_until = Some(Instant::now() + NOTICE_LIFETIME);
    }

    /// Drop a notice once its moment has passed, so the line goes back to saying
    /// nothing rather than repeating an event from minutes ago.
    fn expire_notice(&mut self) {
        let Some(until) = self.notice_until else {
            return;
        };
        if Instant::now() < until {
            return;
        }
        self.notice_until = None;
        match self.screen {
            Screen::Home => self.home.set_notice(None),
            Screen::Session => self.shell.composer.notice = None,
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

    /// What the copy keystroke should take: the composer's selection when there
    /// is one, otherwise the last response. Kept separate from the clipboard
    /// write so a test can check the choice without touching the operator's
    /// clipboard.
    fn copy_target(&self) -> Option<(String, &'static str)> {
        if let Some(selected) = self.shell.composer.editor.selected_text() {
            return Some((selected.to_string(), "copied the selection"));
        }
        self.shell
            .last_response()
            .map(|text| (text, "copied the last response"))
    }

    fn copy_last_response(&mut self) {
        let Some((text, notice)) = self.copy_target() else {
            self.notice("there is nothing to copy: select text, or open a Session with a response");
            return;
        };
        clipboard::copy(&text);
        self.notice(notice);
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
            .find(|row| row.id == id)
            .map(|row| row.label().to_string())
            .unwrap_or_else(|| "untitled".to_string())
    }

    fn handle_home_key(&mut self, key: KeyEvent) {
        // `AppExit` also carries `ctrl+c`, and the landing prompt is the same
        // composer a Session shows. A Session clears a non-empty draft before it
        // quits; the landing screen quit outright, so one keystroke threw away a
        // prompt typed before any Session existed.
        if self.keys.matches(keybinds::Action::InputClear, &key)
            && !self.shell.composer.editor.is_empty()
        {
            self.shell.composer.editor.clear();
            self.shell.composer.dismiss_completion();
            return;
        }
        if self.keys.matches(keybinds::Action::AppExit, &key) {
            self.quit = true;
            return;
        }
        // Switching an account needs a Session, but listing the providers does
        // not: the landing screen used to swallow ctrl+o entirely.
        if self.keys.matches(keybinds::Action::Accounts, &key) {
            self.open_accounts();
            return;
        }
        if self.keys.matches(keybinds::Action::ProviderList, &key) {
            self.open_providers();
            return;
        }
        {
            // Enter on an empty prompt opens the selected Session: the prompt owns
            // the keyboard on the landing screen, so Enter must still be the way in.
            if key.code == KeyCode::Enter && self.shell.composer.editor.is_empty() {
                return;
            }
            match self.shell.composer.handle_key(key, &self.keys) {
                Action::None => {}
                Action::Quit => self.quit = true,
                // A shell command needs the Session whose location it runs in.
                Action::Shell { .. } => {
                    self.notice("open a Session to run a shell command");
                }
                Action::Submit { text, attachments } => {
                    if text.trim().is_empty() {
                        // An empty prompt means "act on what the list has
                        // selected": the keyboard belongs to the prompt, so
                        // Enter has to keep working as the way in.
                        return;
                    }
                    // The composer's exit words quit before they can become a
                    // Session named "exit".
                    if self.accept_exit_word(&text) {
                        return;
                    }
                    self.startup.prompt = Some(text);
                    self.startup.attachments = attachments;
                    if let Some(engine) = self.engine.as_ref() {
                        engine.new_session();
                    }
                }
            }
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
            // A question the engine already resolved — it expired, the run was
            // interrupted, the process restarted — cannot be rejected either:
            // the refusal is what left a blocking panel with no way out. Drop
            // the stale prompt locally and let Escape mean what it means
            // everywhere else. This runs before the rejection so a stale
            // question never sends one the engine will refuse.
            if self.dismiss_stale_question() {
                return;
            }
            if self.reject_question() {
                return;
            }
            // An approval is a decision too, and Escape declines it. Without
            // this exit an approval the engine no longer holds — a run that
            // ended, a restarted process — left the panel on screen with nothing
            // able to answer it, and every key blocked.
            if self.decline_pending_approval() {
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
        if action(keybinds::Action::CopyMessage) {
            self.copy_last_response();
            return;
        }
        // With a draft on screen the arrows belong to the prompt (caret and
        // history); the transcript scroll keys only answer an empty prompt,
        // where there is no caret to move. Otherwise typing a long turn and
        // nudging the caret once detached the transcript for the whole run.
        let prompt_empty = self.shell.composer.editor.is_empty();
        // While a run streams, single-line arrow nudges must not detach the
        // transcript: an arrow pressed to recall or edit is read by the
        // operator as "show me history", and one line of scroll silently
        // detached the whole run's stream. Page-level jumps and the wheel
        // remain deliberate detaches.
        let streaming = self.state.active_run.is_some();
        if prompt_empty && action(keybinds::Action::PageUp) {
            self.shell.scroll_transcript(-5);
            return;
        }
        if prompt_empty && action(keybinds::Action::PageDown) {
            self.shell.scroll_transcript(5);
            return;
        }
        if prompt_empty && !streaming && action(keybinds::Action::LineUp) {
            self.shell.scroll_transcript(-1);
            return;
        }
        if prompt_empty && !streaming && action(keybinds::Action::LineDown) {
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
        // A key this panel does not answer falls through. Swallowing every key
        // while a panel was on screen made a pending approval look like a frozen
        // TUI: the panel could not be answered and nothing else could be done
        // either.
        match &mut panel.kind {
            PanelKind::Approval(view) => {
                let (decision, persistent) = match key.code {
                    KeyCode::Char('1') => ("allow", false),
                    KeyCode::Char('2') => ("allow", true),
                    KeyCode::Char('3') => ("deny", false),
                    // Scrolling is not a decision, and a long approval prompt is
                    // worth reading. Everything else stays blocked: a decision
                    // is blocking, so a stray key must not land in the draft.
                    KeyCode::PageUp | KeyCode::PageDown => return false,
                    _ => return true,
                };
                let response = view.response(decision);
                if let (Some(session_id), Some(engine)) =
                    (session_id.as_deref(), self.engine.as_ref())
                {
                    engine.approve(session_id, response, persistent);
                }
                true
            }
            PanelKind::Question(_) if typing => match key.code {
                // While a custom answer is being typed, keys belong to it.
                KeyCode::Enter => {
                    panel.accept_typing();
                    true
                }
                KeyCode::Esc => {
                    panel.cancel_typing();
                    true
                }
                KeyCode::Backspace => {
                    panel.backspace_typing();
                    true
                }
                KeyCode::Char(character) => {
                    panel.type_char(character);
                    true
                }
                _ => false,
            },
            PanelKind::Question(_) => match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    panel.move_cursor(-1);
                    true
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    panel.move_cursor(1);
                    true
                }
                KeyCode::Char(' ') => {
                    panel.toggle();
                    true
                }
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
                    true
                }
                _ => false,
            },
        }
    }

    /// Declining a pending approval is the other Esc that is answered locally.
    ///
    /// It clears the panel whether or not the engine still holds the request:
    /// the operator asked to get out, and a stale prompt must not outlive that.
    fn decline_pending_approval(&mut self) -> bool {
        let Some(view) = self.shell.panel.as_ref().and_then(Panel::approval_view) else {
            return false;
        };
        let response = view.response("deny");
        if let (Some(session), Some(engine)) = (
            self.session.as_ref().map(|session| session.id.clone()),
            self.engine.as_ref(),
        ) {
            engine.approve(&session, response, false);
        }
        self.state.approvals.clear();
        self.shell.panel = None;
        self.notice("approval declined");
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

    /// Clear a question panel whose question the engine no longer holds.
    ///
    /// This is the difference between "Esc declined it" and "there is nothing
    /// left to decline": once the deadline passed, the engine refuses both
    /// answers, so only dropping the panel locally can end the block.
    fn dismiss_stale_question(&mut self) -> bool {
        let Some(question_id) = self.shell.panel.as_ref().and_then(|panel| {
            matches!(panel.kind, crate::pane::PanelKind::Question(_))
                .then(|| panel.request_id().to_string())
        }) else {
            return false;
        };
        let now = crate::pane::now_ms();
        let expired = self
            .state
            .questions
            .iter()
            .find(|question| question.question_id == question_id)
            .is_some_and(|question| {
                question
                    .expires_at_ms
                    .is_some_and(|deadline| now >= deadline)
            });
        if !expired {
            return false;
        }
        self.state
            .questions
            .retain(|question| question.question_id != question_id);
        self.shell.panel = None;
        self.notice("the question expired before it was answered");
        self.update_status();
        true
    }

    /// Drop questions the engine has already stopped accepting.
    ///
    /// The engine resolves a question as `expired` once `expires_at_ms` passes,
    /// and both `answer_question` and `reject_question` then fail with "question
    /// is already resolved". A panel that outlived its deadline therefore had
    /// two outcomes, both errors, and looked like a hung UI. A snapshot taken
    /// before the expiry carried the question, so the deadline has to be read
    /// here rather than only from the events that resolve it.
    fn expire_questions(&mut self) {
        let now = crate::pane::now_ms();
        self.state
            .questions
            .retain(|question| question.expires_at_ms.is_none_or(|deadline| now < deadline));
    }

    fn sync_panel(&mut self) {
        self.expire_questions();
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
        // A snapshot taken before this run started names no active run — the
        // delayed refresh that would set it has not landed yet. The frame's
        // own run id is then the first evidence of the run, and dropping the
        // frame here swallowed the first tokens of every turn until the
        // committed events replays them in one batch.
        let frame_run = frame
            .get("run_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let run_id = match (self.state.active_run.clone(), frame_run) {
            (Some(active), Some(id)) if active != id => return,
            (Some(active), _) => active,
            (None, Some(id)) => id,
            (None, None) => return,
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
                self.shell.set_running_tool(None);
                // `data` is the engine's delta envelope: `{"kind":"delta",
                // "delta":{...},"raw":{...}}`, so the normalized delta the draft
                // reads sits one level down. Captured from a real turn: `data`
                // alone carries `kind:"delta"` and `raw`, neither of which
                // `Draft::append` matches.
                let envelope = frame.get("data").unwrap_or(&Value::Null);
                let delta = envelope.get("delta").unwrap_or(envelope);
                // A finished provider stream (the engine's end-of-stream
                // marker) freezes the elapsed clock here, before the durable
                // projection retires the run: the operator sees the total
                // time the moment the answer completes.
                if delta.get("kind").and_then(Value::as_str) == Some("stream.done") {
                    self.stream_ended = self
                        .run_since
                        .as_ref()
                        .map(|(_, since)| now.duration_since(*since));
                    return;
                }
                self.stream(&run_id, delta);
                return;
            }
            // The engine repeats this while it has no first token.
            "provider.waiting" => {
                self.stream_ended = None;
                LivePhase::Waiting
            }
            "provider.retry" => LivePhase::Retrying {
                attempt: frame.get("attempt").and_then(Value::as_u64).unwrap_or(0) + 1,
            },
            // An attempt announcement proves the request is in flight, even
            // before the first heartbeat or right after a previous step.
            "provider.attempt" => {
                self.stream_ended = None;
                let phase = match self.live.as_ref().map(|live| live.phase.clone()) {
                    Some(phase) => phase,
                    None => LivePhase::Waiting,
                };
                phase
            }
            // A committed tool call names the work the run is doing, and the
            // transcript keeps one spinner row for it while it lasts.
            "tool.planned" => {
                self.stream_ended = None;
                let label = tool_label(
                    frame
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                self.shell.set_running_tool(Some(label.clone()));
                LivePhase::Tool { name: label }
            }
            // The call finished; the run's next phase is not known yet.
            "tool.completed" => {
                self.live = None;
                self.shell.set_running_tool(None);
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
    fn stream(&mut self, run_id: &str, delta: &Value) {
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
        let parts: Vec<crate::pane::DraftPart> = draft
            .parts
            .iter()
            .map(|part| match part {
                DraftPart::Reasoning(text) => crate::pane::DraftPart::Reasoning(text.clone()),
                DraftPart::Text(text) => crate::pane::DraftPart::Text(text.clone()),
                DraftPart::Call(call) => crate::pane::DraftPart::Call {
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect();
        self.shell.set_draft(&parts);
        // Deltas wake the render loop themselves, and its draw is a diff: the
        // streamed rows update in place. A forced full repaint per token
        // (resize-based redraw) flashed the whole screen on every token.
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
        // A draft that is dirty but was skipped by the paint throttle still has
        // to be drawn. The throttle exists so a token stream does not repaint
        // sixty times a second, but a skipped paint that schedules nothing
        // leaves the newest text on screen nowhere: the next paint waits for an
        // event that may never come, and the transcript freezes until the
        // operator types again. Wake for the remainder of the throttle window.
        if self.shell.draft_pending() {
            return Some(crate::pane::DRAFT_REFRESH);
        }
        let now = crate::pane::now_ms();
        let stamps = match self.screen {
            Screen::Home => Vec::new(),
            Screen::Session => self
                .session
                .as_ref()
                .and_then(|session| session.updated_at_ms)
                .into_iter()
                .collect(),
        };
        let label = stamps
            .into_iter()
            .map(|updated| crate::pane::next_relative_change(updated, now))
            .min();
        let notice = self
            .notice_until
            .map(|until| until.saturating_duration_since(Instant::now()));
        match (label, notice) {
            (Some(label), Some(notice)) => Some(label.min(notice)),
            (label, notice) => label.or(notice),
        }
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
            // The launcher names the model the next prompt would run on: the
            // operator's last choice, labelled from the catalog. Nothing else
            // is in play before a Session exists, and the product's home status
            // line reads its local selection the same way.
            // The remembered choice, or the model the newest Session ran on:
            // an install that predates the remembering still has sessions that
            // name their model, and the launcher should reflect what this
            // machine actually uses rather than stay blank until a pick.
            let landing_model = self.remembered_model.clone().or_else(|| {
                self.catalog
                    .first()
                    .and_then(|session| session.model.clone())
            });
            let landing = landing_model.map(|model| {
                // A Session pin may carry a route id (`provider/model`); the
                // catalog is keyed by the model name alone.
                let name = model
                    .rsplit_once('/')
                    .map(|(_, name)| name)
                    .unwrap_or(&model);
                self.models
                    .iter()
                    .find(|info| info.model == model || info.model == name)
                    .map(ModelInfo::identity)
                    .unwrap_or(model)
            });
            // An install with no route at all leaves the row blank, which
            // reads as a broken status line rather than an empty catalog.
            self.shell.status.model = landing.or_else(|| {
                Some(match self.keys.chord(keybinds::Action::ModelList) {
                    Some(chord) => format!("no model · {chord} to pick a provider"),
                    None => "no model · open the model list to pick a provider".to_string(),
                })
            });
            self.shell.status.usage = None;
            self.shell.status.hints.clear();
            // The launch policy holds before any Session opens, so the strip
            // names it on the launcher too: a person starting work under
            // `--auto` should not have to open a Session to find that out.
            if self.startup.auto {
                self.shell.status.hints.push(StatusHint {
                    text: "auto-approve".to_string(),
                    warning: true,
                });
            }
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
        // Time the run from the moment it was first seen active, so a run that
        // has announced no phase yet still shows a clock. Without an anchor the
        // status had nothing to count from and fell back to a bare, colourless
        // "Working" for as long as the first frame took — which reads the same
        // as a stuck turn.
        let run_id = self.state.active_run.clone();
        self.run_since = match (&run_id, self.run_since.take()) {
            (Some(current), Some((tracked, since))) if &tracked == current => {
                Some((tracked, since))
            }
            (Some(current), _) => Some((current.clone(), now)),
            (None, _) => None,
        };
        let run_elapsed = self
            .run_since
            .as_ref()
            .map(|(_, since)| now.duration_since(*since));
        // The compact activity row splits into what the TS row splits into:
        // state text on the left, elapsed time right-aligned, and a spinner
        // that turns warning-colored once a model wait passes half a minute.
        let (phase, elapsed, alert) = match blocking {
            Some(blocking) => (blocking, None, false),
            None => match (self.state.active_run.as_ref(), live) {
                (Some(_), Some(live)) => (
                    live.state(now),
                    Some(crate::pane::duration_ms(
                        now.duration_since(live.since).as_millis() as u64,
                    )),
                    live.alert(now),
                ),
                // No frame yet, but the run is admitted and moving. Say what is
                // true — it is starting — and keep the clock, so a turn that is
                // demonstrably working does not look like one that has wedged.
                // The alert tone follows the same half-minute threshold as a
                // real phase wait.
                (Some(_), None) => match self.stream_ended {
                    // The answer is on screen: the turn is done, so the label
                    // retires with the frozen total instead of claiming the
                    // run is still working (Claude Code drops the spinner at
                    // stream end; the frozen total is miao's extra honesty
                    // while a stalled projection holds the run open).
                    Some(frozen) => (
                        "Done".to_string(),
                        Some(crate::pane::duration_ms(frozen.as_millis() as u64)),
                        false,
                    ),
                    None => (
                        "Working".to_string(),
                        run_elapsed
                            .map(|waited| crate::pane::duration_ms(waited.as_millis() as u64)),
                        run_elapsed.is_some_and(|waited| waited >= Duration::from_secs(30)),
                    ),
                },
                (None, _) => ("Idle".to_string(), None, false),
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
        self.shell.composer.phase_elapsed = match self.shell.composer.phase.is_some() {
            true => elapsed,
            false => None,
        };
        self.shell.composer.phase_alert = alert && self.shell.composer.phase.is_some();
        // Which model answers, and what the Session has cost so far. A pin on
        // the Session wins, then the model the newest assistant message ran on,
        // labelled with the catalog's protocol so the strip names the provider
        // as well as the model. The engine's `unavailable/model` is a sentinel
        // for "no route resolved", not a model name: painting it in the strip
        // reads as a fault, and the notice beside it already carries the fix.
        let answering = self.shell.transcript().and_then(|transcript| {
            transcript
                .entries
                .iter()
                .rev()
                .find_map(|entry| match entry {
                    crate::session::Entry::Assistant { model, .. } => model.clone(),
                    _ => None,
                })
        });
        let labelled = answering.as_deref().and_then(|model| {
            self.models
                .iter()
                .find(|info| info.model == model)
                .map(ModelInfo::identity)
        });
        self.shell.status.model = self
            .session
            .as_ref()
            .and_then(|session| session.model.clone())
            .or(labelled)
            .or(answering)
            .or_else(|| {
                self.settings
                    .as_ref()
                    .map(|settings| settings.model.clone())
                    .filter(|model| model != engine::UNROUTED_MODEL)
            })
            // The landing screen has nothing else to name: the operator's last
            // choice is the model the next prompt would run on, and the catalog
            // knows the provider and protocol that go with it.
            .or_else(|| {
                let model = self.remembered_model.clone()?;
                Some(
                    self.models
                        .iter()
                        .find(|info| info.model == model)
                        .map(ModelInfo::identity)
                        .unwrap_or(model),
                )
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
        // Scrolled away from the newest row: the transcript keeps filling below
        // the window, so without this the operator cannot tell a stalled run
        // from output that has scrolled out of sight.
        if !self.shell.following() {
            hints.push(StatusHint {
                text: "not following · page down to resume".to_string(),
                warning: false,
            });
        }
        // A blocking approval or question is already the phase line, so
        // repeating it here would say the same thing twice in the one strip the
        // operator scans. The queued count rides the strip, like the TS status
        // line's `queued (n)` segment.
        if self.state.pending > 0 {
            hints.push(StatusHint {
                text: format!("queued ({})", self.state.pending),
                warning: false,
            });
        }
        if self.state.active_run.is_some() {
            hints.push(StatusHint {
                text: "esc interrupt".to_string(),
                warning: false,
            });
        }
        // `--auto` widens what runs without asking, so the operator has to be
        // able to see it. A Session that stops prompting should read as a
        // policy in effect, not as the absence of one — the same reason the
        // warning flag exists. Read-only is the other side worth naming: it
        // refuses writes, which surprises anyone who expects a workspace mode.
        if self.startup.auto {
            hints.push(StatusHint {
                text: "auto-approve".to_string(),
                warning: true,
            });
        }
        self.shell.status.hints = hints;
        self.shell.title.set_status(Some(status));
    }

    /// `--continue` opens the Session with the newest `updated_at_ms`. The list
    /// sorts a pin ahead of recency, but a pin is a view preference rather than
    /// an instruction to resume, and the catalog also carries archived
    /// Sessions: neither may decide where `--continue` lands.
    fn continue_startup(&mut self) {
        if !self.startup.continue_last || self.screen != Screen::Home || self.dialog.is_some() {
            return;
        }
        self.startup.continue_last = false;
        // Ties fall to the smaller id, the order the catalog sorts with, so two
        // launchers reading the same catalog continue the same Session.
        let newest = self
            .catalog
            .iter()
            .filter(|row| row.archived_at_ms.is_none())
            .min_by(|a, b| {
                b.updated_at_ms
                    .cmp(&a.updated_at_ms)
                    .then_with(|| a.id.cmp(&b.id))
            })
            .map(|row| row.id.clone());
        match newest {
            Some(id) => {
                if let Some(engine) = self.engine.clone() {
                    if self.startup.fork {
                        engine.fork_session(&id);
                    } else {
                        engine.open(&id);
                    }
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
        let attachments = std::mem::take(&mut self.startup.attachments);
        self.submit(text, attachments);
    }

    /// The composer's exit words (`exit`, `quit`, with or without the slash)
    /// quit instead of becoming prompts, the way the TS composer answers them.
    fn accept_exit_word(&mut self, text: &str) -> bool {
        match text.trim() {
            "exit" | "quit" => {
                self.quit = true;
                true
            }
            _ => false,
        }
    }

    fn submit(&mut self, text: String, attachments: Vec<Value>) {
        if self.accept_exit_word(&text) {
            return;
        }
        // The turn the operator just started is what they want to watch: a
        // transcript left detached by an earlier scroll re-attaches here,
        // or the whole run streams by out of sight.
        self.shell.follow_transcript();
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
        // The first prompt is what names a Session that has no title yet, so the
        // sidebar and the terminal tab stop reading "New session" the moment it
        // is sent rather than after some later reopen.
        self.name_session_from_prompt(&session_id, &text);
        // Editor context is a prompt prefix rather than a wire field: the
        // engine admits one text string, and the TS client does the same.
        let text = match self.zed_context() {
            Some(context) => format!("{context}\n\n{text}"),
            None => text,
        };
        // The durable run identity is the only honest "a turn is running"
        // signal: `live` is cleared as soon as the first token arrives, and the
        // display phase only appears after the engine has been quiet a while.
        let queued = self.state.active_run.is_some();
        engine.prompt(&session_id, &text, attachments, queued);
        // The prompt left the composer, so its draft is gone too: keeping it
        // would restore text the Session already sent if the operator switched
        // away and back.
        self.drafts.remove(&session_id);
    }

    /// The product creates a Session with a placeholder title and leaves the real
    /// name to the host's title model. The rust-only TUI is the host on this path
    /// and has no title model, so it names the Session from its first prompt —
    /// once, and only while the title is still a placeholder.
    fn name_session_from_prompt(&mut self, session_id: &str, prompt: &str) {
        let placeholder = self
            .session
            .as_ref()
            .is_some_and(|session| session.id == session_id && placeholder_title(session.label()));
        if !placeholder || self.named_sessions.contains(session_id) {
            return;
        }
        let Some(title) = title_from_prompt(prompt) else {
            return;
        };
        let Some(engine) = self.engine.as_ref() else {
            return;
        };
        engine.rename(session_id, &title);
        self.named_sessions.insert(session_id.to_string());
        // The rename is answered later; painting the name now keeps the sidebar
        // from reading "New session" for the whole turn.
        if let Some(session) = self.session.as_mut() {
            session.title = Some(title.clone());
        }
        if let Some(row) = self.catalog.iter_mut().find(|row| row.id == session_id) {
            row.title = Some(title);
        }
        self.shell.set_session(self.session.as_ref());
    }

    /// The home list is refreshed as the ledger changes, so the open Session's
    /// title and age come from it too: a rename, a title model upstream, or a
    /// fresh turn must not leave the sidebar describing the moment it was opened.
    fn sync_open_session(&mut self, rows: &[SessionSummary]) {
        let Some(session) = self.session.as_ref() else {
            return;
        };
        let Some(row) = rows.iter().find(|row| row.id == session.id) else {
            return;
        };
        // A list computed before this process renamed the Session must not hand
        // the placeholder back, and an older answer must not make the age go
        // backwards.
        let title = match row.title.as_deref() {
            Some(title) if !placeholder_title(title) => row.title.clone(),
            _ => session.title.clone(),
        };
        let updated_at_ms = match (session.updated_at_ms, row.updated_at_ms) {
            (Some(current), Some(fresh)) if fresh < current => Some(current),
            (_, fresh) => fresh.or(session.updated_at_ms),
        };
        if title == session.title && updated_at_ms == session.updated_at_ms {
            return;
        }
        let row = row.clone();
        if let Some(session) = self.session.as_mut() {
            session.title = title;
            session.updated_at_ms = updated_at_ms;
            session.preview = row.preview.clone();
        }
        if let Some(catalog_row) = self
            .catalog
            .iter_mut()
            .find(|candidate| candidate.id == row.id)
        {
            *catalog_row = row;
        }
        self.shell.set_session(self.session.as_ref());
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
        self.shell.set_draft(&[]);
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

/// Titles a client creates a Session with, before anything names it.
fn placeholder_title(title: &str) -> bool {
    matches!(title, "" | "untitled" | "New session" | "run")
}

/// How many characters of the first prompt name the Session: enough to tell two
/// conversations apart, short enough for a sidebar.
const TITLE_CHARS: usize = 60;

/// A one-line Session name taken from the first prompt.
fn title_from_prompt(prompt: &str) -> Option<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let single = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.is_empty() {
        return None;
    }
    let mut title = single.chars().take(TITLE_CHARS).collect::<String>();
    if single.chars().count() > TITLE_CHARS {
        title.push('…');
    }
    Some(title)
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
            state: Box::new(SessionState::default()),
        });
        assert_eq!(app.screen, Screen::Session);
        app
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> AppEvent {
        AppEvent::Key(KeyEvent::new(code, modifiers))
    }

    /// End-to-end: the exact frame shapes the engine publishes must reach the
    /// draft the transcript paints. The earlier tests shared a helper that
    /// wrapped the delta one level deeper than the engine does, so they passed
    /// against a contract no provider honoured and a real turn painted nothing.
    #[test]
    fn engine_shaped_deltas_reach_the_painted_draft() {
        let mut app = session_app();
        for frame in [
            serde_json::json!({"kind":"provider.delta","session_id":"ses_1","run_id":"run-1",
                "data":{"kind":"delta","delta":{"kind":"reasoning.delta","text":"让我想想"}}}),
            serde_json::json!({"kind":"provider.delta","session_id":"ses_1","run_id":"run-1",
                "data":{"kind":"delta","delta":{"kind":"text.delta","text":"答案第一段。"}}}),
            serde_json::json!({"kind":"provider.delta","session_id":"ses_1","run_id":"run-1",
                "data":{"kind":"delta","delta":{"kind":"text.delta","text":"答案第二段。"}}}),
        ] {
            app.handle(AppEvent::Provider(frame));
        }
        let painted = drafted(&mut app);
        assert!(
            painted.contains("答案第一段。"),
            "the streamed text reaches the transcript: {painted:?}"
        );
        assert!(
            painted.contains("答案第二段。"),
            "and every later delta appends: {painted:?}"
        );
        assert!(
            painted.contains("Thinking"),
            "the reasoning shows as its one header line: {painted:?}"
        );
    }

    /// A streamed delta that lands inside the paint throttle must still get a
    /// frame. The throttle skips the paint, so without a scheduled wake the
    /// loop waits for an event that never comes: the transcript froze on an
    /// older paint until the operator's next keystroke produced one, which is
    /// the "the answer only appears after I type again" report.
    #[test]
    fn a_pending_draft_asks_the_loop_to_come_back() {
        let mut app = session_app();
        // An idle Session has nothing time-relative on screen, so the loop is
        // content to wait for events.
        assert_eq!(app.next_repaint(), None, "an idle screen waits on events");
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "provider.delta",
            "session_id": "ses_1",
            "run_id": "run-1",
            "data": { "kind": "text.delta", "text": "a token" },
        })));
        assert!(
            app.next_repaint().is_some(),
            "a pending delta schedules its own paint; otherwise the text sits \
             unpainted until the next keystroke"
        );
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
            state: Box::new(SessionState::default()),
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
    fn a_transient_notice_clears_when_its_moment_passes() {
        // A notice reports something that already happened ("copied 120
        // characters"); leaving it there until the next event turns feedback
        // into furniture.
        let mut session = session_app();
        session.notice("copied 120 characters");
        assert_eq!(
            session.shell.composer.notice.as_deref(),
            Some("copied 120 characters")
        );
        assert!(
            session.next_repaint().is_some(),
            "the loop has to wake to clear it"
        );
        // Pretend the moment passed rather than sleeping for it.
        session.notice_until = Some(Instant::now() - Duration::from_millis(1));
        draw(&mut session);
        assert_eq!(
            session.shell.composer.notice, None,
            "an expired notice is gone"
        );
        assert!(session.notice_until.is_none());

        // The landing screen behaves the same way.
        let mut landing = app();
        landing.notice("pinned");
        assert_eq!(landing.home.notice(), Some("pinned"));
        landing.notice_until = Some(Instant::now() - Duration::from_millis(1));
        draw(&mut landing);
        assert_eq!(landing.home.notice(), None);
    }

    #[test]
    fn scrolling_up_says_the_transcript_is_no_longer_following() {
        // Output keeps arriving below a window that has scrolled away, so the
        // strip has to say why the newest rows are missing; otherwise a working
        // run and a stalled one look the same.
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(forty_messages()),
            state: Box::new(SessionState::default()),
        });
        draw(&mut app);
        let says = |app: &App| {
            app.shell
                .status
                .hints
                .iter()
                .any(|hint| hint.text.contains("not following"))
        };
        assert!(!says(&app), "a following transcript says nothing");
        app.handle(wheel(MouseEventKind::ScrollUp));
        draw(&mut app);
        assert!(says(&app), "scrolling away has to be visible");
        app.handle(wheel(MouseEventKind::ScrollDown));
        draw(&mut app);
        assert!(!says(&app), "coming back to the tail clears it");
    }

    #[test]
    fn a_wheel_notch_moves_the_default_three_rows() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(forty_messages()),
            state: Box::new(SessionState::default()),
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
    fn the_command_palette_narrows_as_the_operator_types() {
        // UX-05: discovery is only useful if search works. The palette opens
        // with every command and filters as the operator types, and Enter runs
        // the row it landed on.
        let mut app = app();
        app.handle(key(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let all = app
            .dialog
            .as_ref()
            .and_then(Dialog::palette)
            .expect("palette")
            .visible
            .len();
        assert!(all > 5, "the palette starts with every command: {all}");

        for character in "theme".chars() {
            app.handle(key(KeyCode::Char(character), KeyModifiers::NONE));
        }
        let palette = app
            .dialog
            .as_ref()
            .and_then(Dialog::palette)
            .expect("palette");
        assert!(
            palette.visible.len() < all,
            "typing narrows the list: {} of {all}",
            palette.visible.len()
        );
        let labels = palette
            .visible
            .iter()
            .map(|index| palette.rows[*index].label.as_str())
            .collect::<Vec<_>>();
        assert!(
            labels
                .iter()
                .all(|label| label.to_lowercase().contains("theme")),
            "only theme commands remain: {labels:?}"
        );
        assert!(
            labels.contains(&"Select a theme"),
            "the theme command is reachable: {labels:?}"
        );

        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(
            matches!(app.dialog, Some(Dialog::Theme(_))),
            "Enter runs the command the search landed on"
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
    fn a_forked_launch_copies_instead_of_appending() {
        let mut app = app_with(Startup {
            session: Some("ses_known".into()),
            fork: true,
            auto: false,
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::ForkSession { .. })
        ));
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
    fn continue_ignores_a_pin_and_takes_the_newest_session() {
        let mut app = app_with(Startup {
            continue_last: true,
            ..Startup::default()
        });
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.start();
        assert!(matches!(requests.try_recv(), Ok(engine::Request::Catalog)));
        // The catalog sorts a pin first, so the pinned row leads even though the
        // other Session was touched later. Continuing is about recency: a pin is
        // a list preference, not an instruction to resume that Session.
        app.handle(AppEvent::Catalog(vec![
            SessionSummary {
                pinned_at_ms: Some(10),
                ..summary("ses_pinned", 100)
            },
            summary("ses_recent", 200),
        ]));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Open(id)) if id == "ses_recent"
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
    fn a_reversible_action_does_not_ask_first() {
        // UX-05: archiving is undone by archiving again, so a confirmation
        // would only be a second keystroke between the operator and the work.
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.catalog = vec![summary("ses_a", 10)];
        app.dialog = Some(Dialog::sessions(&app.catalog));
        app.dialog_action(DialogAction::ToggleArchive("ses_a".into()));
        assert!(
            app.dialog.is_none(),
            "archiving goes straight through instead of opening a confirm"
        );
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Archive { session_id, archived })
                if session_id == "ses_a" && archived
        ));
    }

    #[test]
    fn a_destructive_action_asks_with_the_blast_radius_in_hand() {
        // The same menu, the opposite rule: removing a Session destroys what it
        // owns, so it asks, and the prompt says so.
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.catalog = vec![summary("ses_a", 10)];
        app.dialog = Some(Dialog::sessions(&app.catalog));
        app.dialog_action(DialogAction::Remove("ses_a".into()));
        let Some(Dialog::Confirm(confirm)) = app.dialog.as_ref() else {
            panic!("removing asks first");
        };
        assert!(
            confirm.message.contains("cannot be undone"),
            "{}",
            confirm.message
        );
        assert!(
            requests.try_recv().is_err(),
            "nothing is destroyed until the dialog is confirmed"
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
            state: Box::new(SessionState::default()),
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
            state: Box::new(SessionState::default()),
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
            state: Box::new(SessionState::default()),
        });
        assert_eq!(app.terminal_title().as_deref(), Some("repair this test"));
        app.configure_terminal_title(false, true);
        assert_eq!(app.terminal_title(), None);
        app.configure_terminal_title(true, false);
        assert_eq!(app.terminal_title(), None);
    }

    /// The palette and the help list name the chord the keymap binds. They used
    /// to carry their own spelled-out table, which kept advertising `<leader>t`
    /// after the operator moved that action somewhere else.
    #[test]
    fn the_palette_names_the_chord_the_keymap_binds() {
        let mut app = app_with(Startup::default());
        app.open_palette();
        let detail = |app: &App, id: &str| {
            let Some(Dialog::Palette(palette)) = app.dialog.as_ref() else {
                panic!("the palette opens");
            };
            palette
                .rows
                .iter()
                .find(|row| row.id == id)
                .map(|row| row.detail.clone())
                .unwrap_or_default()
        };
        assert_eq!(detail(&app, "theme"), "ctrl+x t");
        // A command with no chord of its own claims none.
        assert_eq!(detail(&app, "tag"), "");

        let mut remapped =
            app_with_overrides(&[("theme_list".into(), Some(vec!["ctrl+y".into()]))].into());
        remapped.open_palette();
        assert_eq!(
            detail(&remapped, "theme"),
            "ctrl+y",
            "the palette follows the live keymap"
        );
    }

    /// Every command the palette offers with a chord has to resolve to a bound
    /// action, or the row advertises a key that does nothing.
    #[test]
    fn every_shortcut_command_resolves_to_a_bound_chord() {
        let keys = Keymap::default();
        let unbound = Builtin::ALL
            .into_iter()
            .filter_map(|builtin| builtin.action().map(|action| (builtin, action)))
            .filter(|(_, action)| keys.chord(*action).is_none())
            .map(|(builtin, _)| builtin.name())
            .collect::<Vec<_>>();
        // Toggling the terminal title ships unbound on purpose: it is reachable
        // only when the operator binds it.
        assert_eq!(unbound, ["terminal-title"]);
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
        // The prompt owns the landing keyboard; typing starts a Session.
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
    fn a_paste_on_the_landing_screen_reaches_the_prompt() {
        let mut app = app();
        assert_eq!(app.screen, Screen::Home);
        app.handle(AppEvent::Paste("first prompt".into()));
        assert_eq!(app.shell.composer.editor.text(), "first prompt");
    }

    #[test]
    fn an_image_pasted_on_the_landing_screen_rides_into_the_new_session() {
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(AppEvent::Clipboard(Some(clipboard::Content::Image {
            mime: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        })));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::NewSession)
        ));
        app.handle(AppEvent::SessionOpened {
            summary: Some(summary("ses_new", 1)),
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        let Ok(engine::Request::Prompt {
            session_id,
            text,
            attachments,
            ..
        }) = requests.try_recv()
        else {
            panic!("the landing prompt must reach the Session it opened");
        };
        assert_eq!(session_id, "ses_new");
        assert_eq!(text, "[Image 1] ");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0]["mime"], "image/png");
    }

    fn approval_state() -> SessionState {
        SessionState {
            todos: Vec::new(),
            goal: None,
            active_run: None,
            pending: 0,
            pending_prompts: Vec::new(),
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

    fn approval_app() -> App {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            // An approval belongs to a Session: without one the decision has
            // nowhere to go.
            summary: Some(summary("ses_open", 1)),
            transcript: Box::new(Transcript::default()),
            state: Box::new(approval_state()),
        });
        assert!(app.shell.panel.is_some(), "the approval is on screen");
        app
    }

    /// A decision is blocking, so a letter stays out of the draft, and the
    /// numbered answers reach the engine instead.
    #[test]
    fn an_approval_answers_its_own_keys_and_keeps_stray_ones_out_of_the_draft() {
        let mut app = approval_app();
        app.handle(key(KeyCode::Char('x'), KeyModifiers::NONE));
        assert!(
            app.shell.composer.editor.is_empty(),
            "a stray key does not land in the draft"
        );

        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Char('1'), KeyModifiers::NONE));
        assert!(
            matches!(requests.try_recv(), Ok(engine::Request::Approve { .. })),
            "1 answers the approval"
        );
        assert!(app.shell.composer.editor.is_empty());
    }

    /// Escape always has an answer, even for a request the engine dropped: a
    /// stale approval used to leave the panel up with every key blocked.
    #[test]
    fn escape_declines_a_pending_approval_instead_of_doing_nothing() {
        let mut app = approval_app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(
            matches!(requests.try_recv(), Ok(engine::Request::Approve { .. })),
            "Escape declines the approval"
        );
        assert!(app.shell.panel.is_none(), "the panel is gone");
        assert!(app.state.approvals.is_empty());
    }

    /// The engine refuses an answer past the deadline and resolves the
    /// question as `expired`, so a panel kept on screen would have two
    /// outcomes — answer and reject — and both would fail. Escape has to be
    /// able to end the block.
    #[test]
    fn a_question_past_its_deadline_cannot_hold_the_screen() {
        let deadline = crate::pane::now_ms().saturating_sub(1);
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState {
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
                    expires_at_ms: Some(deadline),
                }],
                ..SessionState::default()
            }),
        });
        assert!(
            app.shell.panel.is_none(),
            "an expired question must not open a panel"
        );
        assert!(
            app.state.questions.is_empty(),
            "the projection is dropped too"
        );
    }

    /// A question that expires while its panel is open: Escape clears it
    /// instead of messaging the engine with a rejection it will refuse.
    #[test]
    fn escape_clears_a_question_that_expired_while_it_was_open() {
        let mut app = session_app();
        let question = |deadline: u64| crate::session::QuestionView {
            question_id: "run-1/q1".into(),
            input_hash: "b".repeat(64),
            questions: vec![crate::session::QuestionItem {
                question: "Ship it?".into(),
                header: "confirm".into(),
                options: Vec::new(),
                multi_select: false,
                custom: true,
            }],
            expires_at_ms: Some(deadline),
        };
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState {
                questions: vec![question(crate::pane::now_ms().saturating_add(60_000))],
                ..SessionState::default()
            }),
        });
        assert!(app.shell.panel.is_some(), "a live question opens the panel");

        // The engine's own clock moved past the deadline while the panel sat
        // on screen.
        app.state.questions = vec![question(crate::pane::now_ms().saturating_sub(1))];
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(
            requests.try_recv().is_err(),
            "a rejection the engine would refuse is not sent"
        );
        assert!(app.shell.panel.is_none(), "the panel is gone");
        assert!(app.state.questions.is_empty());
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
            state: Box::new(state),
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
                expires_at_ms: None,
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
            state: Box::new(state),
        });
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("needs an answer"));
        assert_eq!(app.shell.composer.phase.as_deref(), Some("needs an answer"));
    }

    #[test]
    fn the_status_names_the_model_that_answered_with_its_protocol() {
        // miao can start without a model, and then the engine's settings hold
        // the `unavailable/model` sentinel. The Session knows what answered, and
        // the catalog knows which protocol that model speaks, so the strip can
        // name both instead of a placeholder.
        let mut app = session_app();
        app.set_settings(engine::Settings {
            spawn: crate::transport::EngineSpawn {
                program: PathBuf::from("/bin/true"),
                args: Vec::new(),
                env: Vec::new(),
            },
            model: engine::UNROUTED_MODEL.to_string(),
            embedded: true,
        });
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript {
                entries: vec![crate::session::Entry::Assistant {
                    agent: Some("build".into()),
                    model: Some("glm-5.3-flash".into()),
                    parts: vec![crate::session::Part::Text("answer".into())],
                }],
                ..Transcript::default()
            }),
            state: Box::new(SessionState::default()),
        });
        app.update_status();
        assert_eq!(app.shell.status.model.as_deref(), Some("glm-5.3-flash"));

        app.models = vec![ModelInfo {
            protocol: "openai-chat".into(),
            model: "glm-5.3-flash".into(),
            route_id: Some("xiaomi/glm-5.3-flash".into()),
            variant: None,
            provider: Some("xiaomi".into()),
            account: None,
        }];
        app.update_status();
        assert_eq!(
            app.shell.status.model.as_deref(),
            Some("glm-5.3-flash · xiaomi · openai-chat"),
            "the strip names the provider, not only the transport"
        );
        assert_ne!(
            app.shell.status.model.as_deref(),
            Some(engine::UNROUTED_MODEL)
        );
    }

    /// The landing screen has no Session pin and no assistant message, so the
    /// strip under its prompt used to name nothing at all. It now names the
    /// model the operator last chose, with the provider and protocol beside it.
    #[test]
    fn the_landing_strip_names_the_remembered_model() {
        let mut app = app();
        app.set_settings(engine::Settings {
            spawn: crate::transport::EngineSpawn {
                program: PathBuf::from("/bin/true"),
                args: Vec::new(),
                env: Vec::new(),
            },
            model: engine::UNROUTED_MODEL.to_string(),
            embedded: true,
        });
        app.models = vec![ModelInfo {
            protocol: "openai-chat".into(),
            model: "glm-5".into(),
            route_id: Some("xiaomi/glm-5".into()),
            variant: None,
            provider: Some("xiaomi".into()),
            account: None,
        }];
        app.remembered_model = Some("glm-5".into());
        app.update_status();
        assert_eq!(
            app.shell.status.model.as_deref(),
            Some("glm-5 · xiaomi · openai-chat"),
            "the landing strip names the model, its provider and its protocol"
        );
    }

    /// An install that never picked a model still has Sessions that name the
    /// model they ran on, so the launcher reads the newest one instead of
    /// staying blank until the operator opens the picker.
    #[test]
    fn the_landing_strip_falls_back_to_the_newest_session_model() {
        let mut app = app();
        app.set_settings(engine::Settings {
            spawn: crate::transport::EngineSpawn {
                program: PathBuf::from("/bin/true"),
                args: Vec::new(),
                env: Vec::new(),
            },
            model: engine::UNROUTED_MODEL.to_string(),
            embedded: true,
        });
        app.models = vec![ModelInfo {
            protocol: "openai-chat".into(),
            model: "glm-5".into(),
            route_id: Some("xiaomi/glm-5".into()),
            variant: None,
            provider: Some("xiaomi".into()),
            account: None,
        }];
        app.remembered_model = None;
        app.catalog = vec![crate::session::SessionSummary {
            id: "ses_a".into(),
            model: Some("xiaomi/glm-5".into()),
            updated_at_ms: Some(2),
            title: None,
            parent_id: None,
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: None,
            credential_id: None,
            preview: None,
        }];
        app.update_status();
        assert_eq!(
            app.shell.status.model.as_deref(),
            Some("glm-5 · xiaomi · openai-chat"),
            "a pinned route id still resolves to the catalog entry"
        );
    }

    #[test]
    fn an_unresolved_model_is_not_painted_as_a_name() {
        // Nothing has answered and the settings only hold the sentinel, so the
        // strip says nothing; the notice beside it carries the fix.
        let mut app = session_app();
        app.set_settings(engine::Settings {
            spawn: crate::transport::EngineSpawn {
                program: PathBuf::from("/bin/true"),
                args: Vec::new(),
                env: Vec::new(),
            },
            model: engine::UNROUTED_MODEL.to_string(),
            embedded: true,
        });
        app.update_status();
        assert_eq!(app.shell.status.model, None);
    }

    #[test]
    fn several_blocking_requests_are_counted_in_the_status() {
        // JOB-04: one approval reads as one tool, but a queue of them has to
        // say how many are waiting — otherwise the operator clears one and
        // cannot tell whether anything is left.
        let approval = |id: &str| crate::session::ApprovalView {
            request_id: id.into(),
            tool: "bash".into(),
            resource: "ls".into(),
            input: serde_json::json!({ "command": "ls" }),
            input_hash: "a".repeat(64),
            policy_revision: "rev-1".into(),
            matcher: None,
            expires_at_ms: None,
        };
        let question = |id: &str| crate::session::QuestionView {
            question_id: id.into(),
            input_hash: "b".repeat(64),
            expires_at_ms: None,
            questions: vec![crate::session::QuestionItem {
                question: "Ship it?".into(),
                header: "confirm".into(),
                options: Vec::new(),
                multi_select: false,
                custom: true,
            }],
        };

        let cases = [
            (
                vec![approval("run-1/a1"), approval("run-1/a2")],
                Vec::new(),
                "needs approval · 2 waiting",
            ),
            (
                Vec::new(),
                vec![question("run-1/q1"), question("run-1/q2")],
                "needs an answer · 2 waiting",
            ),
            (
                vec![approval("run-1/a1")],
                vec![question("run-1/q1")],
                "needs you · 1 approval · 1 question",
            ),
        ];
        for (approvals, questions, expected) in cases {
            let mut app = session_app();
            let state = SessionState {
                approvals,
                questions,
                ..SessionState::default()
            };
            app.handle(AppEvent::SessionOpened {
                summary: None,
                transcript: Box::new(Transcript::default()),
                state: Box::new(state),
            });
            app.update_status();
            assert_eq!(app.shell.title.status(), Some(expected));
            assert!(
                app.shell.title.status_alert(),
                "{expected} is a wait the operator has to act on"
            );
        }
    }

    #[test]
    fn a_pending_approval_opens_a_panel_and_blocks_typing() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(approval_state()),
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
            state: Box::new(state),
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
            state: Box::new(state),
        });
        assert_eq!(app.shell.composer.phase.as_deref(), Some("Working"));
        app.state.active_run = None;
        app.update_status();
        assert!(
            app.shell.composer.phase.is_none(),
            "an idle Session keeps the composer title quiet"
        );
    }

    /// A run can be admitted and moving before any `provider.*` frame arrives.
    /// The status used to fall back to a bare, colourless "Working" for that
    /// whole window, which reads exactly like a wedged turn: no clock, no tone,
    /// nothing to show the engine is alive.
    #[test]
    fn a_run_with_no_frame_yet_still_shows_a_clock() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState {
                active_run: Some("run-1".into()),
                ..SessionState::default()
            }),
        });
        assert_eq!(app.shell.composer.phase.as_deref(), Some("Working"));
        // The very first status frame anchors the clock, so the elapsed value
        // starts at zero rather than staying absent.
        assert!(
            app.shell.composer.phase_elapsed.is_some(),
            "a run with no frame yet still has a clock: {:?}",
            app.shell.composer.phase
        );
        assert!(
            !app.shell.composer.phase_alert,
            "a fresh run is not alerting"
        );

        // The clock is re-read on every frame, so a wait that crosses the
        // half-minute mark turns the title warning-colored even though the
        // engine has still said nothing.
        app.run_since = Some(("run-1".into(), Instant::now() - Duration::from_secs(31)));
        app.update_status();
        assert!(
            app.shell.composer.phase_alert,
            "a silent 31-second run is alerting"
        );

        // A new run restarts the clock rather than inheriting the old wait.
        app.state.active_run = Some("run-2".into());
        app.update_status();
        assert!(
            !app.shell.composer.phase_alert,
            "a new run starts its own clock: {:?}",
            app.shell.composer.phase_elapsed
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
            state: Box::new(state),
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

    /// `--auto` widens what runs without asking. A Session that stops
    /// prompting has to read as a policy in effect, not as the absence of one.
    #[test]
    fn an_auto_session_says_so_in_the_status_strip() {
        let mut app = app_with(Startup {
            session: None,
            continue_last: false,
            prompt: None,
            fork: false,
            auto: true,
            ..Startup::default()
        });
        app.update_status();
        let hints: Vec<&str> = app
            .shell
            .status
            .hints
            .iter()
            .map(|hint| hint.text.as_str())
            .collect();
        assert!(hints.contains(&"auto-approve"), "{hints:?}");
        assert!(
            app.shell.status.hints.iter().any(|hint| hint.warning),
            "a widened policy is not a quiet default: {hints:?}"
        );
    }

    #[test]
    fn a_default_session_carries_no_auto_hint() {
        let mut app = app_with(Startup {
            session: None,
            continue_last: false,
            prompt: None,
            fork: false,
            auto: false,
            ..Startup::default()
        });
        app.update_status();
        let hints: Vec<&str> = app
            .shell
            .status
            .hints
            .iter()
            .map(|hint| hint.text.as_str())
            .collect();
        assert!(!hints.contains(&"auto-approve"), "{hints:?}");
    }

    #[test]
    fn opening_a_session_follows_its_newest_turn_again() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
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
            state: Box::new(SessionState::default()),
        });
        app.shell.scroll_transcript(-3);
        assert!(!app.shell.following(), "scrolling up detaches");
        // Opening a Session must not inherit that: it shows the newest turn.
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
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
            state: Box::new(state),
        });
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Session);
    }

    fn running_app(run_id: &str) -> App {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState {
                active_run: Some(run_id.into()),
                ..SessionState::default()
            }),
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
        assert_eq!(app.shell.title.status(), Some("Working · Esc interrupt"));
        app.handle(provider_frame("provider.waiting"));
        app.update_status();
        assert_eq!(
            app.shell.title.status(),
            Some("Waiting for model · Esc interrupt")
        );
        // A token ends the wait; committed content carries the turn from here.
        app.handle(provider_frame("provider.delta"));
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("Working · Esc interrupt"));
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
            Some("Retrying · attempt 2 · Esc interrupt")
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
            Some("Waiting for model · no engine signal 20.0s · Esc interrupt")
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
        assert_eq!(app.shell.title.status(), Some("Working · Esc interrupt"));
    }

    #[test]
    fn a_projection_for_another_run_drops_the_live_phase() {
        let mut app = running_app("run-1");
        app.handle(provider_frame("provider.waiting"));
        assert!(app.live.is_some());
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState {
                active_run: Some("run-2".into()),
                ..SessionState::default()
            }),
        });
        assert!(app.live.is_none());
    }

    #[test]
    fn mcp_lsp_and_subagent_waits_are_named_by_the_tool_that_blocks() {
        // JOB-04 asks for wait reasons when execution blocks on MCP, LSP or a
        // subagent. The TUI does not need a separate vocabulary for those: each
        // is a tool call, and the status names the tool that is running. This
        // pins that, so a future phase model cannot drop the name silently.
        // Each pair is the engine's own spelling and what the status shows.
        for (name, shown) in [
            ("mcp__github__create_issue", "github/create_issue"),
            ("lsp_diagnostics", "lsp_diagnostics"),
            ("task", "task"),
        ] {
            let mut app = running_app("run-1");
            app.handle(AppEvent::Provider(serde_json::json!({
                "kind": "tool.planned",
                "run_id": "run-1",
                "name": name,
            })));
            app.update_status();
            let status = app.shell.title.status().unwrap_or_default();
            assert!(
                status.starts_with(&format!("Running {shown}")),
                "{name} is named as {shown}, not clipped: {status}"
            );
        }
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
            Some("Running bash · Esc interrupt")
        );
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "tool.completed",
            "run_id": "run-1",
        })));
        app.update_status();
        assert_eq!(app.shell.title.status(), Some("Working · Esc interrupt"));
    }

    #[test]
    fn a_planned_tool_rides_the_transcript_tail_until_it_completes() {
        let mut app = running_app("run-1");
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "tool.planned",
            "run_id": "run-1",
            "name": "bash",
        })));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal
            .draw(|frame| app.shell.render(frame))
            .expect("draw");
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        // The transcript tail row keeps its own lowercase spelling; the status
        // strip's "Running bash" is asserted separately.
        assert!(text.contains("running bash"), "{text}");
        app.handle(AppEvent::Provider(serde_json::json!({
            "kind": "tool.completed",
            "run_id": "run-1",
        })));
        terminal
            .draw(|frame| app.shell.render(frame))
            .expect("draw");
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(!text.contains("running bash"), "{text}");
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
            Some("Running bash · Esc interrupt")
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
        assert_eq!(waited(Duration::from_secs(9)), "9.0s");
        assert_eq!(waited(Duration::from_secs(65)), "1m 5s");
    }

    /// The frame shape the engine actually publishes, copied from a logged
    /// turn: `data` is a delta *envelope* — `{"kind":"delta","delta":{…},
    /// "raw":{…}}` — and the normalized delta sits under `data.delta`. A
    /// helper that put it directly on `data` made the reader look one level
    /// too high, which is exactly how a real turn's text went missing while
    /// the tests stayed green.
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
            .map(|row| {
                row.line
                    .spans
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
            state: Box::new(SessionState {
                active_run: active_run.map(str::to_string),
                ..SessionState::default()
            }),
        }
    }

    #[test]
    fn a_streamed_answer_appears_before_the_turn_commits() {
        let mut app = running_app("run-1");
        app.handle(delta_frame("run-1", "text.delta", "Hel"));
        app.handle(delta_frame("run-1", "text.delta", "lo"));
        let draft = app.draft.as_ref().expect("a streaming draft");
        assert_eq!(draft.text(), "Hello");
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
        assert_eq!(draft.reasoning(), "weighing");
        assert!(draft.text().is_empty(), "reasoning is not the answer");
        // With no answer yet the thinking is one muted header line.
        assert!(drafted(&mut app).contains("Thinking · weighing"));
        app.handle(delta_frame("run-1", "text.delta", "the answer"));
        let shown = drafted(&mut app);
        assert!(shown.contains("Thinking · weighing"));
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
            .is_some_and(|draft| draft.text() == "Hello"));
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
            state: Box::new(SessionState::default()),
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
            state: Box::new(state),
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
            state: Box::new(state),
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
            state: Box::new(SessionState::default()),
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
            state: Box::new(SessionState::default()),
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
            state: Box::new(SessionState::default()),
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
    fn ctrl_o_lists_the_providers_that_hold_an_account_then_their_accounts() {
        let mut app = session_app();
        open_session(&mut app, "ses_a");
        app.handle(key(KeyCode::Char('o'), KeyModifiers::CONTROL));
        assert!(app.pending_accounts);
        app.handle(AppEvent::Accounts(vec![
            AccountInfo {
                credential_id: "cred_a".into(),
                provider: Some("zhipu".into()),
                detail: "glm-5".into(),
            },
            AccountInfo {
                credential_id: "cred_b".into(),
                provider: Some("openai".into()),
                detail: "gpt-5".into(),
            },
            AccountInfo {
                credential_id: "cred_c".into(),
                provider: Some("openai".into()),
                detail: "gpt-5-mini".into(),
            },
        ]));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert_eq!(list.title, "provider accounts");
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "all accounts" && row.detail == "3 accounts"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "openai" && row.detail == "2 accounts"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "zhipu" && row.detail == "1 account"));
        // Down from the `all` row lands on the first provider holding an
        // account; Enter narrows to that provider's accounts.
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert_eq!(list.title, "accounts");
        assert_eq!(
            list.rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cred_b", "cred_c"]
        );
        // The narrowed list starts on its first account, so one step down
        // lands on the second one.
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|s| s.credential_id.as_deref()),
            Some("cred_c")
        );
    }

    #[test]
    fn ctrl_o_opens_the_provider_list_on_the_landing_screen() {
        let mut app = app();
        app.handle(key(KeyCode::Char('o'), KeyModifiers::CONTROL));
        assert!(app.pending_accounts);
        app.handle(AppEvent::Accounts(vec![AccountInfo {
            credential_id: "cred_a".into(),
            provider: Some("openai".into()),
            detail: "gpt-5".into(),
        }]));
        // The landing screen has no Session to switch, so the list is all it
        // shows; the notice arrives only when an account is chosen.
        assert!(matches!(app.dialog, Some(Dialog::ProviderAccounts(_))));
        app.handle(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.home.notice(), Some("open a Session to switch accounts"));
    }

    /// Accounts only exist for catalog routes that name a credential, so a
    /// per-provider configuration (auth.json keys, OAuth) answers with none.
    /// ctrl+o must still show something: the provider list is never empty.
    #[test]
    fn ctrl_o_falls_back_to_the_provider_list_when_no_account_is_stored() {
        let mut app = app();
        app.handle(key(KeyCode::Char('o'), KeyModifiers::CONTROL));
        assert!(app.pending_accounts);
        app.handle(AppEvent::Accounts(Vec::new()));
        assert!(app.pending_providers);
        app.handle(AppEvent::ProviderCatalog(serde_json::json!({
            "providers": [
                { "id": "volcengine", "name": "Volcengine Ark", "models": 16, "configured": true }
            ]
        })));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert_eq!(list.title, "providers");
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "Volcengine Ark" && row.detail == "16 models · ready"));
    }

    #[test]
    fn choosing_a_provider_narrows_the_model_picker_to_it() {
        let mut app = session_app();
        app.models = vec![
            ModelInfo {
                protocol: "openai-chat".into(),
                model: "gpt-5".into(),
                route_id: Some("openai/gpt-5".into()),
                variant: None,
                provider: Some("openai".into()),
                account: None,
            },
            ModelInfo {
                protocol: "openai-chat".into(),
                model: "glm-5".into(),
                route_id: Some("zhipu/glm-5".into()),
                variant: None,
                provider: Some("zhipu".into()),
                account: None,
            },
        ];
        leader(&mut app, 'a');
        app.handle(AppEvent::ProviderCatalog(serde_json::json!({
            "providers": [
                { "id": "openai", "name": "OpenAI", "models": 1, "configured": true },
                { "id": "zhipu", "name": "Zhipu", "models": 1, "configured": true }
            ]
        })));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert_eq!(list.title, "models");
        assert_eq!(app.models_filter.as_deref(), Some("openai"));
        assert!(list.rows.iter().any(|row| row.label.contains("gpt-5")));
        assert!(!list.rows.iter().any(|row| row.label.contains("glm-5")));
    }

    /// A provider the engine serves no model of opens the key prompt. Sending
    /// an operator to `miao auth login` meant leaving the TUI for a shell, and
    /// the running engine could not have reflected the result anyway; pasting
    /// the key here stores it in the file a restarted engine reads.
    #[test]
    fn choosing_an_unconfigured_provider_opens_the_key_prompt() {
        let mut app = session_app();
        leader(&mut app, 'a');
        app.handle(AppEvent::ProviderCatalog(serde_json::json!({
            "providers": [
                { "id": "opencode-go", "name": "OpenCode Go", "models": 37, "configured": false }
            ]
        })));
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        let sign_in = app
            .dialog
            .as_ref()
            .and_then(Dialog::sign_in)
            .expect("prompt");
        assert_eq!(sign_in.provider, "opencode-go");
        assert_eq!(sign_in.name, "OpenCode Go");
    }

    /// A pasted key has to reach the prompt that asked for it. Keystrokes were
    /// already modal, but a paste carries its own event: it fell through to the
    /// composer while the provider prompt stayed empty, so the operator saw the
    /// key appear in the wrong place and Enter submitted an empty prompt.
    #[test]
    fn a_pasted_key_reaches_the_provider_prompt_instead_of_the_composer() {
        let mut app = session_app();
        app.shell.composer.editor.set_text("keep this draft");
        app.open_dialog(Dialog::sign_in_prompt("opencode-go", "OpenCode Go"));
        app.handle(AppEvent::Paste("oc_sk_pasted".into()));
        assert_eq!(
            app.shell.composer.editor.text(),
            "keep this draft",
            "the composer underneath keeps the draft it had"
        );
        let sign_in = app
            .dialog
            .as_ref()
            .and_then(Dialog::sign_in)
            .expect("prompt");
        assert_eq!(sign_in.input.text(), "oc_sk_pasted");
    }

    /// Submitting the prompt stores the key and restarts the engine: routes are
    /// built at startup, so a new engine process is what makes the provider's
    /// models appear and the operator never restarts miao for it.
    #[test]
    fn submitting_the_key_stores_it_and_restarts_the_engine() {
        let mut app = session_app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        let dir = std::env::temp_dir().join(format!("miao-sign-in-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = dir.join("miao.db");
        app.credential_store = Some(store.clone());
        app.open_dialog(Dialog::sign_in_prompt("opencode-go", "OpenCode Go"));
        for character in "sk-test".chars() {
            app.handle(key(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "the prompt closes on submit");
        let listed = miao_engine::credential::list_database(&store).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].integration, "opencode-go");
        assert_eq!(listed[0].label, "default");
        assert!(
            matches!(
                requests.try_recv(),
                Ok(engine::Request::ReloadProviderRoutes)
            ),
            "the engine is restarted so the stored key can serve its models"
        );
        let notice = app.shell.composer.notice.clone().expect("notice");
        assert!(
            notice.contains("restarting the engine"),
            "says what happens next: {notice}"
        );
        assert!(
            !notice.contains("restart miao"),
            "the operator is not asked to restart miao: {notice}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A running turn is worth more than the new models: the restart that serves
    /// a stored key would cancel it, so the reload waits for the Session to go
    /// idle and then happens on its own.
    #[test]
    fn a_stored_key_waits_for_a_running_turn_before_the_engine_restarts() {
        let mut app = session_app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        let dir = std::env::temp_dir().join(format!("miao-sign-in-busy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        app.credential_store = Some(dir.join("miao.db"));
        app.state.active_run = Some("run_1".into());
        app.open_dialog(Dialog::sign_in_prompt(
            "zhipuai-coding-plan",
            "Zhipu AI Coding Plan",
        ));
        for character in "sk-test".chars() {
            app.handle(key(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(
            requests.try_recv().is_err(),
            "the running turn keeps the engine alive"
        );
        assert!(app.pending_routes_reload);
        let notice = app.shell.composer.notice.clone().expect("notice");
        assert!(
            notice.contains("when this turn finishes"),
            "says when the models arrive: {notice}"
        );
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        assert!(
            matches!(
                requests.try_recv(),
                Ok(engine::Request::ReloadProviderRoutes)
            ),
            "the idle Session releases the restart"
        );
        assert!(!app.pending_routes_reload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_provider_list_renders_the_engine_catalog() {
        let mut app = app();
        leader(&mut app, 'a');
        assert!(app.pending_providers);
        app.handle(AppEvent::ProviderCatalog(serde_json::json!({
            "providers": [
                { "id": "openai", "name": "OpenAI", "models": 12, "configured": true },
                { "id": "zhipu", "name": "Zhipu", "models": 4, "configured": false }
            ]
        })));
        let list = app.dialog.as_ref().and_then(Dialog::list).expect("list");
        assert_eq!(list.title, "providers");
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "OpenAI" && row.detail == "12 models · ready"));
        assert!(list
            .rows
            .iter()
            .any(|row| row.label == "Zhipu" && row.detail == "4 models · needs auth"));
        assert_eq!(
            app.providers_needing_auth,
            vec![("zhipu".to_string(), "Zhipu".to_string())]
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

    /// `ctrl+z` is shared with the page's suspend, so the composer has to win
    /// it whenever it has a step to take back — otherwise typing a prompt and
    /// reaching for undo stops the whole process instead.
    /// `ctrl+c` clears the draft before it quits, on the landing screen too: a
    /// prompt typed before any Session exists must survive a stray keystroke.
    #[test]
    fn ctrl_c_clears_a_landing_draft_instead_of_quitting() {
        let mut app = app();
        assert_eq!(app.screen, Screen::Home);
        for c in "draft".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.shell.composer.editor.text(), "draft");
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(app.shell.composer.editor.text(), "", "the draft is cleared");
        assert!(!app.quit, "the app keeps running with a cleared draft");
        // The clear is an editing step, so the same draft comes back on undo —
        // `ctrl+-`, which leaves `ctrl+z` to the page.
        app.handle(key(KeyCode::Char('-'), KeyModifiers::CONTROL));
        assert_eq!(app.shell.composer.editor.text(), "draft");
    }

    /// With nothing to clear the stroke keeps its page meaning and quits.
    #[test]
    fn ctrl_c_quits_the_landing_screen_with_an_empty_draft() {
        let mut app = app();
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }

    /// A selection is what the operator just chose, so the copy keystroke takes
    /// it instead of the last response.
    #[test]
    fn copying_prefers_the_selection_over_the_last_response() {
        let mut app = session_app();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript {
                entries: vec![crate::session::Entry::Assistant {
                    agent: Some("build".into()),
                    model: Some("glm-5.3-flash".into()),
                    parts: vec![crate::session::Part::Text("answer".into())],
                }],
                ..Transcript::default()
            }),
            state: Box::new(SessionState::default()),
        });
        // Without a selection the copy falls back to the response.
        assert_eq!(
            app.copy_target(),
            Some(("answer".to_string(), "copied the last response"))
        );
        for c in "picked".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        for _ in 0..6 {
            app.handle(key(KeyCode::Left, KeyModifiers::SHIFT));
        }
        assert_eq!(
            app.copy_target(),
            Some(("picked".to_string(), "copied the selection"))
        );
        // With neither, the keystroke says so instead of copying something else.
        app.shell.composer.editor.clear();
        app.handle(AppEvent::SessionOpened {
            summary: None,
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        assert_eq!(app.copy_target(), None);
    }

    /// `shift` on the composer's own motions selects, and backspace removes
    /// exactly the selection rather than one more character.
    #[test]
    fn shift_arrows_select_text_in_the_composer() {
        let mut app = session_app();
        for c in "abc".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Left, KeyModifiers::SHIFT));
        app.handle(key(KeyCode::Left, KeyModifiers::SHIFT));
        assert_eq!(app.shell.composer.editor.selected_text(), Some("bc"));
        app.handle(key(KeyCode::Backspace, KeyModifiers::NONE));
        assert_eq!(app.shell.composer.editor.text(), "a");
        assert!(
            !app.shell.composer.editor.selecting(),
            "the selection is gone"
        );
    }

    /// A plain motion ends the selection without touching the text.
    #[test]
    fn a_plain_motion_ends_the_selection() {
        let mut app = session_app();
        for c in "abc".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Left, KeyModifiers::SHIFT));
        assert!(app.shell.composer.editor.selecting());
        app.handle(key(KeyCode::Left, KeyModifiers::NONE));
        assert!(!app.shell.composer.editor.selecting());
        assert_eq!(app.shell.composer.editor.text(), "abc", "the text is kept");
    }

    /// The composer's undo uses `ctrl+-`, the chord the TypeScript composer
    /// binds, so it never has to compete with the page's `ctrl+z` suspend.
    #[test]
    fn ctrl_minus_undoes_the_draft() {
        let mut app = session_app();
        for c in "draft".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.shell.composer.editor.text(), "draft");
        app.handle(key(KeyCode::Char('-'), KeyModifiers::CONTROL));
        assert_eq!(
            app.shell.composer.editor.text(),
            "",
            "the run came back off"
        );
        assert!(!app.suspend_requested, "undo is not a suspend");
    }

    /// `Ctrl+Z` keeps its page meaning even with a draft: job control has to
    /// stay reachable while a prompt is half typed, and the draft survives the
    /// round trip to the shell. Windows has no job control to suspend to, so
    /// the stroke exists only where suspending means something.
    #[cfg(unix)]
    #[test]
    fn ctrl_z_still_suspends_with_a_draft() {
        let mut app = session_app();
        for c in "abc".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert!(app.suspend_requested, "the page still owns ctrl+z");
        assert_eq!(app.shell.composer.editor.text(), "abc", "the draft is kept");
    }

    /// Redo re-applies the undone run on the composer's own chord.
    #[test]
    fn ctrl_period_reapplies_the_undone_draft() {
        let mut app = session_app();
        for c in "abc".chars() {
            app.handle(key(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.handle(key(KeyCode::Char('-'), KeyModifiers::CONTROL));
        assert_eq!(app.shell.composer.editor.text(), "");
        app.handle(key(KeyCode::Char('.'), KeyModifiers::CONTROL));
        assert_eq!(
            app.shell.composer.editor.text(),
            "abc",
            "redo reapplies the run"
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
    /// The rust-only TUI is the host on this path and has no title model, so it
    /// names a new Session from the first prompt — once, and only while the
    /// title is still the placeholder the product created it with.
    #[test]
    fn opening_a_placeholder_session_names_it_from_the_first_prompt() {
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        let mut named = summary("ses_a", 10);
        named.title = Some("New session".into());
        let transcript = || {
            Box::new(Transcript {
                entries: vec![Entry::User {
                    text: "fix  the parser".into(),
                    seq: 3,
                }],
                ..Transcript::default()
            })
        };
        app.handle(AppEvent::SessionOpened {
            summary: Some(named.clone()),
            transcript: transcript(),
            state: Box::new(SessionState::default()),
        });
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Rename { session_id, title })
                if session_id == "ses_a" && title == "fix the parser"
        ));
        // A snapshot arriving before the rename lands must not name it again.
        app.handle(AppEvent::SessionOpened {
            summary: Some(named),
            transcript: transcript(),
            state: Box::new(SessionState::default()),
        });
        assert!(requests.try_recv().is_err(), "named twice");
    }

    /// A Session the product already named keeps its title.
    #[test]
    fn an_already_named_session_is_left_alone() {
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        let mut named = summary("ses_a", 10);
        named.title = Some("auth refactor".into());
        app.handle(AppEvent::SessionOpened {
            summary: Some(named),
            transcript: Box::new(Transcript {
                entries: vec![Entry::User {
                    text: "something else".into(),
                    seq: 3,
                }],
                ..Transcript::default()
            }),
            state: Box::new(SessionState::default()),
        });
        assert!(requests.try_recv().is_err(), "renamed an operator's title");
    }

    /// Sending the first prompt names a placeholder Session straight away: the
    /// sidebar and the terminal tab read the prompt, not "New session", for the
    /// rest of the turn instead of waiting for some later reopen.
    #[test]
    fn submitting_the_first_prompt_names_the_session_and_its_tab() {
        let mut app = app();
        let (handle, mut requests) = engine::Handle::recording();
        app.attach_engine(handle);
        let mut opened = summary("ses_a", 10);
        opened.title = Some("New session".into());
        app.handle(AppEvent::SessionOpened {
            summary: Some(opened),
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        app.submit("fix the parser".into(), Vec::new());
        assert!(matches!(
            requests.try_recv(),
            Ok(engine::Request::Rename { session_id, title })
                if session_id == "ses_a" && title == "fix the parser"
        ));
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|session| session.title.as_deref()),
            Some("fix the parser")
        );
        assert_eq!(app.terminal_title().as_deref(), Some("fix the parser"));
    }

    /// The sidebar follows the ledger: a title or an age that changed upstream
    /// reaches the open Session when the home list refreshes.
    #[test]
    fn a_refreshed_list_brings_the_open_sessions_title_and_age_to_the_sidebar() {
        let mut app = app();
        let mut opened = summary("ses_a", 10);
        opened.title = Some("New session".into());
        app.handle(AppEvent::SessionOpened {
            summary: Some(opened),
            transcript: Box::new(Transcript::default()),
            state: Box::new(SessionState::default()),
        });
        let mut renamed = summary("ses_a", 99);
        renamed.title = Some("auth refactor".into());
        app.handle(AppEvent::Sessions(vec![renamed]));
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|session| session.title.as_deref()),
            Some("auth refactor")
        );
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|session| session.updated_at_ms),
            Some(99)
        );
        // A list computed before that rename landed, and older than what the
        // sidebar already shows, must not take either back.
        let mut stale = summary("ses_a", 5);
        stale.title = Some("New session".into());
        app.handle(AppEvent::Sessions(vec![stale]));
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|session| session.title.as_deref()),
            Some("auth refactor")
        );
        assert_eq!(
            app.session
                .as_ref()
                .and_then(|session| session.updated_at_ms),
            Some(99)
        );
    }

    #[test]
    fn only_the_creation_titles_count_as_placeholders() {
        for placeholder in ["", "untitled", "New session", "run"] {
            assert!(placeholder_title(placeholder), "{placeholder:?}");
        }
        assert!(!placeholder_title("auth refactor"));
        assert!(!placeholder_title("run the tests, then report"));
        assert_eq!(
            title_from_prompt("  ship   the  fix\nand then rest").as_deref(),
            Some("ship the fix")
        );
        assert_eq!(title_from_prompt("   "), None);
        let long = title_from_prompt(&"a".repeat(100)).expect("title");
        assert_eq!(long.chars().count(), 61);
        assert!(long.ends_with('…'));
    }

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
            state: Box::new(SessionState::default()),
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

/// The host's own credential export, used until the engine's catalog answers.
/// The TS host passes one row per active credential (`integrationID`, label),
/// so the list is never empty on a machine that already has accounts.
fn seed_providers(raw: Option<&str>) -> Vec<ProviderEntry> {
    parse_pairs(raw)
        .into_iter()
        .map(|(name, detail)| ProviderEntry {
            id: name.clone(),
            name,
            detail,
            configured: true,
            // The export carries one row per active credential.
            accounts: 1,
        })
        .collect()
}

fn accounts_label(count: usize) -> String {
    match count {
        1 => "1 account".to_string(),
        count => format!("{count} accounts"),
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
