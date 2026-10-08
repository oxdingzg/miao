//! Windows AppContainer sandbox verification (spec section 6.1/6.2).
//!
//! Mirrors `tests/linux-sandbox.rs` for the Windows backend: runs the built
//! `miao-run` binary and asserts the file/network/process-tree guarantees.
//!
//! If the AppContainer backend is unavailable on this host (no privileges), the
//! tests print an explicit SKIP and return — they never silently pass a broken
//! sandbox (see spec section 7).
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_miao-run"))
}

struct Out {
    code: i32,
    combined: String,
}

fn run(args: &[&str]) -> Out {
    let output = Command::new(exe())
        .args(args)
        .output()
        .expect("failed to spawn miao-run");
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Out {
        code: output.status.code().unwrap_or(-1),
        combined,
    }
}

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("miao-{tag}-{nanos}"))
}

/// True when `miao-run` actually applied the AppContainer (not the fallback).
fn sandbox_available(workdir: &Path) -> bool {
    let probe = unique("probe-outside").with_extension("txt");
    let _ = std::fs::remove_file(&probe);
    let wd = workdir.to_string_lossy().to_string();
    let target = probe.to_string_lossy().to_string();
    let out = run(&[
        "--workdir",
        &wd,
        "--",
        "cmd",
        "/c",
        &format!("echo x > {target}"),
    ]);
    let fell_back = out.combined.contains("windows sandbox unavailable");
    let _ = std::fs::remove_file(&probe);
    !fell_back
}

macro_rules! require_sandbox {
    ($wd:expr) => {
        if !sandbox_available($wd) {
            eprintln!(
                "SKIP: windows sandbox unavailable on this host (AppContainer not permitted)"
            );
            return;
        }
    };
}

#[test]
fn write_inside_workdir_allowed() {
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let file = wd.join("in.txt");
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        &format!("echo hi > {}", file.to_string_lossy()),
    ]);
    assert_eq!(
        out.code, 0,
        "workdir write should succeed: {}",
        out.combined
    );
    assert!(file.exists(), "file should exist inside workdir");
}

#[test]
fn stdio_and_command_exit_are_preserved() {
    let wd = unique("stdio");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        "echo stdout-marker& echo stderr-marker 1>&2& exit /b 23",
    ]);
    assert_eq!(out.code, 23, "command exit status lost: {}", out.combined);
    assert!(
        out.combined.contains("stdout-marker"),
        "stdout pipe not inherited"
    );
    assert!(
        out.combined.contains("stderr-marker"),
        "stderr pipe not inherited"
    );
}

#[test]
fn powershell_can_create_and_reopen_nested_workdir_files() {
    let wd = unique("nested");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let nested = wd.join("child").join("state.txt");
    let script = format!(
        "$ErrorActionPreference = 'Stop'; New-Item -ItemType Directory -Path '{}' | Out-Null; Set-Content -LiteralPath '{}' -Value first; Set-Content -LiteralPath '{}' -Value second; Get-Content -LiteralPath '{}'",
        wd.join("child").to_string_lossy(),
        nested.to_string_lossy(),
        nested.to_string_lossy(),
        nested.to_string_lossy(),
    );
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "powershell.exe",
        "-NoProfile",
        "-Command",
        &script,
    ]);
    assert_eq!(
        out.code, 0,
        "nested writes/reopens failed: {}",
        out.combined
    );
    assert!(std::fs::read_to_string(nested).unwrap().contains("second"));
}

#[test]
fn write_outside_denied() {
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let outside = unique("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let file = outside.join("nope.txt");
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        &format!("echo hi > {}", file.to_string_lossy()),
    ]);
    assert_ne!(out.code, 0, "write outside should be denied");
    assert!(!file.exists(), "file outside must not be created");
}

#[test]
fn write_windows_temp_denied() {
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let file = PathBuf::from(r"C:\Windows\Temp\miao-sandbox-test.txt");
    let _ = std::fs::remove_file(&file);
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        &format!("echo hi > {}", file.to_string_lossy()),
    ]);
    assert_ne!(out.code, 0, "write to Windows\\Temp should be denied");
    assert!(!file.exists(), "file in Windows\\Temp must not be created");
}

