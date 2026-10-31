//! Tool rows for the transcript.
//!
//! The native engine names its tools (`read_file`, `run_command`, …) and its
//! `tool_result` content is the JSON-serialized result. The TS TUI never sees
//! that shape: `packages/miao/src/engine/bridge.ts` projects it onto the product
//! vocabulary first. A Rust client reads the wire directly, so the render-side
//! half of that projection lives here; without it every tool row would show raw
//! JSON.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::session::{DisplayFile, ToolPart};
use crate::theme::Theme;

/// Output lines one command row shows before collapsing.
const TOOL_PREVIEW_LINES: usize = 1;
/// Diff lines one changed file shows before collapsing.
const DIFF_PREVIEW_LINES: usize = 12;

pub fn lines(
    tool: &ToolPart,
    files: Option<&[DisplayFile]>,
    theme: &Theme,
    expanded: bool,
) -> Vec<Line<'static>> {
    let name = product_name(&tool.name);
    let input = product_input(&tool.name, &tool.input);
    let raw = tool.output.as_deref();
    let result = raw.and_then(parse_json);
    let mut out = Vec::new();
    match name {
        "bash" => bash(
            &mut out,
            tool,
            &input,
            result.as_ref(),
            raw,
            theme,
            expanded,
        ),
        "read" => read(&mut out, tool, &input, result.as_ref(), theme, expanded),
        "glob" | "grep" => search(
            &mut out,
            tool,
            name,
            &input,
            result.as_ref(),
            theme,
            expanded,
        ),
        "write" | "edit" | "apply_patch" => {
            file(&mut out, tool, name, &input, files, raw, theme, expanded)
        }
        "todowrite" => todos(
            &mut out,
            tool,
            &input,
            result.as_ref(),
            raw,
            theme,
            expanded,
        ),
        "question" => question(&mut out, tool, &input, result.as_ref(), theme),
        "webfetch" => inline(&mut out, tool, "WebFetch", &text(&input, "url"), theme),
        "websearch" => inline(&mut out, tool, "WebSearch", &text(&input, "query"), theme),
        "skill" => inline(&mut out, tool, "Skill", &text(&input, "name"), theme),
        "task" => task(&mut out, tool, &input, raw, theme),
        _ => generic(
            &mut out,
            tool,
            name,
            &input,
            result.as_ref(),
            raw,
            theme,
            expanded,
        ),
    }
    out
}

/// Engine tool name to the product vocabulary the TS renderers switch on.
pub fn product_name(engine: &str) -> &str {
    match engine {
        "read_file" | "read_image" | "list_files" => "read",
        "load_skill" => "skill",
        "write_file" => "write",
        "edit_file" => "edit",
        "run_command" | "start_job" => "bash",
        "job_status" | "job_list" => "job_list",
        "cancel_job" => "job_cancel",
        "job_wait" => "job_wait",
        "schedule_wakeup" | "cancel_wakeup" => "schedule",
        other if other.starts_with("cron_") => "schedule",
        other if other.starts_with("lsp_") => "lsp",
        other => other,
    }
}

/// Engine input to the field names the renderers read.
pub fn product_input(engine: &str, input: &Value) -> Value {
    let Some(record) = input.as_object() else {
        return input.clone();
    };
    let mut projected = record.clone();
    match engine {
        "read_file" | "read_image" | "list_files" | "write_file" | "edit_file" => {
            if !record.contains_key("filePath") {
                if let Some(path) = record.get("path").and_then(Value::as_str) {
                    projected.insert("filePath".into(), Value::String(path.to_string()));
                }
            }
            if engine == "write_file" && !record.contains_key("content") {
                if let Some(body) = record.get("text") {
                    projected.insert("content".into(), body.clone());
                }
            }
        }
        "run_command" | "bash" | "start_job" => {
            if !record.contains_key("command") {
                if let Some(argv) = record.get("argv").and_then(Value::as_array) {
                    let command = argv
                        .iter()
                        .filter_map(Value::as_str)
                        .map(quote_argument)
                        .collect::<Vec<_>>()
                        .join(" ");
                    projected.insert("command".into(), Value::String(command));
                }
            }
            if engine == "start_job" {
                projected.insert("run_in_background".into(), Value::Bool(true));
            }
        }
        "task" => {
            if let Some(agent) = record.get("agent") {
                projected
                    .entry("subagent_type")
                    .or_insert_with(|| agent.clone());
            }
            if !record.contains_key("description") {
                if let Some(line) = record
                    .get("prompt")
                    .and_then(Value::as_str)
                    .and_then(|prompt| prompt.lines().find(|line| !line.trim().is_empty()))
                {
                    projected.insert(
                        "description".into(),
                        Value::String(compact(line.trim()).chars().take(120).collect()),
                    );
                }
            }
        }
        _ => {}
    }
    Value::Object(projected)
}

