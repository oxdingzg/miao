//! Process-level sandbox backends shared by the `miao-run` CLI and the native
//! addon. macOS builds a seatbelt profile for `sandbox-exec`; Linux applies a
//! Landlock ruleset to the current process so the command it spawns inherits
//! it. Both the standalone `miao-run` binary and the compiled `miao` binary's
//! hidden `__sandbox-run` entry point call into this module, so the profile and
//! ruleset stay a single implementation.

use std::path::{Path, PathBuf};

pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether this platform has a sandbox backend.
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}

/// Build a seatbelt profile from scratch. Deny-by-default, then explicitly allow
/// reads everywhere, process execution, and writes only into the given work
/// directories and the system temp/dev nodes.
pub fn profile(workdirs: &[PathBuf], allow_paths: &[PathBuf], allow_network: bool, compat: bool) -> String {
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
    use landlock::{AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr};

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

#[cfg(not(target_os = "linux"))]
pub fn apply_linux_restrictions(_workdirs: &[PathBuf], _allow_paths: &[PathBuf], _allow_network: bool) -> Result<(), String> {
    Ok(())
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
        assert_eq!(supported(), cfg!(any(target_os = "macos", target_os = "linux")));
    }
}
