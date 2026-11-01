//! The plugin tool-hook marker travels inline instead of through a temporary
//! file. These cases pin that the engine reads the environment variable: with
//! it set, startup demands the product tool bridge the marker requires, and
//! without it the same command starts normally.

use std::process::Command;

fn engine(dir: &std::path::Path, hooks: Option<&str>) -> std::process::Output {
    let policy = dir.join("policy.json");
    std::fs::write(&policy, r#"{"mode":"workspace","allow_mcp":true}"#).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_miao-engine"));
    command
        .args(["acp", "--db"])
        .arg(dir.join("engine.db"))
        .args(["--workspace"])
        .arg(dir)
        .args(["--model", "m", "--provider", "openai-chat", "--policy"])
        .arg(&policy)
        .env_remove("MIAO_ENGINE_PLUGIN_HOOKS")
        .env("OPENAI_API_KEY", "fixture-only");
    if let Some(hooks) = hooks {
        command.env("MIAO_ENGINE_PLUGIN_HOOKS", hooks);
    }
    command.output().unwrap()
}

#[test]
fn an_inline_hook_marker_requires_the_product_tool_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let output = engine(
        dir.path(),
        Some(r#"{"before":true,"after":false,"definition":false}"#),
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("plugin hooks require the product tool bridge"),
        "the engine did not read the inline marker: {stderr}"
    );
    assert!(!output.status.success());
}

#[test]
fn no_inline_hook_marker_leaves_startup_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let output = engine(dir.path(), None);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // The same command without the marker must not hit the hook gate at all.
    assert!(
        !stderr.contains("plugin hooks"),
        "startup demanded hooks nobody declared: {stderr}"
    );
}
