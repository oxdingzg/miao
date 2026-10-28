use std::io::{self, Stdout};

use crossterm::cursor::SetCursorStyle;
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::config::{Cursor, CursorShape};

pub type Tui = Terminal<CrosstermBackend<Stdout>>;

/// Terminal settings that must be re-applied after the external editor gives
/// the screen back.
#[derive(Debug, Clone, Copy, Default)]
pub struct Preferences {
    pub mouse: bool,
    pub cursor: Option<Cursor>,
}

pub fn init(preferences: Preferences) -> io::Result<Tui> {
    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableFocusChange
    )?;
    apply(preferences);
    Terminal::new(CrosstermBackend::new(io::stdout()))
}

/// Mouse capture and the cursor shape are terminal state, so they are turned
/// off on the way out whether or not they were on.
pub fn restore() {
    let _ = execute!(
        io::stdout(),
        LeaveAlternateScreen,
        DisableBracketedPaste,
        DisableFocusChange,
        DisableMouseCapture,
        SetCursorStyle::DefaultUserShape
    );
    let _ = disable_raw_mode();
}

/// Hand the terminal to an external editor: leave the alternate screen and
/// stop raw mode so the child owns cooked input and output.
pub fn suspend() {
    restore();
}

/// Take the terminal back after [`suspend`] and repaint from scratch.
pub fn resume(terminal: &mut Tui, preferences: Preferences) -> io::Result<()> {
    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableFocusChange
    )?;
    apply(preferences);
    terminal.clear()
}

fn apply(preferences: Preferences) {
    if preferences.mouse {
        let _ = execute!(io::stdout(), EnableMouseCapture);
    }
    if let Some(cursor) = preferences.cursor {
        let _ = execute!(io::stdout(), cursor_style(cursor));
    }
}

fn cursor_style(cursor: Cursor) -> SetCursorStyle {
    match (cursor.shape(), cursor.blinking()) {
        (CursorShape::Default, _) => SetCursorStyle::DefaultUserShape,
        (CursorShape::Block, true) => SetCursorStyle::BlinkingBlock,
        (CursorShape::Block, false) => SetCursorStyle::SteadyBlock,
        (CursorShape::Underline, true) => SetCursorStyle::BlinkingUnderScore,
        (CursorShape::Underline, false) => SetCursorStyle::SteadyUnderScore,
        (CursorShape::Line, true) => SetCursorStyle::BlinkingBar,
        (CursorShape::Line, false) => SetCursorStyle::SteadyBar,
    }
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_style_follows_the_configuration() {
        let cursor = |style, blinking| Cursor {
            style: Some(style),
            blinking: Some(blinking),
        };
        assert!(matches!(
            cursor_style(cursor(CursorShape::Block, true)),
            SetCursorStyle::BlinkingBlock
        ));
        assert!(matches!(
            cursor_style(cursor(CursorShape::Block, false)),
            SetCursorStyle::SteadyBlock
        ));
        assert!(matches!(
            cursor_style(cursor(CursorShape::Underline, false)),
            SetCursorStyle::SteadyUnderScore
        ));
        assert!(matches!(
            cursor_style(cursor(CursorShape::Line, true)),
            SetCursorStyle::BlinkingBar
        ));
        // A configured cursor with the `default` shape preserves the terminal
        // setting, which is what `DefaultUserShape` restores.
        assert!(matches!(
            cursor_style(cursor(CursorShape::Default, true)),
            SetCursorStyle::DefaultUserShape
        ));
    }
}
