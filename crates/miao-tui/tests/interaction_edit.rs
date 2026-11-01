//! VAL-03: what it costs to correct one character in the composer.
//!
//! The second of the six tasks is "editing input". A correction is the measurable
//! part: a composer with line motions lets an operator fix the first character
//! for a handful of keystrokes, and a composer without them makes them retype
//! the line. This measures both paths on the real binary and checks that the
//! efficient one actually produced the corrected text.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const BODY: &str = "bcdefghijklmnopqrstuvwxyz0123456789abcde";
const CORRECT: &str = "acdefghijklmnopqrstuvwxyz0123456789abcde";

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
}

impl Harness {
    fn spawn() -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-interaction-edit");
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                ..Default::default()
            })
            .expect("open pty");
        let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_miao-tui"));
        cmd.arg("--workspace");
        cmd.arg(&dir);
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
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
        }
    }

    fn write(&mut self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        let _ = writer.write_all(keys);
        let _ = writer.flush();
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }

    /// Only the alphanumeric cells: the composer redraws one character at a
    /// time with a cursor motion in front of each, so the raw stream never
    /// contains a typed line as a contiguous substring.
    fn typed(&self) -> String {
        let mut out = String::new();
        let text = self.text();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                if !c.is_control() {
                    out.push(c);
                }
                continue;
            }
            // Skip the escape sequence: CSI runs until its final byte, and the
            // digits inside a cursor move are not typed text.
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC ends at BEL or ST.
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

    fn wait_for_typed(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.typed().ends_with(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.text().replace('\r', "").contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn open_session(&mut self) {
        assert!(
            self.wait_for("Project A", Duration::from_secs(30)),
            "the home list did not render:\n{}",
            self.text()
        );
        self.write(b"\r");
        assert!(
            self.wait_for("hello from the fixture", Duration::from_secs(30)),
            "the session did not open:\n{}",
            self.text()
        );
    }

    fn shutdown(mut self) {
        let _ = self.child.kill();
        drop(self.writer);
        drop(self.pty);
        let _ = self.reader.join();
        let _ = std::process::Command::new("pkill")
            .args(["-f", "miao-tui-fake-engine"])
            .status();
    }
}

/// Fix the first character with line motions: Home, Delete, the right letter,
/// then ctrl+e to get back to the end. Four keystrokes after the text is typed.
fn fix_with_motions() -> (usize, u128) {
    let mut harness = Harness::spawn();
    harness.open_session();
    let started = Instant::now();
    harness.write(BODY.as_bytes());
    let mut keys = BODY.len();
    harness.write(b"\x1b[H"); // Home
    keys += 1;
    harness.write(b"\x1b[3~"); // Delete
    keys += 1;
    harness.write(b"a");
    keys += 1;
    harness.write(b"\x05"); // ctrl+e
    keys += 1;
    let fixed = harness.wait_for_typed(CORRECT, Duration::from_secs(45));
    let elapsed = started.elapsed().as_millis();
    assert!(
        fixed,
        "the corrected line never rendered:\n{}",
        harness.text()
    );
    harness.shutdown();
    (keys, elapsed)
}

/// The same correction without motions: clear the line and type it again.
fn fix_by_retyping() -> (usize, u128) {
    let mut harness = Harness::spawn();
    harness.open_session();
    let started = Instant::now();
    harness.write(BODY.as_bytes());
    let mut keys = BODY.len();
    // No kill-line binding exists, so a retype means backspacing the line and
    // typing it again — the cost this measurement exists to show.
    for _ in 0..BODY.len() {
        harness.write(b"\x7f");
        keys += 1;
        std::thread::sleep(Duration::from_millis(1));
    }
    harness.write(CORRECT.as_bytes());
    keys += CORRECT.len();
    let fixed = harness.wait_for_typed(CORRECT, Duration::from_secs(45));
    let elapsed = started.elapsed().as_millis();
    assert!(
        fixed,
        "the retyped line never rendered:\n{}",
        harness.text()
    );
    harness.shutdown();
    (keys, elapsed)
}

#[test]
fn correcting_one_character_costs_a_motion_not_a_retype() {
    let (motion_keys, motion_ms) = fix_with_motions();
    let (retype_keys, retype_ms) = fix_by_retyping();
    println!(
        "VAL-03 edit-input: motions={motion_keys} keys/{motion_ms} ms, retype={retype_keys} keys/{retype_ms} ms"
    );
    assert!(
        motion_keys < retype_keys,
        "motions cost {motion_keys} keys against a retype of {retype_keys}"
    );
}
