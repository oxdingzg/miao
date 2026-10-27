//! Minimal markdown rendering for the transcript.
//!
//! The TUI is a reading surface: it needs the document structure and emphasis
//! the model writes, not a full CommonMark parser. Anything unrecognized falls
//! back to plain text, so no content is dropped. TS renders through opentui's
//! markdown widget; this is the same reading shape, with its own code-block
//! highlighter.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::highlight::Highlighter;
use crate::theme::Theme;

/// Render a markdown document as styled transcript lines.
pub fn lines(markdown: &str, theme: &Theme) -> Vec<Line<'static>> {
    let palette = theme.palette;
    let mut out = Vec::new();
    let source: Vec<&str> = markdown.lines().collect();
    let mut index = 0;
    while index < source.len() {
        let line = source[index];
        let trimmed = line.trim_start();
        if let Some(fence) = fence_marker(trimmed) {
            index = push_code(&mut out, &source, index, fence, theme);
            continue;
        }
        if trimmed.is_empty() {
            out.push(Line::default());
            index += 1;
            continue;
        }
        if let Some(level) = heading_level(trimmed) {
            let style = Style::new()
                .fg(match level {
                    1 => palette.primary,
                    2 => palette.secondary,
                    _ => palette.accent,
                })
                .add_modifier(Modifier::BOLD);
            let mut spans = Vec::new();
            parse_inline(heading_text(trimmed, level), style, theme, &mut spans);
            out.push(Line::from(spans));
            index += 1;
            continue;
        }
        if is_rule(trimmed) {
            out.push(Line::from(Span::styled(
                "─".repeat(40),
                Style::new().fg(palette.border),
            )));
            index += 1;
            continue;
        }
        if let Some(body) = trimmed.strip_prefix('>') {
            let body = body.strip_prefix(' ').unwrap_or(body);
            let mut spans = vec![Span::styled("│ ", Style::new().fg(palette.border))];
            parse_inline(body, Style::new().fg(palette.text_muted), theme, &mut spans);
            out.push(Line::from(spans));
            index += 1;
            continue;
        }
        if let Some((indent, marker, body)) = list_item(line) {
            let mut spans = vec![
                Span::styled(indent.to_string(), Style::new()),
                Span::styled(marker, Style::new().fg(palette.primary)),
            ];
            parse_inline(body, Style::new().fg(palette.text), theme, &mut spans);
            out.push(Line::from(spans));
            index += 1;
            continue;
        }
        if line.contains('|') && index + 1 < source.len() && is_table_separator(source[index + 1]) {
            index = push_table(&mut out, &source, index, theme);
            continue;
        }
        let mut spans = Vec::new();
        parse_inline(line, Style::new().fg(palette.text), theme, &mut spans);
        out.push(Line::from(spans));
        index += 1;
    }
    out
}

fn fence_marker(line: &str) -> Option<char> {
    let fence = line.chars().next()?;
    if !matches!(fence, '`' | '~') {
        return None;
    }
    if line.chars().take_while(|c| *c == fence).count() < 3 {
        return None;
    }
    Some(fence)
}

fn push_code(
    out: &mut Vec<Line<'static>>,
    source: &[&str],
    start: usize,
    fence: char,
    theme: &Theme,
) -> usize {
    let palette = theme.palette;
    let info = source[start]
        .trim_start()
        .trim_start_matches(fence)
        .trim()
        .to_string();
    out.push(Line::from(Span::styled(
        if info.is_empty() {
            "  ╭".to_string()
        } else {
            format!("  ╭ {info}")
        },
        Style::new().fg(palette.text_muted),
    )));
    let closing = fence.to_string().repeat(3);
    let mut highlighter = Highlighter::new(&info, palette);
    let mut index = start + 1;
    while index < source.len() {
        let line = source[index];
        if line.trim_start().starts_with(&closing) {
            out.push(Line::from(Span::styled(
                "  ╰".to_string(),
                Style::new().fg(palette.text_muted),
            )));
            return index + 1;
        }
        let mut spans = vec![Span::styled("  │ ", Style::new().fg(palette.border))];
        spans.extend(highlighter.line(line));
        out.push(Line::from(spans));
        index += 1;
    }
    // An unterminated fence is a half-written document, not an error; show its
    // body rather than swallowing the tail of the message.
    out.push(Line::from(Span::styled(
        "  ╰".to_string(),
        Style::new().fg(palette.text_muted),
    )));
    index
}

