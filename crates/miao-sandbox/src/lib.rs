//! Process-level sandbox backends shared by the `miao-run` CLI and the native
//! addon. macOS builds a seatbelt profile for `sandbox-exec`; Linux applies a
//! Landlock ruleset to the current process so the command it spawns inherits
//! it. Both the standalone `miao-run` binary and the compiled `miao` binary's
//! hidden `__sandbox-run` entry point call into this module, so the profile and
//! ruleset stay a single implementation.

use std::path::{Path, PathBuf};

#[cfg(windows)]
pub mod win;

pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether this platform has a sandbox backend.
pub fn supported() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    ))
}

/// Build a seatbelt profile from scratch. Deny-by-default, then explicitly allow
/// reads everywhere, process execution, and writes only into the given work
/// directories and the system temp/dev nodes.
pub fn profile(
    workdirs: &[PathBuf],
    allow_paths: &[PathBuf],
    allow_network: bool,
    compat: bool,
) -> String {
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
        profile.push_str(&format!("  (subpath {})\n", quoted(&canonical(path))));
    }
    profile.push_str(")\n");
    if allow_network {
        profile.push_str("(allow network*)\n");
    }
    profile
}

// Paths are data, never fragments of the seatbelt policy language.
fn quoted(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{text}\"")
}

/// Compatibility-first profile: allow everything, then deny writes to a small set
/// of credential paths and (unless allowed) the network. This trades strict
/// isolation for far fewer false denials.
fn compat_profile(allow_network: bool) -> String {
    let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*\n");
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in [
            ".ssh",
            ".aws",
            ".gnupg",
            ".netrc",
            ".docker/config.json",
            ".config/gh",
        ] {
            profile.push_str(&format!("  (subpath {})\n", quoted(&home.join(relative))));
        }
    }
    profile.push_str(")\n");
    if !allow_network {
        profile.push_str("(deny network*)\n");
    }
    profile
}

/// Apply a Landlock ruleset to the current process. Reads are allowed everywhere;
/// writes are limited to the work/allow directories plus temp/dev; TCP bind and
/// connect are denied unless `allow_network`. The restrictions are inherited by
/// any child the caller spawns.
///
/// NOTE: Landlock's network rules cover TCP bind/connect only (not UDP/DNS), and
/// unsupported access rights are dropped on kernels older than ABI v4. On
/// non-Linux hosts this is a no-op so the addon entry point is uniform.
#[cfg(target_os = "linux")]
pub fn apply_linux_restrictions(
    workdirs: &[PathBuf],
    allow_paths: &[PathBuf],
    allow_network: bool,
) -> Result<(), String> {
    use landlock::{
        Access, AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
    };

    let abi = AccessFs::from_all(landlock::ABI::V1);
    let read = AccessFs::Execute | AccessFs::ReadFile | AccessFs::ReadDir;
    let mut builder = Ruleset::default()
        .handle_access(abi)
        .map_err(|error| error.to_string())?;
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

#[cfg(not(target_os = "linux"))]
pub fn apply_linux_restrictions(
    _workdirs: &[PathBuf],
    _allow_paths: &[PathBuf],
    _allow_network: bool,
) -> Result<(), String> {
    Ok(())
}

/// Strict engine entry point. Unlike the legacy best-effort backend, require
/// Landlock ABI v3 (including refer/truncate), fully enforced filesystem rights,
/// and an inherited socket-creation filter when networking is disabled.
/// Must be called in a fresh single-threaded runner before executing its argv.
#[cfg(target_os = "linux")]
pub fn apply_linux_strict(workdirs: &[PathBuf], allow_network: bool) -> Result<(), String> {
    use landlock::{
        Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus,
    };
    let version = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0,
            1,
        )
    };
    if version < 3 {
        return Err("strict sandbox requires Landlock ABI v3 or newer".into());
    }
    let all = AccessFs::from_all(landlock::ABI::V3);
    let mut ruleset = Ruleset::default()
        .handle_access(all)
        .map_err(|e| e.to_string())?
        .create()
        .map_err(|e| e.to_string())?;
    let root = PathFd::new("/").map_err(|e| e.to_string())?;
    ruleset = ruleset
        .add_rule(PathBeneath::new(
            root,
            AccessFs::Execute | AccessFs::ReadFile | AccessFs::ReadDir,
        ))
        .map_err(|e| e.to_string())?;
    for dir in workdirs {
        let fd = PathFd::new(std::fs::canonicalize(dir).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        ruleset = ruleset
            .add_rule(PathBeneath::new(fd, all))
            .map_err(|e| e.to_string())?;
    }
    let null = PathFd::new("/dev/null").map_err(|e| e.to_string())?;
    ruleset = ruleset
        .add_rule(PathBeneath::new(
            null,
            AccessFs::ReadFile | AccessFs::WriteFile,
        ))
        .map_err(|e| e.to_string())?;
    let status = ruleset.restrict_self().map_err(|e| e.to_string())?;
    if status.ruleset != RulesetStatus::FullyEnforced {
        return Err("filesystem sandbox was not fully enforced".into());
    }
    if !allow_network {
        deny_sockets()?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn deny_sockets() -> Result<(), String> {
    let arch = if cfg!(target_arch = "x86_64") {
        0xc000003e
    } else if cfg!(target_arch = "aarch64") {
        0xc00000b7
    } else {
        return Err("strict network filter unsupported on this architecture".into());
    };
    let deny = 0x00050000 | libc::EPERM as u32;
    let filter = [
        libc::sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 4,
        },
        libc::sock_filter {
            code: 0x15,
            jt: 1,
            jf: 0,
            k: arch,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: deny,
        },
        libc::sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: 0x35,
            jt: 0,
            jf: 1,
            k: 0x40000000,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: deny,
        },
        libc::sock_filter {
            code: 0x15,
            jt: 0,
            jf: 1,
            k: libc::SYS_socket as u32,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: deny,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: 0x7fff0000,
        },
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr() as *mut libc::sock_filter,
    };
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_SET_SECCOMP, 2, &program as *const libc::sock_fprog) } != 0
    {
        return Err(format!(
            "network filter failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn apply_linux_strict(_workdirs: &[PathBuf], _allow_network: bool) -> Result<(), String> {
    Err("strict Landlock backend requires Linux".into())
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
    fn reports_platform_support() {
        assert_eq!(
            supported(),
            cfg!(any(
                target_os = "macos",
                target_os = "linux",
                target_os = "windows"
            ))
        );
    }
}

#[cfg(test)]
mod escaping_tests {
    #[test]
    fn workspace_path_cannot_inject_seatbelt_forms() {
        let path = std::path::PathBuf::from("/tmp/quote\") (allow default) ;\\newline\n");
        let profile = super::profile(&[path], &[], false, false);
        assert!(profile.contains("quote\\\") (allow default) ;\\\\newline\\n"));
        assert_eq!(
            profile
                .lines()
                .filter(|line| line.starts_with("  (subpath"))
                .count(),
            5
        );
    }
}
