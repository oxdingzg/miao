use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ratatui::style::Color;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub primary: Color,
    pub secondary: Color,
    pub accent: Color,
    pub error: Color,
    pub warning: Color,
    pub success: Color,
    pub text: Color,
    pub text_muted: Color,
    pub background: Color,
    pub surface: Color,
    pub element: Color,
    pub border: Color,
    pub border_active: Color,
}

impl Palette {
    /// The same palette with every colour dropped. `NO_COLOR` and a dumb
    /// terminal both land here, and meaning has to keep coming from glyphs and
    /// words, because nothing else is left.
    pub fn monochrome(self) -> Self {
        Self {
            primary: Color::Reset,
            secondary: Color::Reset,
            accent: Color::Reset,
            error: Color::Reset,
            warning: Color::Reset,
            success: Color::Reset,
            text: Color::Reset,
            text_muted: Color::Reset,
            background: Color::Reset,
            surface: Color::Reset,
            element: Color::Reset,
            border: Color::Reset,
            border_active: Color::Reset,
        }
    }

    /// How a fenced code block or a diff body colours its tokens.
    ///
    /// The names and hues follow the product's `--syntax-*` variables
    /// (`packages/ui/src/styles/theme.css`), so code reads the same in the TUI
    /// as in the rest of miao: comments and keywords keep the muted body colour
    /// instead of a hue of their own, while strings and numbers take the fixed
    /// teal and cyan the product uses, swapped for darker twins when the
    /// background is light.
    pub fn syntax(self) -> Syntax {
        // The monochrome palette has no colours left to hand out, so a code
        // block must not reintroduce them through the syntax hues.
        if self.background == Color::Reset {
            return Syntax {
                comment: Color::Reset,
                string: Color::Reset,
                number: Color::Reset,
                keyword: Color::Reset,
            };
        }
        let light = matches!(
            self.background,
            Color::Rgb(r, g, b) if (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000 > 140
        );
        match light {
            true => Syntax {
                comment: self.text_muted,
                string: rgb("006656"),
                number: rgb("007b80"),
                keyword: self.text_muted,
            },
            false => Syntax {
                comment: self.text_muted,
                string: rgb("00ceb9"),
                number: rgb("93e9f6"),
                keyword: self.text_muted,
            },
        }
    }

    /// The block behind one changed diff row, named after the product's own
    /// diff variables (`--surface-diff-add-base`, `--surface-diff-delete-base`):
    /// the row reads as the product's green or red block, on a light canvas as
    /// on a dark one. A monochrome terminal keeps meaning in the glyphs alone.
    pub fn diff_block(self, added: bool) -> Color {
        if self.background == Color::Reset {
            return Color::Reset;
        }
        let light = matches!(
            self.background,
            Color::Rgb(r, g, b) if (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000 > 140
        );
        match (light, added) {
            (true, true) => rgb("e3fae1"),
            (true, false) => rgb("feefeb"),
            (false, true) => rgb("1a2919"),
            (false, false) => rgb("42120b"),
        }
    }
}

/// Token colours for code, named after the product's syntax variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Syntax {
    pub comment: Color,
    pub string: Color,
    pub number: Color,
    pub keyword: Color,
}

/// Whether the environment asks for no colour. `NO_COLOR` follows
/// <https://no-color.org>: any non-empty value wins, whatever the theme says.
/// `TERM=dumb` cannot render colour or cursor movement at all.
pub fn colorless(no_color: Option<&str>, term: Option<&str>) -> bool {
    no_color.is_some_and(|value| !value.is_empty())
        || term.is_some_and(|term| term.eq_ignore_ascii_case("dumb"))
}

/// Which half of a `{dark, light}` color pair a palette resolves. Terminal
/// auto-detection (a luma probe or an OSC query) stays open: until it exists,
/// an operator who wants light pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
}

