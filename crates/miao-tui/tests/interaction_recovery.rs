//! VAL-03: what it costs to recover from a failed turn.
//!
//! The sixth task is "failure recovery". The scripted engine admits the prompt
//! and then fails the run, so the recovery path is "send it again" — and the
//! cost of that is keystrokes, which this measures: recall the prompt from an
//! empty composer and send it, rather than retype it.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const PROMPT: &str = "fix the parser";

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
        let dir: PathBuf = std::env::temp_dir().join("miao-interaction-recovery");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let log = dir.join("admit.log");
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

    /// Wait until at least `count` inputs are admitted and the count has stopped
    /// moving, which is how a test can tell that the turn behind them settled.
    fn wait_for_admits_to_settle(&self, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut stable = 0;
        let mut last = self.admitted();
        loop {
            std::thread::sleep(Duration::from_millis(20));
            let now = self.admitted();
            if now >= count && now == last {
                stable += 1;
                if stable >= 5 {
                    return true;
                }
            } else {
                stable = 0;
            }
            last = now;
            if Instant::now() >= deadline {
                return false;
            }
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

    /// How many prompts the engine has admitted so far.
    fn admitted(&self) -> usize {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("\"method\":\"admit\""))
            .count()
    }

    fn wait_for_admits(&self, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.admitted() >= count {
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
        let _ = std::process::Command::new("pkill")
            .args(["-f", "miao-tui-fake-engine"])
            .status();
    }
}

#[test]
fn a_failed_turn_is_resent_with_two_keystrokes() {
    // The failing run is stretched so the test can wait for it to start and to
    // settle. Recalling while the client still believes the turn is running
    // queues the prompt behind it, and the queued copy is admitted again once
    // the run ends — an extra admission that has nothing to do with a retry.
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
    harness.write(PROMPT.as_bytes());
    let mut typed = PROMPT.len();
    harness.write(b"\r");
    typed += 1;
    assert!(
        harness.wait_for_admits(1, Duration::from_secs(30)),
        "the prompt was never admitted:\n{}",
        harness.text()
    );
    // Let the failing turn settle before recovering. The fixture answers the
    // client's snapshot only after the run ends, so a "working" frame is never
    // painted; the settle is read off the admission count instead — it has to
    // stop moving before the recovery keys are sent, otherwise the recalled
    // prompt is queued behind a run the client still believes is live.
    assert!(
        harness.wait_for_admits_to_settle(1, Duration::from_secs(30)),
        "the failed turn never settled:\n{}",
        harness.text()
    );
    // Recover: recall the prompt the failed turn consumed, then send it again.
    let recovery = Instant::now();
    harness.write(b"\x1b[A"); // Up
    harness.write(b"\r");
    let resent = harness.wait_for_admits(2, Duration::from_secs(30));
    let recovery_ms = recovery.elapsed().as_millis();
    assert!(
        resent,
        "the recalled prompt was never resent:\n{}",
        harness.text()
    );
    println!(
        "VAL-03 failure-recovery: typing={typed} keys, recovery=2 keys/{recovery_ms} ms, total {} ms",
        started.elapsed().as_millis()
    );
    assert_eq!(harness.admitted(), 2);
    harness.shutdown();
}
