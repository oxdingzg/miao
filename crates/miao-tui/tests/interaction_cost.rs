//! VAL-03 mechanical baseline: how many keystrokes and how much wall clock it
//! takes to reach a state, measured on the same surface.
//!
//! "Finding a session" is the one of the six tasks a script can measure
//! honestly: the cost is keystrokes and time-to-open, and both are observable
//! without an operator. Mistakes and rework are not measurable this way and
//! stay with the real observation session.
//!
//! Two ways to reach the same row in a 200-Session catalog:
//!
//! - walk: `j` once per row, which is what a list with no query costs;
//! - filter: `/`, then the substring that names it, then `Enter`.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const CATALOG: usize = 200;
/// A row far enough down that walking is expensive and a query is not.
const TARGET: usize = 150;

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
}

impl Harness {
    fn spawn() -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-interaction-cost");
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 100,
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
        cmd.env("MIAO_TUI_FAKE_SESSION_COUNT", CATALOG.to_string());
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
        // A dead child surfaces as "the row never opened", with its screen
        // captured, rather than as a write error.
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

    fn shutdown(mut self) {
        self.write(b"\x03");
        std::thread::sleep(Duration::from_millis(150));
        self.write(b"\x03");
        let _ = self.child.kill();
        drop(self.writer);
        drop(self.pty);
        let _ = self.reader.join();
        let _ = std::process::Command::new("pkill")
            .args(["-f", "miao-tui-fake-engine"])
            .status();
    }
}

/// Keystrokes it takes to reach the row and the time until its transcript is on
/// screen. `None` means the row never opened inside the budget.
fn walk() -> Option<(usize, u128)> {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Note session 1", Duration::from_secs(10)),
        "the catalog never rendered:\n{}",
        harness.text()
    );
    let started = Instant::now();
    // The prompt owns the landing screen's keyboard, so `Tab` hands it to the
    // list first: without it `j` is typed into the prompt and Enter sends that
    // text as a new turn, which measured composing a prompt rather than walking
    // the catalog.
    harness.write(b"\t");
    let mut keys = 1;
    // Row 1 is already selected, so reaching row TARGET costs TARGET - 1 moves.
    for _ in 1..TARGET {
        harness.write(b"j");
        keys += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    harness.write(b"\r");
    keys += 1;
    let opened = harness.wait_for("fixture answer", Duration::from_secs(20));
    let elapsed = started.elapsed().as_millis();
    harness.shutdown();
    opened.then_some((keys, elapsed))
}

fn filter() -> Option<(usize, u128)> {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Note session 1", Duration::from_secs(10)),
        "the catalog never rendered:\n{}",
        harness.text()
    );
    let query = format!("session {TARGET}");
    let started = Instant::now();
    // Same reason as the walk: the filter belongs to the list, so the list has
    // to hold the keyboard before `/` arms it.
    harness.write(b"\t");
    harness.write(b"/");
    let mut keys = 2;
    for byte in query.bytes() {
        harness.write(&[byte]);
        keys += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    harness.write(b"\r");
    keys += 1;
    let opened = harness.wait_for("fixture answer", Duration::from_secs(20));
    let elapsed = started.elapsed().as_millis();
    harness.shutdown();
    opened.then_some((keys, elapsed))
}

#[test]
fn finding_a_session_costs_a_query_not_a_walk() {
    let walked = walk().expect("walking never opened the row");
    let filtered = filter().expect("filtering never opened the row");
    println!(
        "VAL-03 find-session catalog={CATALOG} target={TARGET}: walk={} keys/{} ms, filter={} keys/{} ms",
        walked.0, walked.1, filtered.0, filtered.1
    );
    assert!(
        filtered.0 < walked.0,
        "the query cost {} keystrokes against a walk of {}",
        filtered.0,
        walked.0
    );
}
