//! UX-04 screen-clearing redraw: a requested full redraw must hand the
//! terminal a clear (`\x1b[2J`) and repaint the screen whole on the next
//! frame, not fall back to a differential update.
//!
//! Two cases pin the same cycle:
//!
//! * `a_requested_redraw_clears_the_screen_and_repaints_every_row` drives the
//!   app's own `terminal::redraw` through a real `CrosstermBackend` whose
//!   writer is a captured buffer, so the asserted bytes are exactly what a
//!   real terminal receives. The terminal size crossterm reports comes from
//!   the controlling tty, so a headless run (CI, `ssh host cargo test`) skips
//!   it; under a real terminal — or tmux — it runs and asserts the stream.
//! * `a_requested_redraw_wipes_the_backend_screen_before_the_next_frame` uses
//!   `ratatui`'s `TestBackend` to keep the clear-and-repaint cycle pinned in
//!   those headless runs.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::Terminal;

use miao_tui::terminal;

/// A marker on every row, so "the whole screen came back" is row-checkable
/// instead of inferred from a byte count.
const PROBE: &str = "ux04-clear-redraw-probe";

/// The backend owns the writer for its whole life, so reading the captured
/// bytes through it would fight the borrow; every draw hands the buffer a
/// clone instead, and the assertions read from their own clone.
#[derive(Clone, Default)]
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn written(shared: &SharedBuf) -> Vec<u8> {
    shared.0.lock().unwrap().clone()
}

/// Markers carry no blank cells: the diff against ratatui's blank backing
/// buffer skips blanks and hands the backend a cursor move for every gap, so
/// a blank inside a row would split its byte run and the `contains_text`
/// scans below would never find a row contiguous. Two digits keep the row
/// numbers substring-unambiguous at terminal heights.
fn screen(rows: u16) -> ratatui::text::Text<'static> {
    (0..rows)
        .map(|row| ratatui::text::Line::from(format!("{PROBE}-{row:02}")))
        .collect::<Vec<_>>()
        .into()
}

/// `assert_buffer_lines` builds the expected buffer from these lines, so each
/// must carry the full row width the real screen has.
fn probe_row(row: u16, columns: u16) -> String {
    format!(
        "{:<width$}",
        format!("{PROBE}-{row:02}"),
        width = columns as usize
    )
}

fn draw(terminal: &mut Terminal<CrosstermBackend<SharedBuf>>, rows: u16) -> io::Result<()> {
    terminal
        .draw(|frame| frame.render_widget(screen(rows), frame.area()))
        .map(|_frame| ())
}

/// Byte slices have no substring check (`contains` looks for one element), so
/// the byte assertions in this file share this `windows` scan.
fn contains_text(bytes: &[u8], text: &str) -> bool {
    bytes
        .windows(text.len())
        .any(|window| window == text.as_bytes())
}

#[test]
fn a_requested_redraw_clears_the_screen_and_repaints_every_row() {
    let Ok(size) = crossterm::terminal::size() else {
        println!(
            "skipping: crossterm reports the size through the controlling tty, \
             which a headless cargo test does not have"
        );
        return;
    };
    if size.0 == 0 || size.1 == 0 {
        println!(
            "skipping: the controlling tty has no cells ({}x{})",
            size.0, size.1
        );
        return;
    }
    let shared = SharedBuf::default();
    let mut terminal = Terminal::new(CrosstermBackend::new(shared.clone())).expect("terminal");
    let rows = size.1;

    draw(&mut terminal, rows).expect("first frame");
    let painted = written(&shared);
    assert!(
        contains_text(&painted, &format!("{PROBE}-00")),
        "the first frame did not paint its probe: {:?}",
        String::from_utf8_lossy(&painted)
    );
    let painted_end = painted.len();

    // The differential baseline: redrawing an unchanged screen must repaint
    // nothing. Ratatui's draw loop still re-emits its per-frame cursor
    // management (the hide sequence) on every frame, so the delta must carry
    // no cell content and no clear — the absence a screen-clearing redraw is
    // contrasted against.
    draw(&mut terminal, rows).expect("unchanged frame");
    let baseline = written(&shared)[painted_end..].to_vec();
    assert!(
        !contains_text(&baseline, PROBE),
        "an unchanged frame repainted content: {:?}",
        String::from_utf8_lossy(&baseline)
    );
    assert!(
        !baseline.windows(4).any(|bytes| bytes == b"\x1b[2J"),
        "an unchanged frame cleared the screen: {:?}",
        String::from_utf8_lossy(&baseline)
    );

    // The app's own path for Ctrl+L, the redraw command and resume-after-suspend.
    terminal::redraw(&mut terminal).expect("redraw");
    let cleared = written(&shared)[painted_end..].to_vec();
    assert!(
        cleared.windows(4).any(|bytes| bytes == b"\x1b[2J"),
        "the redraw did not clear the screen: {:?}",
        String::from_utf8_lossy(&cleared)
    );
    assert!(
        !cleared.windows(4).any(|bytes| bytes == b"\x1b[6n"),
        "the redraw queried the cursor through stdin: {:?}",
        String::from_utf8_lossy(&cleared)
    );
    assert!(
        !contains_text(&cleared, PROBE),
        "the clear itself repainted content: {:?}",
        String::from_utf8_lossy(&cleared)
    );
    let cleared_end = painted_end + cleared.len();

    // Nothing changed between the frames, so anything the redraw left
    // unpainted would be skipped by the next differential update. Every row
    // coming back is what makes the redraw full.
    draw(&mut terminal, rows).expect("post-redraw frame");
    let repainted = written(&shared)[cleared_end..].to_vec();
    for row in 0..rows {
        assert!(
            contains_text(&repainted, &format!("{PROBE}-{row:02}")),
            "row {row} was not repainted after the redraw: {:?}",
            String::from_utf8_lossy(&repainted)
        );
    }
    let stream = written(&shared);
    assert!(
        !stream.windows(4).any(|bytes| bytes == b"\x1b[6n"),
        "the redraw cycle queried the cursor through stdin"
    );
}

#[test]
fn a_requested_redraw_wipes_the_backend_screen_before_the_next_frame() {
    let (columns, rows) = (40u16, 8u16);
    let mut terminal = Terminal::new(TestBackend::new(columns, rows)).expect("terminal");

    terminal
        .draw(|frame| frame.render_widget(screen(rows), frame.area()))
        .expect("first frame");
    terminal
        .backend()
        .assert_buffer_lines((0..rows).map(|row| probe_row(row, columns)));

    terminal::redraw(&mut terminal).expect("redraw");
    // The clear reached the backend: its screen is blank until the next frame
    // repaints it whole.
    terminal
        .backend()
        .assert_buffer_lines((0..rows).map(|_| " ".repeat(columns as usize)));

    terminal
        .draw(|frame| frame.render_widget(screen(rows), frame.area()))
        .expect("post-redraw frame");
    terminal
        .backend()
        .assert_buffer_lines((0..rows).map(|row| probe_row(row, columns)));
}