impl ThemeMode {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "dark" => Some(Self::Dark),
            "light" => Some(Self::Light),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Theme {
    pub name: String,
    pub palette: Palette,
}

impl Theme {
    /// Drop every colour while keeping the theme's name and layout.
    pub fn monochrome(&self) -> Self {
        Self {
            name: self.name.clone(),
            palette: self.palette.monochrome(),
        }
    }
}

pub struct Loaded {
    pub theme: Theme,
    pub catalog: Catalog,
    pub warnings: Vec<String>,
    /// The mode every palette in this load resolved under.
    pub mode: ThemeMode,
}

/// The TypeScript theme assets every binary carries, in menu order: a name
/// plus the verbatim `assets/*.json` text. Both halves of every `{dark,
/// light}` pair travel with the file, so a pinned mode recolours built-in
/// themes the same way it recolours custom ones.
const BUILTIN_ASSETS: &[(&str, &str)] = &[
    ("aura", include_str!("theme/assets/aura.json")),
    ("ayu", include_str!("theme/assets/ayu.json")),
    ("catppuccin", include_str!("theme/assets/catppuccin.json")),
    (
        "catppuccin-frappe",
        include_str!("theme/assets/catppuccin-frappe.json"),
    ),
    (
        "catppuccin-macchiato",
        include_str!("theme/assets/catppuccin-macchiato.json"),
    ),
    ("cobalt2", include_str!("theme/assets/cobalt2.json")),
    ("cursor", include_str!("theme/assets/cursor.json")),
    ("dracula", include_str!("theme/assets/dracula.json")),
    ("everforest", include_str!("theme/assets/everforest.json")),
    ("flexoki", include_str!("theme/assets/flexoki.json")),
    ("github", include_str!("theme/assets/github.json")),
    ("gruvbox", include_str!("theme/assets/gruvbox.json")),
    ("kanagawa", include_str!("theme/assets/kanagawa.json")),
    ("material", include_str!("theme/assets/material.json")),
    ("matrix", include_str!("theme/assets/matrix.json")),
    ("mercury", include_str!("theme/assets/mercury.json")),
    ("monokai", include_str!("theme/assets/monokai.json")),
    ("nightowl", include_str!("theme/assets/nightowl.json")),
    ("nord", include_str!("theme/assets/nord.json")),
    ("one-dark", include_str!("theme/assets/one-dark.json")),
    ("osaka-jade", include_str!("theme/assets/osaka-jade.json")),
    ("miao", include_str!("theme/assets/miao.json")),
    ("opencode", include_str!("theme/assets/opencode.json")),
    ("orng", include_str!("theme/assets/orng.json")),
    ("lucent-orng", include_str!("theme/assets/lucent-orng.json")),
    ("palenight", include_str!("theme/assets/palenight.json")),
    ("rosepine", include_str!("theme/assets/rosepine.json")),
    ("solarized", include_str!("theme/assets/solarized.json")),
    ("synthwave84", include_str!("theme/assets/synthwave84.json")),
    ("tokyonight", include_str!("theme/assets/tokyonight.json")),
    ("vesper", include_str!("theme/assets/vesper.json")),
    ("vercel", include_str!("theme/assets/vercel.json")),
    ("zenburn", include_str!("theme/assets/zenburn.json")),
    ("carbonfox", include_str!("theme/assets/carbonfox.json")),
];

pub const DEFAULT_THEME: &str = "miao";

/// Every theme the TUI can switch to: the built-ins in menu order, plus the
/// custom `themes/*.json` files. A custom file named after a built-in replaces
/// it in place, the way `customThemes` overrides the defaults in the
/// TypeScript host.
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    entries: Vec<(String, Palette)>,
}

impl Catalog {
    /// The built-ins resolved under `mode`, overlaid with the custom themes.
    fn from_assets(
        mode: ThemeMode,
        custom: impl IntoIterator<Item = (String, Palette)>,
        warnings: &mut Vec<String>,
    ) -> Self {
        let mut entries: Vec<(String, Palette)> = BUILTIN_ASSETS
            .iter()
            .filter_map(|(name, _)| {
                builtin_palette(name, mode, warnings).map(|palette| (name.to_string(), palette))
            })
            .collect();
        for (name, palette) in custom {
            match entries.iter_mut().find(|(existing, _)| *existing == name) {
                Some(entry) => entry.1 = palette,
                None => entries.push((name, palette)),
            }
        }
        Self { entries }
    }

    /// The catalog of built-ins alone, resolved dark: what a fixture wants.
    pub fn builtin() -> Self {
        Self::from_assets(ThemeMode::Dark, std::iter::empty(), &mut Vec::new())
    }

    /// Theme names in menu order.
    pub fn names(&self) -> Vec<&str> {
        self.entries.iter().map(|(name, _)| name.as_str()).collect()
    }

    pub fn palette(&self, name: &str) -> Option<Palette> {
        self.entries
            .iter()
            .find(|(entry, _)| entry == name)
            .map(|(_, palette)| *palette)
    }
}

/// Parse one built-in asset under `mode`. The assets ship complete, so a
/// warning here means the embedded file drifted from the schema.
fn builtin_palette(name: &str, mode: ThemeMode, warnings: &mut Vec<String>) -> Option<Palette> {
    let text = BUILTIN_ASSETS.iter().find(|(key, _)| *key == name)?.1;
    let mut parsed_warnings = Vec::new();
    let palette = match parse_theme(text, mode, &mut parsed_warnings) {
        Ok(palette) => Some(palette),
        Err(reason) => {
            warnings.push(format!("built-in theme {name}: {reason}"));
            None
        }
    };
    for warning in parsed_warnings {
        warnings.push(format!("built-in theme {name}: {warning}"));
    }
    palette
}

/// A built-in palette resolved under `mode`.
pub fn builtin(name: &str, mode: ThemeMode) -> Option<Palette> {
    builtin_palette(name, mode, &mut Vec::new())
}

pub fn load(workspace: &Path) -> Loaded {
    let mut loaded = load_at(workspace, crate::config::global_dir().as_deref());
    // Read the environment here rather than in `load_at`, so the parser stays a
    // pure function of the files a test hands it.
    let colorless = colorless(
        std::env::var("NO_COLOR").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
    );
    if colorless {
        loaded.theme = loaded.theme.monochrome();
    }
    loaded
}