fn heading_level(line: &str) -> Option<usize> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    if line.chars().nth(level) != Some(' ') {
        return None;
    }
    Some(level)
}

fn heading_text(line: &str, level: usize) -> &str {
    line[level..].trim().trim_end_matches('#').trim_end()
}

fn is_rule(line: &str) -> bool {
    let mut chars = line.chars().filter(|c| !c.is_whitespace());
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    let mut count = 1;
    for c in chars {
        if c != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

fn list_item(line: &str) -> Option<(&str, String, &str)> {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, rest) = line.split_at(indent_len);
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'*' | b'+') && bytes[1] == b' ' {
        return Some((indent, "• ".to_string(), &rest[2..]));
    }
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let after = &rest[digits..];
    let body = after
        .strip_prefix(". ")
        .or_else(|| after.strip_prefix(") "))?;
    Some((indent, format!("{}. ", &rest[..digits]), body))
}

fn is_table_separator(line: &str) -> bool {
    let cells = split_row(line);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let trimmed = cell.trim_start_matches(':').trim_end_matches(':');
            !trimmed.is_empty() && trimmed.chars().all(|c| c == '-')
        })
}

fn split_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_start_matches('|')
        .trim_end_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

fn push_table(out: &mut Vec<Line<'static>>, source: &[&str], start: usize, theme: &Theme) -> usize {
    let palette = theme.palette;
    let header = split_row(source[start]);
    let mut rows = Vec::new();
    let mut index = start + 2;
    while index < source.len() {
        let line = source[index];
        if line.trim().is_empty() || !line.contains('|') {
            break;
        }
        rows.push(split_row(line));
        index += 1;
    }
    let columns = header
        .len()
        .max(rows.iter().map(Vec::len).max().unwrap_or(0));
    let mut widths: Vec<usize> = (0..columns)
        .map(|column| header.get(column).map_or(0, |cell| cell.width()))
        .collect();
    for row in &rows {
        for (column, cell) in row.iter().enumerate() {
            widths[column] = widths[column].max(cell.width());
        }
    }
    // A long cell would push every other column off screen; clip the column
    // instead and let the viewport wrap the row.
    for width in &mut widths {
        *width = (*width).min(40);
    }
    push_table_row(
        out,
        &header,
        &widths,
        Style::new()
            .fg(palette.secondary)
            .add_modifier(Modifier::BOLD),
    );
    let rule = widths
        .iter()
        .map(|width| "─".repeat(*width))
        .collect::<Vec<_>>()
        .join("─┼─");
    out.push(Line::from(Span::styled(
        rule,
        Style::new().fg(palette.border),
    )));
    for row in &rows {
        push_table_row(out, row, &widths, Style::new().fg(palette.text));
    }
    index
}

fn push_table_row(out: &mut Vec<Line<'static>>, row: &[String], widths: &[usize], style: Style) {
    let mut text = String::new();
    for (column, width) in widths.iter().enumerate() {
        if column > 0 {
            text.push_str(" │ ");
        }
        let cell = row.get(column).map(String::as_str).unwrap_or("");
        text.push_str(cell);
        text.push_str(&" ".repeat(width.saturating_sub(cell.width())));
    }
    out.push(Line::from(Span::styled(text.trim_end().to_string(), style)));
}

