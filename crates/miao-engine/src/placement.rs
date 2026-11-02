//! Where a workspace's ledger lives.
//!
//! A start that names no database looks beside the product's storage root, one
//! file per Location identity. The name is the product's own: the SHA-256 of the
//! Location JSON, so a binary started without flags opens the same store the
//! graphical host already uses instead of a second, empty one.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The product's default storage root: `MIAO_ENGINE_STORAGE` when set, otherwise
/// the directory the installation writes under.
pub fn storage_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("MIAO_ENGINE_STORAGE") {
        let root = PathBuf::from(root);
        return (!root.as_os_str().is_empty()).then_some(root);
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/miao-engine/storage"))
}

/// The stable identity of a workspace directory: the real path when the
/// directory exists, a lexically normalised absolute path when it does not.
/// Every ledger-name derivation goes through this, so one directory spells one
/// Location no matter how the operator reached it — through a symlink (`/tmp`
/// is `/private/tmp` on macOS), with a trailing slash, with `..` segments, or
/// from a different working directory. CFG-06: the same directory must never
/// open two ledgers, and two directories must never share one.
pub fn identity(workspace: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(workspace) {
        return strip_windows_prefix(real);
    }
    let absolute = std::path::absolute(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    normalise_dot_segments(strip_windows_prefix(absolute))
}

/// `canonicalize` on Windows hands back verbatim paths (`\\?\C:\...`), which
/// would digest differently from the plain spelling of the same directory.
#[cfg(windows)]
fn strip_windows_prefix(path: PathBuf) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped.to_owned())
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_windows_prefix(path: PathBuf) -> PathBuf {
    path
}

/// Collapse `.` and `..` without touching the filesystem: `..` pops the last
/// real component and never escapes the root, matching what `canonicalize`
/// would have produced had the directory existed.
fn normalise_dot_segments(path: PathBuf) -> PathBuf {
    let mut stack: Vec<std::path::Component> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // A root or prefix stays put: `/..` is `/`, and `C:\..` is
                // `C:\`, which is how the filesystem resolves them too.
                if !matches!(
                    stack.last(),
                    Some(std::path::Component::RootDir) | Some(std::path::Component::Prefix(_))
                ) {
                    stack.pop();
                }
            }
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for component in stack {
        out.push(component.as_os_str());
    }
    out
}

/// The ledger for one workspace, under `root`.
pub fn database_for(root: &Path, workspace: &Path) -> Option<PathBuf> {
    let directory = identity(workspace);
    let identity = serde_json::json!({ "directory": directory.display().to_string() });
    let digest = Sha256::digest(serde_json::to_vec(&identity).ok()?);
    let mut name = String::with_capacity(digest.len() * 2 + 3);
    for byte in digest {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".db");
    Some(root.join(name))
}

/// The default ledger for `workspace`, or `None` when no root is configured.
pub fn default_database(workspace: &Path) -> Option<PathBuf> {
    database_for(&storage_root()?, workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_slash_names_the_same_ledger() {
        // `miao tui --workspace /repo/` and `--workspace /repo` are the same
        // directory, and absolute() keeps the slash in the digest input. Two
        // spellings must not open two ledgers.
        let root = Path::new("/tmp/root");
        let plain = database_for(root, Path::new("/Users/someone/project")).expect("a ledger");
        let slashed = database_for(root, Path::new("/Users/someone/project/")).expect("a ledger");
        assert_eq!(plain, slashed, "a trailing slash splits the ledger");
    }

    #[test]
    fn a_dotdot_segment_names_the_same_ledger() {
        // `cd /Users/someone && miao tui --workspace project/../project` is the
        // same directory as `--workspace /Users/someone/project`; the `..`
        // survives absolute(), so only a normalised identity collapses them.
        let root = Path::new("/tmp/root");
        let plain = database_for(root, Path::new("/Users/someone/project")).expect("a ledger");
        let dotted =
            database_for(root, Path::new("/Users/someone/other/../project")).expect("a ledger");
        assert_eq!(plain, dotted, "a `..` segment splits the ledger");
    }

    #[test]
    fn a_symlinked_spelling_names_the_same_ledger() {
        // The common case on macOS: /tmp is /private/tmp, and a workspace
        // reached through the link is the same directory as through the real
        // path. absolute() cannot see that; only resolving the link can.
        let dir = tempfile::tempdir().expect("temp dir");
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real, &link).expect("symlink");

        let root = Path::new("/tmp/root");
        let via_real = database_for(root, &real).expect("a ledger");
        let via_link = database_for(root, &link).expect("a ledger");
        assert_eq!(via_real, via_link, "the symlink spelling splits the ledger");
    }

    #[test]
    fn the_ledger_name_is_the_product_location_digest() {
        let root = Path::new("/tmp/root");
        let path = database_for(root, Path::new("/Users/someone/project")).expect("a ledger");
        let name = path
            .file_name()
            .expect("a ledger name")
            .to_string_lossy()
            .to_string();
        // Shape first, on every platform: one 64-hex digest and its suffix.
        assert_eq!(name.len(), 64 + ".db".len(), "{name}");
        assert!(name.ends_with(".db"), "{name}");
        assert!(name[..64].chars().all(|c| c.is_ascii_hexdigit()), "{name}");
        // Two workspaces never share a ledger.
        assert_ne!(
            path,
            database_for(root, Path::new("/Users/someone/other")).expect("a ledger")
        );
        // The exact digest is the product's: it hashes
        // `{ "directory": "<absolute directory>" }`. That string is only stable
        // across hosts on unix — a Windows absolute path differs — so the parity
        // pin lives where the string it pins actually is.
        #[cfg(unix)]
        assert_eq!(
            path,
            root.join("228535309a12cfe4cf9e7b4139686b73a264de615d53cb4ba1e11ac4abab3ef6.db")
        );
    }
}
