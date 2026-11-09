//! JOB-02: the jobs dialog names each owner, and a reopened list shows the
//! state the engine holds now, not the state it held when the Session opened.
//!
//! The scripted engine answers `jobs` with two jobs owned by different
//! Sessions and one subagent run; `MIAO_TUI_FAKE_JOBS` names the phase, so a
//! restart answers a different state and the reopened dialog shows it.

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
    fn spawn(phase: &str) -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-jobs-dialog");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
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
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
        cmd.env("MIAO_TUI_FAKE_JOBS", phase);
        let db = dir.join("engine.db");
        std::fs::write(&db, b"").expect("engine db file");
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.arg("--db");
        cmd.arg(&db);
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
                        seen.lock().expect("output lock").extend_from_slice(&buf[..n]);
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

    /// The screen, not the byte stream: a repaint writes cell runs separated
    /// by cursor motions, so reconstructing the terminal gives what a person
    /// actually sees.
    fn screen(&self) -> String {
        let size = self.pty.get_size().expect("pty size");
        let mut parser = vt100::Parser::new(size.rows, size.cols, 0);
        parser.process(&self.output.lock().expect("output lock"));
        parser.screen().contents()
    }

    fn wait_for(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.screen().contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
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

/// `<leader>j` opens the jobs dialog: every job names the Session that owns
/// it, and the Session's subagent runs sit under the jobs as read-only rows.
#[test]
fn the_jobs_dialog_names_each_owner_and_the_session_subagents() {
    let mut harness = Harness::spawn("before");
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(30)),
        "the session did not open:\n{}",
        harness.screen()
    );
    harness.write(b"\x18j");
    assert!(
        harness.wait_for("job_build · ses_a · running", Duration::from_secs(30)),
        "the owner column never rendered:\n{}",
        harness.screen()
    );
    assert!(
        harness.wait_for("job_deploy · ses_c · finished", Duration::from_secs(30)),
        "the second job's owner never rendered:\n{}",
        harness.screen()
    );
    assert!(
        harness.wait_for("◇ sub_survey · ses_a · running", Duration::from_secs(30)),
        "the subagent row never rendered:\n{}",
        harness.screen()
    );
    harness.shutdown();
}

/// A restarted Session answers the engine's real state now: the reopened
/// dialog shows the jobs as they are after the restart, not as they were.
#[test]
fn a_reopened_jobs_dialog_shows_the_state_after_the_restart() {
    let mut harness = Harness::spawn("before");
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(30)),
        "the session did not open:\n{}",
        harness.screen()
    );
    harness.write(b"\x18j");
    assert!(
        harness.wait_for("job_build · ses_a · running", Duration::from_secs(30)),
        "the list never showed the pre-restart state:\n{}",
        harness.screen()
    );
    harness.shutdown();

    let mut harness = Harness::spawn("after");
    assert!(
        harness.wait_for("hello from the fixture", Duration::from_secs(30)),
        "the restarted session did not open:\n{}",
        harness.screen()
    );
    harness.write(b"\x18j");
    assert!(
        harness.wait_for("job_build · ses_a · finished", Duration::from_secs(30)),
        "the reopened list still shows the pre-restart state:\n{}",
        harness.screen()
    );
    assert!(
        harness.wait_for("◇ sub_survey · ses_a · finished", Duration::from_secs(30)),
        "the subagent row still shows the pre-restart state:\n{}",
        harness.screen()
    );
    harness.shutdown();
}
