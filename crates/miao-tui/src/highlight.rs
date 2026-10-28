//! Line-oriented syntax highlighting for fenced code blocks.
//!
//! The transcript is a reading surface for code the model wrote, and a block in
//! one color is harder to read than the same text in an editor. There is no
//! grammar engine here: a fence's info string selects one of a few language
//! families, and a small scanner colors comments, strings, numbers, and
//! keywords. Anything it does not recognize keeps the plain text style, so the
//! worst case is the old single-color block and an unknown language is never
//! guessed at.

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

use crate::theme::Palette;

/// Languages that share a comment syntax and a keyword set. `None` — an info
/// string outside the table below — renders the block in one color.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Family {
    /// `//` and `/* */` comments, where `'` is a character literal and `&'a` is
    /// a lifetime rather than a quote.
    Rust,
    /// `//` and `/* */` comments: TS/JS, C-family, Go, Java, Swift.
    CLike,
    /// `#` comments: Python, Ruby, TOML, YAML, INI.
    Hash,
    /// `#` comments with shell control keywords.
    Shell,
    /// No comments, `true`/`false`/`null` keywords.
    Json,
}

fn family(info: &str) -> Option<Family> {
    // A fence can carry attributes after the language (`rust,no_run`), so only
    // the leading word names the language.
    let language = info
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '+')
        .next()?
        .to_ascii_lowercase();
    Some(match language.as_str() {
        "rust" | "rs" => Family::Rust,
        "c" | "h" | "cpp" | "c++" | "cc" | "java" | "csharp" | "cs" | "go" | "golang" | "ts"
        | "tsx" | "typescript" | "js" | "jsx" | "javascript" | "swift" | "kotlin" | "kt"
        | "scala" | "php" | "dart" => Family::CLike,
        "py" | "python" | "rb" | "ruby" | "toml" | "yaml" | "yml" | "ini" => Family::Hash,
        "sh" | "bash" | "zsh" | "shell" | "console" => Family::Shell,
        "json" | "jsonc" => Family::Json,
        _ => return None,
    })
}

const C_LIKE: &[&str] = &[
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "crate",
    "default",
    "defer",
    "do",
    "dyn",
    "else",
    "enum",
    "extends",
    "extern",
    "false",
    "finally",
    "fn",
    "for",
    "from",
    "func",
    "function",
    "go",
    "if",
    "impl",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "loop",
    "map",
    "match",
    "mod",
    "move",
    "mut",
    "new",
    "null",
    "package",
    "private",
    "pub",
    "public",
    "range",
    "ref",
    "return",
    "self",
    "static",
    "struct",
    "super",
    "switch",
    "this",
    "throw",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unsafe",
    "use",
    "var",
    "void",
    "where",
    "while",
    "yield",
];

const HASH: &[&str] = &[
    "and", "as", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
    "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "None", "not", "or", "pass", "raise", "return", "self", "True", "try", "while", "with",
    "yield",
];

const SHELL: &[&str] = &[
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in",
    "local", "return", "set", "source", "then", "until", "while",
];

const JSON: &[&str] = &["false", "null", "true"];

fn keywords(family: Family) -> &'static [&'static str] {
    match family {
        Family::Rust | Family::CLike => C_LIKE,
        Family::Hash => HASH,
        Family::Shell => SHELL,
        Family::Json => JSON,
    }
}

fn uses_slash_comments(family: Family) -> bool {
    matches!(family, Family::Rust | Family::CLike)
}

/// Colors one fenced block, carrying block-comment state across its lines.
pub struct Highlighter {
    family: Option<Family>,
    block_comment: bool,
    palette: Palette,
}

impl Highlighter {
    pub fn new(info: &str, palette: Palette) -> Self {
        Self {
            family: family(info),
            block_comment: false,
            palette,
        }
    }

