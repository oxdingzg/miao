//! PERF-03 startup latency harness: how long the TUI takes to become usable.
//!
//! Three phases are recorded separately, because they answer different
//! questions and a single "startup time" hides which one regressed:
//!
//! - `first_frame`: process start until any output at all, which separates a
//!   slow engine handshake from a slow first paint.
//! - `ready_to_type`: process start until the home list is on screen, i.e. the
//!   first frame the operator can type into.
//! - `ready_to_submit`: opening a Session until its transcript renders, i.e.
//!   the moment a prompt can be sent with the real context on screen.
//!
//! Each scenario repeats and reports p50/p95, cold and warm, so a store that
//! only gets slow once it has data shows up. The gate in
//! `crates/miao-engine/docs/measurements.md` is warm ready-to-type p95 <= 500
//! ms; this test only asserts a loose sanity bound so a slow machine fails
//! loudly without pretending to be a certification run.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const REPEATS: usize = 5;
const BUDGET: Duration = Duration::from_secs(20);

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
}

impl Harness {
    /// Boot the TUI against the scripted engine in `dir`. A cold run starts
    /// from an empty workspace and ledger; a warm run keeps what the previous
    /// run left, which is what a second launch in the same workspace sees.
    fn spawn(dir: PathBuf, fresh: bool) -> Self {
        if fresh && dir.exists() {
            std::fs::remove_dir_all(&dir).expect("reset workspace dir");
        }
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
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
        if ready.exists() {
            std::fs::remove_file(&ready).expect("reset fixture readiness");
        }
        cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
        let db = dir.join("engine.db");
        if fresh || !db.exists() {
            std::fs::write(&db, b"").expect("engine db file");
        }
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
                        // ConPTY probes the attached terminal with a
                        // cursor-position report and stalls rendering until the
                        // terminal answers; act like one.
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
        writer.write_all(keys).expect("write keys");
        writer.flush().expect("flush keys");
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }

    fn has_output(&self) -> bool {
        !self.output.lock().expect("output lock").is_empty()
    }
}

/// Wait until `needle` renders. `None` means the phase never happened inside
/// the budget, and it is reported as the timeout rather than dropped: a phase
/// that never arrives is the worst startup outcome, not a missing sample.
fn until(harness: &Harness, needle: &str, started: Instant) -> Option<Duration> {
    let deadline = started + BUDGET;
    loop {
        if harness.text().replace('\r', "").contains(needle) {
            return Some(started.elapsed());
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

struct Sample {
    first_frame_ms: u128,
    ready_to_type_ms: u128,
    ready_to_submit_ms: u128,
}

fn measure(dir: PathBuf, fresh: bool, rounds: usize) -> Vec<Sample> {
    let mut samples = Vec::new();
    for _ in 0..rounds {
        let spawned = Instant::now();
        let mut harness = Harness::spawn(dir.clone(), fresh);
        let mut first_frame = None;
        while spawned.elapsed() < BUDGET {
            if harness.has_output() {
                first_frame = Some(spawned.elapsed());
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let ready_to_type = until(&harness, "Project A", spawned);
        let opened = Instant::now();
        harness.write(b"\r");
        let ready_to_submit = until(&harness, "hello from the fixture", opened);
        samples.push(Sample {
            first_frame_ms: first_frame.unwrap_or(BUDGET).as_millis(),
            ready_to_type_ms: ready_to_type.unwrap_or(BUDGET).as_millis(),
            ready_to_submit_ms: ready_to_submit.unwrap_or(BUDGET).as_millis(),
        });
        harness.write(b"\x03");
        let _ = harness.child.kill();
        drop(harness.pty);
        let _ = harness.reader.join();
    }
    samples
}

fn percentile(sorted: &[u128], fraction: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn column(values: Vec<u128>) -> String {
    let mut sorted = values;
    sorted.sort_unstable();
    format!(
        "{{\"p50_ms\":{},\"p95_ms\":{},\"max_ms\":{}}}",
        percentile(&sorted, 0.50),
        percentile(&sorted, 0.95),
        sorted.last().copied().unwrap_or(0)
    )
}

fn report(scenario: &str, samples: &[Sample]) -> String {
    format!(
        "{{\"scenario\":\"{scenario}\",\"samples\":{},\"first_frame\":{},\"ready_to_type\":{},\"ready_to_submit\":{},\"gate\":{{\"warm_ready_to_type_p95_ms\":500}}}}",
        samples.len(),
        column(samples.iter().map(|s| s.first_frame_ms).collect()),
        column(samples.iter().map(|s| s.ready_to_type_ms).collect()),
        column(samples.iter().map(|s| s.ready_to_submit_ms).collect()),
    )
}

#[test]
fn startup_phases_are_reported_cold_and_warm() {
    let root = std::env::temp_dir().join("miao-startup-latency");
    let store = root.join("store");
    let cold = measure(store.clone(), true, REPEATS);
    assert!(
        cold.iter().all(|sample| sample.ready_to_type_ms < 20_000),
        "the cold run never became usable: {}",
        report("cold", &cold)
    );
    // The warm scenario reuses the store the cold run created.
    let warm = measure(store, false, REPEATS);
    let cold_body = report("cold", &cold);
    let warm_body = report("warm", &warm);
    std::fs::create_dir_all(&root).expect("report dir");
    std::fs::write(root.join("startup-latency-cold.json"), &cold_body).expect("write cold report");
    std::fs::write(root.join("startup-latency-warm.json"), &warm_body).expect("write warm report");
    println!("PERF-03 cold: {cold_body}");
    println!("PERF-03 warm: {warm_body}");
    println!("reports: {}", root.display());
}
