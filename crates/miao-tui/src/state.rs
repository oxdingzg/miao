//! Small state for the TUI's own files: composer history and preferences.
//!
//! Everything here lives outside the workspace and outside the engine: losing
//! it must only cost convenience, never Session data.

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// `MIAO_TUI_STATE_DIR` first (tests and channel isolation), then the XDG data
/// directory, then the plain home fallback.
pub fn dir() -> PathBuf {
    std::env::var_os("MIAO_TUI_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_DATA_HOME").map(|base| PathBuf::from(base).join("miao-tui"))
        })
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/miao-tui"))
        })
        .unwrap_or_else(|| PathBuf::from(".miao-tui-state"))
}

pub fn file(name: &str) -> PathBuf {
    dir().join(name)
}

pub fn read_json<T: DeserializeOwned>(name: &str) -> Option<T> {
    let text = std::fs::read_to_string(file(name)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_json<T: Serialize>(name: &str, value: &T) {
    let path = file(name);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(value) {
        let _ = std::fs::write(path, text);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(default)]
    pub theme: Option<String>,
}

pub fn preferences() -> Preferences {
    read_json("preferences.json").unwrap_or_default()
}

pub fn save_theme(name: &str) {
    let mut prefs = preferences();
    prefs.theme = Some(name.to_string());
    write_json("preferences.json", &prefs);
}

/// A prompt the operator set aside. Stash lives only in the TUI's own state
/// directory: losing it must never cost Session data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StashEntry {
    pub text: String,
    pub saved_at_ms: u64,
}

const STASH_LIMIT: usize = 50;

pub fn stash() -> Vec<StashEntry> {
    let mut entries: Vec<StashEntry> = read_json("stash.json").unwrap_or_default();
    entries.truncate(STASH_LIMIT);
    entries
}

pub fn save_stash(entries: &[StashEntry]) {
    write_json("stash.json", &entries.to_vec());
}

/// Put one prompt at the top of the list. Stashing the same text twice moves
/// the existing entry instead of duplicating it.
pub fn stash_push(text: &str) -> Vec<StashEntry> {
    let mut entries = stash();
    push_entry(&mut entries, text, now_ms());
    save_stash(&entries);
    entries
}

pub fn stash_remove(index: usize) -> Vec<StashEntry> {
    let mut entries = stash();
    remove_entry(&mut entries, index);
    save_stash(&entries);
    entries
}

fn push_entry(entries: &mut Vec<StashEntry>, text: &str, now: u64) {
    entries.retain(|entry| entry.text != text);
    entries.insert(
        0,
        StashEntry {
            text: text.to_string(),
            saved_at_ms: now,
        },
    );
    entries.truncate(STASH_LIMIT);
}

fn remove_entry(entries: &mut Vec<StashEntry>, index: usize) {
    if index < entries.len() {
        entries.remove(index);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushing_moves_an_existing_prompt_to_the_top() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "first", 1);
        push_entry(&mut entries, "second", 2);
        push_entry(&mut entries, "first", 3);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "first");
        assert_eq!(entries[0].saved_at_ms, 3);
    }

    #[test]
    fn the_stash_keeps_at_most_fifty_prompts() {
        let mut entries = Vec::new();
        for index in 0..60 {
            push_entry(&mut entries, &format!("prompt {index}"), index as u64);
        }
        assert_eq!(entries.len(), STASH_LIMIT);
        assert_eq!(entries[0].text, "prompt 59");
    }

    #[test]
    fn removing_an_out_of_range_index_is_a_no_op() {
        let mut entries = vec![StashEntry {
            text: "only".into(),
            saved_at_ms: 1,
        }];
        remove_entry(&mut entries, 9);
        assert_eq!(entries.len(), 1);
        remove_entry(&mut entries, 0);
        assert!(entries.is_empty());
    }
}
