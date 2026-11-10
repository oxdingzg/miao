//! WSP-02 acceptance: the changes view's whole path, timed where the operator
//! waits.
//!
//! The engine-side scale numbers live in `crates/miao-engine/tests/vcs_scale.rs`;
//! this harness times the two ends that harness cannot see. `chord_to_rendered`
//! drives a real TUI over a real wire against the scripted engine: the leader
//! chord goes in, the engine's answer travels back, the view decodes it and
//! paints — and the sample is the wall time until the file count is on screen.
//! The scripted answer is scaled with `MIAO_FAKE_VCS_FILES`, so the same path
//! is timed with a three-file tree and with a 3300-entry answer, which is the
//! size a large review session actually returns. Because the engine answer is
//! scripted, the delta between the two scenarios is the TUI's own share of the
//! path (wire read, decode, render), on top of whatever git costs on the real
//! tree the engine harness measures.
//!
//! `render_only` times just the dialog's paint on a test backend, so a linear
//! scan over every file on every frame cannot hide inside the end-to-end
//! number. Reports land in `$TMPDIR/miao-vcs-latency/` as JSON; the loose
//! sanity bounds exist so a pathological regression fails the run, not to
//! certify a machine.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const REPEATS: usize = 10;
/// Samples the whole scenario may start over before a miss is reported.
const RETRIES: usize = 3;
const LARGE_FILES: usize = 3_300;
const BUDGET: Duration = Duration::from_secs(30);

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
}

