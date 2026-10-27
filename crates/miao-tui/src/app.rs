use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;

use crate::editor::Action;
use crate::engine;
use crate::event::AppEvent;
use crate::pane::{Home, Pane, Shell};
use crate::session::SessionSummary;
use crate::theme::Theme;

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
    pub quit: bool,
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
            quit: false,
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
            AppEvent::SessionOpened {
                summary,
                transcript,
            } => {
                self.session = summary;
                self.shell.set_session(self.session.as_ref());
                self.shell.set_transcript(&transcript);
                self.screen = Screen::Session;
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
        match self.screen {
            Screen::Home => self.handle_home_key(key),
            Screen::Session => self.handle_session_key(key),
        }
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
            if !self.shell.composer.dismiss_completion() {
                self.leave_session();
            }
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
        match self.shell.composer.handle_key(key) {
            Action::None => {}
            Action::Quit => self.quit = true,
            Action::Submit(text) => self.submit(text),
        }
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
        self.shell.set_session(None);
        self.shell.composer.editor.clear();
        self.shell.composer.dismiss_completion();
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

    #[test]
    fn esc_returns_from_a_session_to_the_home_list() {
        let mut app = session_app();
        app.handle(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.screen, Screen::Home);
        assert!(app.session.is_none());
    }
}
