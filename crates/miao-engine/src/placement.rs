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

/// The ledger for one workspace, under `root`.
pub fn database_for(root: &Path, workspace: &Path) -> Option<PathBuf> {
    let directory = std::path::absolute(workspace).ok()?;
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
