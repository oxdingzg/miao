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
    fn spawn(label: &str, inject_panic: bool) -> Self {
        Self::spawn_with(label, inject_panic, false, false, false, false, &[])
    }

    /// Boot the TUI against the scripted engine so the smoke test can enter a
    /// Session without a database, a provider, or a model.
    fn spawn_engine(label: &str) -> Self {
        Self::spawn_with(label, false, true, false, false, false, &[])
    }

    fn spawn_engine_approval(label: &str) -> Self {
        Self::spawn_with(label, false, true, true, false, false, &[])
    }

    /// A workspace with one markdown template command, so the slash path can
    /// be exercised against the engine wire.
    fn spawn_engine_with_commands(label: &str) -> Self {
        Self::spawn_with(label, false, true, false, true, false, &[])
    }

    fn spawn_with(
        label: &str,
        inject_panic: bool,
        engine: bool,
        approval: bool,
        commands: bool,
        launch_prefix: bool,
        environment: &[(&str, &str)],
    ) -> Self {
        Self::spawn_configured(
            label,
            inject_panic,
            engine,
            approval,
            commands,
            launch_prefix,
            environment,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_configured(
        label: &str,
        inject_panic: bool,
        engine: bool,
        approval: bool,
        commands: bool,
        launch_prefix: bool,
        environment: &[(&str, &str)],
        shell: bool,
    ) -> Self {
        let dir = workspace(label);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        if commands {
            // Project commands live under `.miao/command(s)/`, the same
            // directories the host discovers.
            let commands_dir = dir.join(".miao").join("commands");
            std::fs::create_dir_all(&commands_dir).expect("commands dir");
            std::fs::write(
                commands_dir.join("review.md"),
                "---\ndescription: Review a path\n---\nReview $1 carefully\n",
            )
            .expect("template command");
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                ..Default::default()
            })
            .expect("open pty");
        let mut cmd = if shell {
            let mut shell = CommandBuilder::new("bash");
            shell.args(["--noprofile", "--norc", "-i"]);
            shell.env("PS1", "MIAO_SHELL_READY> ");
            shell.env("MIAO_TUI_TEST_PROGRAM", env!("CARGO_BIN_EXE_miao-tui"));
            shell
        } else {
            let mut ui = CommandBuilder::new(env!("CARGO_BIN_EXE_miao-tui"));
            ui.arg("--workspace");
            ui.arg(&dir);
            ui
        };
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
        cmd.env("MIAO_DISABLE_TERMINAL_TITLE", "0");
        if inject_panic {
            cmd.env("MIAO_TUI_TEST_PANIC", "1");
        }
        let ready = dir.join("engine.ready");
        if ready.exists() {
            std::fs::remove_file(&ready).expect("reset fixture readiness");
        }
        if engine {
            cmd.env("MIAO_TUI_FAKE_READY_FILE", &ready);
            let db = dir.join("engine.db");
            std::fs::write(&db, b"").expect("engine db file");
            cmd.env(
                "MIAO_ENGINE_BIN",
                env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
            );
            cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
            if launch_prefix {
                let prefix = r#"literal "prefix" with spaces"#;
                cmd.env(
                    "MIAO_ENGINE_LAUNCH_PREFIX",
                    serde_json::to_string(&[prefix]).unwrap(),
                );
                cmd.env("MIAO_TUI_FAKE_EXPECT_PREFIX", prefix);
            }
            cmd.env("MIAO_TUI_FAKE_ADMIT_LOG", dir.join("admit.log"));
            if approval {
                cmd.env("MIAO_TUI_FAKE_APPROVAL", "1");
            }
            // History lives under the state dir; keep the developer's real
            // composer history out of a test run.
            cmd.env("MIAO_TUI_STATE_DIR", dir.join("state"));
            if shell {
                cmd.env("MIAO_TUI_TEST_DB", &db);
            } else {
                cmd.arg("--db");
                cmd.arg(&db);
            }
        }
        for (key, value) in environment {
            cmd.env(key, value);
        }
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
                        // windows-2025 ConPTY probes the attached terminal with a
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
        let mut harness = Self {
            pty: pair.master,
            child,
            writer,
            output,
            reader: reader_thread,
            dir,
        };
        if shell {
            assert!(wait_for(
                &harness,
                "MIAO_SHELL_READY>",
                Duration::from_secs(2)
            ));
            let background = environment
                .iter()
                .any(|(key, value)| *key == "MIAO_TUI_TEST_BACKGROUND" && *value == "1");
            if background {
                harness.write(b"set -b\r\"$MIAO_TUI_TEST_PROGRAM\" --workspace \"$PWD\" --db \"$MIAO_TUI_TEST_DB\" &\r");
                assert!(
                    wait_for(&harness, "Stopped", Duration::from_secs(2)),
                    "background startup did not wait for fg: {}",
                    harness.text()
                );
                assert!(
                    !harness.text().contains("\x1b[?1049h"),
                    "background UI changed terminal modes"
                );
                assert!(
                    !ready.exists(),
                    "background UI started an engine before foreground admission"
                );
                harness.write(b"fg\r");
            } else {
                harness.write(
                    b"\"$MIAO_TUI_TEST_PROGRAM\" --workspace \"$PWD\" --db \"$MIAO_TUI_TEST_DB\"\r",
                );
            }
        }
        if engine {
            // Cold fixture executable startup is separate from the UI response
            // deadlines below. The real child publishes this only after setup.
            let start = Instant::now();
            while !std::fs::read(&ready).is_ok_and(|bytes| bytes == b"ready") {
                let exited = harness.child.try_wait().expect("fixture child status");
                if exited.is_some() || start.elapsed() >= Duration::from_secs(10) {
                    let output = harness.text();
                    let _ = harness.child.kill();
                    let _ = harness.child.wait();
                    harness.shutdown();
                    panic!("fixture did not become ready: {exited:?}\n{output}");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            std::fs::write(
                harness.dir.join("fixture-startup-ms"),
                start.elapsed().as_millis().to_string(),
            )
            .unwrap();
        }
        harness
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }

    fn screen(&self) -> String {
        let size = self.pty.get_size().expect("pty size");
        let mut parser = vt100::Parser::new(size.rows, size.cols, 0);
        parser.process(&self.output.lock().expect("output lock"));
        parser.screen().contents()
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

fn workspace(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("miao-tui-smoke-{}-{label}", std::process::id()))
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
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                // Window-title payloads are not visible terminal cells.
                let mut escaped = false;
                for c in chars.by_ref() {
                    if c == '\x07' || (escaped && c == '\\') {
                        break;
                    }
                    escaped = c == '\x1b';
                }
            }
            _ => {}
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

fn wait_for_screen(harness: &Harness, needle: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if harness.screen().contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
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
    // The transcript is borderless now; the user entry marker proves it drew.
    assert!(
        rendered.contains("❯"),
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
fn a_literal_launcher_prefix_reaches_the_child_without_shell_parsing() {
    let mut harness = Harness::spawn_with("launch-prefix", false, true, false, false, true, &[]);
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(3)),
        "{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(3)),
        "{}",
        plain(&harness.text())
    );
    harness.write(b"\x03");
    let status =
        wait_exit(&mut harness.child, Duration::from_secs(5)).expect("prefixed child did not exit");
    assert!(status.success());
    harness.shutdown();
}

#[test]
fn the_transcript_renders_markdown_and_tool_rows() {
    let mut harness = Harness::spawn_engine("render");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    // Rows sort by recency: ses_a is first, and ses_b carries the renderer
    // fixture (markdown document plus one completed read).
    harness.write(b"\x1b[B");
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "Fixture Notes", Duration::from_secs(2)),
        "the markdown heading did not render:\n{}",
        plain(&harness.text())
    );
    assert!(
        wait_for_plain(&harness, "Read 2 lines", Duration::from_secs(2)),
        "the tool summary did not render:\n{}",
        plain(&harness.text())
    );
    let rendered = plain(&harness.text());
    for expected in [
        "• bold and code",
        "name │ value",
        "✓ read  src/lib.rs",
        "⎿ Read 2 lines",
    ] {
        assert!(
            rendered.contains(expected),
            "transcript is missing {expected:?}:\n{rendered}"
        );
    }
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn redraw_preserves_the_open_transcript_and_unsent_draft() {
    let mut harness = Harness::spawn_engine("redraw");
    assert!(wait_for_screen(
        &harness,
        "Project A",
        Duration::from_secs(3)
    ));
    harness.write(b"\r");
    assert!(wait_for_screen(
        &harness,
        "hello from the fixture",
        Duration::from_secs(3)
    ));
    harness.write(b"keep this draft");
    assert!(wait_for_screen(
        &harness,
        "keep this draft",
        Duration::from_secs(2)
    ));
    #[cfg(unix)]
    let start = harness.output.lock().expect("output lock").len();
    harness.write(b"\x0c");
    #[cfg(unix)]
    {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let fresh = harness.output.lock().expect("output lock")[start..].to_vec();
            let screen = harness.screen();
            if fresh.windows(4).any(|bytes| bytes == b"\x1b[2J")
                && screen.contains("keep this draft")
                && screen.contains("hello from the fixture")
            {
                assert!(
                    !fresh.windows(4).any(|bytes| bytes == b"\x1b[6n"),
                    "redraw queried the input cursor"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "redraw did not repaint the preserved state: {}",
                screen
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // ConPTY may optimize an unchanged frame instead of forwarding its clear
    // sequence. Editing after redraw must still use the original unsent draft.
    harness.write(b" survives");
    assert!(wait_for_screen(
        &harness,
        "keep this draft survives",
        Duration::from_secs(2)
    ));
    harness.write(b"\x10");
    harness.write(b"redraw");
    assert!(wait_for_screen(
        &harness,
        "Redraw terminal",
        Duration::from_secs(2)
    ));
    harness.write(b"\r");
    assert!(wait_for_screen(
        &harness,
        "keep this draft survives",
        Duration::from_secs(2)
    ));
    assert!(!harness.dir.join("admit.log").exists());
    harness.write(b"\x03");
    harness.write(b"\x03");
    let status =
        wait_exit(&mut harness.child, Duration::from_secs(5)).expect("redrawn UI did not exit");
    assert!(status.success());
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
    for (label, separator) in [("lf", "\n"), ("crlf", "\r\n"), ("cr", "\r")] {
        let mut harness = Harness::spawn_engine(&format!("paste-{label}"));
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
        harness.write(format!("\x1b[200~第一行{separator}第二行\x1b[201~").as_bytes());
        let rendered = wait_for_screen(&harness, "第一行", Duration::from_secs(2))
            && wait_for_screen(&harness, "第二行", Duration::from_secs(2));
        assert!(
            !harness.dir.join("admit.log").exists(),
            "{label} paste submitted a prompt before Enter"
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
            rendered,
            "{label} CJK paste did not render; receipt={recorded}; screen={}; raw={:?}",
            harness.screen(),
            harness.text()
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
fn the_leader_opens_the_model_dialog_and_selects_a_binding() {
    let mut harness = Harness::spawn_engine("models");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        plain(&harness.text())
    );
    // Ctrl+X is the leader; `m` opens the model dialog once the catalog lands.
    harness.write(b"\x18m");
    assert!(
        wait_for_plain(&harness, "fake/gpt", Duration::from_secs(3)),
        "the model dialog did not render the catalog:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("\"method\":\"select_model\"") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("\"method\":\"select_model\""),
        "select_model never reached the engine: {recorded}"
    );
    assert!(
        recorded.contains("\"model\":\"fake/glm\"") && recorded.contains("\"protocol\":\"chat\""),
        "the selected binding was not sent: {recorded}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn the_leader_opens_the_theme_dialog_and_saves_the_choice() {
    let mut harness = Harness::spawn_engine("theme");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\x18t");
    // The menu holds every built-in theme and opens around the active one; the
    // hint belongs to the dialog only, and the active row proves the window
    // opened around it.
    assert!(
        wait_for_plain(&harness, "enter apply · esc close", Duration::from_secs(2)),
        "the theme dialog did not render:\n{}",
        plain(&harness.text())
    );
    assert!(
        wait_for_plain(&harness, "▸ miao", Duration::from_secs(2)),
        "the theme dialog did not open around the active theme:\n{}",
        plain(&harness.text())
    );
    // One row down from the active theme ("miao") lands on "opencode".
    harness.write(b"\x1b[B");
    harness.write(b"\r");
    let preferences = harness.dir.join("state").join("preferences.json");
    let start = Instant::now();
    let mut saved = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        saved = std::fs::read_to_string(&preferences).unwrap_or_default();
        if saved.contains("opencode") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        saved.contains("\"theme\":\"opencode\""),
        "the chosen theme was not saved: {saved}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn the_status_dialog_shows_the_usage_report_and_the_debug_view() {
    let mut harness = Harness::spawn_engine("status");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\x18s");
    assert!(
        wait_for_plain(&harness, "3 (1 partial)", Duration::from_secs(3)),
        "the status dialog did not render the usage report:\n{}",
        plain(&harness.text())
    );
    let rendered = plain(&harness.text());
    assert!(
        rendered.contains("avg 812 ms"),
        "the status dialog is missing TTFT:\n{rendered}"
    );
    assert!(
        rendered.contains("fake/glm · chat"),
        "the status dialog is missing the model pin:\n{rendered}"
    );
    // Esc closes the read-only dialog; the debug view is one leader away.
    // Pause so the lone ESC is not read as the prefix of an Alt chord.
    harness.write(b"\x1b");
    std::thread::sleep(Duration::from_millis(200));
    harness.write(b"\x18d");
    assert!(
        wait_for_plain(&harness, "state dir", Duration::from_secs(3)),
        "the debug dialog did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn ctrl_o_switches_the_pinned_account() {
    let mut harness = Harness::spawn_engine("accounts");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\x0f");
    assert!(
        wait_for_plain(&harness, "cred_a", Duration::from_secs(3)),
        "the account dialog did not render the catalog:\n{}",
        plain(&harness.text())
    );
    // The second row is the other credential.
    harness.write(b"\x1b[B");
    harness.write(b"\r");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("\"method\":\"select_account\"") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("\"method\":\"select_account\"") && recorded.contains("cred_b"),
        "the chosen account was not sent: {recorded}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn a_stashed_draft_comes_back_into_the_composer() {
    let mut harness = Harness::spawn_engine("stash");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        plain(&harness.text())
    );
    harness.write(b"stash me");
    // Ctrl+X then Shift+P stashes the draft and clears the composer.
    harness.write(b"\x18P");
    let stash = harness.dir.join("state").join("stash.json");
    let start = Instant::now();
    let mut saved = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        saved = std::fs::read_to_string(&stash).unwrap_or_default();
        if saved.contains("stash me") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        saved.contains("stash me"),
        "the draft was not stashed: {saved}"
    );
    harness.write(b"\x18p");
    assert!(
        wait_for_plain(&harness, "stash me", Duration::from_secs(3)),
        "the stash dialog did not render:\n{}",
        plain(&harness.text())
    );
    // Enter restores the draft, the next Enter submits it.
    harness.write(b"\r");
    harness.write(b"\r");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("stash me") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("\"method\":\"admit\"") && recorded.contains("stash me"),
        "the restored draft never reached the engine: {recorded}"
    );
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("process did not exit after Ctrl+C");
    assert!(status.success(), "Ctrl+C must exit 0, got {status:?}");
    harness.shutdown();
}

#[test]
fn the_palette_runs_actions_and_a_template_command_reaches_the_engine() {
    let mut harness = Harness::spawn_engine_with_commands("commands");
    assert!(
        wait_for_plain(&harness, "Project A", Duration::from_secs(2)),
        "the home list did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "hello from the fixture", Duration::from_secs(2)),
        "the Session did not open:\n{}",
        plain(&harness.text())
    );
    // Ctrl+P opens the palette; typing narrows it to the help entry.
    harness.write(b"\x10");
    assert!(
        wait_for_plain(&harness, "Select a theme", Duration::from_secs(2)),
        "the palette did not render:\n{}",
        plain(&harness.text())
    );
    harness.write(b"keys");
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "/stash-draft", Duration::from_secs(2)),
        "the palette did not open the help dialog:\n{}",
        plain(&harness.text())
    );
    // A lone Esc needs a pause so it is not read as an Alt chord prefix.
    harness.write(b"\x1b");
    std::thread::sleep(Duration::from_millis(200));
    // The trailing space closes slash completion, so the next Enter submits.
    harness.write(b"/review src/a.rs");
    harness.write(b"\r");
    let log = harness.dir.join("admit.log");
    let start = Instant::now();
    let mut recorded = String::new();
    while start.elapsed() < Duration::from_secs(5) {
        recorded = std::fs::read_to_string(&log).unwrap_or_default();
        if recorded.contains("\"name\":\"review\"") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        recorded.contains("\"method\":\"admit\""),
        "the command never reached the engine: {recorded}"
    );
    assert!(
        recorded.contains("\"name\":\"review\"") && recorded.contains("\"arguments\":\"src/a.rs\""),
        "the captured command reference is missing: {recorded}"
    );
    assert!(
        recorded.contains("\"prompt\":\"Review src/a.rs carefully\""),
        "the template was not rendered before admission: {recorded}"
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
    // ConPTY can discard the first frame when the child immediately panics.
    // Windows still verifies the panic status and diagnostic below.
    #[cfg(not(windows))]
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

#[cfg(unix)]
#[test]
fn exit_signals_restore_the_terminal() {
    for signal in ["TERM", "HUP", "INT"] {
        let mut harness = Harness::spawn(&format!("signal-{signal}"), false);
        assert!(wait_for_plain(
            &harness,
            "miao-tui-smoke",
            Duration::from_secs(3)
        ));
        let pid = harness.child.process_id().expect("child pid").to_string();
        assert!(std::process::Command::new("kill")
            .args([&format!("-{signal}"), &pid])
            .status()
            .expect("send exit signal")
            .success());
        let status = wait_exit(&mut harness.child, Duration::from_secs(5))
            .expect("signal did not stop the UI");
        assert!(status.success(), "{signal}: {status:?}");
        assert!(
            wait_for(&harness, "\x1b[?1049l", Duration::from_secs(2)),
            "{signal} did not leave the alternate screen: {}",
            harness.text()
        );
        assert!(harness.text().contains("\x1b[?2004l"));
        assert!(harness.text().contains("\x1b[?1004l"));
        harness.shutdown();
    }
}

#[test]
fn saved_permissions_review_and_revoke_through_the_engine_wire() {
    let mut harness = Harness::spawn_engine("saved-permissions");
    assert!(wait_for_plain(
        &harness,
        "Project A",
        Duration::from_secs(3)
    ));
    harness.write(b"\r");
    assert!(wait_for_plain(
        &harness,
        "hello from the fixture",
        Duration::from_secs(3)
    ));
    harness.write(b"/permissions ");
    std::thread::sleep(Duration::from_millis(100));
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "public/**", Duration::from_secs(3)),
        "{}",
        plain(&harness.text())
    );
    harness.write(b"\r");
    assert!(wait_for_plain(
        &harness,
        "Directory:",
        Duration::from_secs(3)
    ));
    let log = harness.dir.join("admit.log");
    harness.write(b"\r"); // Keep is the safe default.
    std::thread::sleep(Duration::from_millis(100));
    assert!(!std::fs::read_to_string(&log)
        .unwrap_or_default()
        .contains("permission_pattern_remove"));
    harness.write(b"\r");
    std::thread::sleep(Duration::from_millis(100));
    harness.write(b"\x1b[C");
    std::thread::sleep(Duration::from_millis(100));
    harness.write(b"\r");
    assert!(
        wait_for_plain(&harness, "Saved permission revoked", Duration::from_secs(3)),
        "{}",
        plain(&harness.text())
    );
    let recorded = std::fs::read_to_string(&log).unwrap();
    assert_eq!(recorded.matches("permission_pattern_remove").count(), 1);
    assert!(recorded.contains(&format!("prule_{}", "a".repeat(64))));
    harness.write(b"\x03");
    assert!(wait_exit(&mut harness.child, Duration::from_secs(5))
        .unwrap()
        .success());
    harness.shutdown();
}

#[test]
fn terminal_title_toggle_persists_across_restart_and_an_environment_disable_wins() {
    let dir = workspace("title-toggle");
    std::fs::create_dir_all(dir.join(".miao")).unwrap();
    std::fs::write(
        dir.join(".miao/tui.json"),
        r#"{"keybinds":{"terminal_title_toggle":"ctrl+t"}}"#,
    )
    .unwrap();
    let mut first = Harness::spawn_engine("title-toggle");
    assert!(wait_for_screen(&first, "Project A", Duration::from_secs(3)));
    assert!(wait_for(&first, "\x1b]0;miao\x07", Duration::from_secs(2)));
    first.write(b"\x14");
    assert!(wait_for_screen(
        &first,
        "Terminal title disabled",
        Duration::from_secs(2)
    ));
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("state/preferences.json")).unwrap())
            .unwrap();
    assert_eq!(saved["terminal_title_enabled"], false);
    first.write(b"\x03");
    assert!(wait_exit(&mut first.child, Duration::from_secs(5))
        .unwrap()
        .success());
    let mut second = Harness::spawn_engine("title-toggle");
    assert!(wait_for_screen(
        &second,
        "Project A",
        Duration::from_secs(3)
    ));
    assert!(!second.text().contains("\x1b]0;miao\x07"));
    second.write(b"\x14");
    assert!(wait_for_screen(
        &second,
        "Terminal title enabled",
        Duration::from_secs(2)
    ));
    assert!(wait_for(&second, "\x1b]0;miao\x07", Duration::from_secs(2)));
    second.write(b"\x03");
    assert!(wait_exit(&mut second.child, Duration::from_secs(5))
        .unwrap()
        .success());
    second.shutdown();
    first.shutdown();

    let dir = workspace("title-disabled");
    std::fs::create_dir_all(dir.join(".miao")).unwrap();
    std::fs::write(
        dir.join(".miao/tui.json"),
        r#"{"keybinds":{"terminal_title_toggle":"ctrl+t"}}"#,
    )
    .unwrap();
    let mut disabled = Harness::spawn_with(
        "title-disabled",
        false,
        true,
        false,
        false,
        false,
        &[("MIAO_DISABLE_TERMINAL_TITLE", "TrUe")],
    );
    assert!(wait_for_screen(
        &disabled,
        "Project A",
        Duration::from_secs(3)
    ));
    assert!(!disabled.text().contains("\x1b]0;miao\x07"));
    disabled.write(b"\x14");
    assert!(wait_for_screen(
        &disabled,
        "disabled by MIAO_DISABLE_TERMINAL_TITLE",
        Duration::from_secs(2)
    ));
    assert!(!dir.join("state/preferences.json").exists());
    disabled.write(b"\x03");
    assert!(wait_exit(&mut disabled.child, Duration::from_secs(5))
        .unwrap()
        .success());
    disabled.shutdown();
}

#[test]
fn title_payloads_cannot_satisfy_visible_text_assertions() {
    assert_eq!(
        plain("\x1b]0;hidden\x07visible\x1b]2;also hidden\x1b\\"),
        "visible"
    );
}

#[test]
fn external_editor_exclusively_reads_stdin_then_returns_the_saved_draft() {
    let editor = format!("{} --editor", env!("CARGO_BIN_EXE_miao-tui-fake-engine"));
    let mut harness = Harness::spawn_with(
        "editor-input",
        false,
        true,
        false,
        false,
        false,
        &[("VISUAL", &editor)],
    );
    assert!(wait_for_screen(
        &harness,
        "Project A",
        Duration::from_secs(10)
    ));
    harness.write(b"\r");
    assert!(wait_for_screen(
        &harness,
        "hello from the fixture",
        Duration::from_secs(10)
    ));
    harness.write(b"old draft");
    harness.write(b"\x18e");
    for (index, text) in [(1, "first"), (2, "second"), (3, "third")] {
        assert!(
            wait_for(
                &harness,
                &format!("EDITOR_INPUT_{index}"),
                Duration::from_secs(10)
            ),
            "editor did not receive exclusive input: {}",
            harness.text()
        );
        harness.write(format!("{text}\r").as_bytes());
    }
    assert!(
        wait_for_screen(&harness, "first second third", Duration::from_secs(10)),
        "saved editor draft did not render: {}",
        harness.screen()
    );
    harness.write(b"!");
    assert!(wait_for_screen(
        &harness,
        "first second third!",
        Duration::from_secs(10)
    ));
    assert!(!harness.dir.join("admit.log").exists());
    harness.write(b"\x03");
    harness.write(b"\x03");
    let status = wait_exit(&mut harness.child, Duration::from_secs(5)).expect("editor UI exit");
    assert!(status.success());
    harness.shutdown();
}

#[cfg(unix)]
#[test]
fn editor_interrupt_returns_to_the_ui_and_exit_signals_cancel_the_editor() {
    for signal in ["INT", "TERM", "HUP"] {
        let editor = format!("{} --editor", env!("CARGO_BIN_EXE_miao-tui-fake-engine"));
        let mut harness = Harness::spawn_with(
            &format!("editor-signal-{signal}"),
            false,
            true,
            false,
            false,
            false,
            &[("VISUAL", &editor)],
        );
        assert!(wait_for_screen(
            &harness,
            "Project A",
            Duration::from_secs(10)
        ));
        harness.write(b"\r");
        assert!(wait_for_screen(
            &harness,
            "hello from the fixture",
            Duration::from_secs(10)
        ));
        harness.write(b"keep original draft");
        harness.write(b"\x18e");
        assert!(wait_for(
            &harness,
            "EDITOR_INPUT_1",
            Duration::from_secs(10)
        ));
        let buffer =
            PathBuf::from(std::fs::read_to_string(harness.dir.join("editor-buffer-path")).unwrap());
        let editor_pid = std::fs::read_to_string(harness.dir.join("editor-pid")).unwrap();
        assert!(buffer.exists());
        if signal == "INT" {
            // The cooked terminal delivers Ctrl+C to both UI and editor.
            harness.write(b"\x03");
            if !wait_for_screen(&harness, "keep original draft", Duration::from_secs(3)) {
                // Under CI runner load the line discipline can lose that race
                // and leave the editor in the foreground; deliver the
                // interrupt to the editor process directly.
                let _ = std::process::Command::new("kill")
                    .args(["-INT", editor_pid.trim()])
                    .status();
            }
            assert!(
                wait_for_screen(&harness, "keep original draft", Duration::from_secs(10)),
                "interrupted editor did not restore the draft: {}",
                harness.screen()
            );
            harness.write(b"!");
            assert!(wait_for_screen(
                &harness,
                "keep original draft!",
                Duration::from_secs(10)
            ));
            assert!(harness.child.try_wait().unwrap().is_none());
            harness.write(b"\x03");
            harness.write(b"\x03");
        } else {
            let pid = harness.child.process_id().unwrap().to_string();
            assert!(std::process::Command::new("kill")
                .args([&format!("-{signal}"), &pid])
                .status()
                .unwrap()
                .success());
        }
        assert!(wait_exit(&mut harness.child, Duration::from_secs(5))
            .expect("editor signal exit")
            .success());
        assert!(!buffer.exists(), "cancelled editor left its draft behind");
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &editor_pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success(),
            "editor child survived UI shutdown"
        );
        assert!(!harness.dir.join("admit.log").exists());
        harness.shutdown();
    }
}

