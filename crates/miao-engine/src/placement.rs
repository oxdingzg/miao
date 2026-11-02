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
    #[cfg(target_os = "macos")]
    fn unicode_and_case_fold_to_the_filesystem_truth_on_apfs() {
        // APFS stores names NFD-normalised and matches case-insensitively, so
        // `café` spelled NFC, spelled NFD, and spelled `CAFE` are one directory
        // and one ledger. ext4 keeps the bytes and the case, which is why this
        // is a macOS assertion and not a portable one: there the three spellings
        // are genuinely three directories, and identity must not fold them.
        let dir = tempfile::tempdir().expect("temp dir");
        let nfc = dir.path().join("caf\u{e9}");
        std::fs::create_dir_all(&nfc).expect("create NFC");
        let nfd = dir.path().join("cafe\u{301}");

        let root = Path::new("/tmp/root");
        let via_nfc = database_for(root, &nfc).expect("a ledger");
        let via_nfd = database_for(root, &nfd).expect("a ledger");
        assert_eq!(via_nfc, via_nfd, "NFC and NFD spellings split the ledger");
        // Case folding is deliberately NOT asserted: on a case-insensitive
        // filesystem canonicalize resolves `CAFE` to the real directory and the
        // spellings fold; on a case-sensitive one (modern APFS, ext4) `CAFE` is
        // a different, absent directory and must not fold. The mechanism is the
        // same either way — identity asks the filesystem, and the filesystem's
        // answer is the Location.
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

    #[test]
    fn the_toolsets_reresolution_names_the_same_ledger() {
        // Two surfaces consume the workspace spelling independently: storage
        // derives the ledger from identity(spelling), and the toolset takes
        // the string storage produced and resolves it again through
        // canonicalize (Toolset::new in tools.rs). Whatever each surface does
        // to the spelling, both must land on one directory and one ledger.
        let dir = tempfile::tempdir().expect("temp dir");
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real, &link).expect("symlink");

        let spelled = PathBuf::from(format!("{}/", link.display()));
        let stored = identity(&spelled);
        let toolset = std::fs::canonicalize(&stored).expect("resolve the stored root");
        assert_eq!(
            stored, toolset,
            "identity's output is not the filesystem truth"
        );
        assert_eq!(
            database_for(Path::new("/tmp/root"), &stored).expect("a ledger"),
            database_for(Path::new("/tmp/root"), &toolset).expect("a ledger"),
            "storage and the toolset split the ledger",
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_long_path_names_one_ledger_in_both_spellings() {
        // Windows caps ordinary path APIs at 260 chars; the verbatim spelling
        // (`\\?\C:\...`) bypasses the cap. The directory is created through
        // the verbatim form — the plain spelling cannot even be created past
        // the cap — and identity must digest both spellings to one ledger:
        // canonicalize resolves the verbatim form, the plain one rides the
        // lexical branch (or canonicalizes when the process is long-path
        // aware), and the prefix strip makes both read the same.
        let temp = tempfile::tempdir().expect("temp dir");
        let base = identity(temp.path());
        let segment = "segment".repeat(6);
        let mut long = base;
        (0..8).for_each(|_| long.push(segment.as_str()));
        assert!(long.to_string_lossy().len() > 260, "{}", long.display());
        let verbatim = PathBuf::from(format!(r"\\?\{}", long.display()));
        std::fs::create_dir_all(&verbatim).expect("create the long directory");

        assert_eq!(
            identity(&long),
            identity(&verbatim),
            "the long-path spellings disagree"
        );
        assert_eq!(
            database_for(Path::new("/tmp/root"), &long).expect("a ledger"),
            database_for(Path::new("/tmp/root"), &verbatim).expect("a ledger"),
            "the long-path spellings split the ledger",
        );
    }
}
