//! The git worktrees the engine manages for one checkout.
//!
//! The engine owns the git plumbing (`worktrees`, `worktree_create`,
//! `worktree_remove`); this module only turns its answers into the rows a dialog
//! paints, so the TUI never runs git itself.
use serde_json::Value;

/// One worktree, as the engine reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    /// The single path component the tree is named by.
    pub name: String,
    /// The canonical path a Session's Location would be keyed by.
    pub path: String,
    /// The branch git checked out, when it names one.
    pub branch: Option<String>,
    /// The checkout the others were added from. A removal should refuse it.
    pub main: bool,
}

impl Worktree {
    /// What the row reads: the tree's own name, or the checkout it belongs to.
    pub fn label(&self) -> String {
        if self.main {
            return "checkout".to_string();
        }
        self.name.clone()
    }

    /// The muted half: where the tree is. It stays a bare path because the
    /// dialog hands it to `move_session` when the operator chooses the row.
    pub fn detail(&self) -> String {
        self.path.clone()
    }
}

/// The trees in one engine answer, in the order the engine listed them, which
/// keeps the checkout first.
pub fn decode(value: &Value) -> Vec<Worktree> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(Worktree {
                        name: entry.get("name")?.as_str()?.to_string(),
                        path: entry.get("path")?.as_str()?.to_string(),
                        branch: entry
                            .get("branch")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        main: entry.get("main").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkout_keeps_its_own_label_and_a_tree_names_itself() {
        let trees = decode(&serde_json::json!([
            {"name": "miao", "path": "/repo", "branch": "main", "main": true},
            {"name": "work", "path": "/repo/.miao-worktrees/work", "branch": "work", "main": false},
            {"name": "detached", "path": "/tmp/detached", "main": false}
        ]));
        assert_eq!(trees.len(), 3);
        assert_eq!(trees[0].label(), "checkout");
        assert_eq!(trees[0].detail(), "/repo");
        assert_eq!(trees[1].label(), "work");
        assert_eq!(trees[1].detail(), "/repo/.miao-worktrees/work");
        assert_eq!(trees[2].detail(), "/tmp/detached");
    }

    #[test]
    fn an_answer_that_is_not_a_list_lists_nothing() {
        assert!(decode(&serde_json::json!({})).is_empty());
    }
}
