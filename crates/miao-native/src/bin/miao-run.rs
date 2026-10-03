//! `miao-run`: run a command under an OS sandbox (macOS seatbelt, Linux Landlock).
//!
//! PoC for process-level isolation that the current rule-based permissions cannot
//! provide: the sandbox denies writes outside the allowed work directories and,
//! unless `--allow-network` is given, denies all network access.
//!
//! Usage:
//!   miao-run [--workdir <dir>]... [--allow-path <dir>]... [--allow-network] [--compat]
//!            [--deny-report <file>] [--print-profile] -- <command> [args...]
//!
//! `--allow-path` adds extra writable directories beyond the workdirs (for tool caches,
//! package managers, etc.). `--deny-report` writes the paths a denial blocked to a JSON
//! file so the caller can prompt the user and retry with more `--allow-path` entries.
//! On non-macOS hosts the command is executed without a sandbox.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

struct Options {
    workdirs: Vec<PathBuf>,
    allow_paths: Vec<PathBuf>,
    allow_network: bool,
    compat: bool,
    deny_report: Option<PathBuf>,
    print_profile: bool,
    command: Vec<String>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        workdirs: Vec::new(),
        allow_paths: Vec::new(),
        allow_network: false,
        compat: false,
        deny_report: None,
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
            "--allow-path" => {
                let value = iter.next().ok_or("--allow-path requires a path")?;
                options.allow_paths.push(PathBuf::from(value));
            }
            "--deny-report" => {
                let value = iter.next().ok_or("--deny-report requires a path")?;
                options.deny_report = Some(PathBuf::from(value));
            }
            "--allow-network" => options.allow_network = true,
            "--compat" => options.compat = true,
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

/// Extract the blocked path from a shell error line. macOS seatbelt reports
/// `Operation not permitted`; Linux Landlock reports `Permission denied`, and
/// shell prefixes vary (`sh: /path: ...`, `sh: 1: cannot create /path: ...`),
/// so take everything from the first `/` up to the marker.
fn parse_denied_line(line: &str) -> Option<String> {
    let index = ["Operation not permitted", "Permission denied"]
        .into_iter()
        .filter_map(|marker| line.find(marker))
        .min()?;
    let slash = line[..index].find('/')?;
    let path = line[slash..index].trim_end_matches(|c: char| c == ':' || c.is_whitespace());
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out
}

fn write_report(path: &Path, denied: &[String], exit_code: i32) {
    let list = denied
        .iter()
        .map(|item| format!("\"{}\"", json_escape(item)))
        .collect::<Vec<_>>()
        .join(",");
    let body = format!("{{\"denied\":[{list}],\"exitCode\":{exit_code}}}");
    let _ = std::fs::write(path, body);
}

fn sandbox_invocation(profile: &str, command: &[String]) -> (String, Vec<String>) {
    if cfg!(target_os = "macos") {
        let mut args = vec!["-p".to_string(), profile.to_string()];
        args.extend(command.iter().cloned());
        ("/usr/bin/sandbox-exec".to_string(), args)
    } else {
        (command[0].clone(), command[1..].to_vec())
    }
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("miao-run: {message}");
            return ExitCode::from(2);
        }
    };

    let profile = miao_sandbox::profile(&options.workdirs, &options.allow_paths, options.allow_network, options.compat);
    if options.print_profile {
        println!("{profile}");
        return ExitCode::SUCCESS;
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = miao_sandbox::apply_linux_restrictions(&options.workdirs, &options.allow_paths, options.allow_network) {
        eprintln!("miao-run: failed to apply landlock: {error}");
        return ExitCode::from(125);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    eprintln!("miao-run: no sandbox backend for this platform; running unsandboxed");

    let (program, args) = sandbox_invocation(&profile, &options.command);
    let mut child = match Command::new(&program).args(&args).stdout(Stdio::inherit()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("miao-run: failed to start {program}: {error}");
            return ExitCode::from(127);
        }
    };

    let mut denied = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            if let Some(path) = parse_denied_line(&line) {
                denied.push(path);
            }
        }
    }

    let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(1);
    if let Some(report) = &options.deny_report {
        write_report(report, &denied, code);
    }
    ExitCode::from(code as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_denied_line_extracts_path() {
        assert_eq!(
            parse_denied_line("sh: /Users/me/cache/f.txt: Operation not permitted"),
            Some("/Users/me/cache/f.txt".to_string())
        );
        assert_eq!(
            parse_denied_line("sh: 1: cannot create /home/me/cache/f.txt: Permission denied"),
            Some("/home/me/cache/f.txt".to_string())
        );
        assert_eq!(parse_denied_line("curl: (6) Could not resolve host"), None);
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
