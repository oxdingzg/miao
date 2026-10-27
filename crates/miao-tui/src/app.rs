use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent, MouseEventKind};
use ratatui::Frame;
use serde_json::Value;

use crate::commands::{self, Builtin};
use crate::dialogs::{AccountInfo, Action as DialogAction, ConfirmKind, Dialog, ModelInfo, Row};
use crate::editor::Action;
use crate::engine;
use crate::event::{AppEvent, Bus};
use crate::keybinds::{self, Keymap};
use crate::pane::{render_dialog, Home, Pane, Panel, PanelKind, Shell};
use crate::platform::attention::{self, Attention};
use crate::platform::{clipboard, editor, zed};
use crate::session::{SessionState, SessionSummary};
use crate::state::{self, StashEntry};
use crate::status::UsageSummary;
use crate::theme::{self, Theme};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// The Session list that opens the TUI.
    Home,
    /// One Session's transcript plus composer.
    Session,
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
    dialog: Option<Dialog>,
    /// `Ctrl+X` was pressed; the next key completes the chord.
    leader: bool,
    keys: Keymap,
    workspace: PathBuf,
    /// What the engine was started with, shown by the debug dialog.
    settings: Option<engine::Settings>,
    models: Vec<ModelInfo>,
    accounts: Vec<AccountInfo>,
    usage: Option<UsageSummary>,
    stash: Vec<StashEntry>,
    /// Every root Session, archived included, for the Session dialog.
    catalog: Vec<SessionSummary>,
    /// The model dialog waits for the catalog when nothing is cached yet.
    pending_models: bool,
    /// Same for the account dialog.
    pending_accounts: bool,
    /// Template commands discovered at startup; a slash prompt naming one is
    /// rendered and admitted as a command instead of plain text.
    templates: Vec<commands::Template>,
    attention: Attention,
    /// Set once the engine is attached; clipboard reads report back through it.
    bus: Option<Bus>,
    pending_editor: Option<editor::Request>,
    /// Approval and question ids already announced.
    notified: Vec<String>,
    /// The Zed selection already sent with an earlier prompt.
    zed_selection_key: Option<String>,
    clipboard_busy: bool,
    startup: Startup,
    /// Built-in plus custom themes, in menu order.
    themes: theme::Catalog,
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
        Self {
            shell,
            home,
            screen: Screen::Home,
            engine: None,
            session: None,
            state: SessionState::default(),
            quit: false,
            dialog: None,
            leader: false,
            keys,
            workspace,
            settings: None,
            models: Vec::new(),
            accounts: Vec::new(),
            usage: None,
            stash: Vec::new(),
            catalog: Vec::new(),
            pending_models: false,
            pending_accounts: false,
            templates,
            attention: Attention::new(attention_config),
            bus: None,
            pending_editor: None,
            notified: Vec::new(),
            zed_selection_key: None,
            clipboard_busy: false,
            startup,
            themes,
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

    pub fn attach_engine(&mut self, engine: engine::Handle) {
        self.engine = Some(engine);
    }

    pub fn set_settings(&mut self, settings: engine::Settings) {
        self.settings = Some(settings);
    }

    pub fn render(&mut self, frame: &mut Frame) {
        match self.screen {
            Screen::Home => {
                // The home list keeps the title bar so the workspace under
                // view stays visible before a Session is open.
                let [title, body] = ratatui::layout::Layout::vertical([
                    ratatui::layout::Constraint::Length(1),
                    ratatui::layout::Constraint::Min(1),
                ])
                .areas(frame.area());
                self.shell.title.render(frame, title);
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
                        self.open_dialog(Dialog::models(&self.models));
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
            AppEvent::Usage(usage) => {
                self.usage = Some(usage);
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
                self.session = summary;
                if let Some(summary) = &self.session {
                    match self.catalog.iter_mut().find(|row| row.id == summary.id) {
                        Some(row) => *row = summary.clone(),
                        None => self.catalog.push(summary.clone()),
                    }
                }
                self.state = state;
                self.shell.set_session(self.session.as_ref());
                self.shell.set_transcript(&transcript);
                self.screen = Screen::Session;
                self.sync_panel();
                self.update_status();
                self.continue_prompt();
            }
            AppEvent::ActionFailed(message) => {
                self.shell.composer.notice = Some(message);
            }
            AppEvent::PromptFailed {
                text,
                attachments,
                message,
            } => {
                self.shell.composer.restore_with(&text, attachments);
                self.shell.composer.notice = Some(message);
            }
            AppEvent::EngineFailure(message) => {
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
            self.leader = false;
            self.handle_leader(key);
            return;
        }
        if self.keys.is_leader(&key) {
            self.leader = true;
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
        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return,
        };
        if self.dialog.is_some() {
            if let Some(list) = self.dialog.as_mut().and_then(Dialog::list_mut) {
                list.move_cursor(delta);
            }
            return;
        }
        // A stray wheel event must not leave the leader armed.
        self.leader = false;
        match self.screen {
            Screen::Home => self.home.move_cursor(delta),
            Screen::Session => self.shell.scroll_transcript(delta * 3),
        }
    }

    fn handle_dialog_key(&mut self, key: KeyEvent) {
        let Some(dialog) = self.dialog.as_mut() else {
            return;
        };
        let action = dialog.handle_key(key);
        self.dialog_action(action);
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
            Some(keybinds::Action::AppExit) => self.run_builtin(Builtin::Quit),
            _ => {}
        }
    }

    fn run_builtin(&mut self, builtin: Builtin) {
        match builtin {
            Builtin::Models => self.open_models(),
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
        self.open_dialog(Dialog::models(&self.models));
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
        rows.push(row(
            "keys",
            "Esc back · ctrl+r rename · ctrl+o accounts · ctrl+p commands · PgUp/PgDn scroll",
        ));
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
            DialogAction::None => {}
            DialogAction::Close => self.dialog = None,
            DialogAction::Chosen(index) => self.choose(index),
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
            DialogAction::Remove(id) => {
                let title = self.title_of(&id);
                self.open_dialog(Dialog::confirm_remove(&id, &title));
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
                }
            }
            DialogAction::Confirmed(kind) => {
                let ConfirmKind::RemoveSession(id) = kind;
                self.dialog = None;
                if let Some(engine) = self.engine.as_ref() {
                    engine.remove(&id);
                }
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
    }

    fn open_status(&mut self) {
        let Some(session_id) = self.session_id() else {
            self.notice("open a Session to see status");
            return;
        };
        self.usage = None;
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

    fn notice(&mut self, message: &str) {
        match self.screen {
            Screen::Home => self.home.set_notice(Some(message.to_string())),
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
            (KeyCode::Char('n'), KeyModifiers::NONE) => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.new_session();
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
            if self.reject_question() {
                return;
            }
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
        match self.shell.composer.handle_key(key, &self.keys) {
            Action::None => {}
            Action::Quit => self.quit = true,
            Action::Submit { text, attachments } => self.submit(text, attachments),
        }
    }

    /// Panel keys are a closed vocabulary: a decision is blocking, so typing
    /// must not leak into the composer while one is on screen.
    fn handle_panel_key(&mut self, key: KeyEvent) -> bool {
        let Some(panel) = self.shell.panel.as_mut() else {
            return false;
        };
        let session_id = self.session.as_ref().map(|session| session.id.clone());
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
            PanelKind::Question(_) => match key.code {
                KeyCode::Up | KeyCode::Char('k') => panel.move_cursor(-1),
                KeyCode::Down | KeyCode::Char('j') => panel.move_cursor(1),
                KeyCode::Char(' ') => panel.toggle(),
                KeyCode::Enter => {
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

    fn update_status(&mut self) {
        if self.screen != Screen::Session {
            self.shell.title.set_status(None);
            return;
        }
        let status = match (&self.state.active_run, self.state.pending) {
            (Some(_), 0) => "working · Esc interrupt".to_string(),
            (Some(_), queued) => format!("working · {queued} queued · Esc interrupt"),
            (None, 0) => "idle".to_string(),
            (None, queued) => format!("idle · {queued} queued"),
        };
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
        // A first-word slash command the TUI knows runs here; a discovered
        // template is rendered and admitted with its command reference; any
        // other slash text is a plain prompt, like the TS composer.
        if let Some((name, arguments)) = commands::split(&text) {
            if let Some(builtin) = Builtin::from_name(&name) {
                self.run_builtin(builtin);
                return;
            }
            if let Some(template) = self.templates.iter().find(|item| item.name == name) {
                let prompt = commands::render_template(&template.template, &arguments);
                engine.command(&session_id, &prompt, &text, &name, &arguments);
                return;
            }
        }
        // Editor context is a prompt prefix rather than a wire field: the
        // engine admits one text string, and the TS client does the same.
        let text = match self.zed_context() {
            Some(context) => format!("{context}\n\n{text}"),
            None => text,
        };
        engine.prompt(&session_id, &text, attachments);
    }

    fn leave_session(&mut self) {
        self.screen = Screen::Home;
        self.session = None;
        self.state = SessionState::default();
        self.usage = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Transcript;
    use crate::theme::{self, DEFAULT_THEME};

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
            directory: None,
            model: None,
            credential_id: None,
        }
    }

    fn wheel(kind: MouseEventKind) -> AppEvent {
        AppEvent::Mouse(MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })
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
        }
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
    fn an_unknown_slash_word_still_reaches_the_composer_as_a_prompt() {
        let mut app = engine_session_app();
        app.shell.composer.editor.set_text("/nope plain text");
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert!(app.shell.composer.editor.is_empty());
    }
}
