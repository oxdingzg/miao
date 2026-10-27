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
        Self::spawn_with(label, inject_panic, false, false)
    }

    /// Boot the TUI against the scripted engine so the smoke test can enter a
    /// Session without a database, a provider, or a model.
    fn spawn_engine(label: &str) -> Self {
        Self::spawn_with(label, false, true, false)
    }

    fn spawn_engine_approval(label: &str) -> Self {
        Self::spawn_with(label, false, true, true)
    }

    fn spawn_with(label: &str, inject_panic: bool, engine: bool, approval: bool) -> Self {
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
        if engine {
            let db = dir.join("engine.db");
            std::fs::write(&db, b"").expect("engine db file");
            cmd.env(
                "MIAO_ENGINE_BIN",
                env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
            );
            cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
            cmd.env("MIAO_TUI_FAKE_ADMIT_LOG", dir.join("admit.log"));
            if approval {
                cmd.env("MIAO_TUI_FAKE_APPROVAL", "1");
            }
            // History lives under the state dir; keep the developer's real
            // composer history out of a test run.
            cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
            cmd.arg("--db");
            cmd.arg(&db);
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

/// Strip terminal control sequences so assertions read the cells a person
/// sees; ratatui emits a cursor motion between separately styled cells (every
/// freshly typed character), which would otherwise split typed text.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // CSI runs to a final byte in @..=~; other escapes are two bytes.
        if chars.next() == Some('[') {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

fn wait_for_plain(harness: &Harness, needle: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if plain(&harness.text()).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    plain(&harness.text()).contains(needle)
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
fn boots_renders_panes_and_quits_on_ctrl_c() {
    let mut harness = Harness::spawn_engine("start");
    assert!(
        wait_for(&harness, "miao-tui-smoke", Duration::from_secs(2)),
        "pane title with workspace name did not render in time:\n{}",
        harness.text()
    );
    assert!(
        wait_for(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render the Session titles:\n{}",
        harness.text()
    );
    let rendered = harness.text();
    assert!(
        rendered.contains("sessions"),
        "home pane missing:\n{rendered}"
    );
    harness.write(b"\r");
    assert!(
        wait_for(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the transcript did not render the Session messages:\n{}",
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
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn resize_keeps_process_alive() {
    let mut harness = Harness::spawn_engine("resize");
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
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn multiline_paste_reaches_the_engine_verbatim() {
    let mut harness = Harness::spawn_engine("paste");
    assert!(
        wait_for(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        harness.text()
    );
    harness.write(b"\r");
    assert!(
        wait_for(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        harness.text()
    );
    // A bracketed paste arrives as one event; the editor keeps the line
    // break instead of treating it as a submit.
    harness.write("\x1b[200~第一行\n第二行\x1b[201~".as_bytes());
    assert!(
        wait_for_plain(&harness, "第一行", Duration::from_secs(2))
            && plain(&harness.text()).contains("第二行"),
        "CJK paste did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("第一行\\n第二行") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("第一行\\n第二行"),
        "admit did not carry the pasted prompt verbatim: {recorded}"
    );
    assert!(
        recorded.contains("\"delivery\":\"steer\""),
        "the TUI must send steer prompts: {recorded}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn ctrl_c_clears_a_draft_before_it_quits() {
    let mut harness = Harness::spawn_engine("draft");
    assert!(
        wait_for(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        harness.text()
    );
    harness.write(b"\r");
    assert!(
        wait_for(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        harness.text()
    );
    harness.write("draft text".as_bytes());
    assert!(
        wait_for_plain(&harness, "draft text", Duration::from_secs(2)),
        "typing did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        harness.child.try_wait().expect("try_wait").is_none(),
        "the first Ctrl+C must clear the draft, not quit"
    );
    harness.write(b"\x03");
    let status =
        wait_exit(&mut harness.child, Duration::from_secs(5)).expect("second Ctrl+C must quit");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn an_approval_is_answered_from_the_panel() {
    let mut harness = Harness::spawn_engine_approval("approval");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "always allow", Duration::from_secs(3)),
        "the approval panel did not render:\n{}",
        plain(&harness.text())
    );
    assert!(
        plain(&harness.text()).contains("ls -la"),
        "the approval resource is missing"
    );
    assert!(
        plain(&harness.text()).contains("working"),
        "the status line did not show the active run"
    );
    harness.write(b"1");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("\"decision\":\"allow\"") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("\"decision\":\"allow\""),
        "approve never reached the engine: {recorded}"
    );
    assert!(
        recorded.contains("run-1/call_1"),
        "the approval binding was not echoed: {recorded}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
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
    // The reader thread can lag the process exit by a flush, so poll instead
    // of sampling once.
    assert!(
        wait_for(&harness, "injected panic", Duration::from_secs(2)),
        "panic message missing from output:\n{}",
        harness.text()
    );
    // ConPTY may re-encode VT sequences, so the literal restore check is
    // unix-only; on Windows the exit code plus message stand in.
    #[cfg(not(windows))]
    {
        assert!(
            wait_for(&harness, "\x1b[?1049l", Duration::from_secs(2)),
            "terminal was not restored after panic:\n{}",
            harness.text()
        );
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