pub(crate) fn load_at(workspace: &Path, global: Option<&Path>) -> Loaded {
    let mut warnings = Vec::new();
    let mode = locked_mode(&mut warnings);
    let mut name = String::new();
    for path in crate::config::files(workspace, global) {
        match std::fs::read_to_string(&path) {
            Ok(text) => merge(&text, &path, &mut name, &mut warnings),
            Err(err) => warnings.push(format!("failed to read {}: {err}", path.display())),
        }
    }
    let catalog = Catalog::from_assets(
        mode,
        custom_themes(workspace, global, mode, &mut warnings),
        &mut warnings,
    );
    if name.is_empty() {
        // A saved choice only fills in when no config file named a theme.
        name = crate::state::preferences().theme.unwrap_or_default();
    }
    if name.is_empty() {
        name = DEFAULT_THEME.to_string();
    }
    let palette = match catalog.palette(&name) {
        Some(palette) => palette,
        None => {
            warnings.push(format!(
                "unknown theme \"{name}\", falling back to {DEFAULT_THEME}"
            ));
            name = DEFAULT_THEME.to_string();
            builtin(DEFAULT_THEME, mode).expect("default theme is built in")
        }
    };
    Loaded {
        theme: Theme { name, palette },
        catalog,
        warnings,
        mode,
    }
}

/// The operator's pinned mode, or dark while nothing is pinned.
fn locked_mode(warnings: &mut Vec<String>) -> ThemeMode {
    let lock = crate::state::preferences().theme_mode_lock;
    let Some(text) = lock else {
        return ThemeMode::Dark;
    };
    let Some(mode) = ThemeMode::parse(&text) else {
        warnings.push(format!("unknown theme mode lock \"{text}\", using dark"));
        return ThemeMode::Dark;
    };
    mode
}

/// Directories that may hold a `themes/` folder, in the order the TypeScript
/// host scans them: the global config directory, then each `.miao` directory
/// from the workspace upwards. Later directories win, as they do there.
fn theme_dirs(workspace: &Path, global: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = global.map(Path::to_path_buf).into_iter().collect();
    let mut current = Some(workspace);
    while let Some(dir) = current {
        dirs.push(dir.join(".miao"));
        current = dir.parent();
    }
    dirs
}

/// Custom themes are plain JSON files named after the theme, so a malformed
/// file only removes that one name from the menu.
fn custom_themes(
    workspace: &Path,
    global: Option<&Path>,
    mode: ThemeMode,
    warnings: &mut Vec<String>,
) -> BTreeMap<String, Palette> {
    let mut themes = BTreeMap::new();
    for dir in theme_dirs(workspace, global) {
        let Ok(entries) = std::fs::read_dir(dir.join("themes")) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter(|path| path.is_file())
            .collect();
        files.sort();
        for file in files {
            let Some(name) = file.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let text = match std::fs::read_to_string(&file) {
                Ok(text) => text,
                Err(err) => {
                    warnings.push(format!("failed to read {}: {err}", file.display()));
                    continue;
                }
            };
            let mut parse_warnings = Vec::new();
            match parse_theme(&text, mode, &mut parse_warnings) {
                Ok(palette) => {
                    themes.insert(name.to_string(), palette);
                }
                Err(reason) => {
                    warnings.push(format!("skipping theme {}: {reason}", file.display()))
                }
            }
            for warning in parse_warnings.drain(..) {
                warnings.push(format!("{}: {warning}", file.display()));
            }
        }
    }
    themes
}

/// Reads the TypeScript theme file shape: a `theme` object of named colors,
/// `defs` for shared references, `{dark, light}` pairs, and ANSI color codes.
/// A pair resolves to the half the requested mode names; a pair missing that
/// half warns and resolves to the other one.
fn parse_theme(text: &str, mode: ThemeMode, warnings: &mut Vec<String>) -> Result<Palette, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|err| err.to_string())?;
    let theme = value
        .get("theme")
        .and_then(serde_json::Value::as_object)
        .ok_or("missing \"theme\" object")?;
    let defs = value.get("defs").and_then(serde_json::Value::as_object);
    let color = |key: &str| {
        let raw = theme
            .get(key)
            .ok_or_else(|| format!("missing theme.{key}"))?;
        resolve_color(raw, theme, defs, &mut Vec::new(), mode, warnings)
    };
    Ok(Palette {
        primary: color("primary")?,
        secondary: color("secondary")?,
        accent: color("accent")?,
        error: color("error")?,
        warning: color("warning")?,
        success: color("success")?,
        text: color("text")?,
        text_muted: color("textMuted")?,
        background: color("background")?,
        surface: color("backgroundPanel")?,
        element: color("backgroundElement")?,
        border: color("border")?,
        border_active: color("borderActive")?,
    })
}

