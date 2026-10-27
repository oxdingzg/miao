use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;

use crate::dialogs::{Action as DialogAction, ConfirmKind, Dialog, ModelInfo};
use crate::editor::Action;
use crate::engine;
use crate::event::AppEvent;
use crate::pane::{render_dialog, Home, Pane, Panel, PanelKind, Shell};
use crate::session::{SessionState, SessionSummary};
use crate::state;
use crate::theme::{self, Theme};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// The Session list that opens the TUI.
    Home,
    /// One Session's transcript plus composer.
    Session,
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
    models: Vec<ModelInfo>,
    /// Every root Session, archived included, for the Session dialog.
    catalog: Vec<SessionSummary>,
    /// The model dialog waits for the catalog when nothing is cached yet.
    pending_models: bool,
}

impl App {
    pub fn new(workspace: PathBuf, theme: Theme) -> Self {
        let home = Home::new(theme.clone());
        Self {
            shell: Shell::new(&workspace, theme),
            home,
            screen: Screen::Home,
            engine: None,
            session: None,
            state: SessionState::default(),
            quit: false,
            dialog: None,
            leader: false,
            models: Vec::new(),
            catalog: Vec::new(),
            pending_models: false,
        }
    }

    pub fn attach_engine(&mut self, engine: engine::Handle) {
        self.engine = Some(engine);
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
                    self.shell.composer.paste(&text);
                }
            }
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
            }
            AppEvent::Models(models) => {
                self.models = models;
                if self.pending_models {
                    self.pending_models = false;
                    self.open_dialog(Dialog::models(&self.models));
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
            }
            AppEvent::ActionFailed(message) => {
                self.shell.composer.notice = Some(message);
            }
            AppEvent::PromptFailed { text, message } => {
                self.shell.composer.restore(&text);
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
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
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
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('x') {
            self.leader = true;
            return;
        }
        match self.screen {
            Screen::Home => self.handle_home_key(key),
            Screen::Session => self.handle_session_key(key),
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
        match key.code {
            KeyCode::Char('m') => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.catalog();
                }
                if self.models.is_empty() {
                    self.pending_models = true;
                    return;
                }
                self.open_dialog(Dialog::models(&self.models));
            }
            KeyCode::Char('t') => {
                let current = self.shell.theme().name.clone();
                self.open_dialog(Dialog::theme(&current));
            }
            KeyCode::Char('l') => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.refresh_sessions();
                }
                self.open_dialog(Dialog::sessions(&self.catalog));
            }
            KeyCode::Char('n') => {
                if let Some(engine) = self.engine.as_ref() {
                    engine.new_session();
                }
            }
            KeyCode::Char('q') => self.quit = true,
            _ => {}
        }
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
                let Some(Dialog::Rename { session_id, .. }) = self.dialog.take() else {
                    return;
                };
                if let Some(engine) = self.engine.as_ref() {
                    engine.rename(&session_id, &title);
                }
                if self.session_id().as_deref() == Some(session_id.as_str()) {
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
        }
    }

    /// The model dialog returns an index into the last catalog; the theme
    /// dialog an index into the built-in names.
    fn choose(&mut self, index: usize) {
        let is_theme = matches!(self.dialog, Some(Dialog::Theme(_)));
        self.dialog = None;
        if is_theme {
            let names = theme::names();
            if let Some(name) = names.get(index) {
                self.apply_theme(name);
            }
            return;
        }
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

    fn apply_theme(&mut self, name: &str) {
        let Some(palette) = theme::builtin(name) else {
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
        match (key.code, key.modifiers) {
            (KeyCode::Char('c' | 'd'), KeyModifiers::CONTROL) => self.quit = true,
            (KeyCode::Char('q'), KeyModifiers::NONE) => self.quit = true,
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
        if key.code == KeyCode::Esc {
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
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
            if self.shell.composer.editor.is_empty() {
                self.quit = true;
                return;
            }
            self.shell.composer.editor.clear();
            self.shell.composer.dismiss_completion();
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('r') {
            if let Some(session) = self.session.as_ref() {
                let dialog = Dialog::rename(&session.id, session.label());
                self.open_dialog(dialog);
            }
            return;
        }
        let ctrl_alt = key.modifiers.contains(KeyModifiers::CONTROL)
            && key.modifiers.contains(KeyModifiers::ALT);
        if matches!(key.code, KeyCode::PageUp) || (ctrl_alt && key.code == KeyCode::Char('y')) {
            self.shell.scroll_transcript(-5);
            return;
        }
        if matches!(key.code, KeyCode::PageDown) || (ctrl_alt && key.code == KeyCode::Char('e')) {
            self.shell.scroll_transcript(5);
            return;
        }
        if self.handle_panel_key(key) {
            return;
        }
        match self.shell.composer.handle_key(key) {
            Action::None => {}
            Action::Quit => self.quit = true,
            Action::Submit(text) => self.submit(text),
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

    fn submit(&mut self, text: String) {
        let Some(session_id) = self.session.as_ref().map(|session| session.id.clone()) else {
            self.shell.composer.restore(&text);
            return;
        };
        let Some(engine) = self.engine.as_ref() else {
            self.shell.composer.restore(&text);
            return;
        };
        self.shell.composer.notice = None;
        engine.prompt(&session_id, &text);
    }

    fn leave_session(&mut self) {
        self.screen = Screen::Home;
        self.session = None;
        self.state = SessionState::default();
        self.shell.panel = None;
        self.shell.set_session(None);
        self.shell.title.set_status(None);
        self.shell.composer.editor.clear();
        self.shell.composer.dismiss_completion();
        self.dialog = None;
        self.leader = false;
        if let Some(engine) = self.engine.as_ref() {
            engine.refresh_sessions();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Transcript;
    use crate::theme::{self, DEFAULT_THEME};

    fn app() -> App {
        let palette = theme::builtin(DEFAULT_THEME).expect("default theme is built in");
        App::new(
            PathBuf::from("."),
            Theme {
                name: DEFAULT_THEME.to_string(),
                palette,
            },
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
        }
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
    fn typing_q_goes_into_the_composer_instead_of_quitting() {
        let mut app = session_app();
        app.handle(key(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(!app.quit);
        assert_eq!(app.shell.composer.editor.text(), "q");
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
        assert!(matches!(app.dialog, Some(Dialog::Rename { .. })));
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
        let Some(Dialog::Rename { session_id, input }) = &app.dialog else {
            panic!("expected the rename dialog");
        };
        assert_eq!(session_id, "ses_a");
        assert_eq!(input.text(), "ses_a");
    }
}
