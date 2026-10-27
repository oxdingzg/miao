use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::event::AppEvent;
use crate::pane::Shell;
use crate::theme::Theme;

pub struct App {
    pub shell: Shell,
    pub quit: bool,
}

impl App {
    pub fn new(workspace: PathBuf, theme: Theme) -> Self {
        Self {
            shell: Shell::new(&workspace, theme),
            quit: false,
        }
    }

    pub fn handle(&mut self, event: AppEvent) {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Resize { .. } => {}
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            // Windows reports both Press and Release; handling both would
            // double every keystroke.
            return;
        }
        let input = &mut self.shell.composer.input;
        match (key.code, key.modifiers) {
            (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                if input.is_empty() {
                    self.quit = true;
                } else {
                    input.clear();
                }
            }
            (KeyCode::Char('d'), KeyModifiers::CONTROL) => {
                if input.is_empty() {
                    self.quit = true;
                }
            }
            // TS TUI binds app_exit to <leader>q; plain q is the T1 basic
            // version and moves to the leader chord when the T4 editor lands.
            (KeyCode::Char('q'), KeyModifiers::NONE) => self.quit = true,
            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => input.push(c),
            (KeyCode::Backspace, KeyModifiers::NONE) => {
                input.pop();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn key(code: KeyCode, modifiers: KeyModifiers) -> AppEvent {
        AppEvent::Key(KeyEvent::new(code, modifiers))
    }

    #[test]
    fn ctrl_c_clears_non_empty_input_before_quitting() {
        let mut app = app();
        app.handle(key(KeyCode::Char('h'), KeyModifiers::NONE));
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(!app.quit);
        assert!(app.shell.composer.input.is_empty());
        app.handle(key(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }

    #[test]
    fn plain_q_quits_but_typing_does_not() {
        let mut app = app();
        app.handle(key(KeyCode::Char('a'), KeyModifiers::NONE));
        assert!(!app.quit);
        assert_eq!(app.shell.composer.input, "a");
        app.handle(key(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(app.quit);
    }

    #[test]
    fn release_events_are_ignored() {
        let mut app = app();
        let mut event = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        event.kind = KeyEventKind::Release;
        app.handle(AppEvent::Key(event));
        assert!(!app.quit);
        assert!(app.shell.composer.input.is_empty());
    }
}