    /// Split one body line into styled spans. Concatenating the spans always
    /// reproduces the input line, so nothing the scanner misreads is lost.
    pub fn line(&mut self, text: &str) -> Vec<Span<'static>> {
        let Some(family) = self.family else {
            return vec![Span::styled(text.to_string(), self.text())];
        };
        let keywords = keywords(family);
        let mut spans = Vec::new();
        // Start of the run of text that has not been assigned a style yet.
        let mut plain = 0;
        let mut index = 0;
        while index < text.len() {
            let rest = &text[index..];
            if self.block_comment {
                match rest.find("*/") {
                    Some(end) => {
                        let stop = index + end + 2;
                        self.push(&mut spans, &text[index..stop], self.comment());
                        index = stop;
                        plain = index;
                        self.block_comment = false;
                    }
                    None => {
                        self.push(&mut spans, rest, self.comment());
                        return spans;
                    }
                }
                continue;
            }
            let Some(c) = rest.chars().next() else {
                break;
            };
            let width = c.len_utf8();
            match c {
                '/' if rest.starts_with("//") && uses_slash_comments(family) => {
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, rest, self.comment());
                    return spans;
                }
                '/' if rest.starts_with("/*") && uses_slash_comments(family) => {
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, "/*", self.comment());
                    self.block_comment = true;
                    index += 2;
                    plain = index;
                }
                '#' if matches!(family, Family::Hash | Family::Shell) => {
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, rest, self.comment());
                    return spans;
                }
                // In Rust `'` opens a character literal far less often than it
                // marks a lifetime (`&'a str`), so an unpaired quote is left as
                // text instead of coloring the rest of the line.
                '\'' if family == Family::Rust => {
                    let Some(stop) = rust_char_end(text, index) else {
                        index += width;
                        continue;
                    };
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, &text[index..stop], self.string());
                    index = stop;
                    plain = index;
                }
                '\'' | '"' | '`' => {
                    // An unterminated quote runs to the end of its own line
                    // rather than leaking the string color onto later lines.
                    let stop = quote_end(text, index, c).unwrap_or(text.len());
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, &text[index..stop], self.string());
                    index = stop;
                    plain = index;
                }
                c if c.is_ascii_digit() => {
                    let stop = number_end(text, index);
                    self.push(&mut spans, &text[plain..index], self.text());
                    self.push(&mut spans, &text[index..stop], self.number());
                    index = stop;
                    plain = index;
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let stop = identifier_end(text, index);
                    if keywords.contains(&&text[index..stop]) {
                        self.push(&mut spans, &text[plain..index], self.text());
                        self.push(&mut spans, &text[index..stop], self.keyword());
                        plain = stop;
                    }
                    index = stop;
                }
                _ => index += width,
            }
        }
        self.push(&mut spans, &text[plain..], self.text());
        spans
    }

    fn text(&self) -> Style {
        Style::new().fg(self.palette.text)
    }

    fn comment(&self) -> Style {
        Style::new()
            .fg(self.palette.text_muted)
            .add_modifier(Modifier::ITALIC)
    }

    fn string(&self) -> Style {
        Style::new().fg(self.palette.success)
    }

    fn number(&self) -> Style {
        Style::new().fg(self.palette.warning)
    }

    fn keyword(&self) -> Style {
        Style::new().fg(self.palette.secondary)
    }

    fn push(&self, spans: &mut Vec<Span<'static>>, text: &str, style: Style) {
        if text.is_empty() {
            return;
        }
        spans.push(Span::styled(text.to_string(), style));
    }
}

/// End of the quoted run starting at `start`, or `None` when it is unterminated.
/// A backslash escapes the next character, so `"a\"b"` stays one string.
fn quote_end(text: &str, start: usize, quote: char) -> Option<usize> {
    let mut index = start + quote.len_utf8();
    let mut escaped = false;
    while index < text.len() {
        let c = text[index..].chars().next().expect("char boundary");
        index += c.len_utf8();
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == quote {
            return Some(index);
        }
    }
    None
}

/// End of a Rust character literal: one character or one escape between
/// quotes. Anything else — `&'a str`, `'static`, an apostrophe in prose — is not
/// a literal, and `''` is not one either.
fn rust_char_end(text: &str, start: usize) -> Option<usize> {
    let mut index = start + 1;
    let first = text[index..].chars().next()?;
    if first == '\'' {
        return None;
    }
    index += first.len_utf8();
    if first == '\\' {
        let kind = text[index..].chars().next()?;
        index += kind.len_utf8();
        index += match kind {
            'x' => 2,
            'u' => text[index..].find('}')? + 1,
            _ => 0,
        };
    }
    if index >= text.len() {
        return None;
    }
    text[index..].starts_with('\'').then_some(index + 1)
}