fn resolve_color(
    value: &serde_json::Value,
    theme: &serde_json::Map<String, serde_json::Value>,
    defs: Option<&serde_json::Map<String, serde_json::Value>>,
    chain: &mut Vec<String>,
    mode: ThemeMode,
    warnings: &mut Vec<String>,
) -> Result<Color, String> {
    match value {
        serde_json::Value::String(text) if text == "transparent" || text == "none" => {
            Ok(Color::Reset)
        }
        serde_json::Value::String(text) if text.starts_with('#') => hex_color(text),
        serde_json::Value::String(name) => {
            if chain.contains(name) {
                return Err(format!(
                    "circular color reference {} -> {name}",
                    chain.join(" -> ")
                ));
            }
            let next = defs
                .and_then(|defs| defs.get(name))
                .or_else(|| theme.get(name))
                .ok_or_else(|| format!("color reference \"{name}\" not found"))?;
            chain.push(name.clone());
            let resolved = resolve_color(next, theme, defs, chain, mode, warnings);
            chain.pop();
            resolved
        }
        serde_json::Value::Number(code) => code
            .as_u64()
            .and_then(|code| u8::try_from(code).ok())
            .map(ansi_color)
            .ok_or_else(|| format!("invalid ANSI color code {code}")),
        serde_json::Value::Object(variant) => {
            let other = match mode {
                ThemeMode::Dark => "light",
                ThemeMode::Light => "dark",
            };
            let half = match variant.get(mode.as_str()) {
                Some(half) => half,
                None => {
                    warnings.push(format!(
                        "color has no \"{}\" value, using \"{other}\"",
                        mode.as_str()
                    ));
                    variant
                        .get(other)
                        .ok_or("color has neither \"dark\" nor \"light\" value")?
                }
            };
            resolve_color(half, theme, defs, chain, mode, warnings)
        }
        _ => Err(format!("unsupported color value {value}")),
    }
}

fn hex_color(text: &str) -> Result<Color, String> {
    let digits = text
        .strip_prefix('#')
        .ok_or_else(|| format!("invalid color \"{text}\""))?;
    let expanded = match digits.len() {
        3 => digits.chars().flat_map(|digit| [digit, digit]).collect(),
        6 | 8 => digits[..6].to_string(),
        _ => return Err(format!("invalid color \"{text}\"")),
    };
    let byte = |at: usize| {
        u8::from_str_radix(&expanded[at..at + 2], 16)
            .map_err(|_| format!("invalid color \"{text}\""))
    };
    Ok(Color::Rgb(byte(0)?, byte(2)?, byte(4)?))
}

/// The ANSI palette the TypeScript host expands: 16 base colors, a 6x6x6 cube,
/// then a grayscale ramp.
fn ansi_color(code: u8) -> Color {
    const BASE: [&str; 16] = [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
        "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    if let Some(hex) = BASE.get(usize::from(code)) {
        return hex_color(hex).expect("built-in ANSI colors are valid hex");
    }
    if code < 232 {
        let index = code - 16;
        let step = |value: u8| if value == 0 { 0 } else { value * 40 + 55 };
        return Color::Rgb(step(index / 36), step((index / 6) % 6), step(index % 6));
    }
    let gray = (code - 232) * 10 + 8;
    Color::Rgb(gray, gray, gray)
}

fn merge(text: &str, path: &Path, name: &mut String, warnings: &mut Vec<String>) {
    let stripped = strip_jsonc(text);
    let value: serde_json::Value = match serde_json::from_str(&stripped) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(format!(
                "skipping invalid tui config {}: {err}",
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
    if let Some(theme) = object
        .get("theme")
        .or_else(|| nested.and_then(|tui| tui.get("theme")))
    {
        match theme.as_str() {
            Some(theme) => *name = theme.to_string(),
            None => warnings.push(format!(
                "tui config {}: theme must be a string, ignoring",
                path.display()
            )),
        }
    }
    crate::config::warn_unknown_fields(object, path, warnings);
}

pub(crate) fn strip_jsonc(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    out.push(' ');
                    for rest in chars.by_ref() {
                        if matches!(rest, '\n' | '\r') {
                            out.push(rest);
                            break;
                        }
                        out.extend(std::iter::repeat_n(' ', rest.len_utf8()));
                    }
                }
                Some('*') => {
                    chars.next();
                    out.push_str("  ");
                    let mut previous = '\0';
                    let mut closed = false;
                    for rest in chars.by_ref() {
                        if matches!(rest, '\n' | '\r') {
                            out.push(rest);
                        } else {
                            out.extend(std::iter::repeat_n(' ', rest.len_utf8()));
                        }
                        if previous == '*' && rest == '/' {
                            closed = true;
                            break;
                        }
                        previous = rest;
                    }
                    // Keep invalid syntax visible to serde_json instead of
                    // accepting a valid prefix before an unfinished comment.
                    if !closed {
                        return input.to_owned();
                    }
                }
                _ => out.push('/'),
            },
            _ => out.push(c),
        }
    }
    strip_trailing_commas(&out)
}

fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            ',' => {
                let mut next = index + 1;
                while next < chars.len() && chars[next].is_whitespace() {
                    next += 1;
                }
                let previous = chars[..index]
                    .iter()
                    .rev()
                    .copied()
                    .find(|character| !character.is_whitespace());
                // Preserve leading/missing-value commas so parsing still rejects them.
                if next >= chars.len()
                    || (chars[next] != '}' && chars[next] != ']')
                    || matches!(previous, None | Some('{' | '[' | ',' | ':'))
                {
                    out.push(',');
                } else {
                    out.push(' ');
                }
            }
            _ => out.push(c),
        }
        index += 1;
    }
    out
}

const fn hex_digit(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("built-in palettes use hex digits"),
    }
}

const fn rgb(hex: &str) -> Color {
    let bytes = hex.as_bytes();
    match bytes.len() {
        3 => Color::Rgb(
            (hex_digit(bytes[0]) << 4) | hex_digit(bytes[0]),
            (hex_digit(bytes[1]) << 4) | hex_digit(bytes[1]),
            (hex_digit(bytes[2]) << 4) | hex_digit(bytes[2]),
        ),
        6 => Color::Rgb(
            (hex_digit(bytes[0]) << 4) | hex_digit(bytes[1]),
            (hex_digit(bytes[2]) << 4) | hex_digit(bytes[3]),
            (hex_digit(bytes[4]) << 4) | hex_digit(bytes[5]),
        ),
        _ => panic!("built-in palettes use 3- or 6-digit hex"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_environment_without_colour_is_recognised() {
        // UX-03: a terminal that cannot show colour still has to be usable, so
        // the request has to be honoured rather than prettified away.
        assert!(colorless(Some("1"), None));
        assert!(
            colorless(Some("anything"), None),
            "NO_COLOR only needs a value"
        );
        assert!(colorless(None, Some("dumb")));
        assert!(colorless(None, Some("DUMB")), "TERM is case insensitive");
        assert!(
            !colorless(Some(""), None),
            "an empty NO_COLOR means the operator did not ask"
        );
        assert!(!colorless(None, None), "no request, no change");
        assert!(!colorless(None, Some("xterm-256color")));
    }

    #[test]
    fn the_monochrome_palette_drops_every_colour_and_keeps_the_name() {
        let theme = Theme {
            name: "custom".into(),
            palette: builtin(DEFAULT_THEME, ThemeMode::Dark).expect("theme"),
        };
        let plain = theme.monochrome();
        assert_eq!(plain.name, "custom");
        for colour in [
            plain.palette.primary,
            plain.palette.secondary,
            plain.palette.accent,
            plain.palette.error,
            plain.palette.warning,
            plain.palette.success,
            plain.palette.text,
            plain.palette.text_muted,
            plain.palette.background,
            plain.palette.surface,
            plain.palette.element,
            plain.palette.border,
            plain.palette.border_active,
        ] {
            assert_eq!(colour, Color::Reset);
        }
    }

    #[test]
    fn jsonc_commas_need_a_preceding_value() {
        for text in [
            "{,}",
            "[,]",
            "{/* note */,}",
            "[/* note */,]",
            r#"{"nested":[,]}"#,
            r#"{"nested":{,}}"#,
        ] {
            assert!(
                serde_json::from_str::<serde_json::Value>(&strip_jsonc(text)).is_err(),
                "accepted {text}"
            );
        }
    }

    #[test]
    fn jsonc_carriage_returns_end_line_comments() {
        let text = "// comment\r{\"theme\":\"nord\"}";
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["theme"], "nord");
    }

    #[test]
    fn jsonc_comments_preserve_source_positions_and_token_boundaries() {
        let text = "{/* 中文🐱\r\n comment */\"a\":[1,],\"b\":?}";
        let stripped = strip_jsonc(text);
        assert_eq!(stripped.len(), text.len());
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' || byte == b'\r' {
                assert_eq!(stripped.as_bytes()[index], byte);
            }
        }
        let error = serde_json::from_str::<serde_json::Value>(&stripped).unwrap_err();
        assert_eq!(error.line(), 2);
        assert_eq!(
            error.column(),
            text.lines().last().unwrap().find('?').unwrap() + 1
        );
        assert!(serde_json::from_str::<serde_json::Value>(&strip_jsonc("[1/**/2]")).is_err());
    }

    #[test]
    fn jsonc_unterminated_comments_do_not_turn_invalid_configuration_into_valid_json() {
        for text in [
            "{\"theme\":\"nord\"} /*",
            "{\"theme\":\"nord\"} /* unterminated",
        ] {
            assert!(serde_json::from_str::<serde_json::Value>(&strip_jsonc(text)).is_err());
        }
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_are_stripped() {
        let text = "{\n  // comment\n  /* block */\n  \"theme\": \"nord\", // line\n  \"x\": [1, 2,],\n}\n";
        let stripped = strip_jsonc(text);
        let value: serde_json::Value = serde_json::from_str(&stripped).expect("valid json");
        assert_eq!(value["theme"], "nord");
        assert_eq!(value["x"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn merge_selects_theme_and_reports_unknown_fields() {
        let text = r#"{ "$schema": "x", "theme": "nord", "mystery": 1 }"#;
        let mut name = String::new();
        let mut warnings = Vec::new();
        merge(text, Path::new("t.json"), &mut name, &mut warnings);
        assert_eq!(name, "nord");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("mystery"));
    }

    #[test]
    fn broken_config_is_skipped_not_fatal() {
        let mut name = String::new();
        let mut warnings = Vec::new();
        merge("{ not json", Path::new("t.json"), &mut name, &mut warnings);
        assert!(name.is_empty());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn every_typescript_theme_is_available() {
        // The `DEFAULT_THEMES` keys in packages/tui/src/theme/index.ts.
        const NAMES: &[&str] = &[
            "aura",
            "ayu",
            "catppuccin",
            "catppuccin-frappe",
            "catppuccin-macchiato",
            "cobalt2",
            "cursor",
            "dracula",
            "everforest",
            "flexoki",
            "github",
            "gruvbox",
            "kanagawa",
            "material",
            "matrix",
            "mercury",
            "monokai",
            "nightowl",
            "nord",
            "one-dark",
            "osaka-jade",
            "miao",
            "opencode",
            "orng",
            "lucent-orng",
            "palenight",
            "rosepine",
            "solarized",
            "synthwave84",
            "tokyonight",
            "vesper",
            "vercel",
            "zenburn",
            "carbonfox",
        ];
        let catalog = Catalog::builtin();
        let names = catalog.names();
        for name in NAMES {
            assert!(names.contains(name), "missing theme {name}");
        }
        assert_eq!(names.len(), NAMES.len(), "{names:?}");
    }

    #[test]
    fn built_in_palettes_resolve() {
        for (name, _) in BUILTIN_ASSETS {
            assert!(builtin(name, ThemeMode::Dark).is_some());
        }
        assert!(builtin("nope", ThemeMode::Dark).is_none());
    }

    #[test]
    fn every_builtin_resolves_under_both_modes_without_warnings() {
        for (name, _) in BUILTIN_ASSETS {
            for mode in [ThemeMode::Dark, ThemeMode::Light] {
                let mut warnings = Vec::new();
                assert!(
                    builtin_palette(name, mode, &mut warnings).is_some(),
                    "built-in theme {name} does not resolve under {mode:?}"
                );
                assert!(
                    warnings.is_empty(),
                    "built-in theme {name} warned under {mode:?}: {warnings:?}"
                );
            }
        }
    }

    #[test]
    fn pinning_light_recolours_the_built_in_catalog() {
        let dark = Catalog::from_assets(ThemeMode::Dark, std::iter::empty(), &mut Vec::new());
        let mut light_warnings = Vec::new();
        let light = Catalog::from_assets(ThemeMode::Light, std::iter::empty(), &mut light_warnings);
        assert!(light_warnings.is_empty(), "{light_warnings:?}");
        assert_eq!(dark.names(), light.names(), "both modes ship the same menu");
        let dark_default = dark.palette(DEFAULT_THEME).expect("default is built in");
        let light_default = light.palette(DEFAULT_THEME).expect("default is built in");
        assert_ne!(
            dark_default.background, light_default.background,
            "pinning light recolours the default theme"
        );
    }

    #[test]
    fn a_pinned_light_mode_recolours_the_default_theme_on_reload() {
        let _env = crate::state::env_lock();
        let state = workspace("pin-state");
        let dir = workspace("pin-ws");
        std::env::set_var("MIAO_TUI_STATE_DIR", &state);

        assert_eq!(load_at(&dir, None).mode, ThemeMode::Dark);
        let unpinned = load_at(&dir, None).theme.palette.background;

        crate::state::save_mode_lock(Some("light"));
        let loaded = load_at(&dir, None);
        assert_eq!(loaded.mode, ThemeMode::Light);
        assert_ne!(
            loaded.theme.palette.background, unpinned,
            "a pinned light mode recolours the default theme on reload"
        );

        crate::state::save_mode_lock(None);
        assert_eq!(load_at(&dir, None).mode, ThemeMode::Dark);
        assert_eq!(crate::state::preferences().theme_mode_lock, None);

        std::env::remove_var("MIAO_TUI_STATE_DIR");
        let _ = std::fs::remove_dir_all(&state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn workspace(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-theme-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const CUSTOM: &str = r##"{
        "defs": { "ink": "#eeeeee", "base": "#101010" },
        "theme": {
            "primary": { "dark": "#ff0000", "light": "#aa0000" },
            "secondary": "ink",
            "accent": "#0f0",
            "error": "#ff0000",
            "warning": "#ffaa00",
            "success": "#00ff00",
            "text": "ink",
            "textMuted": "#808080",
            "background": "base",
            "backgroundPanel": "#181818",
            "backgroundElement": "#202020",
            "border": 8,
            "borderActive": "#ffffff"
        }
    }"##;

    #[test]
    fn a_custom_theme_file_joins_the_menu_and_resolves_references() {
        let _env = crate::state::env_lock();
        let dir = workspace("custom");
        let themes = dir.join(".miao").join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(themes.join("custom.json"), CUSTOM).unwrap();
        std::fs::write(dir.join(".miao").join("tui.json"), r#"{"theme": "custom"}"#).unwrap();

        let loaded = load_at(&dir, None);
        // The dark half of a variant wins, references reach `defs`, and an ANSI
        // code expands to the same color the TypeScript host uses.
        let palette = loaded.catalog.palette("custom").expect("custom theme");
        assert_eq!(palette.primary, Color::Rgb(255, 0, 0));
        assert_eq!(palette.secondary, Color::Rgb(0xee, 0xee, 0xee));
        assert_eq!(palette.accent, Color::Rgb(0, 255, 0));
        assert_eq!(palette.border, Color::Rgb(0x80, 0x80, 0x80));
        assert_eq!(loaded.theme.name, "custom");
        assert_eq!(
            loaded.theme.palette.background,
            Color::Rgb(0x10, 0x10, 0x10)
        );
        assert!(loaded.catalog.names().contains(&"custom"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_custom_theme_replaces_the_built_in_of_the_same_name() {
        let _env = crate::state::env_lock();
        let dir = workspace("override");
        let themes = dir.join(".miao").join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(themes.join("nord.json"), CUSTOM).unwrap();

        let loaded = load_at(&dir, None);
        // The file's colors replace the built-in palette instead of being
        // ignored because the name already existed.
        let nord = loaded.catalog.palette("nord").expect("nord");
        assert_eq!(nord.primary, Color::Rgb(255, 0, 0));
        assert_eq!(nord.secondary, Color::Rgb(0xee, 0xee, 0xee));
        assert_ne!(
            nord.secondary,
            builtin("nord", ThemeMode::Dark).unwrap().secondary
        );
        assert_eq!(
            loaded
                .catalog
                .names()
                .iter()
                .filter(|name| **name == "nord")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_custom_theme_is_skipped_with_a_warning() {
        let dir = workspace("broken-custom");
        let themes = dir.join(".miao").join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(
            themes.join("half.json"),
            r##"{"theme": {"primary": "#fff"}}"##,
        )
        .unwrap();

        let loaded = load_at(&dir, None);
        assert!(loaded.catalog.palette("half").is_none());
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("half.json")),
            "{:?}",
            loaded.warnings
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_global_config_directory_participates_in_the_chain() {
        let dir = workspace("global");
        let global = workspace("global-config");
        std::fs::write(global.join("tui.json"), r#"{"theme": "nord"}"#).unwrap();

        let loaded = load_at(&dir, Some(&global));
        assert_eq!(loaded.theme.name, "nord");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&global);
    }

    #[test]
    fn a_nested_tui_object_is_flattened_like_the_typescript_host() {
        let mut name = String::new();
        let mut warnings = Vec::new();
        merge(
            r#"{"tui": {"theme": "nord"}}"#,
            Path::new("t.json"),
            &mut name,
            &mut warnings,
        );
        assert_eq!(name, "nord");
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn unknown_theme_falls_back_to_default() {
        let dir = std::env::temp_dir().join(format!("miao-tui-theme-{}", std::process::id()));
        let config = dir.join(".miao");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("tui.json"), "{\"theme\": \"nope\"}").unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.theme.name, DEFAULT_THEME);
        assert!(loaded.warnings.iter().any(|w| w.contains("unknown theme")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_code_block_paints_with_the_products_syntax_hues() {
        // The same variables the web UI paints code with
        // (`packages/ui/src/styles/theme.css`), so a block keeps its colours
        // when the operator moves between the TUI and the rest of miao.
        let palette = builtin(DEFAULT_THEME, ThemeMode::Dark).expect("builtin theme");
        let syntax = palette.syntax();
        assert_eq!(
            syntax.string,
            rgb("00ceb9"),
            "the product's --syntax-string"
        );
        assert_eq!(
            syntax.number,
            rgb("93e9f6"),
            "the product's --syntax-constant"
        );
        assert_eq!(syntax.comment, palette.text_muted);
        assert_eq!(syntax.keyword, palette.text_muted);
    }

    #[test]
    fn a_light_background_gets_the_dark_twins_of_the_syntax_hues() {
        let light = Palette {
            background: rgb("ffffff"),
            ..builtin(DEFAULT_THEME, ThemeMode::Dark).expect("builtin theme")
        };
        assert_eq!(light.syntax().string, rgb("006656"));
        assert_eq!(light.syntax().number, rgb("007b80"));
    }

    #[test]
    fn the_monochrome_palette_hands_out_no_syntax_colour() {
        let syntax = builtin(DEFAULT_THEME, ThemeMode::Dark)
            .expect("builtin theme")
            .monochrome()
            .syntax();
        for colour in [syntax.comment, syntax.string, syntax.number, syntax.keyword] {
            assert_eq!(colour, Color::Reset);
        }
    }

    #[test]
    fn a_pair_resolves_to_the_half_the_pinned_mode_names() {
        let mut warnings = Vec::new();
        let dark = parse_theme(CUSTOM, ThemeMode::Dark, &mut warnings).expect("parses");
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(dark.primary, Color::Rgb(255, 0, 0));
        let mut warnings = Vec::new();
        let light = parse_theme(CUSTOM, ThemeMode::Light, &mut warnings).expect("parses");
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(light.primary, Color::Rgb(0xaa, 0, 0));
    }

    #[test]
    fn a_pair_missing_the_pinned_half_warns_and_falls_back_to_the_other() {
        let text = r##"{"theme": {"primary": {"light": "#abcdef"}, "secondary": "#111111", "accent": "#00ff00", "error": "#ff0000", "warning": "#ffaa00", "success": "#00ff00", "text": "#eeeeee", "textMuted": "#808080", "background": "#101010", "backgroundPanel": "#181818", "backgroundElement": "#202020", "border": 8, "borderActive": "#ffffff"}}"##;
        let mut warnings = Vec::new();
        let dark = parse_theme(text, ThemeMode::Dark, &mut warnings).expect("parses");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("no \"dark\" value, using \"light\""),
            "{warnings:?}"
        );
        assert_eq!(dark.primary, Color::Rgb(0xab, 0xcd, 0xef));
        let mut warnings = Vec::new();
        let light = parse_theme(text, ThemeMode::Light, &mut warnings).expect("parses");
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(light.primary, Color::Rgb(0xab, 0xcd, 0xef));
    }

    #[test]
    fn the_mode_lock_roundtrips_and_an_unknown_lock_falls_back_to_dark() {
        let _env = crate::state::env_lock();
        let state = workspace("lock-state");
        let dir = workspace("lock-ws");
        std::env::set_var("MIAO_TUI_STATE_DIR", &state);

        crate::state::save_mode_lock(Some("light"));
        assert_eq!(
            crate::state::preferences().theme_mode_lock.as_deref(),
            Some("light")
        );
        assert_eq!(load_at(&dir, None).mode, ThemeMode::Light);

        crate::state::save_mode_lock(Some("neon"));
        let mut warnings = Vec::new();
        assert_eq!(locked_mode(&mut warnings), ThemeMode::Dark);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("unknown theme mode lock"),
            "{warnings:?}"
        );

        crate::state::save_mode_lock(None);
        assert_eq!(load_at(&dir, None).mode, ThemeMode::Dark);
        assert_eq!(crate::state::preferences().theme_mode_lock, None);

        std::env::remove_var("MIAO_TUI_STATE_DIR");
        let _ = std::fs::remove_dir_all(&state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn theme_and_config_read_one_chain() {
        let _env = crate::state::env_lock();
        let state = workspace("chain-state");
        let global = workspace("chain-global");
        let holder = workspace("chain-env");
        let dir = workspace("chain-ws");
        std::env::set_var("MIAO_TUI_STATE_DIR", &state);
        std::env::set_var("MIAO_CONFIG_DIR", &global);
        let env_file = holder.join("tui.json");
        std::fs::write(&env_file, r#"{"leader_timeout": 900}"#).unwrap();
        std::env::set_var("MIAO_TUI_CONFIG", &env_file);
        std::fs::create_dir_all(global.join("themes")).unwrap();
        std::fs::write(global.join("themes").join("paired.json"), CUSTOM).unwrap();
        std::fs::write(
            global.join("tui.json"),
            r#"{"theme": "paired", "leader_timeout": 700}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join(".miao")).unwrap();
        std::fs::write(
            dir.join(".miao").join("tui.json"),
            r#"{"theme": "paired", "prompt": {"max_width": 120}}"#,
        )
        .unwrap();

        let loaded = load_at(&dir, Some(&global));
        assert_eq!(loaded.mode, ThemeMode::Dark);
        assert_eq!(loaded.theme.name, "paired", "the project file wins");
        assert_eq!(
            loaded.theme.palette.primary,
            Color::Rgb(255, 0, 0),
            "nothing pinned, the dark half resolves"
        );
        assert!(
            loaded.warnings.is_empty(),
            "every chained field is known: {:?}",
            loaded.warnings
        );
        assert_eq!(
            loaded
                .catalog
                .palette("paired")
                .map(|palette| palette.primary),
            Some(Color::Rgb(255, 0, 0)),
            "the custom theme came from the global dir of the same chain"
        );

        let (config, warnings) = crate::config::load(&dir);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            config.leader_timeout_ms, 900,
            "the MIAO_TUI_CONFIG file is later in the chain than the global dir"
        );
        assert_eq!(
            config.prompt_max_width,
            crate::config::PromptWidth::Fixed(120)
        );

        for variable in ["MIAO_TUI_STATE_DIR", "MIAO_CONFIG_DIR", "MIAO_TUI_CONFIG"] {
            std::env::remove_var(variable);
        }
        let _ = std::fs::remove_dir_all(&state);
        let _ = std::fs::remove_dir_all(&global);
        let _ = std::fs::remove_dir_all(&holder);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
