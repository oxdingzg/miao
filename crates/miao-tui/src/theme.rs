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

#[derive(Debug, Clone)]
pub struct Theme {
    pub name: String,
    pub palette: Palette,
}

pub struct Loaded {
    pub theme: Theme,
    pub catalog: Catalog,
    pub warnings: Vec<String>,
}

const BUILTIN_THEMES: &[(&str, Palette)] = &[
    // aura
    (
        "aura",
        Palette {
            primary: rgb("a277ff"),
            secondary: rgb("f694ff"),
            accent: rgb("a277ff"),
            error: rgb("ff6767"),
            warning: rgb("ffca85"),
            success: rgb("61ffca"),
            text: rgb("edecee"),
            text_muted: rgb("6d6d6d"),
            background: rgb("0f0f0f"),
            surface: rgb("15141b"),
            element: rgb("15141b"),
            border: rgb("2d2d2d"),
            border_active: rgb("6d6d6d"),
        },
    ),
    // ayu
    (
        "ayu",
        Palette {
            primary: rgb("59C2FF"),
            secondary: rgb("D2A6FF"),
            accent: rgb("E6B450"),
            error: rgb("D95757"),
            warning: rgb("E6B673"),
            success: rgb("7FD962"),
            text: rgb("BFBDB6"),
            text_muted: rgb("565B66"),
            background: rgb("0B0E14"),
            surface: rgb("0F131A"),
            element: rgb("0D1017"),
            border: rgb("6C7380"),
            border_active: rgb("6C7380"),
        },
    ),
    // catppuccin
    (
        "catppuccin",
        Palette {
            primary: rgb("89b4fa"),
            secondary: rgb("cba6f7"),
            accent: rgb("f5c2e7"),
            error: rgb("f38ba8"),
            warning: rgb("f9e2af"),
            success: rgb("a6e3a1"),
            text: rgb("cdd6f4"),
            text_muted: rgb("9399b2"),
            background: rgb("1e1e2e"),
            surface: rgb("181825"),
            element: rgb("11111b"),
            border: rgb("313244"),
            border_active: rgb("45475a"),
        },
    ),
    // catppuccin-frappe
    (
        "catppuccin-frappe",
        Palette {
            primary: rgb("8da4e2"),
            secondary: rgb("ca9ee6"),
            accent: rgb("f4b8e4"),
            error: rgb("e78284"),
            warning: rgb("e5c890"),
            success: rgb("a6d189"),
            text: rgb("c6d0f5"),
            text_muted: rgb("949cb8"),
            background: rgb("303446"),
            surface: rgb("292c3c"),
            element: rgb("232634"),
            border: rgb("414559"),
            border_active: rgb("51576d"),
        },
    ),
    // catppuccin-macchiato
    (
        "catppuccin-macchiato",
        Palette {
            primary: rgb("8aadf4"),
            secondary: rgb("c6a0f6"),
            accent: rgb("f5bde6"),
            error: rgb("ed8796"),
            warning: rgb("eed49f"),
            success: rgb("a6da95"),
            text: rgb("cad3f5"),
            text_muted: rgb("939ab7"),
            background: rgb("24273a"),
            surface: rgb("1e2030"),
            element: rgb("181926"),
            border: rgb("363a4f"),
            border_active: rgb("494d64"),
        },
    ),
    // cobalt2
    (
        "cobalt2",
        Palette {
            primary: rgb("0088ff"),
            secondary: rgb("9a5feb"),
            accent: rgb("2affdf"),
            error: rgb("ff0088"),
            warning: rgb("ffc600"),
            success: rgb("9eff80"),
            text: rgb("ffffff"),
            text_muted: rgb("adb7c9"),
            background: rgb("193549"),
            surface: rgb("122738"),
            element: rgb("1f4662"),
            border: rgb("1f4662"),
            border_active: rgb("0088ff"),
        },
    ),
    // cursor
    (
        "cursor",
        Palette {
            primary: rgb("88c0d0"),
            secondary: rgb("81a1c1"),
            accent: rgb("88c0d0"),
            error: rgb("e34671"),
            warning: rgb("f1b467"),
            success: rgb("3fa266"),
            text: rgb("e4e4e4"),
            text_muted: rgb("e4e4e4"),
            background: rgb("181818"),
            surface: rgb("141414"),
            element: rgb("262626"),
            border: rgb("e4e4e4"),
            border_active: rgb("88c0d0"),
        },
    ),
    // dracula
    (
        "dracula",
        Palette {
            primary: rgb("bd93f9"),
            secondary: rgb("ff79c6"),
            accent: rgb("8be9fd"),
            error: rgb("ff5555"),
            warning: rgb("f1fa8c"),
            success: rgb("50fa7b"),
            text: rgb("f8f8f2"),
            text_muted: rgb("6272a4"),
            background: rgb("282a36"),
            surface: rgb("21222c"),
            element: rgb("44475a"),
            border: rgb("44475a"),
            border_active: rgb("bd93f9"),
        },
    ),
    // everforest
    (
        "everforest",
        Palette {
            primary: rgb("a7c080"),
            secondary: rgb("7fbbb3"),
            accent: rgb("d699b6"),
            error: rgb("e67e80"),
            warning: rgb("e69875"),
            success: rgb("a7c080"),
            text: rgb("d3c6aa"),
            text_muted: rgb("7a8478"),
            background: rgb("2d353b"),
            surface: rgb("333c43"),
            element: rgb("343f44"),
            border: rgb("859289"),
            border_active: rgb("9da9a0"),
        },
    ),
    // flexoki
    (
        "flexoki",
        Palette {
            primary: rgb("DA702C"),
            secondary: rgb("4385BE"),
            accent: rgb("8B7EC8"),
            error: rgb("D14D41"),
            warning: rgb("DA702C"),
            success: rgb("879A39"),
            text: rgb("CECDC3"),
            text_muted: rgb("6F6E69"),
            background: rgb("100F0F"),
            surface: rgb("1C1B1A"),
            element: rgb("282726"),
            border: rgb("575653"),
            border_active: rgb("6F6E69"),
        },
    ),
    // github
    (
        "github",
        Palette {
            primary: rgb("58a6ff"),
            secondary: rgb("bc8cff"),
            accent: rgb("39c5cf"),
            error: rgb("f85149"),
            warning: rgb("e3b341"),
            success: rgb("3fb950"),
            text: rgb("c9d1d9"),
            text_muted: rgb("8b949e"),
            background: rgb("0d1117"),
            surface: rgb("010409"),
            element: rgb("161b22"),
            border: rgb("30363d"),
            border_active: rgb("58a6ff"),
        },
    ),
    // gruvbox
    (
        "gruvbox",
        Palette {
            primary: rgb("83a598"),
            secondary: rgb("d3869b"),
            accent: rgb("8ec07c"),
            error: rgb("fb4934"),
            warning: rgb("fe8019"),
            success: rgb("b8bb26"),
            text: rgb("ebdbb2"),
            text_muted: rgb("928374"),
            background: rgb("282828"),
            surface: rgb("3c3836"),
            element: rgb("504945"),
            border: rgb("665c54"),
            border_active: rgb("ebdbb2"),
        },
    ),
    // kanagawa
    (
        "kanagawa",
        Palette {
            primary: rgb("7E9CD8"),
            secondary: rgb("957FB8"),
            accent: rgb("D27E99"),
            error: rgb("E82424"),
            warning: rgb("D7A657"),
            success: rgb("98BB6C"),
            text: rgb("DCD7BA"),
            text_muted: rgb("727169"),
            background: rgb("1F1F28"),
            surface: rgb("2A2A37"),
            element: rgb("363646"),
            border: rgb("54546D"),
            border_active: rgb("C38D9D"),
        },
    ),
    // material
    (
        "material",
        Palette {
            primary: rgb("82aaff"),
            secondary: rgb("c792ea"),
            accent: rgb("89ddff"),
            error: rgb("f07178"),
            warning: rgb("ffcb6b"),
            success: rgb("c3e88d"),
            text: rgb("eeffff"),
            text_muted: rgb("546e7a"),
            background: rgb("263238"),
            surface: rgb("1e272c"),
            element: rgb("37474f"),
            border: rgb("37474f"),
            border_active: rgb("82aaff"),
        },
    ),
    // matrix
    (
        "matrix",
        Palette {
            primary: rgb("2eff6a"),
            secondary: rgb("00efff"),
            accent: rgb("c770ff"),
            error: rgb("ff4b4b"),
            warning: rgb("e6ff57"),
            success: rgb("62ff94"),
            text: rgb("62ff94"),
            text_muted: rgb("8ca391"),
            background: rgb("0a0e0a"),
            surface: rgb("0e130d"),
            element: rgb("141c12"),
            border: rgb("1e2a1b"),
            border_active: rgb("2eff6a"),
        },
    ),
    // mercury
    (
        "mercury",
        Palette {
            primary: rgb("8da4f5"),
            secondary: rgb("a7b6f8"),
            accent: rgb("8da4f5"),
            error: rgb("fc92b4"),
            warning: rgb("fc9b6f"),
            success: rgb("77c599"),
            text: rgb("dddde5"),
            text_muted: rgb("9d9da8"),
            background: rgb("171721"),
            surface: rgb("10101a"),
            element: rgb("272735"),
            border: rgb("b4b7c8"),
            border_active: rgb("8da4f5"),
        },
    ),
    // monokai
    (
        "monokai",
        Palette {
            primary: rgb("66d9ef"),
            secondary: rgb("ae81ff"),
            accent: rgb("a6e22e"),
            error: rgb("f92672"),
            warning: rgb("e6db74"),
            success: rgb("a6e22e"),
            text: rgb("f8f8f2"),
            text_muted: rgb("75715e"),
            background: rgb("272822"),
            surface: rgb("1e1f1c"),
            element: rgb("3e3d32"),
            border: rgb("3e3d32"),
            border_active: rgb("66d9ef"),
        },
    ),
    // nightowl
    (
        "nightowl",
        Palette {
            primary: rgb("82AAFF"),
            secondary: rgb("7fdbca"),
            accent: rgb("c792ea"),
            error: rgb("EF5350"),
            warning: rgb("ecc48d"),
            success: rgb("c5e478"),
            text: rgb("d6deeb"),
            text_muted: rgb("5f7e97"),
            background: rgb("011627"),
            surface: rgb("0b253a"),
            element: rgb("0b253a"),
            border: rgb("5f7e97"),
            border_active: rgb("82AAFF"),
        },
    ),
    // nord
    (
        "nord",
        Palette {
            primary: rgb("88C0D0"),
            secondary: rgb("81A1C1"),
            accent: rgb("8FBCBB"),
            error: rgb("BF616A"),
            warning: rgb("D08770"),
            success: rgb("A3BE8C"),
            text: rgb("ECEFF4"),
            text_muted: rgb("8B95A7"),
            background: rgb("2E3440"),
            surface: rgb("3B4252"),
            element: rgb("434C5E"),
            border: rgb("434C5E"),
            border_active: rgb("4C566A"),
        },
    ),
    // one-dark
    (
        "one-dark",
        Palette {
            primary: rgb("61afef"),
            secondary: rgb("c678dd"),
            accent: rgb("56b6c2"),
            error: rgb("e06c75"),
            warning: rgb("e5c07b"),
            success: rgb("98c379"),
            text: rgb("abb2bf"),
            text_muted: rgb("5c6370"),
            background: rgb("282c34"),
            surface: rgb("21252b"),
            element: rgb("353b45"),
            border: rgb("393f4a"),
            border_active: rgb("61afef"),
        },
    ),
    // osaka-jade
    (
        "osaka-jade",
        Palette {
            primary: rgb("2DD5B7"),
            secondary: rgb("D2689C"),
            accent: rgb("549e6a"),
            error: rgb("FF5345"),
            warning: rgb("E5C736"),
            success: rgb("549e6a"),
            text: rgb("C1C497"),
            text_muted: rgb("53685B"),
            background: rgb("111c18"),
            surface: rgb("1a2520"),
            element: rgb("23372B"),
            border: rgb("3d4a44"),
            border_active: rgb("2DD5B7"),
        },
    ),
    // miao
    (
        "miao",
        Palette {
            primary: rgb("d77757"),
            secondary: rgb("b1b9f9"),
            accent: rgb("65d9ef"),
            error: rgb("ff6b80"),
            warning: rgb("ffc107"),
            success: rgb("4eba65"),
            text: rgb("f1f6ff"),
            text_muted: rgb("b9b9b6"),
            background: rgb("2e3440"),
            surface: rgb("343b49"),
            element: rgb("3b4252"),
            border: rgb("5d687d"),
            border_active: rgb("9aa6ba"),
        },
    ),
    // opencode
    (
        "opencode",
        Palette {
            primary: rgb("fab283"),
            secondary: rgb("5c9cf5"),
            accent: rgb("9d7cd8"),
            error: rgb("e06c75"),
            warning: rgb("f5a742"),
            success: rgb("7fd88f"),
            text: rgb("eeeeee"),
            text_muted: rgb("808080"),
            background: rgb("0a0a0a"),
            surface: rgb("141414"),
            element: rgb("1e1e1e"),
            border: rgb("484848"),
            border_active: rgb("606060"),
        },
    ),
    // orng
    (
        "orng",
        Palette {
            primary: rgb("EC5B2B"),
            secondary: rgb("EE7948"),
            accent: rgb("FFF7F1"),
            error: rgb("e06c75"),
            warning: rgb("EC5B2B"),
            success: rgb("6ba1e6"),
            text: rgb("eeeeee"),
            text_muted: rgb("808080"),
            background: rgb("0a0a0a"),
            surface: rgb("141414"),
            element: rgb("1e1e1e"),
            border: rgb("EC5B2B"),
            border_active: rgb("EE7948"),
        },
    ),
    // lucent-orng
    (
        "lucent-orng",
        Palette {
            primary: rgb("EC5B2B"),
            secondary: rgb("EE7948"),
            accent: rgb("FFF7F1"),
            error: rgb("e06c75"),
            warning: rgb("EC5B2B"),
            success: rgb("6ba1e6"),
            text: rgb("eeeeee"),
            text_muted: rgb("808080"),
            background: Color::Reset,
            surface: Color::Reset,
            element: Color::Reset,
            border: rgb("EC5B2B"),
            border_active: rgb("EE7948"),
        },
    ),
    // palenight
    (
        "palenight",
        Palette {
            primary: rgb("82aaff"),
            secondary: rgb("c792ea"),
            accent: rgb("89ddff"),
            error: rgb("f07178"),
            warning: rgb("ffcb6b"),
            success: rgb("c3e88d"),
            text: rgb("a6accd"),
            text_muted: rgb("676e95"),
            background: rgb("292d3e"),
            surface: rgb("1e2132"),
            element: rgb("32364a"),
            border: rgb("32364a"),
            border_active: rgb("82aaff"),
        },
    ),
    // rosepine
    (
        "rosepine",
        Palette {
            primary: rgb("9ccfd8"),
            secondary: rgb("c4a7e7"),
            accent: rgb("ebbcba"),
            error: rgb("eb6f92"),
            warning: rgb("f6c177"),
            success: rgb("31748f"),
            text: rgb("e0def4"),
            text_muted: rgb("6e6a86"),
            background: rgb("191724"),
            surface: rgb("1f1d2e"),
            element: rgb("26233a"),
            border: rgb("403d52"),
            border_active: rgb("9ccfd8"),
        },
    ),
    // solarized
    (
        "solarized",
        Palette {
            primary: rgb("268bd2"),
            secondary: rgb("6c71c4"),
            accent: rgb("2aa198"),
            error: rgb("dc322f"),
            warning: rgb("b58900"),
            success: rgb("859900"),
            text: rgb("839496"),
            text_muted: rgb("586e75"),
            background: rgb("002b36"),
            surface: rgb("073642"),
            element: rgb("073642"),
            border: rgb("073642"),
            border_active: rgb("586e75"),
        },
    ),
    // synthwave84
    (
        "synthwave84",
        Palette {
            primary: rgb("36f9f6"),
            secondary: rgb("ff7edb"),
            accent: rgb("b084eb"),
            error: rgb("fe4450"),
            warning: rgb("fede5d"),
            success: rgb("72f1b8"),
            text: rgb("ffffff"),
            text_muted: rgb("848bbd"),
            background: rgb("262335"),
            surface: rgb("1e1a29"),
            element: rgb("2a2139"),
            border: rgb("495495"),
            border_active: rgb("36f9f6"),
        },
    ),
    // tokyonight
    (
        "tokyonight",
        Palette {
            primary: rgb("82aaff"),
            secondary: rgb("c099ff"),
            accent: rgb("ff966c"),
            error: rgb("ff757f"),
            warning: rgb("ff966c"),
            success: rgb("c3e88d"),
            text: rgb("c8d3f5"),
            text_muted: rgb("828bb8"),
            background: rgb("1a1b26"),
            surface: rgb("1e2030"),
            element: rgb("222436"),
            border: rgb("737aa2"),
            border_active: rgb("9099b2"),
        },
    ),
    // vesper
    (
        "vesper",
        Palette {
            primary: rgb("FFC799"),
            secondary: rgb("99FFE4"),
            accent: rgb("FFC799"),
            error: rgb("FF8080"),
            warning: rgb("FFC799"),
            success: rgb("99FFE4"),
            text: rgb("FFFFFF"),
            text_muted: rgb("A0A0A0"),
            background: rgb("101010"),
            surface: rgb("101010"),
            element: rgb("101010"),
            border: rgb("282828"),
            border_active: rgb("FFC799"),
        },
    ),
    // vercel
    (
        "vercel",
        Palette {
            primary: rgb("0070F3"),
            secondary: rgb("52A8FF"),
            accent: rgb("8E4EC6"),
            error: rgb("E5484D"),
            warning: rgb("FFB224"),
            success: rgb("46A758"),
            text: rgb("EDEDED"),
            text_muted: rgb("878787"),
            background: rgb("000000"),
            surface: rgb("1A1A1A"),
            element: rgb("292929"),
            border: rgb("1F1F1F"),
            border_active: rgb("454545"),
        },
    ),
    // zenburn
    (
        "zenburn",
        Palette {
            primary: rgb("8cd0d3"),
            secondary: rgb("dc8cc3"),
            accent: rgb("93e0e3"),
            error: rgb("cc9393"),
            warning: rgb("f0dfaf"),
            success: rgb("7f9f7f"),
            text: rgb("dcdccc"),
            text_muted: rgb("9f9f9f"),
            background: rgb("3f3f3f"),
            surface: rgb("4f4f4f"),
            element: rgb("5f5f5f"),
            border: rgb("5f5f5f"),
            border_active: rgb("8cd0d3"),
        },
    ),
    // carbonfox
    (
        "carbonfox",
        Palette {
            primary: rgb("33b1ff"),
            secondary: rgb("78a9ff"),
            accent: rgb("ff7eb6"),
            error: rgb("ee5396"),
            warning: rgb("f1c21b"),
            success: rgb("25be6a"),
            text: rgb("f2f4f8"),
            text_muted: rgb("7d848f"),
            background: rgb("161616"),
            surface: rgb("1a1a1a"),
            element: rgb("1e1e1e"),
            border: rgb("303030"),
            border_active: rgb("33b1ff"),
        },
    ),
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
    pub fn from_custom(custom: impl IntoIterator<Item = (String, Palette)>) -> Self {
        let mut entries: Vec<(String, Palette)> = BUILTIN_THEMES
            .iter()
            .map(|(name, palette)| (name.to_string(), *palette))
            .collect();
        for (name, palette) in custom {
            match entries.iter_mut().find(|(existing, _)| *existing == name) {
                Some(entry) => entry.1 = palette,
                None => entries.push((name, palette)),
            }
        }
        Self { entries }
    }

    pub fn builtin() -> Self {
        Self::from_custom(std::iter::empty())
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

pub fn builtin(name: &str) -> Option<Palette> {
    BUILTIN_THEMES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, palette)| *palette)
}

