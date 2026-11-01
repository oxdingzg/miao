//! VAL-03: what it costs to resolve a blocking approval.
//!
//! The fourth of the six tasks is "approval". A blocking decision is a closed
//! vocabulary — one key resolves it — so the cost is observable without an
//! operator: keystrokes to the resolved state and the wall clock between the
//! panel appearing and the engine accepting the decision.
//!
//! The scripted engine keeps one request outstanding on the first snapshot, so
//! the panel has something to show without a model call. Mistakes and rework
//! still belong to the operator session.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

/// The panel's own title, which is what a person sees when a decision blocks.
const PANEL: &str = " approval ";

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
    log: PathBuf,
}

impl Harness {
    fn spawn() -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-interaction-approval");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let log = dir.join("actions.log");
        let _ = std::fs::remove_file(&log);
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
        cmd.env("MIAO_TUI_FAKE_ADMIT_LOG", &log);
        cmd.env("MIAO_TUI_FAKE_APPROVAL", "1");
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
            log,
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

    /// Whether the engine has accepted a decision yet.
    fn approved(&self) -> bool {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .any(|line| line.contains("\"method\":\"approve\""))
    }

    fn wait_for_approve(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.approved() {
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
fn a_blocking_approval_costs_one_keystroke() {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Project A", Duration::from_secs(30)),
        "the home list did not render:\n{}",
        harness.text()
    );
    // Opening the session is the walk to the decision, so it counts.
    harness.write(b"\r");
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(30)),
        "the session did not open:\n{}",
        harness.text()
    );
    assert!(
        harness.wait_for(PANEL, Duration::from_secs(30)),
        "the approval panel never rendered:\n{}",
        harness.text()
    );
    let started = Instant::now();
    harness.write(b"1"); // allow once: the whole decision vocabulary
    let resolved = harness.wait_for_approve(Duration::from_secs(30));
    let resolve_ms = started.elapsed().as_millis();
    assert!(
        resolved,
        "the decision never reached the engine:\n{}",
        harness.text()
    );
    println!("VAL-03 approval: resolve=1 key/{resolve_ms} ms");
    assert!(harness.approved());
    harness.shutdown();
}
