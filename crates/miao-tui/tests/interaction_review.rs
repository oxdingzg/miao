//! VAL-03: what it costs to reach the change set a turn produced.
//!
//! The fifth of the six tasks is "reviewing changes". The cost is the walk from
//! the transcript to a rendered change list, which is observable without an
//! operator: keystrokes and time-to-state. The scripted engine answers
//! `vcs_status` with a three-file set so the review surface can be driven.
//!
//! Mistakes and rework — opening the wrong pane, losing the list — stay with the
//! operator session.

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
}

impl Harness {
    fn spawn() -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-interaction-review");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        // The review surface only queries the engine for a change set when the
        // workspace is a repository, so the fixture workspace has to be one.
        let _ = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status();
        std::fs::write(dir.join("tracked.txt"), "tracked").expect("tracked file");
        let _ = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .status();
        let _ = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=fixture@example.com",
                "-c",
                "user.name=fixture",
                "commit",
                "-qm",
                "init",
            ])
            .current_dir(&dir)
            .status();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
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

    /// Whether the change list has rendered.
    fn changes_visible(&self) -> bool {
        let text = self.text().replace('\r', "");
        // The header counts the whole set; the body scrolls, so the first rows
        // are what a person sees on arrival.
        text.contains("3 files") && text.contains("src/parser.rs")
    }

    fn wait_for_changes(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.changes_visible() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
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

#[test]
fn reaching_the_change_list_costs_two_keys() {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Project A", Duration::from_secs(30)),
        "the home list did not render:\n{}",
        harness.text()
    );
    harness.write(b"\r");
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(30)),
        "the session did not open:\n{}",
        harness.text()
    );
    let started = Instant::now();
    // One write for the whole chord, the way every other PTY test sends a
    // leader sequence: the leader expires on `leader_timeout`, so two writes
    // can straddle it on a loaded runner and the chord is then just a stray
    // `g` in the composer.
    harness.write(b"\x18g"); // leader, workspace changes
    let opened = harness.wait_for_changes(Duration::from_secs(30));
    let elapsed_ms = started.elapsed().as_millis();
    assert!(
        opened,
        "the change list never rendered:\n{}",
        harness.text()
    );
    println!("VAL-03 review-changes: 2 keys/{elapsed_ms} ms");
    harness.shutdown();
}
