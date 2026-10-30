//! Window titles are bounded OSC payloads, not terminal commands from a model.
use std::io::{self, Write};

use unicode_segmentation::UnicodeSegmentation;

pub fn sanitize(input: &str) -> String {
    let title = input
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return "miao".into();
    }
    if title.graphemes(true).take(41).count() > 40 {
        return format!("{}…", title.graphemes(true).take(37).collect::<String>());
    }
    title
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
    fn long_titles_keep_whole_graphemes() {
        let glyph = "👩🏽‍💻";
        assert_eq!(sanitize(&glyph.repeat(40)), glyph.repeat(40));
        assert_eq!(
            sanitize(&glyph.repeat(41)),
            format!("{}…", glyph.repeat(37))
        );
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
