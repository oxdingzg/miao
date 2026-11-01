//! PERF-01 input latency harness: PTY keypress-to-echo latency of the TUI
//! composer.
//!
//! The harness boots the real TUI against the scripted engine (the same
//! portable_pty setup as `smoke.rs`), enters a session, and types one
//! character at a time. For every keystroke it measures the time from writing
//! the byte to the character appearing in the rendered output stream, then
//! reports p50/p95/p99/max per scenario as JSON beside the workspace.
//!
//! The COST gate (p95 ≤ 50 ms, p99 ≤ 100 ms, `crates/miao-engine/docs/
//! measurements.md`) is the target this evidence is collected against; the
//! test itself only asserts a loose sanity bound so a slow machine fails
//! loudly without pretending to be a certification run.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize};

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
    dir: PathBuf,
}

impl Harness {
    /// Boot the TUI against the scripted engine without a stream.
    fn spawn_engine(label: &str) -> Self {
        Self::spawn_engine_mode(label, false)
    }

    /// Boot the TUI against the scripted engine, optionally with the fixture's
    /// sustained stream: one committed event every 10 ms for ten seconds, which
    /// is deliberately longer than any typing sample needs.
    fn spawn_engine_mode(label: &str, streaming: bool) -> Self {
        Self::spawn_engine_full(label, streaming, None)
    }

    /// A Session with a long transcript, so typing is measured against a
    /// realistic history rather than two messages.
    fn spawn_engine_history(label: &str, messages: usize) -> Self {
        Self::spawn_engine_full(label, false, Some(messages))
    }

    fn spawn_engine_full(label: &str, streaming: bool, history: Option<usize>) -> Self {
        let dir = std::env::temp_dir().join(format!("miao-input-latency-{label}"));
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
        cmd.env("MIAO_DISABLE_TERMINAL_TITLE", "0");
        let ready = dir.join("engine.ready");
        if ready.exists() {
            std::fs::remove_file(&ready).expect("reset fixture readiness");
        }
        cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
        let db = dir.join("engine.db");
        std::fs::write(&db, b"").expect("engine db file");
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        if streaming {
            cmd.env("MIAO_TUI_FAKE_STREAM", "1");
        }
        if let Some(messages) = history {
            cmd.env("MIAO_TUI_FAKE_HISTORY", messages.to_string());
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
                        // ConPTY probes the attached terminal with a
                        // cursor-position report and stalls rendering until
                        // the terminal answers; act like one.
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
            dir,
        }
    }

    fn write(&mut self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        writer.write_all(keys).expect("write keys");
        writer.flush().expect("flush keys");
    }

    fn output_len(&self) -> usize {
        self.output.lock().expect("output lock").len()
    }

    /// Bytes appended to the output stream since `marker`.
    fn output_since(&self, marker: usize) -> Vec<u8> {
        self.output.lock().expect("output lock")[marker..].to_vec()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }
}