fn quote_argument(argument: &str) -> String {
    if !argument.is_empty()
        && argument.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '=' | '+' | '-')
        })
    {
        return argument.to_string();
    }
    format!("'{}'", argument.replace('\'', "'\\''"))
}

fn parse_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

fn header(tool: &ToolPart, label: &str, detail: &str, theme: &Theme) -> Line<'static> {
    let palette = theme.palette;
    let (glyph, glyph_style) = if tool.failed {
        ("✗", Style::new().fg(palette.error))
    } else if tool.output.is_some() {
        ("✓", Style::new().fg(palette.success))
    } else {
        ("·", Style::new().fg(palette.warning))
    };
    let mut spans = vec![
        Span::styled(format!("{glyph} "), glyph_style),
        Span::styled(label.to_string(), Style::new().fg(palette.secondary)),
    ];
    if !detail.is_empty() {
        spans.push(Span::styled(
            format!("  {detail}"),
            Style::new().fg(palette.text_muted),
        ));
    }
    Line::from(spans)
}

fn result_line(text: &str, color: Color) -> Line<'static> {
    Line::from(Span::styled(format!("  ⎿ {text}"), Style::new().fg(color)))
}

fn preview(out: &mut Vec<Line<'static>>, text: &str, color: Color, limit: usize) {
    let text = strip_ansi(text).replace('\r', "");
    let text = text.trim_end_matches('\n');
    if text.is_empty() {
        return;
    }
    let lines = text.lines().collect::<Vec<_>>();
    for line in lines.iter().take(limit) {
        out.push(Line::from(Span::styled(
            format!("  │ {line}"),
            Style::new().fg(color),
        )));
    }
    if lines.len() > limit {
        // Say how to see the rest: a folded tool block that cannot be opened
        // reads like lost output.
        out.push(Line::from(Span::styled(
            format!("  │ … {} more lines · <leader>u 展开", lines.len() - limit),
            Style::new().fg(color),
        )));
    }
}

fn inline(out: &mut Vec<Line<'static>>, tool: &ToolPart, label: &str, detail: &str, theme: &Theme) {
    out.push(header(tool, label, &compact(detail), theme));
}

fn bash(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    raw: Option<&str>,
    theme: &Theme,
    expanded: bool,
) {
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    let command = text(input, "command");
    let first = command.lines().next().unwrap_or_default().trim();
    out.push(header(tool, "bash", &compact(first), theme));
    if tool.failed {
        let text = result
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| raw.map(str::to_string))
            .unwrap_or_default();
        preview(out, &text, palette.error, limit);
        return;
    }
    let Some(text) = shell_text(result) else {
        return;
    };
    preview(
        out,
        &text,
        if tool.failed {
            palette.error
        } else {
            palette.text_muted
        },
        limit,
    );
}

/// The readable body of a shell result, with the same tail marker the bridge
/// appends for the TS renderer.
fn shell_text(result: Option<&Value>) -> Option<String> {
    let Some(Value::Object(record)) = result else {
        return None;
    };
    if let Some(error) = record.get("error").and_then(Value::as_str) {
        return Some(error.to_string());
    }
    let stdout = record
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end();
    let stderr = record
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end();
    let body = [stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let exit = record.get("exit_code").and_then(Value::as_i64);
    let signal = record.get("signal").and_then(Value::as_i64);
    let timed_out = record.get("reason").and_then(Value::as_str) == Some("timed_out");
    let tail = if timed_out {
        "[command timed out]".to_string()
    } else if let Some(exit) = exit {
        format!("[exit code {exit}]")
    } else if let Some(signal) = signal {
        format!("[killed by signal {signal}]")
    } else {
        "[command not executed]".to_string()
    };
    Some(if body.is_empty() {
        tail
    } else {
        format!("{body}\n{tail}")
    })
}

fn read(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
    expanded: bool,
) {
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    let path = text(input, "filePath");
    out.push(header(tool, "read", &compact(&path), theme));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit);
        }
        return;
    }
    if let Some(summary) = read_summary(&tool.name, result) {
        out.push(result_line(&summary, palette.text_muted));
    }
}

