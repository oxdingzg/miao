#![cfg(target_os = "linux")]

//! End-to-end checks that `miao-run`'s Landlock backend actually enforces on Linux.
//! Run with `cargo test --release`.

use std::path::PathBuf;
use std::process::Command;

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_miao-run"))
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("miao-run-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn write_inside_workdir_is_allowed() {
    let work = temp_dir("inside");
    let status = Command::new(bin())
        .args([
            "--workdir",
            work.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            &format!("echo hi > {}/in.txt", work.display()),
        ])
        .status()
        .unwrap();

    assert!(status.success());
    assert!(work.join("in.txt").exists());
}

#[test]
fn write_outside_workdir_is_denied() {
    let work = temp_dir("outside");
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    let target = format!("{home}/miao-run-denied-{}.txt", std::process::id());
    let _ = std::fs::remove_file(&target);

    let _ = Command::new(bin())
        .args([
            "--workdir",
            work.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            &format!("echo hi > {target}"),
        ])
        .status()
        .unwrap();

    assert!(!std::path::Path::new(&target).exists(), "write outside workdir should be denied");
}

#[test]
fn tcp_network_is_denied_without_allow_network() {
    if Command::new("curl").arg("--version").output().is_err() {
        return;
    }
    let work = temp_dir("net");

    let denied = Command::new(bin())
        .args([
            "--workdir",
            work.to_str().unwrap(),
            "--",
            "curl",
            "-m",
            "5",
            "-sS",
            "-o",
            "/dev/null",
            "http://1.1.1.1",
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success(), "TCP connect should be denied without --allow-network");

    let allowed = Command::new(bin())
        .args([
            "--workdir",
            work.to_str().unwrap(),
            "--allow-network",
            "--",
            "curl",
            "-m",
            "5",
            "-sS",
            "-o",
            "/dev/null",
            "http://1.1.1.1",
        ])
        .output()
        .unwrap();
    assert!(allowed.status.success(), "--allow-network should permit TCP connect");
}
