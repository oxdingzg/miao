//! A host that dies must not leave its engine behind. The stdin write end can
//! survive inside grandchild processes, so the parent watchdog is the only
//! reliable orphan signal; this test pins it with stdin held open.

#![cfg(unix)]

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[tokio::test]
async fn orphaned_engine_exits_after_host_death_despite_open_stdin() {
    let dir = tempfile::tempdir().unwrap();
    // The shell starts the engine in the background with SIGHUP ignored (a
    // host death by default signal disposition must not substitute for the
    // watchdog), reports the engine pid, and exits. The test keeps the stdin
    // pipe's write end open, so stdin EOF cannot fire.
    let script = format!(
        "trap '' HUP; '{}' serve --db '{}' --workspace '{}' --model fixture --endpoint 'http://127.0.0.1:9/v1/chat/completions' >/dev/null 2>&1 & echo $!",
        env!("CARGO_BIN_EXE_miao-engine"),
        dir.path().join("orphan.db").display(),
        dir.path().display(),
    );
    let mut shim = Command::new("sh")
        .arg("-c")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Hold the write end past the shim's exit: this is the grandchild-held
    // descriptor that defeats stdin EOF in production.
    let _keepalive = shim.stdin.take().unwrap();
    let mut reported = String::new();
    shim.stdout
        .take()
        .unwrap()
        .read_to_string(&mut reported)
        .unwrap();
    shim.wait().unwrap();
    let pid: u32 = reported.trim().parse().expect("engine pid");

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        // Signal 0 probes existence without delivering anything.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("orphaned engine {pid} outlived its host with stdin held open");
}