fn parse_inline(text: &str, style: Style, theme: &Theme, spans: &mut Vec<Span<'static>>) {
    let palette = theme.palette;
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::new();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c == '\\' && index + 1 < chars.len() {
            plain.push(chars[index + 1]);
            index += 2;
            continue;
        }
        if c == '`' {
            if let Some(end) = find_char(&chars, index + 1, '`') {
                push_plain(spans, &mut plain, style);
                let code: String = chars[index + 1..end].iter().collect();
                spans.push(Span::styled(
                    code,
                    style.fg(palette.accent).bg(palette.surface),
                ));
                index = end + 1;
                continue;
            }
        }
        if let Some((end, delimiter)) = match_delimiter(&chars, index) {
            push_plain(spans, &mut plain, style);
            let inner: String = chars[index + delimiter.len()..end].iter().collect();
            let emphasis = match delimiter {
                "**" | "__" => Modifier::BOLD,
                "~~" => Modifier::CROSSED_OUT,
                _ => Modifier::ITALIC,
            };
            parse_inline(&inner, style.add_modifier(emphasis), theme, spans);
            index = end + delimiter.len();
            continue;
        }
        if c == '[' {
            if let Some((label_end, url_end)) = find_link(&chars, index) {
                push_plain(spans, &mut plain, style);
                let label: String = chars[index + 1..label_end].iter().collect();
                parse_inline(
                    &label,
                    style.fg(palette.accent).add_modifier(Modifier::UNDERLINED),
                    theme,
                    spans,
                );
                index = url_end + 1;
                continue;
            }
        }
        plain.push(c);
        index += 1;
    }
    push_plain(spans, &mut plain, style);
}

fn match_delimiter(chars: &[char], start: usize) -> Option<(usize, &'static str)> {
    for delimiter in ["**", "__", "~~", "*", "_"] {
        let marker: Vec<char> = delimiter.chars().collect();
        if !chars[start..].starts_with(&marker) {
            continue;
        }
        let inner_start = start + marker.len();
        if inner_start >= chars.len() || chars[inner_start].is_whitespace() {
            continue;
        }
        // `_` inside a word is an identifier (`snake_case`), not emphasis.
        if delimiter == "_" && start > 0 && chars[start - 1].is_alphanumeric() {
            continue;
        }
        if let Some(end) = find_sequence(chars, inner_start, &marker) {
            if end > inner_start {
                return Some((end, delimiter));
            }
        }
    }
    None
}

fn find_sequence(chars: &[char], from: usize, sequence: &[char]) -> Option<usize> {
    (from..chars.len().saturating_sub(sequence.len() - 1))
        .find(|&index| chars[index..].starts_with(sequence))
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&index| chars[index] == target)
}

