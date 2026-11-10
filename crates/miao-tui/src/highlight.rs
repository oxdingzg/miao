//! Line-oriented syntax highlighting for fenced code blocks and diff bodies.
//!
//! The grammars are TextMate definitions: the Sublime defaults plus the extra
//! set bat carries, bundled by `two-face` and read through `syntect`. That is
//! the grammar family the editor's shiki pipeline resolves, so a Rust `impl`,
//! a Java `public`, and a C++ `#include` are coloured by their own language
//! rather than by one table standing in for several of them.
//!
//! A grammar reports scopes, not colours. Every scope stack is folded onto the
//! theme's nine `syntax*` tokens here, so code reads the same as in the rest of
//! miao and a theme switch recolours it. An info string no grammar claims keeps
//! the plain text colour, which is the old single-colour block.

use std::str::FromStr;
use std::sync::OnceLock;

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use syntect::highlighting::ScopeSelectors;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::theme::Palette;

/// Every bundled grammar, loaded once on the first fenced block or diff row: a
/// session that shows no code never pays for the tables.
fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_no_newlines)
}

/// The grammar an info string names, or `None` when nothing claims it.
///
/// `find_syntax_by_token` takes a file extension or a case-insensitive name,
/// which covers both a fence (`rust`, `cpp`) and a diff row's file path
/// (`main.rs`, `Main.java`).
fn find(info: &str) -> Option<&'static SyntaxReference> {
    // A fence can carry attributes after the language (`rust,no_run`), so only
    // the leading word names the language.
    let language = info
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '+' && c != '#' && c != '-')
        .next()?;
    if language.is_empty() {
        return None;
    }
    let set = syntaxes();
    set.find_syntax_by_token(language)
        .or_else(|| alias(language).and_then(|name| set.find_syntax_by_name(name)))
}

/// A fence token whose grammar the bundled set names differently, or that reads
/// as a variant of one it has: `jsx` is JavaScript to a TextMate grammar, and
/// JSON5 is JSON. Nothing here invents a grammar the set does not carry —
/// PowerShell, for one, has none and renders plain.
fn alias(language: &str) -> Option<&'static str> {
    let language = language.to_ascii_lowercase();
    Some(match language.as_str() {
        "jsx" | "mjs" | "cjs" => "JavaScript",
        "jsonc" | "json5" | "jsonl" => "JSON",
        "mts" | "cts" => "TypeScript",
        _ => return None,
    })
}

/// One class of code token. A grammar's scopes say which class a run of code is;
/// the theme says what that class looks like.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Token {
    Text,
    Comment,
    Keyword,
    Function,
    Variable,
    String,
    Number,
    Kind,
    Operator,
    Punctuation,
}

/// The scope selectors that fold a grammar onto [`Token`], parsed once.
struct Rules {
    comment: ScopeSelectors,
    string: ScopeSelectors,
    constant: ScopeSelectors,
    operator: ScopeSelectors,
    keyword: ScopeSelectors,
    kind: ScopeSelectors,
    function: ScopeSelectors,
    variable: ScopeSelectors,
    punctuation: ScopeSelectors,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(Rules::bundled)
}

impl Rules {
    fn bundled() -> Self {
        let selector =
            |spec: &str| ScopeSelectors::from_str(spec).expect("built-in scope selectors parse");
        Self {
            // A comment's `//` or `#` markers are definition punctuation, but a
            // reader sees them as part of the comment.
            comment: selector("comment, punctuation.definition.comment"),
            string: selector("string, constant.character.escape, punctuation.definition.string"),
            // Literals such as `true`, `null`, and `None` are constants in the
            // TextMate scopes; the product paints constants with the number hue.
            constant: selector("constant, support.constant"),
            operator: selector("keyword.operator"),
            keyword: selector("keyword, storage"),
            kind: selector(
                "entity.name.type, entity.name.class, entity.name.struct, entity.name.enum, \
                 entity.name.trait, entity.name.union, entity.name.interface, entity.name.tag, \
                 entity.name.namespace, entity.other.inherited-class, support.type, \
                 support.class, support.other",
            ),
            function: selector(
                "entity.name.function, entity.name.function.macro, support.function, \
                 variable.function, meta.function-call",
            ),
            variable: selector("variable, variable.parameter, variable.other"),
            punctuation: selector("punctuation"),
        }
    }

    /// The class of the innermost scope that names one. Deeper scopes win, so a
    /// string inside a call is a string and not the call's scope.
    fn token(&self, stack: &[Scope]) -> Token {
        let hit = |selector: &ScopeSelectors| selector.does_match(stack).is_some();
        if hit(&self.comment) {
            return Token::Comment;
        }
        if hit(&self.string) {
            return Token::String;
        }
        if hit(&self.constant) {
            return Token::Number;
        }
        // `keyword.operator` is also a `keyword`, so it has to be asked first.
        if hit(&self.operator) {
            return Token::Operator;
        }
        if hit(&self.keyword) {
            return Token::Keyword;
        }
        if hit(&self.kind) {
            return Token::Kind;
        }
        if hit(&self.function) {
            return Token::Function;
        }
        if hit(&self.variable) {
            return Token::Variable;
        }
        if hit(&self.punctuation) {
            return Token::Punctuation;
        }
        Token::Text
    }
}