pub fn load(workspace: &Path) -> Loaded {
    load_at(workspace, crate::config::global_dir().as_deref())
}

pub(crate) fn load_at(workspace: &Path, global: Option<&Path>) -> Loaded {
    let mut warnings = Vec::new();
    let mut name = String::new();
    for path in crate::config::files(workspace, global) {
        match std::fs::read_to_string(&path) {
            Ok(text) => merge(&text, &path, &mut name, &mut warnings),
            Err(err) => warnings.push(format!("failed to read {}: {err}", path.display())),
        }
    }
    let catalog = Catalog::from_custom(custom_themes(workspace, global, &mut warnings));
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
            builtin(DEFAULT_THEME).expect("default theme is built in")
        }
    };
    Loaded {
        theme: Theme { name, palette },
        catalog,
        warnings,
    }
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
            match parse_theme(&text) {
                Ok(palette) => {
                    themes.insert(name.to_string(), palette);
                }
                Err(reason) => {
                    warnings.push(format!("skipping theme {}: {reason}", file.display()))
                }
            }
        }
    }
    themes
}

/// Reads the TypeScript theme file shape: a `theme` object of named colors,
/// `defs` for shared references, `{dark, light}` pairs, and ANSI color codes.
/// The Rust TUI is dark-only for now, so the `dark` half of a pair wins.
fn parse_theme(text: &str) -> Result<Palette, String> {
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
        resolve_color(raw, theme, defs, &mut Vec::new())
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
            let resolved = resolve_color(next, theme, defs, chain);
            chain.pop();
            resolved
        }
        serde_json::Value::Number(code) => code
            .as_u64()
            .and_then(|code| u8::try_from(code).ok())
            .map(ansi_color)
            .ok_or_else(|| format!("invalid ANSI color code {code}")),
        serde_json::Value::Object(variant) => {
            let dark = variant.get("dark").ok_or("color has no \"dark\" value")?;
            resolve_color(dark, theme, defs, chain)
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

/// Top-level `tui.json` fields the TypeScript host understands. The ones this
/// loader does not read belong to another loader or are not mirrored yet, but
/// none of them is an unknown field.
const KNOWN_FIELDS: &[&str] = &[
    "$schema",
    "theme",
    "tui",
    "keybinds",
    "plugin",
    "plugin_enabled",
    "leader_timeout",
    "attention",
    "prompt",
    "scroll_speed",
    "scroll_acceleration",
    "diff_style",
    "cursor",
    "mouse",
];

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
    for key in object.keys() {
        if !KNOWN_FIELDS.contains(&key.as_str()) {
            warnings.push(format!(
                "tui config {}: ignoring unsupported field \"{key}\"",
                path.display()
            ));
        }
    }
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
                if next >= chars.len() || (chars[next] != '}' && chars[next] != ']') {
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
        for (name, _) in BUILTIN_THEMES {
            assert!(builtin(name).is_some());
        }
        assert!(builtin("nope").is_none());
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
        assert_ne!(nord.secondary, builtin("nord").unwrap().secondary);
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
}
