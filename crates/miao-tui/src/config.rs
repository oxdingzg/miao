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

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub attention: AttentionConfig,
    /// Capture mouse input for wheel scrolling. Defaults to on, like the
    /// TypeScript host.
    pub mouse: bool,
    /// Rows one wheel notch moves the transcript. The TypeScript host calls this
    /// `scroll_speed` and defaults it to 3.
    pub scroll_speed: f64,
    /// `scroll_acceleration.enabled`: multiply the speed for notches that arrive
    /// in a burst. The TypeScript host uses a trackpad model; here a burst is a
    /// run of notches inside the same short window.
    pub scroll_acceleration: bool,
    /// `None` leaves the terminal's own cursor shape alone.
    pub cursor: Option<Cursor>,
    /// `keybinds` entries, flattened to action name → strokes. `None` means the
    /// action was explicitly unbound (`false` or `"none"`).
    pub keybinds: BTreeMap<String, Option<Vec<String>>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            attention: AttentionConfig::default(),
            mouse: true,
            scroll_speed: 3.0,
            scroll_acceleration: false,
            cursor: None,
            keybinds: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CursorShape {
    Default,
    #[default]
    Block,
    Underline,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cursor {
    pub style: Option<CursorShape>,
    pub blinking: Option<bool>,
}

impl Cursor {
    pub fn shape(&self) -> CursorShape {
        self.style.unwrap_or_default()
    }

    /// Blinking defaults to on; it has no effect with [`CursorShape::Default`].
    pub fn blinking(&self) -> bool {
        self.blinking.unwrap_or(true)
    }
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
    let Some(object) = value.as_object() else {
        return;
    };
    // The TypeScript host flattens a nested `tui` object; a top-level field
    // takes precedence over the same name nested under it.
    let nested = object.get("tui").and_then(serde_json::Value::as_object);
    let field = |name: &str| {
        object
            .get(name)
            .or_else(|| nested.and_then(|tui| tui.get(name)))
    };
    if let Some(mouse) = field("mouse") {
        match mouse.as_bool() {
            Some(mouse) => config.mouse = mouse,
            None => warnings.push(format!(
                "tui config {}: mouse must be a boolean, ignoring",
                path.display()
            )),
        }
    }
    if let Some(cursor) = field("cursor") {
        merge_cursor(cursor, path, config, warnings);
    }
    if let Some(speed) = field("scroll_speed") {
        match speed.as_f64() {
            Some(speed) if speed.is_finite() && speed > 0.0 => config.scroll_speed = speed,
            _ => warnings.push(format!(
                "tui config {}: scroll_speed must be a positive number, ignoring",
                path.display()
            )),
        }
    }
    if let Some(acceleration) = field("scroll_acceleration") {
        merge_scroll_acceleration(acceleration, path, config, warnings);
    }
    if let Some(keybinds) = field("keybinds") {
        merge_keybinds(keybinds, path, config, warnings);
    }
    let Some(attention) = field("attention") else {
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

/// `scroll_acceleration` is `{ "enabled": bool }` in the TypeScript schema; a
/// bare boolean is refused there too, so it is refused here.
fn merge_scroll_acceleration(
    value: &serde_json::Value,
    path: &Path,
    config: &mut Config,
    warnings: &mut Vec<String>,
) {
    let Some(object) = value.as_object() else {
        warnings.push(format!(
            "tui config {}: scroll_acceleration must be an object with an \"enabled\" flag, ignoring",
            path.display()
        ));
        return;
    };
    for (key, value) in object {
        match key.as_str() {
            "enabled" => match value.as_bool() {
                Some(enabled) => config.scroll_acceleration = enabled,
                None => warnings.push(format!(
                    "tui config {}: scroll_acceleration.enabled must be a boolean, ignoring",
                    path.display()
                )),
            },
            other => warnings.push(format!(
                "tui config {}: ignoring unsupported scroll_acceleration field \"{other}\"",
                path.display()
            )),
        }
    }
}

fn merge_cursor(
    value: &serde_json::Value,
    path: &Path,
    config: &mut Config,
    warnings: &mut Vec<String>,
) {
    let Some(object) = value.as_object() else {
        warnings.push(format!(
            "tui config {}: cursor must be an object, ignoring",
            path.display()
        ));
        return;
    };
    let cursor = config.cursor.get_or_insert_with(Cursor::default);
    for (key, value) in object {
        match key.as_str() {
            "style" => match value.as_str() {
                Some("default") => cursor.style = Some(CursorShape::Default),
                Some("block") => cursor.style = Some(CursorShape::Block),
                Some("underline") => cursor.style = Some(CursorShape::Underline),
                Some("line") => cursor.style = Some(CursorShape::Line),
                _ => warnings.push(format!(
                    "tui config {}: cursor.style must be block, underline, line or default, ignoring",
                    path.display()
                )),
            },
            "blinking" => match value.as_bool() {
                Some(blinking) => cursor.blinking = Some(blinking),
                None => warnings.push(format!(
                    "tui config {}: cursor.blinking must be a boolean, ignoring",
                    path.display()
                )),
            },
            other => warnings.push(format!(
                "tui config {}: ignoring unsupported cursor field \"{other}\"",
                path.display()
            )),
        }
    }
}

fn merge_keybinds(
    value: &serde_json::Value,
    path: &Path,
    config: &mut Config,
    warnings: &mut Vec<String>,
) {
    let Some(object) = value.as_object() else {
        warnings.push(format!(
            "tui config {}: keybinds must be an object, ignoring",
            path.display()
        ));
        return;
    };
    for (name, value) in object {
        let specs = match value {
            // `false` is how the TypeScript host spells "unbind this".
            serde_json::Value::Bool(false) => {
                config.keybinds.insert(name.clone(), None);
                continue;
            }
            serde_json::Value::String(spec) => vec![spec.clone()],
            serde_json::Value::Array(items) => {
                let specs: Option<Vec<String>> = items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect();
                let Some(specs) = specs else {
                    warnings.push(format!(
                        "tui config {}: keybinds.{name} entries must be strings, ignoring",
                        path.display()
                    ));
                    continue;
                };
                specs
            }
            _ => {
                warnings.push(format!(
                    "tui config {}: keybinds.{name} must be a string, a list or false, ignoring",
                    path.display()
                ));
                continue;
            }
        };
        // One entry may carry several comma-separated strokes, and `none`
        // reaches the same state as `false`.
        let specs: Vec<String> = specs
            .iter()
            .flat_map(|spec| spec.split(','))
            .map(str::trim)
            .filter(|spec| !spec.is_empty() && !spec.eq_ignore_ascii_case("none"))
            .map(str::to_string)
            .collect();
        config
            .keybinds
            .insert(name.clone(), (!specs.is_empty()).then_some(specs));
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
        assert!(Config::default().mouse);
        assert!(Config::default().cursor.is_none());
    }

    #[test]
    fn mouse_and_cursor_come_from_the_same_files() {
        let dir = temp_dir("terminal");
        let (config, warnings) = merge_at(
            r#"{"mouse": false, "cursor": {"style": "underline", "blinking": false}}"#,
            &dir,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!config.mouse);
        let cursor = config.cursor.expect("cursor");
        assert_eq!(cursor.shape(), CursorShape::Underline);
        assert!(!cursor.blinking());

        let (config, warnings) = merge_at(r#"{"cursor": {"style": "nope"}, "mouse": "yes"}"#, &dir);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(config.mouse);
        assert_eq!(
            config.cursor.map(|cursor| cursor.shape()),
            Some(CursorShape::Block)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scroll_speed_and_acceleration_come_from_the_typescript_keys() {
        let dir = temp_dir("scroll");
        let (config, warnings) = merge_at(
            r#"{"scroll_speed": 1.5, "scroll_acceleration": {"enabled": true}}"#,
            &dir,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(config.scroll_speed, 1.5);
        assert!(config.scroll_acceleration);

        // The host flattens a nested `tui` object, so the same keys under it
        // must work too.
        let (config, warnings) = merge_at(
            r#"{"tui": {"scroll_speed": 6, "scroll_acceleration": {"enabled": false}}}"#,
            &dir,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(config.scroll_speed, 6.0);
        assert!(!config.scroll_acceleration);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_scroll_configuration_warns_and_keeps_the_default() {
        let dir = temp_dir("scroll-bad");
        let (config, warnings) =
            merge_at(r#"{"scroll_speed": 0, "scroll_acceleration": true}"#, &dir);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert_eq!(config.scroll_speed, 3.0);
        assert!(!config.scroll_acceleration);
        assert!(
            warnings[0].contains("scroll_speed must be a positive number"),
            "{warnings:?}"
        );
        assert!(
            warnings[1].contains("scroll_acceleration must be an object"),
            "{warnings:?}"
        );

        let (config, warnings) = merge_at(
            r#"{"scroll_speed": -2, "scroll_acceleration": {"enabled": "yes"}}"#,
            &dir,
        );
        assert_eq!(config.scroll_speed, 3.0);
        assert!(!config.scroll_acceleration);
        assert!(
            warnings[1].contains("scroll_acceleration.enabled must be a boolean"),
            "{warnings:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_fields_merge_across_files() {
        let mut config = Config::default();
        let mut warnings = Vec::new();
        merge(
            r#"{"cursor": {"style": "line"}}"#,
            Path::new("a/tui.json"),
            &mut config,
            &mut warnings,
        );
        merge(
            r#"{"cursor": {"blinking": false}}"#,
            Path::new("b/tui.json"),
            &mut config,
            &mut warnings,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        let cursor = config.cursor.expect("cursor");
        assert_eq!(cursor.shape(), CursorShape::Line);
        assert!(!cursor.blinking());
    }

    #[test]
    fn attention_fields_merge_and_sounds_resolve_relative_to_the_file() {
        let dir = temp_dir("merge");
        // An absolute path must survive untouched, so the sample has to be
        // absolute on the platform under test: a leading slash carries no drive
        // letter on Windows and would be resolved against `dir` instead.
        #[cfg(windows)]
        let absolute = "C:\\error.wav";
        #[cfg(not(windows))]
        let absolute = "/tmp/error.wav";
        let (config, warnings) = merge_at(
            &format!(
                r#"{{
                "attention": {{
                    "enabled": true,
                    "notifications": false,
                    "sound": false,
                    "volume": 0.25,
                    "sound_pack": "custom",
                    "sounds": {{ "done": "sounds/done.mp3", "error": {absolute:?} }}
                }}
            }}"#
            ),
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
            Some(absolute)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keybinds_accept_strings_lists_and_unbinding() {
        let dir = temp_dir("keybinds");
        let (config, warnings) = merge_at(
            r##"{
                "keybinds": {
                    "command_list": "ctrl+space",
                    "session_list": ["<leader>1", "ctrl+l"],
                    "app_exit": false,
                    "theme_list": "none"
                }
            }"##,
            &dir,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            config.keybinds.get("command_list"),
            Some(&Some(vec!["ctrl+space".to_string()]))
        );
        assert_eq!(
            config.keybinds.get("session_list"),
            Some(&Some(vec!["<leader>1".to_string(), "ctrl+l".to_string()]))
        );
        assert_eq!(config.keybinds.get("app_exit"), Some(&None));
        assert_eq!(config.keybinds.get("theme_list"), Some(&None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_keybinds_are_flattened_and_invalid_values_warn() {
        let dir = temp_dir("nested-keybinds");
        let (config, warnings) =
            merge_at(r#"{"tui": {"keybinds": {"model_list": "ctrl+m"}}}"#, &dir);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            config.keybinds.get("model_list"),
            Some(&Some(vec!["ctrl+m".to_string()]))
        );

        let (_, warnings) = merge_at(r#"{"keybinds": {"a": 1, "b": [1]}}"#, &dir);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
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