#[test]
fn read_system32_allowed() {
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        "type C:\\Windows\\System32\\drivers\\etc\\hosts",
    ]);
    assert_eq!(
        out.code, 0,
        "reading system files should be allowed: {}",
        out.combined
    );
}

#[test]
fn network_denied_by_default() {
    if std::env::var_os("MIAO_SANDBOX_NET").is_none() {
        eprintln!("SKIP: set MIAO_SANDBOX_NET=1 to run network tests");
        return;
    }
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--",
        "curl.exe",
        "--noproxy",
        "*",
        "-m",
        "8",
        "-sS",
        "-o",
        "NUL",
        "http://www.baidu.com",
    ]);
    assert_ne!(out.code, 0, "network should be denied by default");
}

#[test]
fn network_allowed_with_flag() {
    if std::env::var_os("MIAO_SANDBOX_NET").is_none() {
        eprintln!("SKIP: set MIAO_SANDBOX_NET=1 to run network tests");
        return;
    }
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);
    let body = wd.join("body.html");
    let out = run(&[
        "--workdir",
        &wd.to_string_lossy(),
        "--allow-network",
        "--",
        "curl.exe",
        "--noproxy",
        "*",
        "-m",
        "15",
        "-sS",
        "-o",
        &body.to_string_lossy(),
        "-w",
        "%{http_code}",
        "http://www.baidu.com",
    ]);
    assert_eq!(
        out.code, 0,
        "network should be allowed with --allow-network: {}",
        out.combined
    );
    assert!(
        body.exists(),
        "downloaded body should be written into the workdir"
    );
}

#[test]
fn child_tree_killed_with_miaorun() {
    let wd = unique("wd");
    std::fs::create_dir_all(&wd).unwrap();
    require_sandbox!(&wd);

    // Child writes a heartbeat file every second; if the job object works, killing
    // miao-run kills the child and the heartbeat stops changing.
    let hb = wd.join("hb.txt");
    let script = format!(
        "while ($true) {{ Set-Content -LiteralPath '{}' -Value (Get-Date); Start-Sleep -Seconds 1 }}",
        hb.to_string_lossy()
    );
    let mut child = Command::new(exe())
        .args([
            "--workdir",
            &wd.to_string_lossy(),
            "--",
            "powershell.exe",
            "-NoProfile",
            "-Command",
            &script,
        ])
        .spawn()
        .expect("spawn miao-run");

    // Wait for the heartbeat to appear.
    let mut seen = false;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        if hb.exists() {
            seen = true;
            break;
        }
        if let Some(status) = child.try_wait().expect("poll miao-run") {
            panic!("heartbeat command exited before writing: {status:?}");
        }
    }
    if !seen {
        let _ = child.kill();
        panic!("child heartbeat never appeared");
    }

    child.kill().expect("kill miao-run");
    let _ = child.wait();

    let t1 = std::fs::metadata(&hb).and_then(|m| m.modified()).ok();
    std::thread::sleep(Duration::from_secs(3));
    let t2 = std::fs::metadata(&hb).and_then(|m| m.modified()).ok();
    assert_eq!(
        t1, t2,
        "child (heartbeat writer) should be dead after miao-run is killed"
    );

    // A killed invocation cannot revoke its ACLs. Its SID must nevertheless
    // remain unusable by later invocations with a different workspace.
    let other = unique("next-wd");
    std::fs::create_dir_all(&other).unwrap();
    let out = run(&[
        "--workdir",
        &other.to_string_lossy(),
        "--",
        "cmd",
        "/c",
        &format!("echo escaped > {}", hb.to_string_lossy()),
    ]);
    assert_ne!(
        out.code, 0,
        "later invocation accessed killed sandbox workspace"
    );
    assert_eq!(std::fs::metadata(&hb).and_then(|m| m.modified()).ok(), t2);
}
