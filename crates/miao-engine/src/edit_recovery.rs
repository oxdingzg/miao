//! Stale-edit recovery (snapshot rebase), ported from the TypeScript edit tool.
//!
//! Models edit the file they last read. When the file has drifted since that
//! read, `old_string` no longer occurs in the current text and the edit fails
//! with a stale fingerprint, costing the model a full re-read turn for an edit
//! whose intent is clear. Recovery relocates `old_string` in the file the model
//! actually saw, proves the target position with exact, unique context anchors
//! in the current file, and replaces the bounded region strictly between them.
//!
//! Unlike the TypeScript original, a context line that occurs once but not as a
//! whole line is skipped instead of producing a bogus line index; the position
//! is never guessed (invariant I2).

use std::collections::{HashMap, VecDeque};

const MAX_CONTEXT_LINES: isize = 3;
const MAX_REGION_SLACK: usize = 8;
const MAX_FILES: usize = 24;
const MAX_CHARS: usize = 512 * 1024;

pub(crate) enum Refusal {
    Ambiguous,
    Unanchored,
    Disproportionate,
}

impl Refusal {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Refusal::Ambiguous => "ambiguous",
            Refusal::Unanchored => "unanchored",
            Refusal::Disproportionate => "disproportionate",
        }
    }
}

pub(crate) enum Recovery {
    Recovered { replaced: String, note: String },
    Refused(Refusal),
    Inapplicable,
}

/// One recovery attempt. Runs only after the exact matcher failed, so every
/// outcome except `Recovered` leaves the previous failure unchanged.
pub(crate) fn recover(
    snapshot: &str,
    current: &str,
    old_string: &str,
    new_string: &str,
) -> Recovery {
    if old_string.is_empty() || current.contains(old_string) {
        return Recovery::Inapplicable;
    }
    let occurrences = count_occurrences(snapshot, old_string);
    if occurrences == 0 {
        return Recovery::Inapplicable;
    }
    if occurrences > 1 {
        return Recovery::Refused(Refusal::Ambiguous);
    }
    let snapshot_lines: Vec<&str> = snapshot.split('\n').collect();
    let current_lines: Vec<&str> = current.split('\n').collect();
    let first = snapshot.find(old_string).expect("one occurrence");
    let block_start = snapshot[..first].matches('\n').count();
    let block_end = block_start + old_string.matches('\n').count();

    let above = anchor(
        &snapshot_lines,
        &current_lines,
        block_start as isize - 1,
        -1,
    );
    let below = anchor(&snapshot_lines, &current_lines, block_end as isize + 1, 1);
    if above.is_none() && below.is_none() {
        return Recovery::Refused(Refusal::Unanchored);
    }
    let from = above.map(|line| line + 1).unwrap_or(0);
    let to = below.unwrap_or(current_lines.len());
    let block_lines = block_end - block_start + 1;
    if to.saturating_sub(from) > block_lines + MAX_REGION_SLACK {
        return Recovery::Refused(Refusal::Disproportionate);
    }

    let mut replaced_lines = current_lines[..from].to_vec();
    replaced_lines.extend(new_string.split('\n'));
    replaced_lines.extend_from_slice(&current_lines[to..]);
    let replaced = replaced_lines.join("\n");
    if replaced == current {
        return Recovery::Inapplicable;
    }
    let relocated = if above.is_none() {
        "above the end of the file"
    } else if below.is_none() {
        "below the start of the file"
    } else {
        "between unchanged context lines"
    };
    Recovery::Recovered {
        replaced,
        note: format!(
            "The file had drifted since the last read, so oldString was relocated {relocated} and the edit was rebased onto the current content. The diff shows everything the rebase applied, including drift it replaced."
        ),
    }
}

/// Nearest non-empty snapshot line within reach that occurs exactly once in the
/// current text, as a line index in the current text.
fn anchor(
    snapshot_lines: &[&str],
    current_lines: &[&str],
    start: isize,
    step: isize,
) -> Option<usize> {
    let current = current_lines.join("\n");
    let mut line = start;
    while line >= 0
        && (line as usize) < snapshot_lines.len()
        && (start - line).abs() < MAX_CONTEXT_LINES
    {
        let text = snapshot_lines[line as usize];
        if !text.trim().is_empty() && count_occurrences(&current, text) == 1 {
            if let Some(index) = current_lines.iter().position(|entry| *entry == text) {
                return Some(index);
            }
        }
        line += step;
    }
    None
}

fn count_occurrences(text: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    text.match_indices(needle).count()
}

/// Location-scoped LRU of the text the model last saw per file: 24 files,
/// 512 KiB each, same bounds as the TypeScript implementation.
pub(crate) struct Snapshots {
    files: HashMap<String, String>,
    order: VecDeque<String>,
}

