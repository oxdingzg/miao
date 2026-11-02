//! VAL-03: what one wrong turn costs, and how much the correction adds.
//!
//! VAL-03 asks for mistakes and rework as well as time-to-state. Half of that is
//! scriptable: the *cost of a correction* is deterministic — the same keystrokes
//! and the same screen every run — so it is measured here. What a script cannot
//! know is how often people actually take a wrong turn; that frequency needs an
//! operator record, and this file deliberately does not pretend to produce it.
//!
//! Two rework paths against the same 200-Session catalog, each compared with the
//! clean path measured in the same run:
//!
//! - a mistyped query (`session 15O` for `session 150`), corrected with one
//!   backspace before submitting;
//! - walking five rows too far down the list and coming back with `k`.

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
        // Each harness gets its own directory: the two tests in this file run in
        // parallel and would otherwise share one catalog and one engine socket.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "miao-interaction-misstep-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
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
/// Walk to the target row, optionally overshooting by `overshoot` rows first and
/// correcting with `k`. Returns the keystrokes spent and the time to open.
fn walk(overshoot: usize) -> Option<(usize, u128)> {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Note session 1", Duration::from_secs(10)),
        "the catalog never rendered:\n{}",
        harness.text()
    );
    let started = Instant::now();
    // The prompt owns the landing screen's keyboard, so `Tab` hands it to the list.
    harness.write(b"\t");
    let mut keys = 1;
    for _ in 1..TARGET + overshoot {
        harness.write(b"j");
        keys += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    for _ in 0..overshoot {
        harness.write(b"k");
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

/// Ask for `query`, then apply `corrections` (each a key sequence) before
/// submitting. Returns the keystrokes spent and the time to open.
fn filter(query: &str, corrections: Vec<Vec<u8>>) -> Option<(usize, u128)> {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("Note session 1", Duration::from_secs(10)),
        "the catalog never rendered:\n{}",
        harness.text()
    );
    let started = Instant::now();
    harness.write(b"\t");
    harness.write(b"/");
    let mut keys = 2;
    harness.write(query.as_bytes());
    keys += query.len();
    for correction in corrections {
        harness.write(&correction);
        keys += correction.len();
        std::thread::sleep(Duration::from_millis(5));
    }
    harness.write(b"\r");
    keys += 1;
    let opened = harness.wait_for("fixture answer", Duration::from_secs(20));
    let elapsed = started.elapsed().as_millis();
    harness.shutdown();
    opened.then_some((keys, elapsed))
}
#[test]
fn a_wrong_turn_costs_the_correction_on_top_of_the_intended_path() {
    // Sequential on purpose: the harness reaps every fixture engine on shutdown,
    // so two measurements running in parallel would kill each other's engine.
    let clean_query =
        filter("session 150", Vec::new()).expect("the clean query never opened the row");
    let mistyped = filter("session 15O", vec![vec![0x7f], b"0".to_vec()])
        .expect("the corrected query never opened the row");
    println!(
        "VAL-03 misstep query-typo: clean={} keys/{} ms, corrected={} keys/{} ms",
        clean_query.0, clean_query.1, mistyped.0, mistyped.1
    );
    assert!(
        mistyped.0 > clean_query.0,
        "a corrected typo cost {} keystrokes, no more than the clean {}",
        mistyped.0,
        clean_query.0
    );

    let clean_walk = walk(0).expect("the clean walk never opened the row");
    let overshot = walk(5).expect("the corrected walk never opened the row");
    println!(
        "VAL-03 misstep walk-overshoot: clean={} keys/{} ms, overshot={} keys/{} ms",
        clean_walk.0, clean_walk.1, overshot.0, overshot.1
    );
    assert!(
        overshot.0 > clean_walk.0,
        "an overshoot cost {} keystrokes, no more than the clean {}",
        overshot.0,
        clean_walk.0
    );
}