fn number_end(text: &str, start: usize) -> usize {
    let mut index = start;
    while index < text.len() {
        let c = text[index..].chars().next().expect("char boundary");
        // Digits, hex letters, exponents, float points, and separators all stay
        // in one run; anything else ends it.
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            index += c.len_utf8();
            continue;
        }
        break;
    }
    index
}

fn identifier_end(text: &str, start: usize) -> usize {
    let mut index = start;
    while index < text.len() {
        let c = text[index..].chars().next().expect("char boundary");
        if c.is_ascii_alphanumeric() || c == '_' {
            index += c.len_utf8();
            continue;
        }
        break;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme;
    use ratatui::style::Color;

    fn palette() -> Palette {
        theme::builtin("miao").expect("builtin theme")
    }

    fn text(spans: &[Span<'_>]) -> String {
        spans.iter().map(|span| span.content.as_ref()).collect()
    }

    fn colored(spans: &[Span<'_>], color: Color) -> Vec<String> {
        spans
            .iter()
            .filter(|span| span.style.fg == Some(color))
            .map(|span| span.content.to_string())
            .collect()
    }

    #[test]
    fn a_rust_line_colors_its_keywords_numbers_and_comment() {
        let mut highlighter = Highlighter::new("rust", palette());
        let line = "let x = 42; // note";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(colored(&spans, palette().secondary), vec!["let"]);
        assert_eq!(colored(&spans, palette().warning), vec!["42"]);
        assert_eq!(colored(&spans, palette().text_muted), vec!["// note"]);
    }

    #[test]
    fn a_block_comment_carries_across_lines() {
        let mut highlighter = Highlighter::new("rust", palette());
        let spans = highlighter.line("/* open");
        assert_eq!(text(&spans), "/* open");
        assert_eq!(colored(&spans, palette().text_muted), vec!["/*", " open"]);
        let spans = highlighter.line("close */ fn main");
        assert_eq!(text(&spans), "close */ fn main");
        assert_eq!(colored(&spans, palette().text_muted), vec!["close */"]);
        assert_eq!(colored(&spans, palette().secondary), vec!["fn"]);
    }

    #[test]
    fn strings_keep_their_escapes_and_their_own_bounds() {
        let mut highlighter = Highlighter::new("ts", palette());
        let line = r#"const path = "a\"b" + 'c'"#;
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(colored(&spans, palette().success), vec![r#""a\"b""#, "'c'"]);
    }

    #[test]
    fn a_rust_char_literal_is_a_string_but_lifetimes_are_not() {
        let mut highlighter = Highlighter::new("rust", palette());
        let line = "fn borrow<'a>(c: char) -> &'a str { let q = '\\''; }";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(colored(&spans, palette().success), vec!["'\\''"]);
    }

    #[test]
    fn an_unterminated_double_quote_stops_at_the_end_of_its_line() {
        let mut highlighter = Highlighter::new("rust", palette());
        let spans = highlighter.line(r#"let s = "open"#);
        assert_eq!(colored(&spans, palette().success), vec![r#""open"#]);
        let spans = highlighter.line("let t = 1;");
        assert!(colored(&spans, palette().success).is_empty(), "{spans:?}");
    }

    #[test]
    fn json_keywords_are_not_treated_as_comments() {
        let mut highlighter = Highlighter::new("json", palette());
        let line = r#"{"ok": true, "n": 3}"#;
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(colored(&spans, palette().secondary), vec!["true"]);
        assert!(
            colored(&spans, palette().text_muted).is_empty(),
            "{spans:?}"
        );
    }

    #[test]
    fn an_unknown_language_stays_one_span_in_text_color() {
        let mut highlighter = Highlighter::new("diff", palette());
        let line = "- let x = 1 // not a comment";
        let spans = highlighter.line(line);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].content.as_ref(), line);
        assert_eq!(spans[0].style.fg, Some(palette().text));
    }

    #[test]
    fn shell_comments_and_control_keywords_are_recognized() {
        let mut highlighter = Highlighter::new("bash", palette());
        let line = "if [ -f x ]; then echo hi # done";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(colored(&spans, palette().text_muted), vec!["# done"]);
        assert!(colored(&spans, palette().secondary).contains(&"if".to_string()));
    }
}