fn read_summary(engine: &str, result: Option<&Value>) -> Option<String> {
    let Some(Value::Object(record)) = result else {
        return None;
    };
    if engine == "read_image" {
        return Some("Read image".to_string());
    }
    if engine == "list_files" {
        let count = record
            .get("entries")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let truncated = record
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Some(format!(
            "Read {count} {}{}",
            if count == 1 { "entry" } else { "entries" },
            if truncated { " (truncated)" } else { "" }
        ));
    }
    let body = record.get("text").and_then(Value::as_str)?;
    let count = if body.is_empty() {
        0
    } else {
        body.trim_end_matches('\n').lines().count()
    };
    let truncated = record
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(format!(
        "Read {count} {}{}",
        if count == 1 { "line" } else { "lines" },
        if truncated { " (truncated)" } else { "" }
    ))
}

fn search(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    label: &str,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
    expanded: bool,
) {
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    let pattern = text(input, "pattern");
    let path = text(input, "path");
    let detail = if path.is_empty() || path == "." {
        compact(&pattern)
    } else {
        compact(&format!("{pattern} in {path}"))
    };
    out.push(header(tool, label, &detail, theme));
    if !tool.failed {
        if let Some(summary) = search_summary(result) {
            out.push(result_line(&summary, palette.text_muted));
        }
        return;
    }
    if let Some(output) = tool.output.as_deref() {
        preview(out, output, palette.error, limit);
    }
}

fn search_summary(result: Option<&Value>) -> Option<String> {
    let Value::Object(record) = result? else {
        return None;
    };
    let count = record
        .get("matches")
        .and_then(Value::as_array)
        .map(Vec::len)?;
    let truncated = record
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(format!(
        "{count} {}{}",
        if count == 1 { "match" } else { "matches" },
        if truncated { " (truncated)" } else { "" }
    ))
}

// The render context is flat on purpose: every helper reads the same pieces
// and a context struct would only rename them at each call site.
#[allow(clippy::too_many_arguments)]
fn file(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    name: &str,
    input: &Value,
    files: Option<&[DisplayFile]>,
    raw: Option<&str>,
    theme: &Theme,
    expanded: bool,
) {
    let diff_limit = if expanded {
        usize::MAX
    } else {
        DIFF_PREVIEW_LINES
    };
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    let path = text(input, "filePath");
    let label = match name {
        "write" => "write",
        "edit" => "edit",
        _ => "apply_patch",
    };
    out.push(header(tool, label, &compact(&path), theme));
    if tool.failed {
        let message = raw.unwrap_or_default();
        preview(out, message, palette.error, limit);
        return;
    }
    let Some(files) = files.filter(|files| !files.is_empty()) else {
        return;
    };
    let added: u64 = files.iter().map(|file| file.additions).sum();
    let removed: u64 = files.iter().map(|file| file.deletions).sum();
    out.push(result_line(
        &file_summary(added, removed),
        palette.text_muted,
    ));
    for file in files {
        out.push(Line::from(Span::styled(
            format!(
                "  ◆ {} {} +{} −{}",
                file.action, file.path, file.additions, file.deletions
            ),
            Style::new().fg(palette.accent),
        )));
        let mut started = false;
        let diff = file
            .patch
            .lines()
            .filter(|line| {
                if line.starts_with("@@") {
                    started = true;
                }
                started
            })
            .collect::<Vec<_>>();
        for line in diff.iter().take(diff_limit) {
            out.push(Line::from(Span::styled(
                format!("  {line}"),
                Style::new().fg(diff_color(line, theme)),
            )));
        }
        if diff.len() > diff_limit {
            out.push(Line::from(Span::styled(
                format!("  … {} more diff lines", diff.len() - diff_limit),
                Style::new().fg(palette.text_muted),
            )));
        }
    }
}