fn find_link(chars: &[char], start: usize) -> Option<(usize, usize)> {
    let close = find_char(chars, start + 1, ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = find_char(chars, close + 2, ')')?;
    Some((close, end))
}

fn push_plain(spans: &mut Vec<Span<'static>>, plain: &mut String, style: Style) {
    if plain.is_empty() {
        return;
    }
    spans.push(Span::styled(std::mem::take(plain), style));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme;

    fn theme() -> Theme {
        Theme {
            name: "test".to_string(),
            palette: theme::builtin("miao").expect("builtin theme"),
        }
    }

    fn text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn headings_carry_level_colors_and_bold() {
        let lines = lines("# Title\n\n## Section\n\n### Detail", &theme());
        assert_eq!(text(&lines[0]), "Title");
        assert_eq!(lines[0].spans[0].style.fg, Some(theme().palette.primary));
        assert!(lines[0].spans[0]
            .style
            .add_modifier
            .contains(Modifier::BOLD));
        assert_eq!(text(&lines[2]), "Section");
        assert_eq!(lines[2].spans[0].style.fg, Some(theme().palette.secondary));
        assert_eq!(text(&lines[4]), "Detail");
        assert_eq!(lines[4].spans[0].style.fg, Some(theme().palette.accent));
    }

    #[test]
    fn inline_emphasis_and_code_are_spans_of_the_same_line() {
        let lines = lines("a **bold** and `code` and ~~gone~~", &theme());
        let line = &lines[0];
        let joined = text(line);
        let bold = line
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "bold")
            .expect("bold span");
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
        let code = line
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "code")
            .expect("code span");
        assert_eq!(code.style.fg, Some(theme().palette.accent));
        assert_eq!(code.style.bg, Some(theme().palette.surface));
        let gone = line
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "gone")
            .expect("struck span");
        assert!(gone.style.add_modifier.contains(Modifier::CROSSED_OUT));
        assert_eq!(joined, "a bold and code and gone");
    }

    #[test]
    fn snake_case_does_not_become_emphasis() {
        let lines = lines("call read_file_then_write_file now", &theme());
        assert_eq!(text(&lines[0]), "call read_file_then_write_file now");
        assert_eq!(lines[0].spans.len(), 1);
    }

    #[test]
    fn a_link_keeps_its_label_and_drops_the_url() {
        let lines = lines("see [the guide](https://example.com/x) now", &theme());
        let line = &lines[0];
        let label = line
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "the guide")
            .expect("label span");
        assert_eq!(label.style.fg, Some(theme().palette.accent));
        assert!(!text(line).contains("example.com"));
    }

    #[test]
    fn lists_keep_indentation_and_replace_the_bullet() {
        let lines = lines("  - one\n1. first", &theme());
        assert_eq!(text(&lines[0]), "  • one");
        assert_eq!(text(&lines[1]), "1. first");
    }

    #[test]
    fn a_fence_keeps_every_body_line_verbatim() {
        let lines = lines(
            "before\n```rust\nfn main() {}\n  *not emphasis*\n```\nafter",
            &theme(),
        );
        let body = lines.iter().map(text).collect::<Vec<_>>();
        assert!(body.contains(&"  │ fn main() {}".to_string()));
        assert!(body.contains(&"  │   *not emphasis*".to_string()));
        assert_eq!(lines[0].spans[0].content.as_ref(), "before");
        assert_eq!(body.last().map(String::as_str), Some("after"));
    }

    #[test]
    fn a_fence_is_highlighted_by_its_language() {
        let lines = lines("```rust\nlet x = 1; // note\n```", &theme());
        let body = &lines[1];
        assert_eq!(text(body), "  │ let x = 1; // note");
        let colors: Vec<_> = body.spans.iter().map(|span| span.style.fg).collect();
        assert!(
            colors.contains(&Some(theme().palette.secondary)),
            "{colors:?}"
        );
        assert!(
            colors.contains(&Some(theme().palette.text_muted)),
            "{colors:?}"
        );
    }

    #[test]
    fn a_fence_without_a_language_stays_plain() {
        let lines = lines("```\nlet x = 1; // note\n```", &theme());
        let body = &lines[1];
        assert_eq!(text(body), "  │ let x = 1; // note");
        assert_eq!(body.spans.len(), 2);
        assert_eq!(body.spans[1].style.fg, Some(theme().palette.text));
    }

    #[test]
    fn a_quote_and_a_rule_get_their_own_shape() {
        let lines = lines("> quoted\n---", &theme());
        assert_eq!(text(&lines[0]), "│ quoted");
        assert_eq!(text(&lines[1]), "─".repeat(40));
    }

    #[test]
    fn a_table_is_aligned_by_column_widths() {
        let lines = lines(
            "| name | value |\n| --- | --- |\n| a | 1 |\n| longer | 22 |",
            &theme(),
        );
        let rendered: Vec<String> = lines.iter().map(text).collect();
        assert!(rendered[0].starts_with("name"));
        assert!(rendered[0].contains("value"));
        assert!(rendered[1].contains('┼'));
        assert!(rendered[2].starts_with("a "));
        assert!(rendered[3].starts_with("longer"));
    }

    #[test]
    fn an_unterminated_fence_still_renders_its_body() {
        let lines = lines("```\nstill writing", &theme());
        let rendered: Vec<String> = lines.iter().map(text).collect();
        assert!(rendered.contains(&"  │ still writing".to_string()));
        assert_eq!(rendered.last().map(String::as_str), Some("  ╰"));
    }
}
