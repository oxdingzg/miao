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
        Self::spawn_with(label, inject_panic, false, false, false)
    }

    /// Boot the TUI against the scripted engine so the smoke test can enter a
    /// Session without a database, a provider, or a model.
    fn spawn_engine(label: &str) -> Self {
        Self::spawn_with(label, false, true, false, false)
    }

    fn spawn_engine_approval(label: &str) -> Self {
        Self::spawn_with(label, false, true, true, false)
    }

    /// A workspace with one markdown template command, so the slash path can
    /// be exercised against the engine wire.
    fn spawn_engine_with_commands(label: &str) -> Self {
        Self::spawn_with(label, false, true, false, true)
    }

    fn spawn_with(
        label: &str,
        inject_panic: bool,
        engine: bool,
        approval: bool,
        commands: bool,
    ) -> Self {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-smoke-{}-{label}", std::process::id()));
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
    // The menu holds every built-in theme and opens around the active one, so
    // the first visible window is the end of the list rather than its head.
    assert!(
        wait_for_plain(&harness, "everforest", Duration::from_secs(2)),
        "the theme dialog did not render:\n{}",
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