#[cfg(unix)]
#[test]
fn shell_job_control_restores_the_terminal_and_preserves_the_draft() {
    let mut harness =
        Harness::spawn_configured("job-control", false, true, false, false, false, &[], true);
    assert!(wait_for_screen(
        &harness,
        "Project A",
        Duration::from_secs(2)
    ));
    harness.write(b"\r");
    assert!(wait_for_screen(
        &harness,
        "hello from the fixture",
        Duration::from_secs(2)
    ));
    harness.write(b"draft before suspend");
    assert!(wait_for_screen(
        &harness,
        "draft before suspend",
        Duration::from_secs(2)
    ));
    for index in 0..2 {
        let offset = harness.text().len();
        harness.write(b"\x1a");
        let start = Instant::now();
        while !harness.text()[offset..].contains("MIAO_SHELL_READY>")
            && start.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = harness.text();
        assert!(
            output[offset..].contains("Stopped"),
            "job did not stop: {output}"
        );
        assert!(
            output[offset..].contains("\x1b[?1049l"),
            "terminal was not restored before shell handoff"
        );
        harness.write(b"printf 'SHELL_HAS_INPUT\\n'\r");
        assert!(wait_for(
            &harness,
            "SHELL_HAS_INPUT\r\n",
            Duration::from_secs(2)
        ));
        if index == 0 {
            let offset = harness.text().len();
            harness.write(b"bg\rsleep 0.1; jobs\r");
            let start = Instant::now();
            while !harness.text()[offset..].contains("Stopped")
                && start.elapsed() < Duration::from_secs(2)
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                harness.text()[offset..].contains("Stopped"),
                "bg resumed terminal readers: {}",
                harness.text()
            );
        }
        harness.write(b"fg\r");
        assert!(
            wait_for_screen(&harness, "draft before suspend", Duration::from_secs(2)),
            "fg did not repaint: {}",
            harness.screen()
        );
    }
    harness.write(b"!");
    assert!(wait_for_screen(
        &harness,
        "draft before suspend!",
        Duration::from_secs(2)
    ));
    assert!(!harness.dir.join("admit.log").exists());
    let offset = harness.text().len();
    harness.write(b"\x03");
    harness.write(b"\x03");
    let start = Instant::now();
    while !harness.text()[offset..].contains("MIAO_SHELL_READY>")
        && start.elapsed() < Duration::from_secs(5)
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(harness.text()[offset..].contains("MIAO_SHELL_READY>"));
    harness.write(b"exit\r");
    assert!(wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("shell exit")
        .success());
    harness.shutdown();
}

