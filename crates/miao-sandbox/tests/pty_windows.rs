//! Windows-only proof that a child runs confined on a real pseudoconsole.
//!
//! The pty backend requires AppContainer confinement and refuses to widen the
//! security context on failure (see `crate::pty`). This test pins the
//! combination that motivates that rule: `CreatePseudoConsole` plus an
//! AppContainer child must work together, so no unconfined fallback is ever
//! needed. Skipped on every other platform.

#![cfg(windows)]

use std::time::{Duration, Instant};

use miao_sandbox::pty::{Pty, Spec};

#[test]
fn confined_pty_runs_a_child_and_reports_confinement() {
    let workspace = std::env::temp_dir().join(format!("miao-pty-confined-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).unwrap();
    let spec = Spec {
        argv: vec!["cmd.exe".into(), "/c".into(), "echo CONFINED-OK".into()],
        cwd: workspace.clone(),
        writable: vec![workspace.clone()],
        temp: workspace.clone(),
        allow_network: false,
        rows: 24,
        cols: 80,
    };
    let mut pty = match Pty::spawn(spec) {
        Ok(pty) => pty,
        Err(
            miao_sandbox::win::WinError::Unavailable(message)
            | miao_sandbox::win::WinError::Start(message),
        ) => panic!("confined ConPTY launch must succeed on Windows: {message}"),
    };
    assert!(
        pty.confined(),
        "the child must run inside an AppContainer; an unconfined launch is a regression"
    );
    let mut output = String::new();
    let mut buffer = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !output.contains("CONFINED-OK") {
        match pty.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => output.push_str(&String::from_utf8_lossy(&buffer[..size])),
            Err(_) => break,
        }
    }
    assert!(
        output.contains("CONFINED-OK"),
        "the pseudoconsole should carry the child output, got {output:?}"
    );
    std::fs::remove_dir_all(&workspace).ok();
}