fn file_summary(added: u64, removed: u64) -> String {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!(
            "Added {added} {}",
            if added == 1 { "line" } else { "lines" }
        ));
    }
    if removed > 0 {
        parts.push(format!(
            "{} {removed} {}",
            if added > 0 { "removed" } else { "Removed" },
            if removed == 1 { "line" } else { "lines" }
        ));
    }
    if parts.is_empty() {
        "No line changes".to_string()
    } else {
        parts.join(", ")
    }
}

fn diff_color(line: &str, theme: &Theme) -> Color {
    let palette = theme.palette;
    if line.starts_with('+') {
        return palette.success;
    }
    if line.starts_with('-') {
        return palette.error;
    }
    if line.starts_with("@@") {
        return palette.accent;
    }
    palette.text_muted
}

fn todos(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    raw: Option<&str>,
    theme: &Theme,
    expanded: bool,
) {
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    let list = input
        .get("todos")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            result
                .and_then(|value| value.get("value"))
                .and_then(|value| value.get("todos"))
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default();
    out.push(header(tool, "todowrite", "", theme));
    if tool.failed {
        preview(out, raw.unwrap_or_default(), palette.error, limit);
        return;
    }
    for todo in &list {
        let status = todo
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        let glyph = match status {
            "completed" => "✓",
            "in_progress" => "•",
            "cancelled" => "×",
            "waiting" => "…",
            "blocked" => "!",
            _ => " ",
        };
        let color = if status == "in_progress" {
            palette.warning
        } else {
            palette.text_muted
        };
        let id = todo
            .get("id")
            .and_then(Value::as_str)
            .map(|id| format!("{id}: "))
            .unwrap_or_default();
        let content = todo
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let depends = todo
            .get("depends_on")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|deps| !deps.is_empty())
            .map(|deps| format!(" ← {deps}"))
            .unwrap_or_default();
        out.push(Line::from(Span::styled(
            format!("  [{glyph}] {id}{content}{depends}"),
            Style::new().fg(color),
        )));
    }
}

fn question(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
) {
    let palette = theme.palette;
    out.push(header(tool, "question", "", theme));
    let answers = result
        .and_then(|value| value.get("answers"))
        .and_then(Value::as_array);
    let questions = input.get("questions").and_then(Value::as_array);
    for (index, item) in questions.into_iter().flatten().enumerate() {
        let text = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default();
        out.push(Line::from(Span::styled(
            format!("  {text}"),
            Style::new().fg(palette.text_muted),
        )));
        let answer = answers
            .and_then(|answers| answers.get(index))
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|answer| !answer.is_empty())
            .unwrap_or_else(|| "(no answer)".to_string());
        out.push(result_line(&answer, palette.text));
    }
}

