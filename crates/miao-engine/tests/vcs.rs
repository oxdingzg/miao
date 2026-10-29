//! WSP-02 slice 1: the engine answers "what changed in this workspace" from a
//! real repository, not from a stubbed git.
use miao_engine::{store::Store, vcs};
use std::{path::Path, process::Command};

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(["-c", "user.email=test@example.com", "-c", "user.name=Test"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn write(root: &Path, name: &str, text: &str) {
    std::fs::write(root.join(name), text).unwrap();
}

fn kinds(status: &serde_json::Value) -> Vec<(String, String)> {
    status["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            (
                file["path"].as_str().unwrap().to_owned(),
                file["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_directory_outside_a_repository_is_an_answer_not_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let status = vcs::status(dir.path().to_str().unwrap(), 10).await.unwrap();
    assert_eq!(status["repository"], false);
    assert_eq!(status["root"], dir.path().to_str().unwrap());
    assert!(status.get("files").is_none(), "{status}");
}

#[tokio::test]
async fn staged_unstaged_untracked_and_renamed_entries_stay_distinguishable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-b", "main"]);
    write(root, "a.txt", "one\n");
    write(root, "c.txt", "three\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "first"]);

    write(root, "b.txt", "two\n");
    git(root, &["add", "b.txt"]);
    write(root, "a.txt", "one\nchanged\n");
    git(root, &["mv", "c.txt", "d.txt"]);
    write(root, "notes.md", "notes\n");

    let status = vcs::status(root.to_str().unwrap(), 100).await.unwrap();
    assert_eq!(status["repository"], true);
    assert_eq!(status["branch"], "main");
    assert_eq!(status["detached"], false);
    assert_eq!(status["file_count"], 4, "{status}");
    assert_eq!(status["truncated"], false);
    assert_eq!(
        kinds(&status),
        vec![
            ("a.txt".to_owned(), "modified".to_owned()),
            ("b.txt".to_owned(), "added".to_owned()),
            ("d.txt".to_owned(), "renamed".to_owned()),
            ("notes.md".to_owned(), "untracked".to_owned()),
        ],
        "{status}"
    );
    // The raw columns still say which side carries the change.
    let modified = &status["files"][0];
    assert_eq!(modified["index"], ".");
    assert_eq!(modified["worktree"], "M");
    let renamed = &status["files"][2];
    assert_eq!(renamed["original_path"], "c.txt");
    let untracked = &status["files"][3];
    assert_eq!(untracked["index"], ".");
    assert_eq!(untracked["worktree"], "?");
    // No upstream configured, so no divergence is claimed.
    assert!(status.get("ahead").is_none(), "{status}");
}

#[tokio::test]
async fn divergence_comes_from_the_local_branch_header() {
    let dir = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    git(root, &["init", "-b", "main"]);
    write(root, "a.txt", "one\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "first"]);
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(root, &["push", "-u", "origin", "main"]);
    write(root, "a.txt", "one\ntwo\n");
    git(root, &["commit", "-am", "second"]);

    let status = vcs::status(root.to_str().unwrap(), 100).await.unwrap();
    assert_eq!(status["upstream"], "origin/main");
    assert_eq!(status["ahead"], 1);
    assert_eq!(status["behind"], 0);
}

#[tokio::test]
async fn a_large_workspace_says_how_many_entries_it_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-b", "main"]);
    for name in ["one.txt", "two.txt", "three.txt"] {
        write(root, name, "x\n");
    }
    let status = vcs::status(root.to_str().unwrap(), 2).await.unwrap();
    assert_eq!(status["files"].as_array().unwrap().len(), 2);
    assert_eq!(status["file_count"], 3);
    assert_eq!(status["truncated"], true);
}

#[tokio::test]
async fn the_store_reads_the_status_of_the_session_location() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-b", "main"]);
    write(root, "a.txt", "one\n");
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("s", "session", root.to_str().unwrap())
        .await
        .unwrap();
    let status = store.vcs_status("s").await.unwrap();
    assert_eq!(status["repository"], true);
    assert_eq!(status["root"], root.to_str().unwrap());
    assert_eq!(status["files"][0]["kind"], "untracked");
    // A Session nobody initialized has no location to inspect.
    assert!(store.vcs_status("missing").await.is_err());
}
