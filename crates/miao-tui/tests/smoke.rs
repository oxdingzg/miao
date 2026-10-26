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
    output: Arc<Mutex<String>>,
    reader: JoinHandle<()>,
    dir: PathBuf,
}

impl Harness {
    fn spawn(label: &str, inject_panic: bool) -> Self {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-smoke-{}-{label}", std::process::id()));
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
        if inject_panic {
            cmd.env("MIAO_TUI_TEST_PANIC", "1");
        }
        let child = pair.slave.spawn_command(cmd).expect("spawn miao-tui");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take writer")));
        let output = Arc::new(Mutex::new(String::new()));
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
                            .push_str(&String::from_utf8_lossy(&buf[..n]));
                        // windows-2025 ConPTY probes the attached terminal with a
                        // cursor-position report and stalls rendering until the
                        // terminal answers; act like one.
                        if !replied_cpr && seen.lock().expect("output lock").contains("\x1b[6n") {
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

    fn text(&self) -> String {
        self.output.lock().expect("output lock").clone()
    }

    fn write(&mut self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        writer.write_all(keys).expect("write keys");
        writer.flush().expect("flush keys");
    }

    fn resize(&self, rows: u16, cols: u16) {
        self.pty
            .resize(PtySize {
                rows,
                cols,
                ..Default::default()
            })
            .expect("resize pty");
    }

    fn shutdown(self) {
        drop(self.writer);
        drop(self.pty);
        let _ = self.reader.join();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn wait_for(harness: &Harness, needle: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if harness.text().contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    harness.text().contains(needle)
}

fn wait_exit(child: &mut Box<dyn Child + Send + Sync>, timeout: Duration) -> Option<ExitStatus> {
    let start = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if start.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn boots_renders_panes_and_quits_on_q() {
    let mut harness = Harness::spawn("start", false);
    assert!(
        wait_for(&harness, "miao-tui-smoke", Duration::from_secs(2)),
        "pane title with workspace name did not render in time:\n{}",
        harness.text()
    );
    let rendered = harness.text();
    assert!(
        rendered.contains("transcript"),
        "transcript pane missing:\n{rendered}"
    );
    assert!(
        rendered.contains("composer"),
        "composer pane missing:\n{rendered}"
    );
    harness.write(b"q");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after q");
    assert!(status.success(), "q must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn resize_keeps_process_alive() {
    let mut harness = Harness::spawn("resize", false);
    assert!(
        wait_for(&harness, "miao-tui-smoke", Duration::from_secs(2)),
        "pane title did not render in time:\n{}",
        harness.text()
    );
    for (rows, cols) in [(12, 60), (40, 120), (10, 40)] {
        harness.resize(rows, cols);
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            harness.child.try_wait().expect("try_wait").is_none(),
            "process exited during resize to {rows}x{cols}"
        );
    }
    harness.write(b"q");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after q");
    assert!(status.success(), "q must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn panic_restores_terminal() {
    let mut harness = Harness::spawn("panic", true);
    assert!(
        wait_for(&harness, "miao-tui-smoke", Duration::from_secs(2)),
        "pane title did not render in time:\n{}",
        harness.text()
    );
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("injected panic run did not exit");
    assert_eq!(
        status.exit_code(),
        101,
        "panic must exit 101, got {status:?}"
    );
    assert!(
        harness.text().contains("injected panic"),
        "panic message missing from output:\n{}",
        harness.text()
    );
    // ConPTY may re-encode VT sequences, so the literal restore check is
    // unix-only; on Windows the exit code plus message stand in.
    #[cfg(not(windows))]
    {
        let output = harness.text();
        let entered = output
            .find("\x1b[?1049h")
            .expect("alternate screen never entered");
        assert!(
            output[entered..].contains("\x1b[?1049l"),
            "terminal was not restored after panic:\n{output}"
        );
    }
    harness.shutdown();
}