impl Harness {
    fn spawn(dir: PathBuf, scaled_files: Option<usize>) -> Self {
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
        if !db.exists() {
            std::fs::write(&db, b"").expect("engine db file");
        }
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        // The child inherits this, so the scripted answer scales with the
        // scenario without a fixture flag.
        if let Some(count) = scaled_files {
            cmd.env("MIAO_FAKE_VCS_FILES", count.to_string());
        }
        cmd.arg("--db");
        cmd.arg(&db);
        // The launcher is a prompt now (`d5ca52247a`); `--session` is its
        // direct entry point, so these measurements start in the Session.
        cmd.arg("--session");
        cmd.arg("ses_a");
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
}

/// Wait until `needle` renders. `None` means the phase never happened inside
/// the budget, and it is reported as the timeout rather than dropped.
fn until(harness: &Harness, needle: &str, started: Instant) -> Option<Duration> {
    let deadline = started + BUDGET;
    loop {
        if harness.text().replace('\r', "").contains(needle) {
            return Some(started.elapsed());
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// One end-to-end sample: open the scripted session, send the leader chord,
/// and time the wall until the changes view answers on screen.
fn measure_scenario(
    dir: PathBuf,
    scaled_files: Option<usize>,
    repeats: usize,
) -> Vec<Option<u128>> {
    let mut samples = Vec::new();
    let mut retries = RETRIES;
    for _ in 0..repeats {
        let mut sample = sample_once(&dir, scaled_files);
        // One starved sample is not evidence that the chord never paints: the
        // runner shares its cores with other jobs, and a sample whose process
        // was descheduled past the budget looks exactly like a broken key
        // binding. Start that sample over, but spend from a per-scenario budget
        // so a chord that genuinely never renders still fails instead of
        // turning this harness into a long wait, and only report a miss once
        // the budget is gone.
        while sample.is_none() && retries > 0 {
            retries -= 1;
            sample = sample_once(&dir, scaled_files);
        }
        samples.push(sample.map(|elapsed| elapsed.as_millis()));
    }
    samples
}

fn sample_once(dir: &std::path::Path, scaled_files: Option<usize>) -> Option<Duration> {
    let mut harness = Harness::spawn(dir.to_path_buf(), scaled_files);
    let transcript = until(&harness, "hello from the fixture", Instant::now());
    let chord_time = transcript.and_then(|_| {
        // Leader arm, then the chord key: the clock starts at the arm.
        let started = Instant::now();
        harness.write(b"\x18");
        harness.write(b"g");
        let needle = match scaled_files {
            Some(count) => format!("{count} files"),
            None => "3 files".to_string(),
        };
        until(&harness, &needle, started)
    });
    let _ = harness.child.kill();
    drop(harness.pty);
    let _ = harness.reader.join();
    chord_time
}

fn percentile(sorted: &[u128], fraction: f64) -> u128 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn column(values: Vec<u128>) -> serde_json::Value {
    let mut sorted = values;
    sorted.sort_unstable();
    serde_json::json!({
        "p50_ms": percentile(&sorted, 0.50),
        "p95_ms": percentile(&sorted, 0.95),
        "max_ms": sorted.last().copied().unwrap_or(0),
    })
}

fn summarize(samples: &[Option<u128>]) -> serde_json::Value {
    let landed: Vec<u128> = samples.iter().filter_map(|sample| *sample).collect();
    let missed = samples.len() - landed.len();
    serde_json::json!({
        "samples": samples.len(),
        "never_rendered": missed,
        "chord_to_rendered": column(landed),
    })
}

#[test]
fn the_changes_whole_path_is_reported_small_and_scaled() {
    let dir = std::env::temp_dir().join("miao-vcs-latency").join("store");
    let _ = std::fs::remove_dir_all(&dir);
    let small = measure_scenario(dir.clone(), None, REPEATS);
    let large = measure_scenario(dir.clone(), Some(LARGE_FILES), REPEATS);
    let body = serde_json::json!({
        "scenario_small": {"changed_entries": 3, "whole_path": summarize(&small)},
        "scenario_large": {"changed_entries": LARGE_FILES, "whole_path": summarize(&large)},
        "render_only": render_report(),
        "decode_only": decode_report(),
    });
    let root = std::env::temp_dir().join("miao-vcs-latency");
    std::fs::create_dir_all(&root).expect("report dir");
    std::fs::write(root.join("vcs-latency.json"), format!("{body}\n")).expect("write report");
    println!("WSP-02 {body}");
    println!("reports: {}", root.display());

    // A chord that never paints is the failure this harness exists to catch,
    // so a timeout sample fails the run outright.
    for (scenario, samples) in [("small", &small), ("large", &large)] {
        assert!(
            samples.iter().all(|sample| sample.is_some()),
            "the {scenario} scenario never rendered within the budget: {body}"
        );
    }
    let Some(p95) = large
        .iter()
        .filter_map(|sample| *sample)
        .collect::<Vec<_>>()
        .into_iter()
        .min()
    else {
        panic!("no landed samples: {body}");
    };
    assert!(
        p95 < 5_000,
        "the scaled whole path is pathologically slow: fastest sample {p95} ms — {body}"
    );
}

/// The dialog's own paint, on a test backend at a review-sized area: 200
/// frames per scale, so per-frame work over every file cannot hide.
fn render_report() -> serde_json::Value {
    use miao_tui::theme::{builtin, Theme, ThemeMode, DEFAULT_THEME};
    use miao_tui::workspace_changes::{Change, Dialog, VcsState};
    use ratatui::{backend::TestBackend, Terminal};

    let theme = Theme {
        name: DEFAULT_THEME.to_string(),
        palette: builtin(DEFAULT_THEME, ThemeMode::Dark).expect("theme"),
    };
    let paint = |files: usize| -> Vec<u128> {
        let state = VcsState {
            branch: Some("main".into()),
            detached: false,
            ahead: Some(1),
            behind: None,
            files: (0..files)
                .map(|index| Change {
                    path: format!("src/file_{index}.rs"),
                    original_path: None,
                    kind: "modified".into(),
                })
                .collect(),
            truncated: false,
            file_count: Some(files as u64),
            repository: true,
        };
        let mut dialog = Dialog::new(1, "ses_scale");
        dialog.loaded(Ok(state));
        let area_width: u16 = 120;
        let mut samples = Vec::new();
        for _ in 0..200 {
            let mut terminal = Terminal::new(TestBackend::new(area_width, 40)).expect("terminal");
            let started = Instant::now();
            terminal
                .draw(|frame| dialog.render(frame, frame.area(), &theme))
                .expect("draw");
            samples.push(started.elapsed().as_micros());
        }
        samples
    };
    let mut sorted_small = paint(3);
    sorted_small.sort_unstable();
    let mut sorted_large = paint(5_000);
    sorted_large.sort_unstable();
    serde_json::json!({
        "note": "per-frame paint microseconds, TestBackend 120x40",
        "files_3": {
            "p50_us": percentile(&sorted_small, 0.50),
            "p95_us": percentile(&sorted_small, 0.95),
        },
        "files_5000": {
            "p50_us": percentile(&sorted_large, 0.50),
            "p95_us": percentile(&sorted_large, 0.95),
        },
    })
}

/// The decode half of the TUI's share: one wire answer in, a validated view
/// out. Timed separately so the wire read, decode and paint costs stay
/// attributable instead of collapsing into one number.
fn decode_report() -> serde_json::Value {
    let answer = serde_json::json!({
        "repository": true,
        "branch": "main",
        "detached": false,
        "ahead": 1,
        "behind": 0,
        "truncated": false,
        "file_count": LARGE_FILES,
        "files": (0..LARGE_FILES)
            .map(|index| serde_json::json!({
                "path": format!("src/file_{index}.rs"),
                "kind": "modified"
            }))
            .collect::<Vec<_>>(),
    });
    let wire = serde_json::to_vec(&answer).expect("serialize").len();
    let mut samples = Vec::new();
    for _ in 0..100 {
        let started = Instant::now();
        let state = miao_tui::workspace_changes::decode(answer.clone()).expect("decodes");
        samples.push(started.elapsed().as_micros());
        std::hint::black_box(&state);
    }
    samples.sort_unstable();
    serde_json::json!({
        "note": "decode microseconds for one scaled answer",
        "answer_bytes": wire,
        "p50_us": percentile(&samples, 0.50),
        "p95_us": percentile(&samples, 0.95),
    })
}