impl Snapshots {
    pub(crate) fn new() -> Self {
        Self {
            files: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub(crate) fn register(&mut self, file: String, text: String) {
        if text.len() > MAX_CHARS {
            return;
        }
        self.files.remove(&file);
        self.order.retain(|entry| entry != &file);
        self.order.push_back(file.clone());
        self.files.insert(file, text);
        while self.order.len() > MAX_FILES {
            if let Some(oldest) = self.order.pop_front() {
                self.files.remove(&oldest);
            }
        }
    }

    pub(crate) fn lookup(&self, file: &str) -> Option<&str> {
        self.files.get(file).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovered(outcome: Recovery) -> (String, String) {
        match outcome {
            Recovery::Recovered { replaced, note } => (replaced, note),
            _ => panic!("expected recovery"),
        }
    }

    #[test]
    fn recovers_drift_below_the_block() {
        // The external write renamed the block, so the matcher already failed.
        let snapshot = "alpha\nbeta\ngamma\n";
        let current = "alpha\nrenamed\ngamma\ninserted\n";
        let (replaced, note) = recovered(recover(snapshot, current, "beta", "BETA"));
        assert_eq!(replaced, "alpha\nBETA\ngamma\ninserted\n");
        assert!(note.contains("rebased"));
    }

    #[test]
    fn recovers_drift_above_the_block() {
        let snapshot = "alpha\nbeta\ngamma\n";
        let current = "inserted\nalpha\nrenamed\ngamma\n";
        let (replaced, _) = recovered(recover(snapshot, current, "beta", "BETA"));
        assert_eq!(replaced, "inserted\nalpha\nBETA\ngamma\n");
    }

    #[test]
    fn recovers_against_a_file_boundary() {
        // Only the line above the block is a unique anchor, so the bounded
        // region runs to the end of the file and the drift inside it is
        // replaced -- the same region rule the TypeScript recovery applies.
        let snapshot = "alpha\nbeta";
        let current = "alpha\nrenamed\nx";
        let (replaced, note) = recovered(recover(snapshot, current, "beta", "BETA"));
        assert_eq!(replaced, "alpha\nBETA");
        assert!(note.contains("start of the file"));

        // The block on the first line leaves only a below anchor, so the
        // region starts at the top of the file.
        let (replaced, note) = recovered(recover(
            "beta\nalpha\n",
            "renamed\nalpha\nx\n",
            "beta",
            "BETA",
        ));
        assert_eq!(replaced, "BETA\nalpha\nx\n");
        assert!(note.contains("end of the file"));
    }

    #[test]
    fn refuses_ambiguous_snapshot_occurrences() {
        let outcome = recover("x\nrun\nx\nrun\n", "x\ndone\nx\ndone\n", "run", "RUN");
        assert!(matches!(outcome, Recovery::Refused(Refusal::Ambiguous)));
    }

    #[test]
    fn refuses_without_a_unique_anchor() {
        let outcome = recover("x\ntarget\nx\n", "x\nthing\nx\nmore\n", "target", "TARGET");
        assert!(matches!(outcome, Recovery::Refused(Refusal::Unanchored)));
    }

    #[test]
    fn refuses_a_disproportionate_region() {
        let snapshot = "anchor\ntarget\nanchor2\n";
        let current =
            "anchor\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\nanchor2\n";
        let outcome = recover(snapshot, current, "target", "TARGET");
        assert!(matches!(
            outcome,
            Recovery::Refused(Refusal::Disproportionate)
        ));
    }

    #[test]
    fn stays_inapplicable_when_the_matcher_was_right() {
        // The matcher still finds old_string: recovery must not apply.
        assert!(matches!(
            recover("alpha\nbeta\n", "alpha\nbeta\n", "beta", "BETA"),
            Recovery::Inapplicable
        ));
        // The recovered text would equal the current text: nothing to do.
        assert!(matches!(
            recover("run\nx\n", "done\nx\n", "run", "done"),
            Recovery::Inapplicable
        ));
        assert!(matches!(
            recover("", "anything\n", "", "x"),
            Recovery::Inapplicable
        ));
    }

    #[test]
    fn snapshots_evict_beyond_the_file_bound() {
        let mut snapshots = Snapshots::new();
        for index in 0..MAX_FILES + 1 {
            snapshots.register(format!("file-{index}"), format!("contents {index}"));
        }
        assert!(snapshots.lookup("file-0").is_none());
        assert!(snapshots.lookup(&format!("file-{MAX_FILES}")).is_some());
        snapshots.register("file-1".into(), "rewritten".into());
        assert_eq!(snapshots.lookup("file-1"), Some("rewritten"));
    }

    #[test]
    fn snapshots_ignore_oversized_text() {
        let mut snapshots = Snapshots::new();
        snapshots.register("big".into(), "x".repeat(MAX_CHARS + 1));
        assert!(snapshots.lookup("big").is_none());
    }
}
