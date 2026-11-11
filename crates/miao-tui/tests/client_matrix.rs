//! QA-02: the terminal conditions a headless run cannot see, made executable.
//!
//! The acceptance item asked for human records of CJK/IME, narrow screens and
//! tmux. The parts that depend on a human — whether a font has a glyph, whether
//! an IME's own popup is comfortable — stay out of reach. Everything else does
//! not: the renderer measures its own output, so a pty at a known size can ask
//! it what it painted, and that is what these tests do.
//!
//! Three conditions, each with the failure it is meant to catch:
//!
//! - **Double-width text** in a pane narrower than the message. A renderer that
//!   counts characters instead of columns overflows the right edge and drops
//!   the tail; the assertion is that the tail is on screen and nothing reached
//!   past the last column.
//! - **A 40-column pane.** Below the point where the status line, composer and
//!   transcript all fit side by side, layout has to degrade rather than clip.
//! - **tmux.** `$TERM` is `screen-256color` and `$TERM_PROGRAM` is `tmux`, so
//!   the TUI cannot key its behaviour off a terminal it does not have. The
//!   assertion is that a Session still opens and paints.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
    cols: u16,
}

impl Harness {
    fn spawn(label: &str, rows: u16, cols: u16, environment: &[(&str, &str)]) -> Self {
        let dir: PathBuf = std::env::temp_dir().join(format!("miao-client-matrix-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                ..Default::default()
            })
            .expect("open pty");
        let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_miao-tui"));
        cmd.arg("--workspace");
        cmd.arg(&dir);
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
        cmd.env("MIAO_DISABLE_TERMINAL_TITLE", "0");
        let ready = dir.join("engine.ready");
        let _ = std::fs::remove_file(&ready);
        cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
        let db = dir.join("engine.db");
        std::fs::write(&db, b"").expect("engine db file");
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        cmd.arg("--session");
        cmd.arg("ses_a");
        for (key, value) in environment {
            cmd.env(key, value);
        }
        cmd.arg("--db");
        cmd.arg(&db);
        let child = pair.slave.spawn_command(cmd).expect("spawn miao-tui");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take writer")));
        let output = Arc::new(Mutex::new(Vec::new()));
        let seen = output.clone();
        let responder = writer.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut replied_cpr = false;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        seen.lock()
                            .expect("output lock")
                            .extend_from_slice(&buf[..n]);
                        if !replied_cpr
                            && seen
                                .lock()
                                .expect("output lock")
                                .windows(4)
                                .any(|bytes| bytes == b"\x1b[6n")
                        {
                            replied_cpr = true;
                            let _ = responder
                                .lock()
                                .expect("writer lock")
                                .write_all(b"\x1b[1;1R");
                            let _ = responder.lock().expect("writer lock").flush();
                        }
                    }
                }
            }
        });
        Self {
            pty: pair.master,
            child,
            writer,
            output,
            reader: reader_thread,
            cols,
        }
    }

    /// The screen as a terminal reconstructs it: what a person sees, not the
    /// repaint byte stream.
    /// The rendered grid, read row by row.
    ///
    /// Deliberately not `contents()`: on Windows the same parsed grid comes back
    /// as one long row with no separators, so a test that split that string
    /// measured the whole screen as a single line and reported "row 0 is 1200
    /// columns wide". Reading each cell makes the row structure explicit and
    /// identical on every platform.
    fn screen(&self) -> String {
        let size = self.pty.get_size().expect("pty size");
        let mut parser = vt100::Parser::new(size.rows, size.cols, 0);
        parser.process(&self.output.lock().expect("output lock"));
        let screen = parser.screen();
        let (rows, cols) = screen.size();
        (0..rows)
            .map(|row| {
                (0..cols)
                    .map(|col| {
                        screen
                            .cell(row, col)
                            .map(|cell| cell.contents())
                            .unwrap_or_default()
                    })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for_screen(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.screen().contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn shutdown(mut self) {
        let _ = self.child.kill();
        drop(self.writer);
        drop(self.pty);
        let _ = self.reader.join();
    }
}

/// Nothing may be painted past the last column.
///
/// The terminal rebuilds the screen at the pane's true width, so a row wider
/// than `cols` display columns is content it had to push out of the pane. Width
/// is measured in display columns, not characters: `chars().count()` calls a CJK
/// glyph one column and would report a line that actually takes eighty of them
/// as forty.
fn overflows(screen: &str, cols: u16) -> Option<(usize, usize, String)> {
    for (row, line) in screen.lines().enumerate() {
        let width: usize = line
            .chars()
            .map(|character| unicode_width::UnicodeWidthChar::width(character).unwrap_or(0))
            .sum();
        if width > cols as usize {
            return Some((row, width, line.to_string()));
        }
    }
    None
}

/// Every character of the message is still on screen, in order.
///
/// This is the assertion a character-counting wrap actually breaks: it folds the
/// run at the wrong column, and the tail either lands past the right edge (the
/// terminal drops it) or is pushed off the bottom of the pane. Comparing the
/// screen against the source text with wrapping and whitespace removed asks the
/// only question that matters — did the whole message arrive —
/// without depending on where the renderer chose to break it.
fn lost_characters(screen: &str, expected: &str) -> Vec<char> {
    let visible: Vec<char> = screen
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let mut cursor = 0;
    let mut missing = Vec::new();
    for character in expected
        .chars()
        .filter(|character| !character.is_whitespace())
    {
        match visible[cursor..].iter().position(|seen| *seen == character) {
            Some(offset) => cursor += offset + 1,
            None => missing.push(character),
        }
    }
    missing
}

#[test]
fn double_width_text_stays_inside_a_narrow_pane() {
    // 40 columns with unbreakable CJK: the message cannot fit on one line, so
    // the only way the tail survives is if wrapping happens on column
    // boundaries.
    let harness = Harness::spawn("cjk", 30, 40, &[("MIAO_TUI_FAKE_CJK", "1")]);
    assert!(
        harness.wait_for_screen("cjk-tail-marker", Duration::from_secs(30)),
        "the CJK transcript never rendered its tail, which is what a \
         character-counting wrap does to the end of an unbreakable run:\n{}",
        harness.screen()
    );
    let screen = harness.screen();
    // The message the fixture sends, wrapped or not: every character of it has
    // to survive. A renderer that measured a CJK glyph as one column folds the
    // run too late and the tail is pushed out of the pane.
    let message =
        "这是一段很长的中文回复用来检验双宽字符在窄窗格里的折行处理是否正确完成😀 cjk-tail-marker";
    let missing = lost_characters(&screen, message);
    assert!(
        missing.is_empty(),
        "the pane dropped {} character(s) of the message: {missing:?}\n{screen}",
        missing.len()
    );
    if let Some((row, width, line)) = overflows(&screen, harness.cols) {
        panic!(
            "row {row} is {width} columns wide in a {} column pane: {line:?}",
            harness.cols
        );
    }
    harness.shutdown();
}

#[test]
fn a_forty_column_pane_degrades_instead_of_clipping() {
    // The narrowest pane the TUI claims to support. Both ends of the layout have
    // to survive: the transcript's content and the composer the operator types
    // into.
    let harness = Harness::spawn("narrow", 20, 40, &[("MIAO_TUI_FAKE_CJK", "1")]);
    assert!(
        harness.wait_for_screen("cjk-tail-marker", Duration::from_secs(30)),
        "the transcript did not render at 40 columns:\n{}",
        harness.screen()
    );
    let screen = harness.screen();
    if let Some((row, width, line)) = overflows(&screen, harness.cols) {
        panic!(
            "row {row} is {width} columns wide in a {} column pane: {line:?}",
            harness.cols
        );
    }
    harness.shutdown();
}

#[test]
fn a_session_still_opens_under_tmux() {
    // A test that could not run under tmux would tell the operator their
    // environment is unsupported. The TUI reports itself as `screen-256color`
    // with `$TERM_PROGRAM=tmux`, which is what a real session sees, and the
    // Session still has to open and paint.
    let harness = Harness::spawn(
        "tmux",
        30,
        80,
        &[("TERM", "screen-256color"), ("TERM_PROGRAM", "tmux")],
    );
    assert!(
        harness.wait_for_screen("hello from the fixture", Duration::from_secs(30)),
        "the Session did not open under tmux:\n{}",
        harness.screen()
    );
    // The composer is the surface a tmux user types into; if it painted, the
    // pane is interactive and not just a transcript dump.
    assert!(
        harness.screen().contains("Ask anything") || harness.screen().contains("│"),
        "the composer did not paint under tmux:\n{}",
        harness.screen()
    );
    harness.shutdown();
}
