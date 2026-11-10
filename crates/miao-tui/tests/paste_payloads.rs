//! INP-03: pasted blocks, file references, and attachment payloads reach the
//! engine with the prompt.
//!
//! The composer folds a long paste into a marker and attaches a pasted file
//! path as bytes beside the prompt. What must hold is the pairing: the screen
//! shows a marker, and the admit frame carries the block's full text or the
//! file's raw bytes under the same prompt. The scripted engine
//! (`tests/fixtures/fake_engine.rs`) logs every admit frame, so the payload
//! side of the pairing is read back from that log.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(30);

/// Four lines: past the folding threshold, so the composer holds a marker and
/// only the admit frame may carry the block itself.
const PASTED: &str = "alpha row\nbeta row\ngamma row\ndelta row";
const PNG_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_BYTES: &[u8] = b"%PDF-1.4\n";

struct Harness {
    pty: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    reader: JoinHandle<()>,
    log: PathBuf,
}

impl Harness {
    fn spawn() -> Self {
        let dir: PathBuf = std::env::temp_dir().join("miao-paste-payloads");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        std::fs::write(dir.join("shot.png"), PNG_BYTES).expect("write png");
        std::fs::write(dir.join("plan.pdf"), PDF_BYTES).expect("write pdf");
        let log = dir.join("admit.log");
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
        cmd.env("MIAO_TUI_FAKE_ADMIT_LOG", &log);
        let db = dir.join("engine.db");
        std::fs::write(&db, b"").expect("engine db file");
        cmd.env(
            "MIAO_ENGINE_BIN",
            env!("CARGO_BIN_EXE_miao-tui-fake-engine"),
        );
        cmd.env("MIAO_TUI_FAKE_SESSIONS", "1");
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
                        seen.lock()
                            .expect("output lock")
                            .extend_from_slice(&buf[..n]);
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
            log,
        }
    }

    fn write(&mut self, keys: &[u8]) {
        let mut writer = self.writer.lock().expect("writer lock");
        let _ = writer.write_all(keys);
        let _ = writer.flush();
    }

    /// One bracketed paste: the bytes arrive as a single paste event, which is
    /// the path a terminal's paste command takes.
    fn paste(&mut self, text: &str) {
        self.write(format!("\x1b[200~{text}\x1b[201~").as_bytes());
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("output lock")).into_owned()
    }

    /// The screen, not the byte stream: repaints split cell runs with cursor
    /// motions, so what a person reads is reconstructed, not searched raw.
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

    fn wait_for_admits(&self, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.admitted() >= count {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn admitted(&self) -> usize {
        self.admits().len()
    }

    /// Every admit frame the fake engine logged, params included.
    fn admits(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("\"method\":\"admit\""))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
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

/// The whole delivery path in one turn: a long paste folds to a marker on
/// screen yet rides out as its full text; pasted file paths become named,
/// byte-exact attachments; and one admit frame carries all of it beside the
/// typed words.
#[test]
fn a_pasted_block_and_file_paths_reach_the_engine_with_their_payloads() {
    let mut harness = Harness::spawn();
    assert!(
        harness.wait_for("hello from the fixture", TIMEOUT),
        "the session did not open:\n{}",
        harness.text()
    );

    harness.paste(PASTED);
    assert!(
        harness.wait_for("[Pasted ~4 lines]", TIMEOUT),
        "the pasted block never folded to its marker:\n{}",
        harness.screen()
    );
    harness.paste("shot.png");
    assert!(
        harness.wait_for("[Image 1]", TIMEOUT),
        "the pasted image path never became an attachment marker:\n{}",
        harness.screen()
    );
    harness.paste("plan.pdf");
    assert!(
        harness.wait_for("[File plan.pdf]", TIMEOUT),
        "the pasted pdf path never became an attachment marker:\n{}",
        harness.screen()
    );

    harness.write(b"explain");
    harness.write(b"\r");
    assert!(
        harness.wait_for_admits(1, TIMEOUT),
        "the prompt was never admitted:\n{}",
        harness.text()
    );
    let admits = harness.admits();
    harness.shutdown();
    assert_eq!(admits.len(), 1, "exactly one prompt went out");
    let params = &admits[0]["params"];
    let prompt = params["input"]["prompt"].as_str().expect("prompt");
    assert_eq!(
        prompt,
        format!("{PASTED}[Image 1] [File plan.pdf] explain"),
        "the marker must expand to the block's full text, in place"
    );

    let attachments = params["attachments"].as_array().expect("attachments");
    assert_eq!(attachments.len(), 2, "both file paths ride with the prompt");
    assert_eq!(attachments[0]["mime"], "image/png");
    assert_eq!(
        attachments[0]["metadata"],
        serde_json::json!({ "name": "shot.png" }),
        "the image carries its file name"
    );
    let png = base64::engine::general_purpose::STANDARD
        .decode(attachments[0]["data"].as_str().expect("png data"))
        .expect("png base64");
    assert_eq!(png, PNG_BYTES, "the image bytes are raw, not re-encoded");

    assert_eq!(attachments[1]["mime"], "application/pdf");
    assert_eq!(
        attachments[1]["metadata"],
        serde_json::json!({ "name": "plan.pdf" }),
        "the pdf carries its file name"
    );
    let pdf = base64::engine::general_purpose::STANDARD
        .decode(attachments[1]["data"].as_str().expect("pdf data"))
        .expect("pdf base64");
    assert_eq!(pdf, PDF_BYTES, "the pdf bytes are raw");
}
