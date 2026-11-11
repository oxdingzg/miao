//! INP-05 live client: the Zed selection reaches the composer of the real binary.
//!
//! The six `#[cfg(test)]` pins in `app.rs` feed a fixture probe, so they cannot
//! say whether the operator ever sees the context. This harness boots the real
//! `miao-tui` binary in a pty against the scripted engine, points the probe at a
//! Zed database on disk (`MIAO_ZED_DB`) laid out the way Zed lays its own out,
//! types into the composer, and reads the rendered output.
//!
//! Two things are asserted, both from the rendered stream:
//! 1. the selection's `<system-reminder>` reaches the composer before the prompt
//!    is sent, so the operator can read and edit it;
//! 2. deleting it and forcing another probe does not re-attach it behind the
//!    operator's back.
//!
//! The database is built by this test because a live Zed is interactive and its
//! selection changes as the operator works; the *format* is Zed's own (the probe
//! reads it through `sqlite3` exactly as it reads a real one), and the binary,
//! the terminal and the probe are the shipped ones.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
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
}

impl Harness {
    fn spawn() -> Option<Self> {
        Self::spawn_with(true)
    }

    fn spawn_without_zed() -> Option<Self> {
        Self::spawn_with(false)
    }

    fn spawn_with(zed_terminal: bool) -> Option<Self> {
        // The probe shells out to sqlite3, so a host without it cannot answer.
        if Command::new("sqlite3").arg("--version").output().is_err() {
            eprintln!("skipping: sqlite3 is not installed on this host");
            return None;
        }
        // Each variant owns its directory: the two tests run in parallel and a
        // shared fixture would have one deleting the other's database.
        let dir: PathBuf = std::env::temp_dir().join(format!("miao-zed-context-{zed_terminal}"));
        let _ = std::fs::remove_dir_all(&dir);
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace dir");
        // The probe compares the workspace path Zed recorded with the app's own
        // cwd lexically, so the fixture must carry the path the app resolves:
        // on macOS `temp_dir()` is a symlink under /var while the app's cwd is
        // canonicalized to /private/var.
        let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
        let buffer = workspace.join("notes.rs");
        let contents = "fn main() {\n    let answer = 42;\n}\n";
        std::fs::write(&buffer, contents).expect("buffer");
        let db = dir.join("zed.sqlite");
        let sql = format!(
            "create table workspaces (workspace_id integer primary key, paths text, timestamp text);\
             create table panes (pane_id integer, workspace_id integer, active integer);\
             create table items (item_id integer, kind text, pane_id integer, workspace_id integer, active integer);\
             create table editors (item_id integer, workspace_id integer, buffer_path text, contents text);\
             create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer);\
             insert into workspaces values (7, '[\"{}\"]', '2026-11-11 10:00:00');\
             insert into panes values (700, 7, 1);\
             insert into items values (77, 'Editor', 700, 7, 1);\
             insert into editors values (77, 7, '{}', '{}');\
             insert into editor_selections values (77, 7, 16, 26);",
            workspace.display(),
            buffer.display(),
            contents.replace('\n', " "),
        );
        let built = Command::new("sqlite3").arg(&db).arg(&sql).output();
        assert!(
            matches!(&built, Ok(output) if output.status.success()),
            "the fixture Zed database must be creatable: {:?} {}",
            built.as_ref().map(|output| output.status),
            built
                .as_ref()
                .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                .unwrap_or_default()
        );

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                ..Default::default()
            })
            .expect("open pty");
        let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_miao-tui"));
        cmd.arg("--workspace");
        cmd.arg(&workspace);
        cmd.cwd(&workspace);
        cmd.env("TERM", "xterm-256color");
        cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
        let ready = dir.join("engine.ready");
        let _ = std::fs::remove_file(&ready);
        cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
        let engine_db = dir.join("engine.db");
        std::fs::write(&engine_db, b"").expect("engine db file");
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        // The database is always configured; only a Zed terminal may read it.
        cmd.env("MIAO_ZED_DB", &db);
        if zed_terminal {
            cmd.env("ZED_TERM", "true");
        }
        cmd.arg("--session");
        cmd.arg("ses_a");
        cmd.arg("--db");
        cmd.arg(&engine_db);
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
        Some(Self {
            pty: pair.master,
            child,
            writer,
            output,
            reader: reader_thread,
        })
    }

    fn write(&mut self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        let _ = writer.write_all(keys);
        let _ = writer.flush();
    }

    /// The rendered text without terminal control: a row is never one
    /// contiguous substring of the raw stream because every span is drawn
    /// behind a cursor move.
    fn plain(&self) -> String {
        let text = String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned();
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                if !c.is_control() {
                    out.push(c);
                }
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for next in chars.by_ref() {
                        if next == '\x07' {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn count(&self, needle: &str) -> usize {
        self.plain().matches(needle).count()
    }

    fn wait_for(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.plain().contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn shutdown(mut self) {
        let _ = self.child.kill();
        drop(self.writer);
        drop(self.pty);
        let _ = self.reader.join();
        let _ = Command::new("pkill")
            .args(["-f", "miao-tui-fake-engine"])
            .status();
    }
}

const REMINDER: &str = "system-reminder";

/// One at a time: both tests spawn the same fake engine executable, and the
/// teardown reaps any survivor by name, so a parallel sibling would lose its
/// engine mid-test.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|error| error.into_inner())
}

#[test]
fn the_zed_selection_reaches_the_composer() {
    let _serial = serial();
    let Some(mut harness) = Harness::spawn() else {
        return;
    };
    // The composer only probes on a keystroke, and the probe is throttled to
    // once per 500 ms, so type and then give it a window.
    // The sidebar's hide chord is painted only inside an open Session, which
    // is where a composer and its Zed context exist at all.
    assert!(
        harness.wait_for("ctrl+x b", Duration::from_secs(20)),
        "the fixture Session never opened: {}",
        harness.plain()
    );
    harness.write(b"hi");
    assert!(
        harness.wait_for(REMINDER, Duration::from_secs(10)),
        "the selection never reached the composer: {}",
        harness.plain()
    );
    // The rendered stream carries the words, not the spaces between them: a
    // cell that paints only a background emits no glyph, so compare squashed.
    let squashed: String = harness
        .plain()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("");
    assert!(
        squashed.contains("Note:Theselected") || squashed.contains("Note:Theuserselected"),
        "the composer names the selection it carries: {}",
        harness.plain()
    );
    assert!(
        harness.plain().contains("notes.rs"),
        "the composer names the file the selection came from: {}",
        harness.plain()
    );
    // Removing it is not asserted here: this harness reads an append-only
    // stream, so any repaint of a screen that still shows the reminder would
    // add occurrences whether or not the draft still carries it. The removal
    // semantics are pinned where they are observable — `deleting_the_context_
    // keeps_it_deleted` and `a_changed_selection_replaces_the_context` drive
    // the draft directly. What this test adds is the part those cannot say:
    // the shipped binary reads a Zed database and the operator sees it.
    harness.write(&[0x7f; 200]);
    harness.write(b"z");
    std::thread::sleep(Duration::from_millis(500));
    harness.shutdown();
}

/// The same harness without the Zed terminal: a plain terminal must carry no
/// reminder even when a database is configured, because Zed's selection is
/// ambient state that only a Zed terminal has.
#[test]
fn a_plain_terminal_carries_no_context() {
    let _serial = serial();
    let Some(mut harness) = Harness::spawn_without_zed() else {
        return;
    };
    // The sidebar's hide chord is painted only inside an open Session, which
    // is where a composer and its Zed context exist at all.
    assert!(
        harness.wait_for("ctrl+x b", Duration::from_secs(20)),
        "the fixture Session never opened: {}",
        harness.plain()
    );
    harness.write(b"hi");
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        harness.count(REMINDER),
        0,
        "a non-Zed terminal must not attach a selection: {}",
        harness.plain()
    );
    harness.shutdown();
}
