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
