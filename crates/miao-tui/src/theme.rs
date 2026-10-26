use std::path::{Path, PathBuf};

use ratatui::style::Color;

#[derive(Debug, Clone, Copy)]
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
    pub warnings: Vec<String>,
}

const BUILTIN_THEMES: &[(&str, Palette)] = &[
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
    (
        "nord",
        Palette {
            primary: rgb("88c0d0"),
            secondary: rgb("81a1c1"),
            accent: rgb("8fbcbb"),
            error: rgb("bf616a"),
            warning: rgb("d08770"),
            success: rgb("a3be8c"),
            text: rgb("eceff4"),
            text_muted: rgb("8b95a7"),
            background: rgb("2e3440"),
            surface: rgb("3b4252"),
            element: rgb("434c5e"),
            border: rgb("434c5e"),
            border_active: rgb("4c566a"),
        },
    ),
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
    (
        "vesper",
        Palette {
            primary: rgb("ffc799"),
            secondary: rgb("99ffe4"),
            accent: rgb("ffc799"),
            error: rgb("ff8080"),
            warning: rgb("ffc799"),
            success: rgb("99ffe4"),
            text: rgb("ffffff"),
            text_muted: rgb("a0a0a0"),
            background: rgb("101010"),
            surface: rgb("101010"),
            element: rgb("101010"),
            border: rgb("282828"),
            border_active: rgb("ffc799"),
        },
    ),
];

pub const DEFAULT_THEME: &str = "miao";

pub fn builtin(name: &str) -> Option<Palette> {
    BUILTIN_THEMES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, palette)| *palette)
}

pub fn load(workspace: &Path) -> Loaded {
    let mut warnings = Vec::new();
    let mut name = String::new();
    for path in config_chain(workspace) {
        match std::fs::read_to_string(&path) {
            Ok(text) => merge(&text, &path, &mut name, &mut warnings),
            Err(err) => warnings.push(format!("failed to read {}: {err}", path.display())),
        }
    }
    if name.is_empty() {
        name = DEFAULT_THEME.to_string();
    }
    let palette = match builtin(&name) {
        Some(palette) => palette,
        None => {
            warnings.push(format!(
                "unknown theme \"{name}\", falling back to {DEFAULT_THEME}"
            ));
            builtin(DEFAULT_THEME).expect("default theme is built in")
        }
    };
    Loaded {
        theme: Theme { name, palette },
        warnings,
    }
}

fn config_chain(workspace: &Path) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    let mut dir = Some(workspace);
    while let Some(current) = dir {
        let candidate = current.join(".miao").join("tui.json");
        if candidate.is_file() {
            chain.push(candidate);
        }
        dir = current.parent();
    }
    chain.reverse();
    chain
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
    for (key, value) in object {
        match key.as_str() {
            "$schema" => {}
            "theme" => match value.as_str() {
                Some(theme) => *name = theme.to_string(),
                None => warnings.push(format!(
                    "tui config {}: theme must be a string, ignoring",
                    path.display()
                )),
            },
            other => warnings.push(format!(
                "tui config {}: ignoring unsupported field \"{other}\"",
                path.display()
            )),
        }
    }
}

fn strip_jsonc(input: &str) -> String {
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
                    for rest in chars.by_ref() {
                        if rest == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut previous = '\0';
                    for rest in chars.by_ref() {
                        if previous == '*' && rest == '/' {
                            break;
                        }
                        previous = rest;
                    }
                    out.push(' ');
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
    fn built_in_palettes_resolve() {
        for (name, _) in BUILTIN_THEMES {
            assert!(builtin(name).is_some());
        }
        assert!(builtin("nope").is_none());
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
