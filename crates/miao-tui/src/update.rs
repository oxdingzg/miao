//! What the installed launcher points at, when it is newer than this build.
//!
//! The footer shows the running build's version, which is a compile-time
//! constant: an upgrade swaps the launcher's symlink and never touches a process
//! already running. Without this, an operator who upgraded sees the old version
//! and concludes the upgrade did not happen.

use std::path::PathBuf;

/// The stable launcher the installer repoints. `miao-preview` and `miao-dev`
/// live elsewhere and are their own channels, so a build that is not this file
/// has nothing to report.
fn launcher() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".miao/bin/miao");
    path.exists().then_some(path)
}

/// `miao 0.3.68` reads as `0.3.68`; anything else reads as nothing.
pub fn parse(output: &str) -> Option<String> {
    let version = output.split_whitespace().nth(1)?;
    let parts = version.split('.').collect::<Vec<_>>();
    if parts.len() < 2
        || !parts
            .iter()
            .all(|part| part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some(version.to_string())
}

/// Numeric comparison of dotted versions, so `0.3.9` is older than `0.3.68`.
/// A missing segment counts as zero.
pub fn newer(installed: &str, running: &str) -> bool {
    let segments = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (installed, running) = (segments(installed), segments(running));
    let width = installed.len().max(running.len());
    for index in 0..width {
        let left = installed.get(index).copied().unwrap_or(0);
        let right = running.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// The installed version when it is newer than this build. The launcher is asked
/// for its version directly: the installer leaves no metadata beside the binary,
/// so the only authority is the binary itself.
pub fn pending() -> Option<String> {
    let current = std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    let launcher = std::fs::canonicalize(launcher()?).ok()?;
    // Running the installed build already: nothing to announce.
    if current.as_deref() == Some(launcher.as_path()) {
        return None;
    }
    let output = std::process::Command::new(&launcher)
        .arg("--version")
        .output()
        .ok()?;
    let installed = parse(std::str::from_utf8(&output.stdout).ok()?)?;
    newer(&installed, crate::VERSION).then_some(installed)
}

#[cfg(test)]
mod tests {
    use super::{newer, parse};

    #[test]
    fn a_version_line_parses_and_noise_does_not() {
        assert_eq!(parse("miao 0.3.68\n"), Some("0.3.68".into()));
        assert_eq!(parse("miao"), None);
        assert_eq!(parse("miao next"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn comparison_is_numeric_not_lexical() {
        assert!(newer("0.3.68", "0.3.65"));
        assert!(!newer("0.3.9", "0.3.68"), "9 < 68 numerically");
        assert!(newer("0.4.0", "0.3.99"));
        assert!(newer("1.0", "0.9.9"));
        assert!(!newer("0.3.68", "0.3.68"));
        assert!(!newer("0.3.65", "0.3.68"));
    }
}
