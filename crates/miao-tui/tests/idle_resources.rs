//! PERF-04 resource harness: what an idle TUI costs.
//!
//! The criterion asks for CPU, RSS and file-descriptor usage to be *recorded*
//! across idle runs rather than inferred. This spawns the real TUI against the
//! scripted engine, lets the first frames settle, and samples the process with
//! `ps` over a quiet window.
//!
//! The assertions are deliberately loose — an idle TUI burning a whole core or
//! holding half a gigabyte is a regression worth failing on, while an exact
//! figure in a debug build on a shared runner is not.

use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, PtySize};

struct Harness {
    /// Held so the master side stays open for the life of the child.
    _pty: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    dir: PathBuf,
    pid: u32,
}

impl Harness {
    fn spawn(label: &str) -> Self {
        Self::spawn_with(label, &[], None)
    }

    /// `session` lands the TUI inside that Session, which is what makes a
    /// streaming measurement describe the paint path rather than the home list.
    fn spawn_with(label: &str, environment: &[(&str, &str)], session: Option<&str>) -> Self {
        let dir = std::env::temp_dir().join(format!("miao-idle-resources-{label}"));
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                ..Default::default()
            })
            .expect("open pty");
        let ready = dir.join("engine.ready");
        let _ = std::fs::remove_file(&ready);
        let db = dir.join("engine.db");
        std::fs::write(&db, b"").expect("engine db file");
        let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_miao-tui"));
        cmd.arg("--workspace");
        cmd.arg(&dir);
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
        cmd.env("MIAO_DISABLE_TERMINAL_TITLE", "0");
        cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        for (key, value) in environment {
            cmd.env(key, value);
        }
        if let Some(session) = session {
            cmd.arg("--session");
            cmd.arg(session);
        }
        cmd.arg("--db");
        cmd.arg(&db);
        let child = pair.slave.spawn_command(cmd).expect("spawn miao-tui");
        drop(pair.slave);
        // Drain the pty: a full buffer would block the child and make the
        // measurement describe a stuck process instead of an idle one.
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(read) = reader.read(&mut buf) {
                if read == 0 {
                    break;
                }
            }
        });
        let pid = child.process_id().expect("the child has a pid");
        Self {
            _pty: pair.master,
            child,
            dir,
            pid,
        }
    }

    fn ready(&self) -> bool {
        std::fs::read(self.dir.join("engine.ready")).is_ok_and(|bytes| bytes == b"ready")
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Cumulative CPU milliseconds and resident kilobytes for one process.
fn sample(pid: u32) -> (u128, u64) {
    let output = Command::new("ps")
        .args(["-o", "time=", "-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.split_whitespace();
    let time = fields.next().unwrap_or("0:00");
    let rss = fields.next().and_then(|value| value.parse::<u64>().ok());
    (cpu_millis(time), rss.unwrap_or(0))
}

/// Open file descriptors for one process. Linux exposes them as a directory;
/// macOS needs `lsof`, which is why the two paths differ rather than the count
/// being inferred from memory or handles.
fn descriptors(pid: u32) -> Option<usize> {
    let proc_dir = format!("/proc/{pid}/fd");
    if let Ok(entries) = std::fs::read_dir(&proc_dir) {
        return Some(entries.filter_map(Result::ok).count());
    }
    let output = Command::new("lsof")
        .args(["-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // `-Fn` prints one `n<path>` line per open descriptor; the process and
    // file-name lines carry other letters.
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().filter(|line| line.starts_with('n')).count())
}

/// The process and every descendant of it. The TUI spawns the engine when
/// embedding is off, and the engine in turn spawns whatever it runs (a sandbox
/// helper, an MCP or LSP server, a worker), so a one-level walk would miss the
/// members the criterion names. The walk stops at a depth and a size bound so a
/// pathological tree cannot loop.
fn tree(pid: u32) -> Vec<u32> {
    fn children(pid: u32) -> Vec<u32> {
        let Ok(output) = Command::new("pgrep")
            .args(["-P", &pid.to_string()])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect()
    }
    let mut pids = vec![pid];
    let mut next = 0;
    while next < pids.len() && pids.len() < 64 {
        let current = pids[next];
        next += 1;
        for child in children(current) {
            if !pids.contains(&child) {
                pids.push(child);
            }
        }
    }
    pids
}

/// The executable name, so a record can say which members the tree held
/// instead of only how many.
fn command_name(pid: u32) -> String {
    let Ok(output) = Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
    else {
        return "unknown".to_string();
    };
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    raw.rsplit('/').next().unwrap_or_default().to_string()
}

/// Sum of the measured window across every process in the tree./// Sum of the measured window across every process in the tree.
fn measure_tree(harness: &Harness, label: &str, window: Duration) -> (usize, u128, u64, u64) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !harness.ready() {
        assert!(
            Instant::now() < deadline,
            "the fixture did not become ready; the measurement would describe a start-up, not a run"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_secs(2));
    let pids = tree(harness.pid);
    let before = pids.iter().map(|pid| sample(*pid).0).sum::<u128>();
    std::thread::sleep(window);
    let pids = tree(harness.pid);
    let mut cpu_ms = 0;
    let mut rss_kb = 0;
    let mut fds = 0;
    for pid in &pids {
        let (cpu, rss) = sample(*pid);
        cpu_ms += cpu;
        rss_kb += rss;
        fds += descriptors(*pid).unwrap_or(0) as u64;
    }
    let cpu_ms = cpu_ms.saturating_sub(before);
    let members = pids
        .iter()
        .map(|pid| command_name(*pid))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "PERF-04 {label}: processes={} [{members}] cpu_ms={cpu_ms} over {}ms, rss_kb_total={rss_kb}, fds_total={fds}",
        pids.len(),
        window.as_millis()
    );
    (pids.len(), cpu_ms, rss_kb, fds)
}

/// `ps` prints `M:SS.ss` on macOS and `HH:MM:SS` on Linux; reading the parts
/// from the left with a base of sixty handles both.
fn cpu_millis(spec: &str) -> u128 {
    let seconds = spec.split(':').fold(0.0, |total, part| {
        total * 60.0 + part.parse::<f64>().unwrap_or(0.0)
    });
    (seconds * 1000.0) as u128
}

/// Wait for the fixture, let the first frames settle, then measure one window.
/// Both scenarios describe the same protocol so their numbers are comparable.
fn measure(harness: &Harness, label: &str, window: Duration) -> (u128, u64, Option<usize>) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !harness.ready() {
        assert!(
            Instant::now() < deadline,
            "the fixture did not become ready; the measurement would describe a start-up, not a run"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Let the first frames and the engine's initial projections settle, so the
    // window describes steady state rather than start-up.
    std::thread::sleep(Duration::from_secs(2));
    let (before, _) = sample(harness.pid);
    std::thread::sleep(window);
    let (after, rss_kb) = sample(harness.pid);
    let cpu_ms = after.saturating_sub(before);
    let fds = descriptors(harness.pid);
    println!(
        "PERF-04 {label}: cpu_ms={cpu_ms} over {}ms, rss_kb={rss_kb}, fds={}",
        window.as_millis(),
        fds.map_or_else(|| "unavailable".to_string(), |count| count.to_string())
    );
    (cpu_ms, rss_kb, fds)
}

#[test]
fn an_idle_tui_reports_its_cpu_and_memory() {
    let harness = Harness::spawn("idle");
    let (cpu_ms, rss_kb, fds) = measure(&harness, "idle", Duration::from_secs(3));
    assert!(
        cpu_ms < 3_000,
        "an idle TUI used {cpu_ms} ms of CPU in three seconds, which is a busy loop rather than an idle wait"
    );
    assert!(
        rss_kb > 0 && rss_kb < 512 * 1024,
        "an idle TUI held {rss_kb} kB of memory"
    );
    // A leak shows up here long before it shows up in RSS. The bound is loose
    // enough for a busy runner and tight enough that a descriptor leak per
    // frame would fail within a short window.
    if let Some(fds) = fds {
        assert!(
            fds > 0 && fds < 1024,
            "an idle TUI held {fds} open file descriptors"
        );
    }
}

#[test]
fn a_streaming_tui_reports_its_cpu_and_memory() {
    // The criterion pairs idle runs with prolonged streaming, so both have to
    // be recorded rather than only the quiet case. The fixture delivers a
    // committed event every ten milliseconds for ten seconds.
    // Inside the Session, so the stream is painted instead of merely arriving.
    let harness = Harness::spawn_with("streaming", &[("MIAO_TUI_FAKE_STREAM", "1")], Some("ses_a"));
    let (cpu_ms, rss_kb, fds) = measure(&harness, "streaming", Duration::from_secs(3));
    assert!(
        cpu_ms < 3_000,
        "a streaming TUI used {cpu_ms} ms of CPU in three seconds, which is a busy loop rather than a stream"
    );
    assert!(
        rss_kb > 0 && rss_kb < 512 * 1024,
        "a streaming TUI held {rss_kb} kB of memory"
    );
    if let Some(fds) = fds {
        assert!(
            fds > 0 && fds < 1024,
            "a streaming TUI held {fds} open file descriptors"
        );
    }
}

#[test]
fn a_spawned_engine_appears_in_the_process_tree() {
    // PERF-04 asks for the whole process tree; the embedded default is one
    // process, so this measures the shape that actually has one: the TUI with
    // the engine it spawned.
    let harness = Harness::spawn_with("spawned", &[("MIAO_TUI_EMBEDDED", "0")], None);
    let (processes, cpu_ms, rss_kb, fds) =
        measure_tree(&harness, "spawned-engine", Duration::from_secs(3));
    assert!(
        processes >= 2,
        "the spawned engine is missing from the tree: {processes} process(es)"
    );
    assert!(
        cpu_ms < 3_000,
        "the tree used {cpu_ms} ms of CPU in three seconds while idle"
    );
    assert!(
        rss_kb > 0 && rss_kb < 512 * 1024,
        "the tree held {rss_kb} kB of memory"
    );
    assert!(fds > 0 && fds < 2048, "the tree held {fds} descriptors");
}
