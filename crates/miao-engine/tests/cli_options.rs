use std::process::Command;

/// Every flag the runtime reads has to be an accepted CLI option: one the
/// whitelist omits is refused before the engine starts, which is how the LSP
/// ablation became impossible to run without anyone noticing.
#[test]
fn engine_flags_the_runtime_reads_are_accepted_options() {
    let dir = tempfile::tempdir().unwrap();
    let cases: [&[&str]; 6] = [
        &["--lsp-diagnostics", "off"],
        &["--lsp-config", "/nonexistent/lsp.json"],
        &["--prompt-cache", "on"],
        &["--verify-command", "true"],
        &["--edit-recovery", "off"],
        // Automatic context management is opt-in through this flag, which was
        // missing from the whitelist until it was measured.
        &[
            "--context-limits",
            "{\"window\":32000,\"ratio\":0.5,\"headroom\":2000,\"perPass\":8}",
        ],
    ];
    for case in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args(["acp", "--db"])
            .arg(dir.path().join("engine.db"))
            .args(["--workspace"])
            .arg(dir.path())
            .args(["--model", "m", "--provider", "anthropic"])
            .args(case)
            .env_remove("ANTHROPIC_API_KEY")
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("unknown or duplicate option"),
            "{case:?} is refused as an unknown option: {stderr}"
        );
    }
}