fn task(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    raw: Option<&str>,
    theme: &Theme,
) {
    let palette = theme.palette;
    let description = text(input, "description");
    out.push(header(tool, "task", &compact(&description), theme));
    // The child Session's transcript is not part of this Session's wire; the
    // row carries the task's final text so the delegating turn stays readable.
    if let Some(output) = raw {
        let value = parse_json(output);
        let first = value
            .as_ref()
            .and_then(|value| value.get("result").or(Some(value)))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                output
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let first = first.trim();
        if !first.is_empty() {
            preview(
                out,
                first,
                if tool.failed {
                    palette.error
                } else {
                    palette.text_muted
                },
                3,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn generic(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    label: &str,
    input: &Value,
    result: Option<&Value>,
    raw: Option<&str>,
    theme: &Theme,
    expanded: bool,
) {
    let limit = if expanded {
        usize::MAX
    } else {
        TOOL_PREVIEW_LINES
    };
    let palette = theme.palette;
    out.push(header(tool, label, &input_summary(input), theme));
    let body = if tool.failed {
        result
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| raw.map(str::to_string))
    } else {
        raw.map(str::to_string)
    };
    let Some(body) = body else {
        return;
    };
    preview(
        out,
        &body,
        if tool.failed {
            palette.error
        } else {
            palette.text_muted
        },
        limit,
    );
}

fn input_summary(input: &Value) -> String {
    let candidate = [
        "command",
        "filePath",
        "pattern",
        "query",
        "url",
        "description",
    ]
    .iter()
    .find_map(|key| input.get(key).and_then(Value::as_str));
    match candidate {
        Some(text) => compact(text),
        None => compact(&input.to_string()),
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn compact(text: &str) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= 80 {
        return single;
    }
    let mut cut = single.chars().take(77).collect::<String>();
    cut.push('…');
    cut
}

/// Remove terminal escape sequences from PTY output before it is laid out.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameter/intermediate bytes end at the first final byte.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: terminated by BEL or ST.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme;
    use serde_json::json;

    fn theme() -> Theme {
        Theme {
            name: "test".to_string(),
            palette: theme::builtin("miao").expect("builtin theme"),
        }
    }

    fn tool(name: &str, input: Value, output: Option<Value>, failed: bool) -> ToolPart {
        ToolPart {
            id: "call_1".into(),
            name: name.into(),
            input,
            output: output.map(|value| value.to_string()),
            failed,
        }
    }

    fn rendered(lines: &[Line<'_>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn display_file() -> DisplayFile {
        DisplayFile {
            path: "src/lib.rs".into(),
            action: "update".into(),
            patch: "Index: src/lib.rs\n====\n--- src/lib.rs\n+++ src/lib.rs\n@@ -1 +1 @@\n-a\n+b\n"
                .into(),
            additions: 1,
            deletions: 1,
        }
    }

    #[test]
    fn engine_tools_map_onto_renderer_names() {
        assert_eq!(product_name("read_file"), "read");
        assert_eq!(product_name("run_command"), "bash");
        assert_eq!(product_name("cancel_wakeup"), "schedule");
        assert_eq!(product_name("cron_create"), "schedule");
        assert_eq!(product_name("lsp_hover"), "lsp");
        assert_eq!(product_name("mcp_server_tool"), "mcp_server_tool");
    }

    #[test]
    fn file_inputs_gain_the_fields_the_renderers_read() {
        let input = product_input(
            "write_file",
            &json!({"path": "a.txt", "text": "body", "expected_sha256": null}),
        );
        assert_eq!(input["filePath"], "a.txt");
        assert_eq!(input["content"], "body");
        let command = product_input(
            "run_command",
            &json!({"argv": ["echo", "two words"], "cwd": "."}),
        );
        assert_eq!(command["command"], "echo 'two words'");
        let task = product_input(
            "task",
            &json!({"agent": "build", "prompt": "first line\nrest"}),
        );
        assert_eq!(task["subagent_type"], "build");
        assert_eq!(task["description"], "first line");
    }

    #[test]
    fn a_shell_result_becomes_stdout_stderr_and_a_tail() {
        let part = tool(
            "run_command",
            json!({"argv": ["echo", "hi"]}),
            Some(json!({"stdout": "hi\n", "stderr": "", "exit_code": 0})),
            false,
        );
        let lines = lines(&part, None, &theme(), false);
        let rendered = rendered(&lines);
        assert_eq!(rendered[0], "✓ bash  echo hi");
        assert!(rendered.contains(&"  │ hi".to_string()));
        // Folded output keeps one line; the tail and the hint stay reachable
        // through the elision marker instead of crowding the transcript.
        assert!(rendered.iter().any(|line| line.contains("more lines")));
        assert!(rendered.iter().any(|line| line.contains("<leader>u")));
    }

    #[test]
    fn expanded_tool_output_shows_every_line_and_ignores_the_fold_budget() {
        let output = (1..=12)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let part = tool(
            "run_command",
            json!({"argv": ["seq", "12"]}),
            Some(json!({"stdout": output, "stderr": "", "exit_code": 0})),
            false,
        );
        let folded = rendered(&lines(&part, None, &theme(), false));
        assert!(folded.len() < 12);
        assert!(folded.iter().any(|line| line.contains("more lines")));
        let expanded = rendered(&lines(&part, None, &theme(), true));
        assert!(expanded.iter().any(|line| line.contains("line 12")));
        assert!(!expanded.iter().any(|line| line.contains("more lines")));
    }

    #[test]
    fn a_failed_shell_result_shows_the_reason() {
        let part = tool(
            "bash",
            json!({"command": "ls"}),
            Some(json!({"error": "permission denied"})),
            true,
        );
        let lines = lines(&part, None, &theme(), false);
        let rendered = rendered(&lines);
        assert_eq!(rendered[0], "✗ bash  ls");
        assert!(rendered.contains(&"  │ permission denied".to_string()));
    }

    #[test]
    fn long_shell_output_is_collapsed() {
        let output = (0..10)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let part = tool(
            "bash",
            json!({"command": "seq"}),
            Some(json!({"stdout": output, "exit_code": 0})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert!(rendered.iter().any(|line| line.contains("  │ … ")));
        assert!(rendered.iter().any(|line| line.contains("<leader>u 展开")));
    }

    #[test]
    fn terminal_escape_sequences_are_stripped() {
        let part = tool(
            "bash",
            json!({"command": "ls"}),
            Some(json!({"stdout": "\u{1b}[31mred\u{1b}[0m\n", "exit_code": 0})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert!(rendered.contains(&"  │ red".to_string()));
    }

    #[test]
    fn a_read_reports_its_line_count() {
        let part = tool(
            "read_file",
            json!({"path": "a.rs"}),
            Some(json!({"text": "one\ntwo\n", "sha256": "0"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert_eq!(rendered[0], "✓ read  a.rs");
        assert!(rendered.contains(&"  ⎿ Read 2 lines".to_string()));
    }

    #[test]
    fn a_search_reports_its_match_count() {
        let part = tool(
            "grep",
            json!({"pattern": "fn main", "path": "src"}),
            Some(json!({"matches": [{"path": "@a"}], "truncated": true})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert_eq!(rendered[0], "✓ grep  fn main in src");
        assert!(rendered.contains(&"  ⎿ 1 match (truncated)".to_string()));
    }

    #[test]
    fn an_edit_renders_the_committed_diff_not_its_json() {
        let files = vec![display_file()];
        let part = tool(
            "edit_file",
            json!({"path": "src/lib.rs", "expected_sha256": "0"}),
            Some(json!({"path": "src/lib.rs", "sha256": "1"})),
            false,
        );
        let rendered = rendered(&lines(&part, Some(&files), &theme(), false));
        assert_eq!(rendered[0], "✓ edit  src/lib.rs");
        assert!(rendered.contains(&"  ⎿ Added 1 line, removed 1 line".to_string()));
        assert!(rendered.contains(&"  ◆ update src/lib.rs +1 −1".to_string()));
        assert!(rendered.contains(&"  -a".to_string()));
        assert!(rendered.contains(&"  +b".to_string()));
        assert!(!rendered.iter().any(|line| line.contains("Index:")));
    }

    #[test]
    fn todos_render_with_status_glyphs_and_dependencies() {
        let part = tool(
            "todowrite",
            json!({"todos": [
                {"id": "1", "content": "write code", "status": "completed"},
                {"id": "2", "content": "test it", "status": "in_progress", "depends_on": ["1"]}
            ]}),
            None,
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert_eq!(rendered[0], "· todowrite");
        assert!(rendered.contains(&"  [✓] 1: write code".to_string()));
        assert!(rendered.contains(&"  [•] 2: test it ← 1".to_string()));
    }

    #[test]
    fn a_web_fetch_keeps_only_its_url() {
        let part = tool(
            "webfetch",
            json!({"url": "https://example.com/docs"}),
            Some(json!({"content": "an entire page"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert_eq!(rendered, ["✓ WebFetch  https://example.com/docs"]);
    }

    #[test]
    fn a_question_shows_each_answer() {
        let part = tool(
            "question",
            json!({"questions": [
                {"question": "Which files?", "options": [{"label": "src"}]},
                {"question": "Proceed?", "options": [{"label": "yes"}]}
            ]}),
            Some(json!({"state": "answered", "answers": [["src"], ["yes", "now"]]})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert!(rendered.contains(&"  Which files?".to_string()));
        assert!(rendered.contains(&"  ⎿ src".to_string()));
        assert!(rendered.contains(&"  ⎿ yes, now".to_string()));
    }

    #[test]
    fn an_unknown_tool_keeps_its_input_and_output() {
        let part = tool(
            "mcp_server_tool",
            json!({"query": "hello"}),
            Some(json!({"result": "world"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false));
        assert_eq!(rendered[0], "✓ mcp_server_tool  hello");
        assert!(rendered.contains(&"  │ {\"result\":\"world\"}".to_string()));
    }
}