/// Colors one fenced block or diff body, carrying the grammar's state (an open
/// block comment, a multi-line string) across its lines.
pub struct Highlighter {
    parse: Option<ParseState>,
    scopes: ScopeStack,
    palette: Palette,
}

impl Highlighter {
    pub fn new(info: &str, palette: Palette) -> Self {
        Self {
            parse: find(info).map(ParseState::new),
            scopes: ScopeStack::new(),
            palette,
        }
    }

    /// Split one body line into styled spans. Concatenating the spans always
    /// reproduces the input line, so nothing a grammar misreads is lost.
    pub fn line(&mut self, text: &str) -> Vec<Span<'static>> {
        let Some(parse) = self.parse.as_mut() else {
            return vec![Span::styled(text.to_string(), self.plain())];
        };
        let Ok(ops) = parse.parse_line(text, syntaxes()) else {
            return vec![Span::styled(text.to_string(), self.plain())];
        };
        let mut spans = Vec::new();
        let mut start = 0;
        for (index, op) in ops {
            if index > start {
                self.push(&mut spans, &text[start..index]);
                start = index;
            }
            // A stack that refuses an operation cannot classify the rest of the
            // line, and a wrong colour is worse than none: paint the tail in the
            // plain text colour.
            if self.scopes.apply(&op).is_err() {
                self.push(&mut spans, &text[start..]);
                return spans;
            }
        }
        self.push(&mut spans, &text[start..]);
        spans
    }

    fn push(&self, spans: &mut Vec<Span<'static>>, text: &str) {
        if text.is_empty() {
            return;
        }
        let style = self.style(rules().token(self.scopes.as_slice()));
        match spans.last_mut() {
            Some(span) if span.style == style => span.content.to_mut().push_str(text),
            _ => spans.push(Span::styled(text.to_string(), style)),
        }
    }

    fn plain(&self) -> Style {
        Style::new().fg(self.palette.text)
    }

    fn style(&self, token: Token) -> Style {
        let syntax = self.palette.syntax;
        match token {
            Token::Text => self.plain(),
            // Italic is what keeps a comment readable as prose next to code.
            Token::Comment => Style::new()
                .fg(syntax.comment)
                .add_modifier(Modifier::ITALIC),
            Token::Keyword => Style::new().fg(syntax.keyword),
            Token::Function => Style::new().fg(syntax.function),
            Token::Variable => Style::new().fg(syntax.variable),
            Token::String => Style::new().fg(syntax.string),
            Token::Number => Style::new().fg(syntax.number),
            Token::Kind => Style::new().fg(syntax.kind),
            Token::Operator => Style::new().fg(syntax.operator),
            Token::Punctuation => Style::new().fg(syntax.punctuation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme;
    use ratatui::style::Color;

    fn palette() -> Palette {
        theme::builtin("miao", crate::theme::ThemeMode::Dark).expect("builtin theme")
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

    /// Spans in one colour, split by the italic that marks a comment.
    fn colored_comment(spans: &[Span<'_>], color: Color) -> Vec<String> {
        spans
            .iter()
            .filter(|span| {
                span.style.fg == Some(color) && span.style.add_modifier.contains(Modifier::ITALIC)
            })
            .map(|span| span.content.to_string())
            .collect()
    }

    fn colored_code(spans: &[Span<'_>], color: Color) -> Vec<String> {
        spans
            .iter()
            .filter(|span| {
                span.style.fg == Some(color) && !span.style.add_modifier.contains(Modifier::ITALIC)
            })
            .map(|span| span.content.to_string())
            .collect()
    }

    #[test]
    fn the_bundled_grammars_cover_the_languages_the_transcript_shows() {
        for language in [
            "rs",
            "rust",
            "java",
            "cpp",
            "c++",
            "c",
            "h",
            "cs",
            "go",
            "ts",
            "tsx",
            "js",
            "jsx",
            "py",
            "rb",
            "php",
            "swift",
            "kt",
            "scala",
            "dart",
            "lua",
            "sh",
            "bash",
            "zsh",
            "toml",
            "yaml",
            "yml",
            "ini",
            "json",
            "jsonc",
            "sql",
            "html",
            "css",
            "scss",
            "xml",
            "md",
            "dockerfile",
            "makefile",
            "ex",
            "exs",
            "hs",
            "ml",
            "clj",
            "r",
            "pl",
            "vue",
            "svelte",
            "proto",
            "graphql",
            "tf",
            "zig",
            "nim",
            "jl",
            "tex",
        ] {
            assert!(find(language).is_some(), "no grammar for {language}");
        }
        // A language the bundled set carries no grammar for stays plain rather
        // than borrowing a neighbour's keywords.
        assert!(find("ps1").is_none());
    }

    #[test]
    fn a_rust_line_colors_its_keywords_numbers_and_comment() {
        let mut highlighter = Highlighter::new("rust", palette());
        let line = "let x = 42; // note";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        // The default theme gives keywords and operators one hue, so `=` lands
        // in the same bucket as `let`; what matters is that both are painted.
        assert!(
            colored_code(&spans, palette().syntax.keyword).contains(&"let".to_string()),
            "{spans:?}"
        );
        assert_eq!(colored(&spans, palette().syntax.number), vec!["42"]);
        assert_eq!(
            colored_comment(&spans, palette().syntax.comment),
            vec!["// note"]
        );
    }

    #[test]
    fn each_language_colors_its_own_keywords() {
        // `public` is a Java and C++ keyword and an ordinary identifier in Rust;
        // `impl` is the other way round. One shared keyword table cannot tell
        // them apart, which is what the scanner this replaced did.
        let mut java = Highlighter::new("java", palette());
        let java = java.line("public class Main {}");
        assert!(
            colored_code(&java, palette().syntax.keyword).contains(&"public".to_string()),
            "{java:?}"
        );
        let mut rust = Highlighter::new("rust", palette());
        let rust = rust.line("public impl Thing {}");
        let rust_keywords = colored_code(&rust, palette().syntax.keyword);
        assert!(rust_keywords.contains(&"impl".to_string()), "{rust:?}");
        assert!(
            !rust_keywords.contains(&"public".to_string()),
            "Rust has no `public` keyword: {rust:?}"
        );
    }

    #[test]
    fn a_cpp_preprocessor_directive_is_not_one_color() {
        let mut highlighter = Highlighter::new("cpp", palette());
        let line = "#include <vector>";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert!(
            spans
                .iter()
                .any(|span| span.content.contains("#include")
                    && span.style.fg != Some(palette().text)),
            "the directive carries a token colour: {spans:?}"
        );
    }

    #[test]
    fn a_function_name_is_not_its_keyword() {
        let mut highlighter = Highlighter::new("rust", palette());
        let spans = highlighter.line("fn main() {");
        assert!(
            colored_code(&spans, palette().syntax.keyword).contains(&"fn".to_string()),
            "{spans:?}"
        );
        assert!(
            colored_code(&spans, palette().syntax.function).contains(&"main".to_string()),
            "{spans:?}"
        );
    }

    #[test]
    fn a_block_comment_carries_across_lines() {
        let mut highlighter = Highlighter::new("rust", palette());
        let spans = highlighter.line("/* open");
        assert_eq!(text(&spans), "/* open");
        assert_eq!(
            colored_comment(&spans, palette().syntax.comment),
            vec!["/* open"]
        );
        let spans = highlighter.line("close */ fn main");
        assert_eq!(text(&spans), "close */ fn main");
        assert_eq!(
            colored_comment(&spans, palette().syntax.comment),
            vec!["close */"]
        );
        assert!(
            colored_code(&spans, palette().syntax.keyword).contains(&"fn".to_string()),
            "{spans:?}"
        );
    }

    #[test]
    fn strings_keep_their_escapes_and_their_own_bounds() {
        let mut highlighter = Highlighter::new("ts", palette());
        let line = r#"const path = "a\"b" + 'c'"#;
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert_eq!(
            colored(&spans, palette().syntax.string),
            vec![r#""a\"b""#, "'c'"]
        );
    }

    #[test]
    fn a_rust_char_literal_is_not_read_as_a_lifetime() {
        let mut highlighter = Highlighter::new("rust", palette());
        let line = "fn borrow<'a>(c: char) -> &'a str { let q = '\\''; }";
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert!(
            colored(&spans, palette().syntax.string).contains(&"'\\''".to_string()),
            "{spans:?}"
        );
    }

    #[test]
    fn json_constants_take_the_constant_hue_and_no_comment_hue() {
        let mut highlighter = Highlighter::new("json", palette());
        let line = r#"{"ok": true, "n": 3}"#;
        let spans = highlighter.line(line);
        assert_eq!(text(&spans), line);
        assert!(
            colored(&spans, palette().syntax.number).contains(&"true".to_string()),
            "{spans:?}"
        );
        assert!(
            colored_comment(&spans, palette().syntax.comment).is_empty(),
            "{spans:?}"
        );
    }

    #[test]
    fn an_unknown_language_stays_one_span_in_text_color() {
        let mut highlighter = Highlighter::new("miao-not-a-language", palette());
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
        assert_eq!(
            colored_comment(&spans, palette().syntax.comment),
            vec!["# done"]
        );
        assert!(colored_code(&spans, palette().syntax.keyword).contains(&"if".to_string()));
    }

    #[test]
    fn a_monochrome_palette_paints_code_without_hues() {
        let theme = theme::builtin("miao", crate::theme::ThemeMode::Dark).expect("builtin theme");
        let mut highlighter = Highlighter::new("rust", theme.monochrome());
        let spans = highlighter.line("let x = 42; // note");
        for span in &spans {
            assert_eq!(span.style.fg, Some(Color::Reset), "{spans:?}");
        }
    }
}
