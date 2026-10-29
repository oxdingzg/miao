//! Read-only Git state for a Session's workspace (WSP-02 slice 1).
//!
//! One `git status --porcelain=v2 --branch` call answers "what changed here":
//! parsing machine-readable output keeps untracked, staged, renamed and
//! conflicted entries distinguishable, and `-z` keeps paths verbatim instead of
//! shell-quoted. Nothing here writes the index, takes a lock or touches the
//! network; `ahead`/`behind` come from the local `branch.ab` header.

use crate::{protocol::Error, store::Store};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::process::Command;

/// Most entries one status answer carries. A huge monorepo returns the count it
/// can prove and says so, rather than silently dropping the rest.
pub const MAX_STATUS_FILES: usize = 5_000;
/// Longest path kept verbatim; anything longer is a malformed record.
const MAX_PATH_CHARS: usize = 4_096;
/// `git status` is local and cheap, but a wedged filesystem or a git hook must
/// not hold the drain forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

impl Store {
    /// The Session's workspace Git state, or `{"repository": false}` when its
    /// location is not inside a repository. Absence is an answer, not an error.
    pub async fn vcs_status(&self, session: &str) -> Result<Value, Error> {
        let Some(root) = self.location(session).await? else {
            return Err(Error::Invalid("Session does not exist".into()));
        };
        status(&root, MAX_STATUS_FILES).await
    }
}

pub async fn status(root: &str, limit: usize) -> Result<Value, Error> {
    let output = tokio::time::timeout(
        GIT_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=normal",
                "-z",
            ])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| Error::Invalid("git status timed out".into()))?
    .map_err(|error| Error::Invalid(format!("git status could not run: {error}")))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr);
        let reason = reason.trim();
        // Outside a repository git refuses with a stable message; that is a
        // fact about the workspace, not a failure of the question.
        if reason.contains("not a git repository") {
            return Ok(json!({"repository": false, "root": root}));
        }
        return Err(Error::Invalid(format!("git status failed: {reason}")));
    }
    let mut parsed = parse(&output.stdout, limit);
    parsed["repository"] = json!(true);
    parsed["root"] = json!(root);
    Ok(parsed)
}

/// Parse `--porcelain=v2 --branch -z` output. Header records (`#`) carry the
/// branch; every other record is one changed path.
fn parse(bytes: &[u8], limit: usize) -> Value {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut branch = Value::Null;
    let mut detached = false;
    let mut upstream = Value::Null;
    let mut ahead: Option<u64> = None;
    let mut behind: Option<u64> = None;
    let mut files = Vec::new();
    let mut total = 0usize;
    while let Some(record) = records.next() {
        let Ok(record) = std::str::from_utf8(record) else {
            continue;
        };
        if let Some(header) = record.strip_prefix("# ") {
            let mut fields = header.splitn(2, ' ');
            match (fields.next(), fields.next()) {
                (Some("branch.head"), Some("(detached)")) => detached = true,
                (Some("branch.head"), Some(name)) => branch = json!(name),
                (Some("branch.upstream"), Some(name)) => upstream = json!(name),
                (Some("branch.ab"), Some(counts)) => {
                    let mut counts = counts.split_whitespace();
                    ahead = counts
                        .next()
                        .and_then(|count| count.strip_prefix('+'))
                        .and_then(|count| count.parse().ok());
                    behind = counts
                        .next()
                        .and_then(|count| count.strip_prefix('-'))
                        .and_then(|count| count.parse().ok());
                }
                _ => {}
            }
            continue;
        }
        // A rename or copy record carries its original path as the next
        // NUL-separated field, which is why the whole output is read as records.
        let (entry, original) = match record.split_once(' ') {
            Some(("1", rest)) => (ordinary(rest, 7), None),
            Some(("2", rest)) => {
                let entry = ordinary(rest, 8);
                let original = records
                    .next()
                    .and_then(|path| std::str::from_utf8(path).ok());
                (entry, original)
            }
            Some(("u", rest)) => (ordinary(rest, 9), None),
            Some(("?", path)) => (untracked(path), None),
            _ => continue,
        };
        let Some((index, worktree, path)) = entry else {
            continue;
        };
        total += 1;
        if files.len() >= limit {
            continue;
        }
        files.push(json!({
            "path": bounded(path),
            "original_path": original.map(bounded),
            "index": index.to_string(),
            "worktree": worktree.to_string(),
            "kind": kind(index, worktree),
        }));
    }
    let mut value = json!({
        "branch": branch,
        "detached": detected_branch(detached, &branch),
        "upstream": upstream,
        "files": files,
        "file_count": total,
        "truncated": total > limit,
    });
    if let (Some(ahead), Some(behind)) = (ahead, behind) {
        value["ahead"] = json!(ahead);
        value["behind"] = json!(behind);
    }
    value
}

/// `branch.head (detached)` is the only source of detachment; a repository
/// with no commits yet reports `(initial)`, which is not detached.
fn detected_branch(detached: bool, branch: &Value) -> bool {
    detached && branch.is_null()
}

