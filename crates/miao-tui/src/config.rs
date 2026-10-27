//! TUI settings read from `tui.json` files.
//!
//! Only the `attention` section is consumed here; the theme has its own parser
//! but reads the same files, so `files` lives here. The order matches the
//! TypeScript host: global config, `MIAO_TUI_CONFIG`, then the project's
//! `.miao/tui.json` files from the workspace root downwards, so the closest
//! file wins.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct AttentionConfig {
    pub enabled: bool,
    pub notifications: bool,
    pub sound: bool,
    pub volume: f32,
    /// Sound name to file path, already resolved against the config's folder.
    pub sounds: BTreeMap<String, String>,
}

impl Default for AttentionConfig {
    fn default() -> Self {
        Self {
            // Off by default: an unconfigured terminal must stay silent.
            enabled: false,
            notifications: true,
            sound: true,
            volume: 0.4,
            sounds: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Config {
    pub attention: AttentionConfig,
}

pub const SOUND_NAMES: &[&str] = &[
    "default",
    "question",
    "permission",
    "error",
    "done",
    "subagent_done",
];

pub fn load(workspace: &Path) -> (Config, Vec<String>) {
    let mut warnings = Vec::new();
    let mut config = Config::default();
    for path in files(workspace, global_dir().as_deref()) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            merge(&text, &path, &mut config, &mut warnings);
        }
    }
    (config, warnings)
}

/// The `tui.json` files the TypeScript host merges, lowest precedence first:
/// the global config directory, `MIAO_TUI_CONFIG`, then the project's `.miao`
/// files from the workspace root downwards so the closest file wins.
pub(crate) fn files(workspace: &Path, global: Option<&Path>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(dir) = global {
        let candidate = dir.join("tui.json");
        if candidate.is_file() {
            files.push(candidate);
        }
    }
    if let Some(path) = std::env::var_os("MIAO_TUI_CONFIG") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            files.push(candidate);
        }
    }
    let mut project = Vec::new();
    let mut dir = Some(workspace);
    while let Some(current) = dir {
        let candidate = current.join(".miao").join("tui.json");
        if candidate.is_file() {
            project.push(candidate);
        }
        dir = current.parent();
    }
    project.reverse();
    files.extend(project);
    files
}

/// The product's configuration directory: the same answer
/// `Global.Path.config` gives the TypeScript host.
pub fn global_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MIAO_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Some(base) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(base).join("miao"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
}

fn merge(text: &str, path: &Path, config: &mut Config, warnings: &mut Vec<String>) {
    let value: serde_json::Value = match serde_json::from_str(&crate::theme::strip_jsonc(text)) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!(
                "skipping invalid tui config {}: {error}",
                path.display()
            ));
            return;
        }
    };
    let Some(attention) = value.get("attention") else {
        return;
    };
    let Some(attention) = attention.as_object() else {
        warnings.push(format!(
            "tui config {}: attention must be an object, ignoring",
            path.display()
        ));
        return;
    };
    let base = path.parent().unwrap_or(Path::new("."));
    for (key, value) in attention {
        match key.as_str() {
            "enabled" => set_flag(
                value,
                "enabled",
                &mut config.attention.enabled,
                path,
                warnings,
            ),
            "notifications" => set_flag(
                value,
                "notifications",
                &mut config.attention.notifications,
                path,
                warnings,
            ),
            "sound" => set_flag(value, "sound", &mut config.attention.sound, path, warnings),
            "volume" => match value.as_f64() {
                Some(volume) if (0.0..=1.0).contains(&volume) => {
                    config.attention.volume = volume as f32;
                }
                _ => warnings.push(format!(
                    "tui config {}: attention.volume must be between 0 and 1, ignoring",
                    path.display()
                )),
            },
            "sound_pack" => {
                // The Rust binary ships no built-in packs; a configured pack id
                // only matters to the TypeScript plugin host.
            }
            "sounds" => merge_sounds(value, base, config, path, warnings),
            other => warnings.push(format!(
                "tui config {}: ignoring unsupported attention field \"{other}\"",
                path.display()
            )),
        }
    }
}

fn set_flag(
    value: &serde_json::Value,
    name: &str,
    target: &mut bool,
    path: &Path,
    warnings: &mut Vec<String>,
) {
    match value.as_bool() {
        Some(flag) => *target = flag,
        None => warnings.push(format!(
            "tui config {}: attention.{name} must be a boolean, ignoring",
            path.display()
        )),
    }
}