#[cfg(unix)]
#[test]
fn background_startup_waits_for_foreground_before_taking_the_terminal() {
    let mut harness = Harness::spawn_configured(
        "background-job",
        false,
        true,
        false,
        false,
        false,
        &[("MIAO_TUI_TEST_BACKGROUND", "1")],
        true,
    );
    assert!(
        wait_for_screen(&harness, "Project A", Duration::from_secs(2)),
        "foreground UI did not render: {}",
        harness.screen()
    );
    let offset = harness.text().len();
    harness.write(b"\x03");
    let start = Instant::now();
    while !harness.text()[offset..].contains("MIAO_SHELL_READY>")
        && start.elapsed() < Duration::from_secs(5)
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(harness.text()[offset..].contains("MIAO_SHELL_READY>"));
    harness.write(b"exit\r");
    assert!(wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("background shell exit")
        .success());
    harness.shutdown();
}

#[cfg(unix)]
#[test]
fn suspend_without_a_controlling_shell_does_not_leave_an_orphaned_job_stopped() {
    let mut harness = Harness::spawn_engine("orphaned-job");
    assert!(wait_for_screen(
        &harness,
        "Project A",
        Duration::from_secs(2)
    ));
    harness.write(b"\r");
    assert!(wait_for_screen(
        &harness,
        "hello from the fixture",
        Duration::from_secs(2)
    ));
    harness.write(b"orphan draft");
    assert!(wait_for_screen(
        &harness,
        "orphan draft",
        Duration::from_secs(2)
    ));
    harness.write(b"\x1a");
    harness.write(b"!");
    assert!(
        wait_for_screen(&harness, "orphan draft!", Duration::from_secs(2)),
        "orphaned job became unresumable: {}",
        harness.screen()
    );
    assert!(!harness.dir.join("admit.log").exists());
    harness.write(b"\x03");
    harness.write(b"\x03");
    assert!(wait_exit(&mut harness.child, Duration::from_secs(5))
        .expect("orphaned UI exit")
        .success());
    harness.shutdown();
}