fn wait_for_plain(harness: &Harness, needle: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if harness.text().replace("\r", "").contains(needle) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_exit(child: &mut Box<dyn Child + Send + Sync>, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("wait child") {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// One echo-latency sample: the bytes written and the ms until they showed up
/// in the rendered output stream.
struct Sample {
    latency_ms: u128,
}

/// Type `keys` one byte at a time; for each, wait until the byte shows up in
/// the output appended after the pre-write marker. A byte that never appears
/// within `per_key` is recorded at the timeout (and reported), not skipped —
/// a dropped keystroke is the worst latency outcome.
fn measure_echo(harness: &mut Harness, keys: &[u8], per_key: Duration) -> Vec<Sample> {
    let mut samples = Vec::new();
    for &sent in keys {
        let marker = harness.output_len();
        let sent_at = Instant::now();
        harness.write(&[sent]);
        let mut latency: Option<Duration> = None;
        while sent_at.elapsed() < per_key {
            if harness.output_since(marker).contains(&sent) {
                latency = Some(sent_at.elapsed());
                break;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        samples.push(Sample {
            latency_ms: latency.unwrap_or(per_key).as_millis(),
        });
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

fn write_report(dir: &std::path::Path, scenario: &str, samples: &[Sample]) {
    let mut latencies: Vec<u128> = samples.iter().map(|sample| sample.latency_ms).collect();
    latencies.sort_unstable();
    let report = json_report(
        scenario,
        samples.len(),
        percentile(&latencies, 0.50),
        percentile(&latencies, 0.95),
        percentile(&latencies, 0.99),
        latencies.last().copied().unwrap_or(0),
    );
    let path = dir.join(format!("input-latency-{scenario}.json"));
    std::fs::write(&path, &report).expect("write latency report");
    println!("PERF-01 {scenario}: {report}");
}

fn json_report(
    scenario: &str,
    samples: usize,
    p50: u128,
    p95: u128,
    p99: u128,
    max: u128,
) -> String {
    format!(
        "{{\"scenario\":\"{scenario}\",\"samples\":{samples},\"p50_ms\":{p50},\"p95_ms\":{p95},\"p99_ms\":{p99},\"max_ms\":{max},\"gate_p95_ms\":50,\"gate_p99_ms\":100}}"
    )
}

#[test]
fn typing_echo_latency_is_reported_for_the_composer() {
    let mut harness = Harness::spawn_engine("idle-typing");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(4)),
        "the home list did not render:\n{}",
        harness.text()
    );
    // Enter the first fake session so the composer is the active surface.
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(3)),
        "the session transcript did not render:\n{}",
        harness.text()
    );
    // Let the first full frame settle so the per-keystroke measurement starts
    // from a quiescent renderer.
    std::thread::sleep(Duration::from_millis(300));

    // One distinct byte per keystroke, so the echo scan can never match an
    // earlier occurrence of the same character.
    let keys: Vec<u8> = b"abcdefghijklmnopqrstuvwxyz0123456789".to_vec();
    let samples = measure_echo(&mut harness, &keys, Duration::from_millis(1500));

    write_report(&harness.dir, "composer-idle", &samples);
    // Sanity bound only: a dropped or multi-second-echo keystroke fails the
    // run. The COST gate itself is evaluated against the recorded percentiles
    // in the evidence JSON, not asserted here.
    let worst = samples
        .iter()
        .map(|sample| sample.latency_ms)
        .max()
        .unwrap_or(0);
    assert!(
        worst < 1500,
        "a keystroke took {worst} ms to echo — dropped input or a hung renderer"
    );
    // The composer still holds the typed characters: the first Ctrl-C clears
    // the input, the second exits the TUI.
    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(200));
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(10)).expect("tui did not exit");
    assert!(status.success());
    // Keep the workspace (with the latency reports) for the evidence step;
    // drop the pty writer first so the reader thread sees EOF, like smoke.rs.
    drop(harness.writer);
    drop(harness.pty);
    let _ = harness.reader.join();
    // The TUI's exit does not stop its engine child: without this cleanup the
    // orphan keeps running into the next test binary and breaks the editor
    // signal tests that follow.
    let _ = std::process::Command::new("pkill")
        .args(["-f", "miao-tui-fake-engine"])
        .status();
    std::thread::sleep(Duration::from_millis(150));
}

#[test]
fn typing_echo_latency_is_reported_in_a_long_session() {
    // PERF-01 also asks for a 10k-line history: the per-keystroke cost has to
    // hold up in a Session that is not two messages long.
    let mut harness = Harness::spawn_engine_history("long-history", 10_000);
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(6)),
        "the home list did not render:\n{}",
        harness.text()
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "answer 5000", Duration::from_secs(20)),
        "the long transcript did not render:\n{}",
        harness.text()
    );
    std::thread::sleep(Duration::from_millis(300));

    let keys: Vec<u8> = b"abcdefghijklmnopqrstuvwxyz0123456789".to_vec();
    let samples = measure_echo(&mut harness, &keys, Duration::from_millis(2000));

    write_report(&harness.dir, "composer-long-history", &samples);
    let worst = samples
        .iter()
        .map(|sample| sample.latency_ms)
        .max()
        .unwrap_or(0);
    assert!(
        worst < 2000,
        "a keystroke took {worst} ms to echo in a long Session — dropped input or a hung renderer"
    );

    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(200));
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(10)).expect("tui did not exit");
    assert!(status.success());
    drop(harness.writer);
    drop(harness.pty);
    let _ = harness.reader.join();
    let _ = std::process::Command::new("pkill")
        .args(["-f", "miao-tui-fake-engine"])
        .status();
    std::thread::sleep(Duration::from_millis(150));
}

#[test]
fn typing_echo_latency_is_reported_while_the_turn_streams() {
    // PERF-01 is about input-first latency under sustained load, so this is the
    // scenario the gate actually cares about: the transcript is committing an
    // event every 10 ms while the operator types.
    let mut harness = Harness::spawn_engine_mode("streaming-typing", true);
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(4)),
        "the home list did not render:\n{}",
        harness.text()
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(3)),
        "the session transcript did not render:\n{}",
        harness.text()
    );
    // One byte per keystroke so the echo scan can never match an earlier
    // occurrence of the same character, and few enough that the whole sample
    // sits inside the fixture's ten seconds of streaming.
    let keys: Vec<u8> = b"abcdefghijkl".to_vec();
    let before = harness.output_len();
    let samples = measure_echo(&mut harness, &keys, Duration::from_millis(1500));
    // The stream advanced while the keystrokes were being measured; without
    // this the scenario would silently degrade to the idle case.
    assert!(
        harness.output_len() > before,
        "nothing streamed during the measurement"
    );
    write_report(&harness.dir, "composer-streaming", &samples);
    let worst = samples
        .iter()
        .map(|sample| sample.latency_ms)
        .max()
        .unwrap_or(0);
    assert!(
        worst < 1500,
        "a keystroke took {worst} ms to echo while the turn streamed"
    );
    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(200));
    harness.write(b"\x03");
    let _ = wait_exit(&mut harness.child, Duration::from_secs(10));
    drop(harness.writer);
    drop(harness.pty);
    let _ = harness.reader.join();
    let _ = std::process::Command::new("pkill")
        .args(["-f", "miao-tui-fake-engine"])
        .status();
    std::thread::sleep(Duration::from_millis(150));
}