fn merge_sounds(
    value: &serde_json::Value,
    base: &Path,
    config: &mut Config,
    path: &Path,
    warnings: &mut Vec<String>,
) {
    let Some(sounds) = value.as_object() else {
        warnings.push(format!(
            "tui config {}: attention.sounds must be an object, ignoring",
            path.display()
        ));
        return;
    };
    for (name, sound) in sounds {
        if !SOUND_NAMES.contains(&name.as_str()) {
            warnings.push(format!(
                "tui config {}: ignoring unknown sound \"{name}\"",
                path.display()
            ));
            continue;
        }
        let Some(sound) = sound.as_str().filter(|sound| !sound.trim().is_empty()) else {
            warnings.push(format!(
                "tui config {}: attention.sounds.{name} must be a path, ignoring",
                path.display()
            ));
            continue;
        };
        let resolved = Path::new(sound);
        let resolved = if resolved.is_absolute() {
            resolved.to_path_buf()
        } else {
            base.join(resolved)
        };
        config
            .attention
            .sounds
            .insert(name.clone(), resolved.to_string_lossy().into_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merge_at(text: &str, dir: &Path) -> (Config, Vec<String>) {
        let mut config = Config::default();
        let mut warnings = Vec::new();
        let path = dir.join("tui.json");
        merge(text, &path, &mut config, &mut warnings);
        (config, warnings)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_match_the_typescript_host() {
        let config = AttentionConfig::default();
        assert!(!config.enabled);
        assert!(config.notifications);
        assert!(config.sound);
        assert_eq!(config.volume, 0.4);
        assert!(config.sounds.is_empty());
    }

    #[test]
    fn attention_fields_merge_and_sounds_resolve_relative_to_the_file() {
        let dir = temp_dir("merge");
        let (config, warnings) = merge_at(
            r#"{
                "attention": {
                    "enabled": true,
                    "notifications": false,
                    "sound": false,
                    "volume": 0.25,
                    "sound_pack": "custom",
                    "sounds": { "done": "sounds/done.mp3", "error": "/tmp/error.wav" }
                }
            }"#,
            &dir,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(config.attention.enabled);
        assert!(!config.attention.notifications);
        assert!(!config.attention.sound);
        assert_eq!(config.attention.volume, 0.25);
        assert_eq!(
            config.attention.sounds.get("done").map(String::as_str),
            Some(dir.join("sounds/done.mp3").to_string_lossy().as_ref())
        );
        assert_eq!(
            config.attention.sounds.get("error").map(String::as_str),
            Some("/tmp/error.wav")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_values_warn_but_keep_the_previous_setting() {
        let dir = temp_dir("invalid");
        let (config, warnings) = merge_at(
            r#"{"attention": {"volume": 2, "sound": "yes", "sounds": { "nope": "x", "done": 3 }}}"#,
            &dir,
        );
        assert_eq!(config.attention.volume, 0.4);
        assert!(config.attention.sound);
        assert_eq!(warnings.len(), 4, "{warnings:?}");
        assert!(warnings.iter().any(|warning| warning.contains("volume")));
        assert!(warnings.iter().any(|warning| warning.contains("nope")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_is_skipped_without_touching_the_defaults() {
        let dir = temp_dir("broken");
        let (config, warnings) = merge_at("{ not json", &dir);
        assert_eq!(config, Config::default());
        assert_eq!(warnings.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_files_apply_root_first_and_closer_files_win() {
        let dir = temp_dir("chain");
        let nested = dir.join("a").join("b");
        std::fs::create_dir_all(dir.join(".miao")).unwrap();
        std::fs::create_dir_all(nested.join(".miao")).unwrap();
        // Keep the developer's own global config out of this assertion.
        std::env::set_var("MIAO_CONFIG_DIR", dir.join("global"));
        std::fs::write(
            dir.join(".miao").join("tui.json"),
            r#"{"attention": {"enabled": true, "volume": 0.1}}"#,
        )
        .unwrap();
        std::fs::write(
            nested.join(".miao").join("tui.json"),
            r#"{"attention": {"volume": 0.9}}"#,
        )
        .unwrap();
        let (config, warnings) = load(&nested);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(config.attention.enabled);
        assert_eq!(config.attention.volume, 0.9);
        std::env::remove_var("MIAO_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
