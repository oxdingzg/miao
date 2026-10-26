//! Diffs a host renders for a committed file mutation.
//!
//! The model already wrote the text it asked for, so a patch inside the tool
//! result would only duplicate it in context. A mutation reports these diffs
//! under `_display`, and `Store::tool_result` moves that block into the
//! `tool.completed` event before the result is serialized for the model: the
//! host sees the patch, the model never pays for it.

use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

/// One file's display entry, or `None` when the text did not change.
///
/// `path` is workspace-relative and `action` is `create`, `update` or `delete`.
/// The patch carries the same `Index:`/`---`/`+++`/`@@` shape the product's own
/// edit tool emits, because the host feeds both into one renderer.
pub fn file(before: &str, after: &str, path: &str, action: &str) -> Option<Value> {
    let diff = TextDiff::from_lines(before, after);
    let (additions, deletions) = diff
        .iter_all_changes()
        .fold((0u32, 0u32), |counts, change| match change.tag() {
            ChangeTag::Insert => (counts.0 + 1, counts.1),
            ChangeTag::Delete => (counts.0, counts.1 + 1),
            ChangeTag::Equal => counts,
        });
    if additions == 0 && deletions == 0 {
        return None;
    }
    let mut unified = diff.unified_diff();
    unified.context_radius(3);
    Some(json!({
        "path": path,
        "action": action,
        "patch": format!(
            "Index: {path}\n{separator}\n--- {path}\n+++ {path}\n{hunks}",
            separator = "=".repeat(67),
            hunks = unified.to_string(),
        ),
        "additions": additions,
        "deletions": deletions,
    }))
}

/// The `_display` block for one or more committed files.
pub fn files(entries: Vec<Value>) -> Value {
    json!({ "files": entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_file_carries_counts_and_a_renderable_patch() {
        let entry = file("one\ntwo\nthree\n", "one\nTWO\nthree\n", "a.txt", "update").unwrap();
        assert_eq!(entry["path"], json!("a.txt"));
        assert_eq!(entry["action"], json!("update"));
        assert_eq!(entry["additions"], json!(1));
        assert_eq!(entry["deletions"], json!(1));
        // The product's own edit tool emits this header, and the host feeds
        // both into one diff renderer.
        let patch = entry["patch"].as_str().unwrap();
        assert!(patch.starts_with("Index: a.txt\n"));
        assert!(patch.contains(&"=".repeat(67)));
        assert!(patch.contains("--- a.txt\n+++ a.txt\n"));
        assert!(patch.contains("@@ -1,3 +1,3 @@"));
        assert!(patch.contains("-two\n+TWO\n"));
    }

    #[test]
    fn an_unchanged_file_has_no_entry() {
        assert!(file("same\n", "same\n", "a.txt", "update").is_none());
    }

    #[test]
    fn a_created_file_is_all_additions() {
        let entry = file("", "first\nsecond\n", "b.txt", "create").unwrap();
        assert_eq!(entry["additions"], json!(2));
        assert_eq!(entry["deletions"], json!(0));
    }

    #[test]
    fn a_deleted_file_is_all_deletions() {
        let entry = file("first\nsecond\n", "", "c.txt", "delete").unwrap();
        assert_eq!(entry["additions"], json!(0));
        assert_eq!(entry["deletions"], json!(2));
    }
}
