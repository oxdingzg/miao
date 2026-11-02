//! Window titles are bounded OSC payloads, not terminal commands from a model.
use std::io::{self, Write};

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Cells a title may occupy.
///
/// A tab strip shows a fraction of the window's width, so a sentence there
/// crowds out the other tabs. The prompt itself stays readable in the
/// transcript; the tab only needs enough to recognise the Session.
const TITLE_CELLS: usize = 24;

pub fn sanitize(input: &str) -> String {
    let title = input
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return "miao".into();
    }
    fit(&title, TITLE_CELLS)
}

/// Cut to `cells` display cells, ellipsis included.
///
/// Cells, not characters: a CJK title spends two cells per character, so a
/// character count let a Chinese title run to twice the width of an English one
/// and still called it short.
fn fit(text: &str, cells: usize) -> String {
    if UnicodeWidthStr::width(text) <= cells {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for grapheme in text.graphemes(true) {
        let width = UnicodeWidthStr::width(grapheme);
        if used + width > cells.saturating_sub(1) {
            break;
        }
        out.push_str(grapheme);
        used += width;
    }
    out.push('…');
    out
}

pub fn tab(title: Option<&str>, prompt: Option<&str>) -> String {
    let title = title.filter(|title| !is_default(title));
    sanitize(title.or(prompt).unwrap_or_default())
}

fn is_default(title: &str) -> bool {
    if title == "New session" {
        return true;
    }
    let Some(date) = title
        .strip_prefix("New session - ")
        .or_else(|| title.strip_prefix("Child session - "))
    else {
        return false;
    };
    let pattern = b"0000-00-00T00:00:00.000Z";
    date.len() == pattern.len()
        && date.bytes().zip(pattern).all(|(actual, expected)| {
            if *expected == b'0' {
                actual.is_ascii_digit()
            } else {
                actual == *expected
            }
        })
}

pub struct Title<W: Write> {
    output: W,
    last: Option<String>,
    owned: bool,
}

impl<W: Write> Title<W> {
    pub fn new(output: W) -> Self {
        Self {
            output,
            last: None,
            owned: false,
        }
    }

    pub fn update(&mut self, title: Option<&str>) -> io::Result<()> {
        let title = title.map(sanitize);
        if title == self.last && !(title.is_none() && self.owned) {
            return Ok(());
        }
        if title.is_some() || self.owned {
            write!(
                self.output,
                "\x1b]0;{}\x07",
                title.as_deref().unwrap_or_default()
            )?;
            self.output.flush()?;
        }
        self.owned = title.is_some();
        self.last = title;
        Ok(())
    }

    pub fn invalidate(&mut self) {
        self.last = None;
    }
}

impl<W: Write> Drop for Title<W> {
    fn drop(&mut self) {
        if self.owned {
            let _ = self.output.write_all(b"\x1b]0;\x07");
            let _ = self.output.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize, tab, Title};

    #[test]
    fn controls_cannot_terminate_or_inject_a_title_sequence() {
        let title = sanitize("  hello\x07\x1b]2;owned\n\u{009b} title  ");
        assert_eq!(title, "hello ]2;owned title");
        assert!(!title.chars().any(char::is_control));
        assert_eq!(sanitize("\x1b\x07\n"), "miao");
    }

    #[test]
    fn a_long_title_is_cut_to_what_a_tab_strip_shows() {
        let glyph = "👩🏽‍💻";
        let title = sanitize(&glyph.repeat(40));
        assert!(
            unicode_width::UnicodeWidthStr::width(title.as_str()) <= 24,
            "{title:?} is wider than a tab"
        );
        assert!(title.ends_with('…'), "{title:?}");
        // Whole graphemes: half a joined emoji is not a title.
        assert!(title.trim_end_matches('…').chars().count() > 0);
    }

    /// A CJK title spends two cells per character, so a character count let it
    /// run twice as wide as an English title of the same length.
    #[test]
    fn a_wide_title_counts_cells_not_characters() {
        let title = sanitize("首页与会话页列几何统一和边界撑满的问题");
        assert!(
            unicode_width::UnicodeWidthStr::width(title.as_str()) <= 24,
            "{title:?} is wider than a tab"
        );
        assert!(title.ends_with('…'), "{title:?}");
    }

    #[test]
    fn a_missing_or_generated_title_uses_the_admitted_prompt() {
        for title in [
            None,
            Some("New session"),
            Some("New session - 2026-10-30T00:00:00.000Z"),
            Some("Child session - 2026-10-30T00:00:00.000Z"),
        ] {
            assert_eq!(
                tab(title, Some("repair the failing test")),
                "repair the failing test"
            );
        }
        assert_eq!(tab(Some("Named session"), Some("prompt")), "Named session");
        assert_eq!(
            tab(Some("New session - invalid"), Some("prompt")),
            "New session - invalid"
        );
        assert_eq!(tab(None, None), "miao");
    }

    #[test]
    fn dropping_a_written_title_clears_it_but_an_unowned_title_is_untouched() {
        let mut output = Vec::new();
        {
            let mut title = Title::new(&mut output);
            title.update(None).unwrap();
        }
        assert!(output.is_empty());
        {
            let mut title = Title::new(&mut output);
            title.update(Some("session")).unwrap();
        }
        assert_eq!(output, b"\x1b]0;session\x07\x1b]0;\x07");
    }

    #[test]
    fn unchanged_titles_are_not_rewritten_and_disabled_titles_emit_nothing() {
        let mut title = Title::new(Vec::new());
        title.update(None).unwrap();
        assert!(title.output.is_empty());
        title.update(Some("miao")).unwrap();
        let first = title.output.clone();
        title.update(Some("miao")).unwrap();
        assert_eq!(title.output, first);
        title.invalidate();
        title.update(Some("miao")).unwrap();
        assert_eq!(title.output, first.repeat(2));
        title.update(None).unwrap();
        assert!(title.output.ends_with(b"\x1b]0;\x07"));
        let disabled = title.output.clone();
        title.update(None).unwrap();
        assert_eq!(title.output, disabled);
    }
}
