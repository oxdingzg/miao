//! Git worktrees for parallel Sessions.
//!
//! A worktree is a second checkout of the same repository, which is how two
//! Sessions work on one project without sharing a working tree. The engine owns
//! the git plumbing so the CLI, an engine command and an in-Session tool create,
//! list and remove the same trees the same way instead of each shelling out to
//! git with its own rules.
//!
//! Names stay one path component under `<root>/.miao-worktrees/`, and every
//! reported path is canonical: a Session's Location is keyed by its real path,
//! so `/tmp/x` and `/private/tmp/x` would otherwise be two Locations and the
//! Session would appear to disappear.
use crate::protocol::Error;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The directory a checkout keeps its worktrees in. One name per checkout, so a
/// removal can be asked for by name without guessing a path.
pub const DIRECTORY: &str = ".miao-worktrees";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tree {
    /// The single path component the tree is named by on disk.
    pub name: String,
    /// The canonical path a Session's Location would be keyed by.
    pub path: String,
    /// The branch git checked out, when it names one (`detached` otherwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The checkout the others were added from. git lists it first.
    pub main: bool,
}

/// Every worktree git knows for `root`, the checkout itself first.
pub fn list(root: &Path) -> Result<Vec<Tree>, Error> {
    let listed = git(root, &["worktree", "list", "--porcelain"])?;
    Ok(parse(&listed))
}

/// Add a worktree named `name`, creating or resetting the branch of that name.
pub fn create(root: &Path, name: &str) -> Result<Tree, Error> {
    validate(name)?;
    let path = root.join(DIRECTORY).join(name);
    git(
        root,
        &["worktree", "add", "-B", name, &path.display().to_string()],
    )?;
    Ok(Tree {
        name: name.to_string(),
        path: canonical(&path).display().to_string(),
        branch: Some(name.to_string()),
        main: false,
    })
}

/// Remove the worktree named `name` and the branch it held.
///
/// `--force` matches what git itself needs once the tree holds any change: a
/// removal that kept local edits alive would leave an unregistered directory
/// behind. Callers that must not strand Sessions check [`anchored_sessions`]
/// first; this function is the mechanical step.
pub fn remove(root: &Path, name: &str) -> Result<(), Error> {
    validate(name)?;
    let path = canonical(&root.join(DIRECTORY).join(name));
    git(
        root,
        &["worktree", "remove", "--force", &path.display().to_string()],
    )?;
    // The branch git created with the tree goes with it. A branch something
    // else still holds stays: git refuses, and the removal itself already
    // happened, so a stale branch is reported by `list`, not by a failed
    // removal.
    let _ = git(root, &["branch", "-D", name]);
    Ok(())
}

/// Sessions whose recorded root is `tree` itself or below it, read from one
/// ledger. A removal that strands them leaves their tools pointing at a dead
/// directory, so the count is what a caller shows before agreeing to it.
pub fn anchored_sessions(db: &Path, tree: &Path) -> Result<u64, Error> {
    if !db.is_file() {
        return Ok(0);
    }
    let connection =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let anchored: i64 = connection.query_row(
        "SELECT count(*) FROM engine_location WHERE root = ?1 OR root LIKE ?1 || '/%'",
        [canonical(tree).display().to_string()],
        |row| row.get(0),
    )?;
    Ok(anchored as u64)
}

fn validate(name: &str) -> Result<(), Error> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(Error::Invalid(
            "worktree name must be a single path component".into(),
        ));
    }
    Ok(())
}

fn parse(listed: &str) -> Vec<Tree> {
    let mut trees: Vec<Tree> = Vec::new();
    for line in listed.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            let path = canonical(Path::new(path));
            trees.push(Tree {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                path: path.display().to_string(),
                branch: None,
                main: trees.is_empty(),
            });
            continue;
        }
        if let (Some(branch), Some(tree)) = (line.strip_prefix("branch "), trees.last_mut()) {
            let name = branch.strip_prefix("refs/heads/").unwrap_or(branch);
            tree.branch = Some(name.to_string());
        }
    }
    trees
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn git(root: &Path, args: &[&str]) -> Result<String, Error> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| Error::Invalid(format!("git: {error}")))?;
    if !output.status.success() {
        return Err(Error::Invalid(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "miao-worktree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("workspace");
        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["config", "user.email", "test@miao.invalid"],
            vec!["config", "user.name", "miao test"],
            vec!["commit", "--allow-empty", "-m", "seed"],
        ] {
            git(&root, &args).expect("git");
        }
        root
    }

    #[test]
    fn a_created_tree_lists_under_the_checkout() {
        let root = repository();
        let created = create(&root, "work").expect("create");
        assert_eq!(created.name, "work");
        assert_eq!(created.branch.as_deref(), Some("work"));
        assert_eq!(
            created.path,
            canonical(&root.join(DIRECTORY).join("work"))
                .display()
                .to_string()
        );

        let trees = list(&root).expect("list");
        assert_eq!(trees.len(), 2);
        assert!(
            trees[0].main,
            "the checkout git lists first is the main one"
        );
        assert_eq!(trees[1].name, "work");
        assert_eq!(trees[1].branch.as_deref(), Some("work"));
        remove(&root, "work").expect("remove");
        assert_eq!(list(&root).expect("list").len(), 1);
    }

    #[test]
    fn a_name_that_would_escape_the_directory_is_refused() {
        let root = repository();
        for name in ["", "../escape", "a/b", "a\\b"] {
            assert!(create(&root, name).is_err(), "{name:?} must be refused");
        }
        // Nothing was created, so the checkout is still the only tree.
        assert_eq!(list(&root).expect("list").len(), 1);
    }

    #[test]
    fn anchored_sessions_count_what_a_removal_would_strand() {
        let root = repository();
        let tree = create(&root, "work").expect("create");
        let db = root.join("engine.db");
        let connection = rusqlite::Connection::open(&db).expect("db");
        connection
            .execute_batch("CREATE TABLE engine_location (session_id TEXT, root TEXT);")
            .expect("schema");
        assert_eq!(
            anchored_sessions(&db, Path::new(&tree.path)).expect("count"),
            0
        );
        connection
            .execute(
                "INSERT INTO engine_location VALUES ('ses_a', ?1), ('ses_b', ?2)",
                [tree.path.clone(), format!("{}/sub/dir", tree.path)],
            )
            .expect("insert");
        assert_eq!(
            anchored_sessions(&db, Path::new(&tree.path)).expect("count"),
            2,
            "a Session inside a subdirectory of the tree is still stranded by removing it"
        );
    }
}
