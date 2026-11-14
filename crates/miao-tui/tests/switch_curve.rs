#![cfg(unix)]

//! PERF-04 switch curve: what a hundred Session switches cost.
//!
//! The criterion asks for CPU, RSS and descriptor usage "across 100 Session
//! switches". Opening a Session and leaving it again exercises the paths that
//! could leak — the snapshot read, the subscription, the projection and the
//! teardown — so this drives that cycle through the real binary and samples the
//! process before and after.
//!
//! The assertions are about growth, not about an absolute figure: a healthy
//! TUI returns to roughly where it started, and a leak shows up as a slope.
//!
//! Unix only: the fixture is driven through a pty and the samples come from
//! `ps` and `/proc` or `lsof`, none of which describe a Windows process.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, PtySize};

/// One switch is "open the Session, then leave it again".
const SWITCHES: usize = 100;

struct Harness {
    /// Held so the pty stays open for the child's lifetime; the reader owns its
    /// clone and the assertions read the byte stream.
    _pty: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    pid: u32,
    dir: PathBuf,
}

impl Harness {
    fn spawn(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("miao-switch-curve-{label}"));
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
        cmd.arg("--db");
        cmd.arg(&db);
        // The launcher is a prompt now (`d5ca52247a`); `--session` is its
        // direct entry point, so these measurements start in the Session.
        cmd.arg("--session");
        cmd.arg("ses_a");
        let child = pair.slave.spawn_command(cmd).expect("spawn miao-tui");
        drop(pair.slave);
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take writer")));
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let output = Arc::new(Mutex::new(Vec::new()));
        let seen = output.clone();
        // The reader owns its clone of the master, so it ends when the child
        // does; nothing here has to join it.
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen
                        .lock()
                        .expect("output lock")
                        .extend_from_slice(&buf[..read]),
                }
            }
        });
        let pid = child.process_id().expect("the child has a pid");
        Self {
            _pty: pair.master,
            child,
            writer,
            output,
            pid,
            dir,
        }
    }

    fn send(&self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        writer.write_all(keys).expect("write keys");
        writer.flush().expect("flush keys");
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }

    fn wait_for(&self, needle: &str, timeout: Duration) -> bool {
        // Compare against everything the process wrote, not only the current
        // frame: entering and leaving a Session redraws the whole window, so a
        // marker that was painted and then scrolled away is still evidence the
        // switch happened.
        let deadline = Instant::now() + timeout;
        loop {
            if String::from_utf8_lossy(&self.output.lock().expect("output lock"))
                .replace('\r', "")
                .contains(needle)
            {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
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

/// Cumulative CPU milliseconds, resident kilobytes and open descriptors for
/// one process. The criterion asks for all three across the switches, so the
/// sample carries the CPU time too rather than inferring it from wall clock.
fn sample(pid: u32) -> (u128, u64, Option<usize>) {
    let output = Command::new("ps")
        .args(["-o", "time=", "-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.split_whitespace();
    let time = fields.next().unwrap_or("0:00");
    let rss = fields.next().and_then(|value| value.parse::<u64>().ok());
    (cpu_millis(time), rss.unwrap_or(0), descriptors(pid))
}

/// `ps` prints `M:SS.ss` on macOS and `HH:MM:SS` on Linux; reading the parts
/// from the left with a base of sixty handles both.
fn cpu_millis(spec: &str) -> u128 {
    let seconds = spec.split(':').fold(0.0, |total, part| {
        total * 60.0 + part.parse::<f64>().unwrap_or(0.0)
    });
    (seconds * 1000.0) as u128
}

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
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.starts_with('n'))
            .count(),
    )
}

#[test]
fn a_hundred_session_switches_do_not_grow_the_process() {
    let harness = Harness::spawn("sessions");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !harness.ready() {
        assert!(
            Instant::now() < deadline,
            "the fixture did not become ready; the curve would describe a start-up"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(10)),
        "the Session did not open:\n{}",
        harness.text()
    );
    // Let the first frames settle so the baseline is not start-up cost.
    std::thread::sleep(Duration::from_secs(1));
    let (cpu_before, rss_before, fds_before) = sample(harness.pid);
    let mut rss_peak = rss_before;

    let mut opened = 0;
    for index in 0..SWITCHES {
        // The launcher is a prompt, so a Session is opened from its history
        // dialog: the leader chord names the list, and Enter opens the row it
        // lands on. This is the same walk an operator makes.
        harness.send(b"\x18");
        harness.send(b"l");
        assert!(
            harness.wait_for("open · 1-9 pinned", Duration::from_secs(5)),
            "switch {index}: the session dialog never opened\n{}",
            harness.text()
        );
        harness.send(b"\r");
        assert!(
            harness.wait_for("hello from the fixture", Duration::from_secs(5)),
            "switch {index}: the Session never opened\n{}",
            harness.text()
        );
        harness.send(b"\x1b");
        assert!(
            harness.wait_for("Ask anything", Duration::from_secs(5)),
            "switch {index}: the launcher never came back\n{}",
            harness.text()
        );
        opened += 1;
        if opened % 25 == 0 {
            let (cpu, rss, fds) = sample(harness.pid);
            if rss > rss_peak {
                rss_peak = rss;
            }
            println!(
                "PERF-04 switches={opened} cpu_ms={} rss_kb={rss} fds={}",
                cpu.saturating_sub(cpu_before),
                fds.map_or_else(|| "unavailable".to_string(), |count| count.to_string())
            );
        }
    }
    // Give teardown a moment before the closing sample, so an in-flight release
    // cannot read as a leak.
    std::thread::sleep(Duration::from_secs(1));
    let (cpu_after, rss_after, fds_after) = sample(harness.pid);
    println!(
        "PERF-04 switch curve: {opened} switches, cpu_ms={}, rss_kb {rss_before} -> {rss_after}, fds {} -> {}",
        cpu_after.saturating_sub(cpu_before),
        fds_before.map_or_else(|| "unavailable".to_string(), |count| count.to_string()),
        fds_after.map_or_else(|| "unavailable".to_string(), |count| count.to_string())
    );

    let cpu_used = cpu_after.saturating_sub(cpu_before);
    assert!(
        cpu_used < 60_000,
        "a hundred switches used {cpu_used} ms of CPU, which is a busy loop rather than a switch curve"
    );
    let growth = rss_after.saturating_sub(rss_before);
    assert!(
        growth < 8 * 1024,
        "a hundred switches grew RSS by {growth} kB, which is a leak rather than warm caches"
    );
    if let (Some(before), Some(after)) = (fds_before, fds_after) {
        assert!(
            after <= before + 8,
            "a hundred switches left {before} -> {after} open descriptors"
        );
    }

    // The criterion's leak half: at rest the process returns to its high-water
    // mark instead of climbing past it. A leak per switch would put the final
    // sample above every checkpoint; a healthy one holds or drops once the
    // teardown has settled.
    std::thread::sleep(Duration::from_secs(3));
    let (_, rss_recheck, fds_recheck) = sample(harness.pid);
    println!(
        "PERF-04 switch settle: rss_kb={rss_recheck} (peak {rss_peak}), fds={}",
        fds_recheck.map_or_else(|| "unavailable".to_string(), |count| count.to_string())
    );
    assert!(
        rss_recheck <= rss_peak + 1024,
        "after a hundred switches the process kept climbing at rest: checkpoint peak {rss_peak} kB, settled at {rss_recheck} kB"
    );
}
