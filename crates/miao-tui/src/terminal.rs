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
use std::io::Write;

use crate::config::{Cursor, CursorShape};

pub type Tui = Terminal<CrosstermBackend<Stdout>>;

/// Present one frame atomically. Streaming turns repaint the transcript many
/// times a second, and terminals that apply partial updates mid-frame show
/// that as full-screen flicker; wrapping the frame in synchronized-update
/// markers lets capable terminals buffer and present it in one piece.
/// Terminals without support ignore the markers and behave as before.
pub fn draw_frame<F>(terminal: &mut Tui, render: F) -> io::Result<()>
where
    F: FnOnce(&mut ratatui::Frame),
{
    // Writes on a second handle to the same tty keep their order with the
    // backend's own writes, so the markers bracket the frame on the wire.
    // CSI 2026 = synchronized update: capable terminals buffer everything
    // between the markers and present the frame in one piece.
    let mut stdout = std::io::stdout();
    stdout.write_all(b"\x1b[?2026h")?;
    let result = terminal.draw(render).map(|_frame| ());
    stdout.write_all(b"\x1b[?2026l")?;
    result
}

/// Covers normal exit and every error after raw-mode initialization begins.
pub struct RestoreGuard;

impl Drop for RestoreGuard {
    fn drop(&mut self) {
        restore();
    }
}

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
    redraw(terminal)
}

/// Fullscreen repaint without a cursor-position query. `Terminal::clear`
/// snapshots the cursor through stdin, which races the dedicated input reader.
/// Resizing the fullscreen viewport also resets its backing buffers.
pub fn redraw(terminal: &mut Tui) -> io::Result<()> {
    let size = terminal.size()?;
    terminal.resize(ratatui::layout::Rect::new(0, 0, size.width, size.height))
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
