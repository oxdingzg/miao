//! `miao-run`: run a command under a macOS seatbelt sandbox.
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

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Build a seatbelt profile from scratch. Deny-by-default, then explicitly allow
/// reads everywhere, process execution, and writes only into the given work
/// directories and the system temp/dev nodes.
fn profile(workdirs: &[PathBuf], allow_paths: &[PathBuf], allow_network: bool, compat: bool) -> String {
    if compat {
        return compat_profile(allow_network);
    }

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
    for path in workdirs.iter().chain(allow_paths) {
        profile.push_str(&format!("  (subpath \"{}\")\n", canonical(path).display()));
    }
    profile.push_str(")\n");
    if allow_network {
        profile.push_str("(allow network*)\n");
    }
    profile
}

/// Compatibility-first profile: allow everything, then deny writes to a small set
/// of credential paths and (unless allowed) the network. This trades strict
/// isolation for far fewer false denials.
fn compat_profile(allow_network: bool) -> String {
    let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*\n");
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in [".ssh", ".aws", ".gnupg", ".netrc", ".docker/config.json", ".config/gh"] {
            profile.push_str(&format!("  (subpath \"{}\")\n", home.join(relative).display()));
        }
    }
    profile.push_str(")\n");
    if !allow_network {
        profile.push_str("(deny network*)\n");
    }
    profile
}

/// Extract the blocked path from a shell error line such as
/// `sh: /path/to/file: Operation not permitted`.
fn parse_denied_line(line: &str) -> Option<String> {
    let marker = "Operation not permitted";
    let prefix = line[..line.find(marker)?].trim_end();
    let prefix = prefix.strip_suffix(':')?.trim_end();
    let path = prefix.split_once(": ").map(|(_, rest)| rest).unwrap_or(prefix).trim();
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

/// Apply a Landlock ruleset to the current process. Reads are allowed everywhere;
/// writes are limited to the work/allow directories plus temp/dev; TCP bind and
/// connect are denied unless `--allow-network`. The restrictions are inherited by
/// the command we exec.
///
/// NOTE: Landlock's network rules cover TCP bind/connect only (not UDP/DNS), and
/// unsupported access rights are dropped on kernels older than ABI v4.
#[cfg(target_os = "linux")]
fn apply_linux_restrictions(
    workdirs: &[PathBuf],
    allow_paths: &[PathBuf],
    allow_network: bool,
) -> Result<(), String> {
    use landlock::{Access, AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr};

    let abi = AccessFs::from_all(landlock::ABI::V1);
    let read = AccessFs::Execute | AccessFs::ReadFile | AccessFs::ReadDir;
    let mut builder = Ruleset::default().handle_access(abi).map_err(|error| error.to_string())?;
    if !allow_network {
        // BestEffort drops these on a kernel that predates ABI v4, so this is safe.
        builder = builder
            .handle_access(AccessNet::from_all(landlock::ABI::V4))
            .map_err(|error| error.to_string())?;
    }
    let mut ruleset = builder.create().map_err(|error| error.to_string())?;

    if let Ok(root) = PathFd::new("/") {
        ruleset = ruleset
            .add_rule(PathBeneath::new(root, read))
            .map_err(|error| error.to_string())?;
    }
    for dir in ["/tmp", "/private/tmp", "/private/var/tmp", "/dev"]
        .into_iter()
        .map(PathBuf::from)
        .chain(workdirs.iter().cloned())
        .chain(allow_paths.iter().cloned())
    {
        if let Ok(fd) = PathFd::new(canonical(&dir)) {
            ruleset = ruleset
                .add_rule(PathBeneath::new(fd, abi))
                .map_err(|error| error.to_string())?;
        }
    }

    ruleset.restrict_self().map_err(|error| error.to_string())?;
    Ok(())
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("miao-run: {message}");
            return ExitCode::from(2);
        }
    };

    let profile = profile(&options.workdirs, &options.allow_paths, options.allow_network, options.compat);
    if options.print_profile {
        println!("{profile}");
        return ExitCode::SUCCESS;
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = apply_linux_restrictions(&options.workdirs, &options.allow_paths, options.allow_network) {
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
    fn profile_allows_only_given_workdirs() {
        let profile = profile(&[PathBuf::from("/tmp")], &[], false, false);
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("(subpath \"/tmp\")"));
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn profile_includes_extra_allow_paths() {
        let profile = profile(&[], &[PathBuf::from("/tmp")], false, false);
        assert!(profile.contains("(subpath \"/tmp\")"));
    }

    #[test]
    fn profile_can_allow_network() {
        assert!(profile(&[], &[], true, false).contains("(allow network*)"));
    }

    #[test]
    fn compat_profile_allows_default() {
        let profile = profile(&[], &[], false, true);
        assert!(profile.contains("(allow default)"));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn parse_denied_line_extracts_path() {
        assert_eq!(
            parse_denied_line("sh: /Users/me/cache/f.txt: Operation not permitted"),
            Some("/Users/me/cache/f.txt".to_string())
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