/// An ordinary/renamed/unmerged record: `XY` then a fixed number of metadata
/// fields, then the path. The three record types carry different metadata
/// widths, so the caller names where the path starts.
fn ordinary(rest: &str, path_at: usize) -> Option<(char, char, &str)> {
    let mut chars = rest.split(' ').next()?.chars();
    let index = chars.next()?;
    let worktree = chars.next()?;
    // The path is everything after the fixed prefix; it may contain spaces
    // itself, so split at the prefix instead of at the end.
    let path = rest.splitn(path_at + 1, ' ').nth(path_at)?;
    Some((index, worktree, path))
}

fn untracked(path: &str) -> Option<(char, char, &str)> {
    Some(('.', '?', path))
}

/// The display classification of one XY pair. `kind` answers "what happened to
/// this file"; the raw XY columns stay available for staged-vs-worktree detail.
fn kind(index: char, worktree: char) -> &'static str {
    let xy = [index, worktree];
    if worktree == '?' {
        return "untracked";
    }
    if xy.contains(&'U') {
        return "conflicted";
    }
    if xy.contains(&'R') {
        return "renamed";
    }
    if xy.contains(&'C') {
        return "copied";
    }
    if xy.contains(&'A') {
        return "added";
    }
    if xy.contains(&'D') {
        return "deleted";
    }
    if xy.contains(&'T') {
        return "type-changed";
    }
    if xy.contains(&'M') {
        return "modified";
    }
    "changed"
}

/// A path is bounded by characters, not bytes, so a non-ASCII name cannot be
/// cut mid-character.
fn bounded(path: &str) -> String {
    if path.chars().count() <= MAX_PATH_CHARS {
        return path.to_owned();
    }
    path.chars().take(MAX_PATH_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xy_pairs_map_to_display_kinds() {
        for (index, worktree, expected) in [
            ('.', '?', "untracked"),
            ('U', 'U', "conflicted"),
            ('A', 'U', "conflicted"),
            ('R', '.', "renamed"),
            ('.', 'R', "renamed"),
            ('A', '.', "added"),
            ('.', 'D', "deleted"),
            ('M', '.', "modified"),
            ('.', 'M', "modified"),
            ('T', '.', "type-changed"),
            ('C', '.', "copied"),
            ('X', 'Y', "changed"),
        ] {
            assert_eq!(kind(index, worktree), expected, "{index}{worktree}");
        }
    }

    #[test]
    fn a_rename_record_consumes_its_original_path() {
        let output = b"# branch.head main\0# branch.oid abc\0\
            2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.rs\0src/old name.rs\0\
            1 .M N... 100644 100644 100644 aaaa aaaa src/modified.rs\0";
        let parsed = parse(output, 10);
        assert_eq!(parsed["branch"], "main");
        assert_eq!(parsed["file_count"], 2);
        assert_eq!(parsed["files"][0]["path"], "src/new name.rs");
        assert_eq!(parsed["files"][0]["original_path"], "src/old name.rs");
        assert_eq!(parsed["files"][0]["kind"], "renamed");
        assert_eq!(parsed["files"][1]["path"], "src/modified.rs");
        assert_eq!(parsed["files"][1]["index"], ".");
        assert_eq!(parsed["files"][1]["worktree"], "M");
        assert!(parsed["ahead"].is_null(), "{parsed}");
    }

    #[test]
    fn an_unmerged_record_keeps_its_wide_prefix_out_of_the_path() {
        let output = b"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.rs\0";
        let parsed = parse(output, 10);
        assert_eq!(parsed["files"][0]["path"], "src/conflict.rs");
        assert_eq!(parsed["files"][0]["index"], "U");
        assert_eq!(parsed["files"][0]["kind"], "conflicted");
    }

    #[test]
    fn a_bounded_answer_says_how_many_entries_it_left_out() {
        let output = b"? a\0? b\0? c\0";
        let parsed = parse(output, 2);
        assert_eq!(parsed["files"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["file_count"], 3);
        assert_eq!(parsed["truncated"], true);
        let exact = parse(output, 3);
        assert_eq!(exact["truncated"], false);
    }

    #[test]
    fn upstream_counters_and_detachment_come_from_the_headers() {
        let output =
            b"# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +2 -1\0";
        let parsed = parse(output, 10);
        assert_eq!(parsed["upstream"], "origin/feature");
        assert_eq!(parsed["ahead"], 2);
        assert_eq!(parsed["behind"], 1);
        assert_eq!(parsed["detached"], false);

        let detached = parse(b"# branch.head (detached)\0", 10);
        assert_eq!(detached["branch"], Value::Null);
        assert_eq!(detached["detached"], true);

        // A repository without commits is initial, not detached.
        let initial = parse(b"# branch.head (initial)\0", 10);
        assert_eq!(initial["branch"], "(initial)");
        assert_eq!(initial["detached"], false);
    }
}
