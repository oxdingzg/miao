//! `miao-run`: run a command under a macOS seatbelt sandbox.
//!
//! PoC for process-level isolation that the current rule-based permissions cannot
//! provide: the sandbox denies writes outside the allowed work directories and,
//! unless `--allow-network` is given, denies all network access.
//!
//! Usage:
//!   miao-run [--workdir <dir>]... [--allow-network] [--print-profile] -- <command> [args...]
//!
//! On non-macOS hosts the command is executed without a sandbox.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

struct Options {
    workdirs: Vec<PathBuf>,
    allow_network: bool,
    print_profile: bool,
    command: Vec<String>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        workdirs: Vec::new(),
        allow_network: false,
        print_profile: false,
        command: Vec::new(),
    };
    let mut iter = args.into_iter().peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--workdir" => {
                let value = iter.next().ok_or("--workdir requires a path")?;
                options.workdirs.push(PathBuf::from(value));
            }
            "--allow-network" => options.allow_network = true,
            "--print-profile" => options.print_profile = true,
            "--" => {
                options.command.extend(iter);
                break;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if options.command.is_empty() && !options.print_profile {
        return Err("no command given; use `-- <command> [args...]`".to_string());
    }
    Ok(options)
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Build a seatbelt profile from scratch. Deny-by-default, then explicitly allow
/// reads everywhere, process execution, and writes only into the given work
/// directories and the system temp/dev nodes.
fn profile(workdirs: &[PathBuf], allow_network: bool) -> String {
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n");
    profile.push_str("(allow process-exec)\n");
    profile.push_str("(allow process-fork)\n");
    profile.push_str("(allow sysctl-read)\n");
    profile.push_str("(allow file-read*)\n");
    profile.push_str("(allow mach-lookup)\n");
    profile.push_str("(allow signal (target self))\n");
    profile.push_str("(allow file-write*\n");
    profile.push_str("  (subpath \"/private/tmp\")\n");
    profile.push_str("  (subpath \"/tmp\")\n");
    profile.push_str("  (subpath \"/private/var/tmp\")\n");
    profile.push_str("  (subpath \"/dev\")\n");
    for workdir in workdirs {
        profile.push_str(&format!("  (subpath \"{}\")\n", canonical(workdir).display()));
    }
    profile.push_str(")\n");
    if allow_network {
        profile.push_str("(allow network*)\n");
    }
    profile
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("miao-run: {message}");
            return ExitCode::from(2);
        }
    };

    let profile = profile(&options.workdirs, options.allow_network);
    if options.print_profile {
        println!("{profile}");
        return ExitCode::SUCCESS;
    }

    if cfg!(target_os = "macos") {
        let status = Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(&profile)
            .args(&options.command)
            .status();
        match status {
            Ok(status) => return ExitCode::from(status.code().unwrap_or(1) as u8),
            Err(error) => {
                eprintln!("miao-run: failed to start sandbox-exec: {error}");
                return ExitCode::from(127);
            }
        }
    }

    eprintln!("miao-run: no sandbox backend for this platform; running unsandboxed");
    match Command::new(&options.command[0]).args(&options.command[1..]).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => {
            eprintln!("miao-run: failed to start command: {error}");
            ExitCode::from(127)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_allows_only_given_workdirs() {
        let profile = profile(&[PathBuf::from("/tmp")], false);
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("(subpath \"/tmp\")"));
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn profile_can_allow_network() {
        assert!(profile(&[], true).contains("(allow network*)"));
    }

    #[test]
    fn parse_requires_a_command() {
        assert!(parse(["--workdir".to_string(), "/tmp".to_string()]).is_err());
    }

    #[test]
    fn parse_collects_command_after_separator() {
        let options = parse(["--".to_string(), "echo".to_string(), "hi".to_string()]).unwrap();
        assert_eq!(options.command, vec!["echo".to_string(), "hi".to_string()]);
    }
}
