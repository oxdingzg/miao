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
use unicode_width::UnicodeWidthStr;

use crate::highlight::Highlighter;
use crate::session::{DisplayFile, ToolPart};
use crate::theme::Theme;

/// Output lines one command row shows before collapsing.
const TOOL_PREVIEW_LINES: usize = 1;
/// Diff lines one changed file shows before collapsing.
const DIFF_PREVIEW_LINES: usize = 12;
/// Characters one terminal read lays out per row.
const PAINT_ROW_CHARS: usize = 120;

/// How much of a tool result to paint, and the chord that changes it.
///
/// Folding is one decision, so the budget and the hint travel together: every
/// renderer used to recompute the same limit from `expanded`, and passing the
/// chord beside it on its own pushed three of them past clippy's argument
/// budget for no gain in clarity.
#[derive(Clone, Copy)]
struct Fold<'a> {
    expanded: bool,
    /// The chord the operator presses to unfold, as the keymap spells it.
    toggle: Option<&'a str>,
}

impl Fold<'_> {
    /// Rows a preview may paint out of `budget`, unlimited when expanded.
    fn limit(self, budget: usize) -> usize {
        match self.expanded {
            true => usize::MAX,
            false => budget,
        }
    }
}

pub fn lines(
    tool: &ToolPart,
    files: Option<&[DisplayFile]>,
    theme: &Theme,
    expanded: bool,
    toggle: Option<&str>,
) -> Vec<Line<'static>> {
    let name = product_name(&tool.name);
    let input = product_input(&tool.name, &tool.input);
    let raw = tool.output.as_deref();
    let result = raw.and_then(parse_json);
    let mut out = Vec::new();
    let fold = Fold { expanded, toggle };
    match name {
        "bash" => bash(&mut out, tool, &input, result.as_ref(), raw, theme, fold),
        "read" => read(&mut out, tool, &input, result.as_ref(), theme, fold),
        "glob" | "grep" => search(&mut out, tool, name, &input, result.as_ref(), theme, fold),
        "write" | "edit" | "apply_patch" => {
            file(&mut out, tool, name, &input, files, raw, theme, fold)
        }
        "todowrite" => todos(&mut out, tool, result.as_ref(), raw, theme, fold),
        "question" => question(&mut out, tool, &input, result.as_ref(), theme),
        "webfetch" => inline(&mut out, tool, "WebFetch", &text(&input, "url"), theme),
        "websearch" => inline(&mut out, tool, "WebSearch", &text(&input, "query"), theme),
        "skill" => inline(&mut out, tool, "Skill", &text(&input, "name"), theme),
        "task" => task(&mut out, tool, &input, raw, theme, fold),
        "send_message" => receipt(&mut out, tool, &input, raw, theme),
        "list_sessions" => sessions(&mut out, tool, result.as_ref(), theme, fold),
        "read_session_context" => out.push(header(
            tool,
            "read session",
            &compact(&text(&input, "to")),
            theme,
        )),
        "terminal_start" => terminal_started(&mut out, tool, &input, result.as_ref(), theme, fold),
        "terminal_write" | "terminal_resize" => {
            terminal_control(&mut out, tool, name, &input, theme, fold)
        }
        "terminal_read" => terminal_read(&mut out, tool, &input, result.as_ref(), theme, fold),
        "terminal_stop" => terminal_stopped(&mut out, tool, &input, result.as_ref(), theme, fold),
        "terminal_list" => terminal_list(&mut out, tool, result.as_ref(), theme, fold),
        _ => generic(
            &mut out,
            tool,
            name,
            &input,
            result.as_ref(),
            raw,
            theme,
            fold,
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
        "apply_patch" => {
            // A patch names its targets inside the payload, not in a field the
            // row can print: without this the header read as a bare
            // `apply_patch` with no subject at all.
            let patch = record
                .get("patch")
                .or_else(|| record.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let targets: Vec<&str> = patch
                .lines()
                .filter_map(|line| line.trim().strip_prefix("***"))
                .filter_map(|rest| rest.rsplit_once(':'))
                .map(|(_, path)| path.trim())
                .filter(|path| !path.is_empty())
                .collect();
            if let Some(subject) = match targets.as_slice() {
                [] => None,
                [only] => Some((*only).to_string()),
                [first, ..] => Some(format!("{first} +{} more", targets.len() - 1)),
            } {
                projected.insert("filePath".into(), Value::String(subject));
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

#[cfg(test)]
mod patch_subject_tests {
    use super::product_input;
    use serde_json::json;

    /// A patch names its targets inside the payload. Without this projection
    /// the row read as a bare `apply_patch` with no subject, and a transcript
    /// of several calls showed the operator nothing at all.
    #[test]
    fn a_patch_row_names_what_it_touches() {
        let one = product_input(
            "apply_patch",
            &json!({
                "patch": "*** Begin Patch\n*** Update File: crates/miao-tui/src/app.rs\n@@\n-a\n+b\n*** End Patch"
            }),
        );
        assert_eq!(one["filePath"], json!("crates/miao-tui/src/app.rs"));

        let many = product_input(
            "apply_patch",
            &json!({
                "patch": "*** Begin Patch\n*** Add File: a.rs\n*** Delete File: b.rs\n*** Update File: c.rs\n*** End Patch"
            }),
        );
        assert_eq!(many["filePath"], json!("a.rs +2 more"));

        // A payload with no target marker leaves the row as it was rather than
        // printing an empty subject.
        let none = product_input("apply_patch", &json!({ "patch": "not a patch" }));
        assert!(none.get("filePath").is_none());
    }
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
    // Each state gets its own glyph as well as its own colour: a finished call
    // reads as a tick and a failed one as a cross even in a monochrome theme,
    // where both dots were the same shape and only the colour told them apart.
    let (glyph, glyph_style) = if tool.failed {
        ("✗", Style::new().fg(palette.error))
    } else if tool.output.is_some() {
        ("✓", Style::new().fg(palette.success))
    } else if tool.unreturned {
        // The turn ended without this call's result: nothing is in flight, so
        // the row must not keep the running glyph.
        ("–", Style::new().fg(palette.text_muted))
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

fn preview(
    out: &mut Vec<Line<'static>>,
    text: &str,
    color: Color,
    limit: usize,
    toggle: Option<&str>,
) {
    let text = scrub_output(text);
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
        // reads like lost output. The chord is the one the keymap actually
        // binds, so a remap or an unbound action cannot leave the line
        // promising a key that does nothing.
        let hidden = lines.len() - limit;
        let line = match toggle {
            Some(chord) => format!("  │ … {hidden} more lines · {chord} expand"),
            None => format!("  │ … {hidden} more lines"),
        };
        out.push(Line::from(Span::styled(line, Style::new().fg(color))));
    }
}

/// A coordination message reads as its receipt: who it went to and whether that
/// peer was asked to act. The engine answers with exactly that, so the row shows
/// the answer instead of raw JSON, and the reason stays visible under it.
fn receipt(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    raw: Option<&str>,
    theme: &Theme,
) {
    let palette = theme.palette;
    let to = text(input, "to");
    let state = match raw
        .and_then(parse_json)
        .as_ref()
        .and_then(|answer| answer.get("wake"))
        .and_then(Value::as_str)
    {
        Some("requested") => " · wake requested",
        Some(_) => " · left for later",
        None => "",
    };
    out.push(header(
        tool,
        "message",
        &compact(&format!("→ {to}{state}")),
        theme,
    ));
    if let Some(reason) = input.get("reason").and_then(Value::as_str) {
        out.push(result_line(reason, palette.text_muted));
    }
}

fn inline(out: &mut Vec<Line<'static>>, tool: &ToolPart, label: &str, detail: &str, theme: &Theme) {
    out.push(header(tool, label, &compact(detail), theme));
}

/// Peer discovery as one line per Session. The raw result is a catalog of
/// every live Session in the Location — printing it verbatim buried the
/// transcript under a screen of JSON on sessions that coordinate with peers.
fn sessions(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    result: Option<&Value>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let palette = theme.palette;
    let rows = result
        .and_then(|value| value.get("sessions"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let summary = match rows {
        [] => "no peer sessions".to_string(),
        [only] => peer_line(only),
        rows => format!("{} sessions: {}", rows.len(), peer_line(&rows[0])),
    };
    out.push(header(tool, "sessions", &compact(&summary), theme));
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let body = rows.iter().map(peer_line).collect::<Vec<_>>().join("\n");
    if !body.is_empty() {
        preview(out, &body, palette.text_muted, limit, fold.toggle);
    }
}

fn peer_line(row: &Value) -> String {
    let title = row
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or("untitled");
    let task = row.get("task").and_then(Value::as_str).unwrap_or("unknown");
    let objective = row
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if objective.is_empty() {
        format!("{title} · {task}")
    } else {
        format!("{title} · {task} · {objective}")
    }
}

/// Session-owned interactive terminals read as their id and state. The read
/// payload carries raw PTY text with escape sequences, so the row paints the
/// decoded output instead of the JSON envelope that delivered it — that
/// envelope dumped verbatim buried the transcript under a screen of escapes.
fn terminal_started(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    let argv = input
        .get("argv")
        .and_then(Value::as_array)
        .map(|argv| {
            argv.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    out.push(header(tool, "terminal", &compact(&argv), theme));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
        }
        return;
    }
    let Some(record) = result else {
        return;
    };
    out.push(result_line(
        &format!(
            "{} · {}×{}",
            text(record, "id"),
            record.get("rows").and_then(Value::as_u64).unwrap_or(0),
            record.get("cols").and_then(Value::as_u64).unwrap_or(0)
        ),
        palette.text_muted,
    ));
}

fn terminal_control(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    name: &str,
    input: &Value,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    let id = compact(&text(input, "id"));
    let detail = match name {
        "terminal_resize" => format!(
            "{id} · {}×{}",
            input.get("rows").and_then(Value::as_u64).unwrap_or(0),
            input.get("cols").and_then(Value::as_u64).unwrap_or(0)
        ),
        _ => id,
    };
    out.push(header(
        tool,
        &format!("terminal {}", name.trim_start_matches("terminal_")),
        &detail,
        theme,
    ));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
        }
        return;
    }
    out.push(result_line("accepted", palette.text_muted));
}

fn terminal_read(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    out.push(header(
        tool,
        "terminal read",
        &compact(&text(input, "id")),
        theme,
    ));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
        }
        return;
    }
    let Some(record) = result else {
        return;
    };
    let body = record
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut summary = byte_summary(body.len());
    let dropped = record.get("dropped").and_then(Value::as_u64).unwrap_or(0);
    if dropped > 0 {
        summary.push_str(&format!(" · {} dropped", byte_summary(dropped as usize)));
    }
    if record
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        summary.push_str(" · more retained");
    }
    summary.push_str(&format!(" · {}", exit_summary(record.get("exit"))));
    out.push(result_line(&summary, palette.text_muted));
    if !body.is_empty() {
        preview(
            out,
            &paint_rows(&scrub_output(body)),
            palette.text_muted,
            limit,
            fold.toggle,
        );
    }
}

/// A PTY window is laid out as rows before the fold counts them. A full-screen
/// program positions cells with escape sequences and emits no newline at all, so
/// one read arrives as a single line of thousands of characters: a row budget
/// cannot fold what is not a row, and the pane laid the whole window out
/// instead. Scrubbing comes first so a row break cannot land inside an escape
/// sequence and leave its tail as text.
fn paint_rows(text: &str) -> String {
    text.split('\n')
        .flat_map(|line| {
            let chars = line.chars().collect::<Vec<_>>();
            match chars.len() <= PAINT_ROW_CHARS {
                true => vec![line.to_string()],
                false => chars
                    .chunks(PAINT_ROW_CHARS)
                    .map(|chunk| chunk.iter().collect())
                    .collect(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn terminal_stopped(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    out.push(header(
        tool,
        "terminal stop",
        &compact(&text(input, "id")),
        theme,
    ));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
        }
        return;
    }
    let Some(record) = result else {
        return;
    };
    out.push(result_line(&exit_summary(Some(record)), palette.text_muted));
}

fn terminal_list(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    result: Option<&Value>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    out.push(header(tool, "terminal list", "", theme));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
        }
        return;
    }
    let body = result
        .and_then(|value| value.get("terminals"))
        .and_then(Value::as_array)
        .map(|terminals| {
            terminals
                .iter()
                .map(|terminal| {
                    format!(
                        "{} · {}",
                        text(terminal, "id"),
                        exit_summary(terminal.get("exit"))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if body.is_empty() {
        out.push(result_line("no terminals", palette.text_muted));
        return;
    }
    preview(out, &body, palette.text_muted, limit, fold.toggle);
}

fn exit_summary(exit: Option<&Value>) -> String {
    // A live terminal answers `"exit": null` — the key exists but carries no
    // exit yet, and that reads as running, not as a finished call.
    let Some(exit) = exit.filter(|value| !value.is_null()) else {
        return "running".to_string();
    };
    let reason = exit
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("exited");
    if let Some(code) = exit.get("exit_code").and_then(Value::as_i64) {
        return format!("{reason} · exit {code}");
    }
    if let Some(signal) = exit.get("signal").and_then(Value::as_i64) {
        return format!("{reason} · signal {signal}");
    }
    reason.to_string()
}

fn byte_summary(len: usize) -> String {
    if len < 1024 {
        return format!("{len} B");
    }
    if len < 1024 * 1024 {
        return format!("{:.1} KiB", len as f64 / 1024.0);
    }
    format!("{:.1} MiB", len as f64 / (1024.0 * 1024.0))
}

fn bash(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    input: &Value,
    result: Option<&Value>,
    raw: Option<&str>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
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
        preview(out, &text, palette.error, limit, fold.toggle);
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
        fold.toggle,
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
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    let path = text(input, "filePath");
    out.push(header(tool, "read", &compact(&path), theme));
    if tool.failed {
        if let Some(output) = tool.output.as_deref() {
            preview(out, output, palette.error, limit, fold.toggle);
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
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
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
        preview(out, output, palette.error, limit, fold.toggle);
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
    fold: Fold<'_>,
) {
    let diff_limit = fold.limit(DIFF_PREVIEW_LINES);
    let limit = fold.limit(TOOL_PREVIEW_LINES);
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
        preview(out, message, palette.error, limit, fold.toggle);
        return;
    }
    let Some(files) = files.filter(|files| !files.is_empty()) else {
        // A call still streaming has no recorded diff, and an engine that
        // committed no display block leaves one behind. The input is then the
        // only record of the change, and a row that is a bare filename tells
        // the operator nothing about what was edited.
        let (rows, hidden) = input_diff(name, input, diff_limit);
        paint_diff(out, &rows, hidden, &path, theme, fold.toggle);
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
        let (rows, hidden) = patch_diff(&file.patch, diff_limit);
        paint_diff(out, &rows, hidden, &file.path, theme, fold.toggle);
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

/// One painted diff row: the source line number when the patch states one, the
/// `+`/`-` marker, and the code the line holds.
enum DiffRow {
    /// The seam between two hunks, where the numbers restart.
    Hunk,
    Line {
        number: Option<u64>,
        marker: char,
        text: String,
    },
}

/// Split a unified patch into paintable rows, stopping after `budget` lines.
///
/// `hidden` counts the lines the budget left out so the fold can say how much of
/// the change is off screen. A hunk header that states its range
/// (`@@ -12,7 +12,9 @@`) restarts both counters; the V4A shape an `apply_patch`
/// tool takes as input states no range, so its rows carry no numbers.
fn patch_diff(patch: &str, budget: usize) -> (Vec<DiffRow>, usize) {
    let mut rows = Vec::new();
    let mut hidden = 0;
    let mut drawn = 0;
    let mut numbers: Option<(u64, u64)> = None;
    let mut started = false;
    for line in patch.lines() {
        if line.starts_with("@@") {
            if drawn > 0 && drawn < budget {
                rows.push(DiffRow::Hunk);
            }
            started = true;
            numbers = hunk_start(line);
            continue;
        }
        // Everything above the first hunk names the file, not a change to it.
        if !started {
            continue;
        }
        let Some((marker, text)) = marker_line(line) else {
            continue;
        };
        let current = numbers;
        let number = current.map(|(old, new)| {
            numbers = Some(match marker {
                '+' => (old, new + 1),
                '-' => (old + 1, new),
                _ => (old + 1, new + 1),
            });
            if marker == '+' {
                new
            } else {
                old
            }
        });
        if drawn >= budget {
            hidden += 1;
            continue;
        }
        drawn += 1;
        rows.push(DiffRow::Line {
            number,
            marker,
            text: text.to_string(),
        });
    }
    (rows, hidden)
}

/// The change a call asked for, for the call no diff was recorded for.
///
/// A streamed call has no display diff yet, and an engine that committed none
/// leaves the input as the only record of what changed.
fn input_diff(name: &str, input: &Value, budget: usize) -> (Vec<DiffRow>, usize) {
    if name == "apply_patch" {
        return patch_diff(&text(input, "patch"), budget);
    }
    let (removed, added) = match name {
        "edit" => (text(input, "old_string"), text(input, "new_string")),
        _ => (String::new(), text(input, "content")),
    };
    // A replacement spends the budget on both halves: giving it all to one side
    // would hide the very text the model asked to write.
    let per_side = if removed.is_empty() || added.is_empty() {
        budget
    } else {
        budget.div_ceil(2)
    };
    let mut rows = Vec::new();
    let mut hidden = 0;
    for (marker, side) in [('-', removed.as_str()), ('+', added.as_str())] {
        for (index, text) in side.lines().enumerate() {
            if index >= per_side {
                hidden += 1;
                continue;
            }
            rows.push(DiffRow::Line {
                number: None,
                marker,
                text: text.to_string(),
            });
        }
    }
    (rows, hidden)
}

fn paint_diff(
    out: &mut Vec<Line<'static>>,
    rows: &[DiffRow],
    hidden: usize,
    path: &str,
    theme: &Theme,
    toggle: Option<&str>,
) {
    let palette = theme.palette;
    // One gutter width for the whole block: a digit count that varies per row
    // makes the markers jag down the block and the code jump sideways.
    let width = rows
        .iter()
        .filter_map(|row| match row {
            DiffRow::Line {
                number: Some(number),
                ..
            } => Some(number.to_string().len()),
            _ => None,
        })
        .max()
        .unwrap_or(0);
    // The scanner carries block-comment state across lines, so the file's own
    // language decides the spans; an extension outside the table stays plain.
    let mut highlighter = Highlighter::new(extension(path), palette);
    // A changed row is a block, not a streak of coloured text: every cell of it
    // carries the change's tint, and the block ends on one column so its right
    // edge is straight whatever the code says.
    let block = rows
        .iter()
        .filter_map(|row| match row {
            DiffRow::Line { marker, text, .. } if *marker != ' ' => {
                Some(width + 4 + marker.len_utf8() + text.width())
            }
            _ => None,
        })
        .max()
        .unwrap_or(0);
    for row in rows {
        match row {
            DiffRow::Hunk => out.push(Line::from(Span::styled(
                format!("  {:width$}  …", ""),
                Style::new().fg(palette.text_muted),
            ))),
            DiffRow::Line {
                number,
                marker,
                text,
            } => {
                let gutter = match number {
                    Some(number) => format!("  {number:>width$}  "),
                    None => format!("  {:width$}  ", ""),
                };
                // A changed row is the product's diff block: the row's own
                // green or red behind flat text in the matching hue, the way
                // the product paints a diff. Unchanged rows keep the scanner.
                let (block_style, flat) = match marker {
                    '+' | '-' => {
                        let (background, text) = palette.diff(*marker == '+');
                        (
                            Style::new().bg(background),
                            Some(Style::new().fg(text).patch(Style::new().bg(background))),
                        )
                    }
                    _ => (Style::new(), None),
                };
                let mut spans = vec![
                    Span::styled(
                        gutter,
                        Style::new().fg(palette.text_muted).patch(block_style),
                    ),
                    Span::styled(
                        marker.to_string(),
                        flat.unwrap_or_else(|| Style::new().fg(diff_color(*marker, theme))),
                    ),
                ];
                let start = width + 4 + marker.len_utf8() + text.width();
                match flat {
                    // The product's diff line is one flat colour: the scanner
                    // would put a teal string inside a green row.
                    Some(style) => spans.push(Span::styled(text.clone(), style)),
                    None => spans.extend(
                        highlighter
                            .line(text)
                            .into_iter()
                            .map(|span| span.patch_style(block_style)),
                    ),
                }
                if *marker != ' ' && start < block {
                    spans.push(Span::styled(" ".repeat(block - start), block_style));
                }
                out.push(Line::from(spans));
            }
        }
    }
    if hidden > 0 {
        let line = match toggle {
            Some(chord) => format!("  … {hidden} more diff lines · {chord} expand"),
            None => format!("  … {hidden} more diff lines"),
        };
        out.push(Line::from(Span::styled(
            line,
            Style::new().fg(palette.text_muted),
        )));
    }
}

/// The `-a,b +c,d` range a unified hunk header states, if it states one.
fn hunk_start(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, new) = rest.split_once(" +")?;
    Some((
        old.split(',').next()?.parse().ok()?,
        new.split([',', ' ']).next()?.parse().ok()?,
    ))
}

/// The marker a diff body line opens with, and the text after it. A line that is
/// not a change at all (`\ No newline at end of file`) has no marker.
fn marker_line(line: &str) -> Option<(char, &str)> {
    match line.chars().next() {
        Some(marker @ ('+' | '-' | ' ')) => Some((marker, &line[marker.len_utf8()..])),
        None => Some((' ', "")),
        Some(_) => None,
    }
}

/// The extension whose scanner colours a file's code.
fn extension(path: &str) -> &str {
    path.rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default()
}

fn diff_color(marker: char, theme: &Theme) -> Color {
    let palette = theme.palette;
    match marker {
        '+' => palette.success,
        '-' => palette.error,
        _ => palette.text_muted,
    }
}

fn todos(
    out: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    result: Option<&Value>,
    raw: Option<&str>,
    theme: &Theme,
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
    let palette = theme.palette;
    out.push(header(tool, "todowrite", "", theme));
    if tool.failed {
        preview(
            out,
            raw.unwrap_or_default(),
            palette.error,
            limit,
            fold.toggle,
        );
        return;
    }
    // The list the engine recorded, never the one the model asked for. The
    // result carries the applied list, while the input is what the call meant
    // to write — and while the call is still in flight that input is a partial
    // stream that would paint as the Session's plan before the engine has one.
    // The sidebar paints the recorded list, so a row painted from the input
    // disagreed with it every time the plan moved: same six items, different
    // statuses, in the two places an operator reads the plan.
    let Some(list) = result
        .and_then(|value| value.get("value"))
        .and_then(|value| value.get("todos"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for todo in list {
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
    fold: Fold<'_>,
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
                fold.toggle,
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
    fold: Fold<'_>,
) {
    let limit = fold.limit(TOOL_PREVIEW_LINES);
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
        fold.toggle,
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

/// Terminal escape sequences and stray control characters never paint: PTY
/// text and echoed model output would otherwise corrupt the transcript's own
/// rendering. Newlines and tabs survive.
pub(crate) fn scrub_output(text: &str) -> String {
    strip_ansi(text)
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
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

    /// A call whose turn ended without a result is not running any more. The
    /// row's state used to be inferred from the result alone, so such a row
    /// kept the running glyph for the rest of the Session.
    #[test]
    fn an_unreturned_call_reads_as_settled_not_running() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut call = tool("apply_patch", serde_json::json!({}), None, false);
        call.unreturned = true;
        let text = format!("{:?}", lines(&call, None, &theme, false, None));
        assert!(
            text.contains('–'),
            "an unanswered call after a finished turn shows the settled glyph: {text}"
        );
        assert!(
            !text.contains('·'),
            "it must not keep the running glyph: {text}"
        );
        // Before the turn ends the same row still reads as in flight.
        call.unreturned = false;
        let running = format!("{:?}", lines(&call, None, &theme, false, None));
        assert!(running.contains('·'), "a live call still shows running");
    }

    fn tool(name: &str, input: Value, output: Option<Value>, failed: bool) -> ToolPart {
        ToolPart {
            id: "call_1".into(),
            name: name.into(),
            input,
            output: output.map(|value| value.to_string()),
            failed,
            unreturned: false,
        }
    }

    /// A completed `read_file` puts its result on its own indented row, and
    /// that row has to survive a narrow pane: `wrap_rows` folds a plain row at
    /// the pane width, so a 44-column transcript used to break `  ⎿ Read 2
    /// lines` in half with no hanging indent. The row is short by design — it
    /// is a one-line summary — so it hangs under its own `⎿` column instead of
    /// folding mid-phrase.
    #[test]
    fn a_short_read_summary_does_not_fold_mid_phrase() {
        let lines = lines(
            &tool(
                "read_file",
                json!({"path": "src/lib.rs"}),
                Some(json!({"text": "one\ntwo", "sha256": "0"})),
                false,
            ),
            None,
            &theme(),
            false,
            None,
        );
        let rendered = rendered(&lines);
        assert!(
            rendered.iter().any(|line| line.contains("⎿ Read 2 lines")),
            "{rendered:?}"
        );
    }

    fn rendered(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(row_text).collect()
    }

    /// A diff reads by shape before it reads by text: the whole changed row
    /// carries the change's tint, not only the `+`/`-` glyph, and every changed
    /// row ends on the same column so the block's edge is straight. An unchanged
    /// row stays on the canvas, where the tint would claim a change that is not
    /// there.
    #[test]
    fn a_changed_diff_row_is_a_tinted_block() {
        let theme = theme();
        let palette = theme.palette;
        let call = tool(
            "apply_patch",
            json!({"patch": "*** Begin Patch\n*** Update File: src/a.rs\n@@ -1,2 +1,2 @@\n kept\n-gone\n+kept better and longer\n*** End Patch"}),
            None,
            false,
        );
        let rows = lines(&call, None, &theme, false, None);
        let find = |needle: &str| {
            rows.iter()
                .find(|row| row_text(row).contains(needle))
                .unwrap_or_else(|| panic!("no row holds {needle}: {:?}", rendered(&rows)))
        };
        let added = find("kept better and longer");
        let removed = find("gone");
        let context = find(" kept");
        let (added_bg, added_text) = palette.diff(true);
        let (removed_bg, removed_text) = palette.diff(false);
        assert!(
            added
                .spans
                .iter()
                .all(|span| span.style.bg == Some(added_bg)),
            "every cell of an added row carries the added tint: {:?}",
            added
        );
        assert!(
            added
                .spans
                .iter()
                .any(|span| span.content.as_ref() == "kept better and longer"
                    && span.style.fg == Some(added_text)),
            "a changed row is the product's flat diff text, not the scanner's: {:?}",
            added
        );
        assert!(
            removed
                .spans
                .iter()
                .all(|span| span.style.bg == Some(removed_bg)),
            "every cell of a removed row carries the removed tint: {:?}",
            removed
        );
        assert!(
            removed
                .spans
                .iter()
                .any(|span| span.content.as_ref() == "gone" && span.style.fg == Some(removed_text)),
            "a changed row is the product's flat diff text, not the scanner's: {:?}",
            removed
        );
        assert!(
            context.spans.iter().all(|span| span.style.bg.is_none()),
            "an unchanged row stays on the canvas: {:?}",
            context
        );
        // The shorter removed row is padded out to the block the added row sets.
        let cells = |row: &Line<'_>| {
            row.spans
                .iter()
                .map(|span| span.content.width())
                .sum::<usize>()
        };
        assert_eq!(
            cells(removed),
            cells(added),
            "both changed rows end on the block's column: {:?}",
            rendered(&rows)
        );
    }

    /// A colourless theme has no canvas to mix into, so the block drops away and
    /// the glyphs and words keep carrying the change on their own.
    #[test]
    fn a_colourless_theme_paints_no_diff_block() {
        let theme = theme().monochrome();
        let call = tool(
            "apply_patch",
            json!({"patch": "*** Begin Patch\n*** Update File: src/a.rs\n@@ -1,1 +1,1 @@\n-gone\n+kept\n*** End Patch"}),
            None,
            false,
        );
        let rows = lines(&call, None, &theme, false, None);
        assert!(
            rows.iter().flat_map(|row| row.spans.iter()).all(|span| span
                .style
                .bg
                .is_none_or(|bg| bg == ratatui::style::Color::Reset)),
            "no cell claims a block colour: {:?}",
            rendered(&rows)
        );
    }

    fn row_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
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
        let lines = lines(&part, None, &theme(), false, Some("ctrl+x u"));
        let rendered = rendered(&lines);
        assert_eq!(rendered[0], "✓ bash  echo hi");
        assert!(rendered.contains(&"  │ hi".to_string()));
        // Folded output keeps one line; the tail and the hint stay reachable
        // through the elision marker instead of crowding the transcript.
        assert!(rendered.iter().any(|line| line.contains("more lines")));
        // The hint names the key the operator presses, not the config's
        // `<leader>` placeholder.
        assert!(rendered
            .iter()
            .any(|line| line.contains("· ctrl+x u expand")));
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
        let folded = rendered(&lines(&part, None, &theme(), false, None));
        assert!(folded.len() < 12);
        assert!(folded.iter().any(|line| line.contains("more lines")));
        let expanded = rendered(&lines(&part, None, &theme(), true, None));
        assert!(expanded.iter().any(|line| line.contains("line 12")));
        assert!(!expanded.iter().any(|line| line.contains("more lines")));
    }

    /// The receipt is the engine's own answer, so the row repeats it rather
    /// than dumping JSON: who received the message and whether it was asked to
    /// act are the two facts a caller needs.
    #[test]
    fn a_coordination_message_reads_as_a_receipt() {
        let part = tool(
            "send_message",
            json!({"to": "ses_b", "message": "verify the migration", "reason": "the operator asked"}),
            Some(
                json!({"sessionID": "ses_b", "wake": "requested", "reason": "the operator asked"}),
            ),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert!(
            rendered[0].contains("message") && rendered[0].contains("→ ses_b"),
            "{rendered:?}"
        );
        assert!(rendered[0].contains("wake requested"), "{rendered:?}");
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("the operator asked")),
            "the reason stays visible: {rendered:?}"
        );
        // The raw answer never reaches the transcript.
        assert!(!rendered.iter().any(|line| line.contains("sessionID")));
    }

    #[test]
    fn a_failed_shell_result_shows_the_reason() {
        let part = tool(
            "bash",
            json!({"command": "ls"}),
            Some(json!({"error": "permission denied"})),
            true,
        );
        let lines = lines(&part, None, &theme(), false, None);
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
        // An unbound toggle keeps the count and promises no key at all.
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert!(rendered.iter().any(|line| line.contains("  │ … ")));
        assert!(rendered.iter().any(|line| line.contains("more lines")));
        assert!(!rendered.iter().any(|line| line.contains("expand")));
    }

    #[test]
    fn terminal_escape_sequences_are_stripped() {
        let part = tool(
            "bash",
            json!({"command": "ls"}),
            Some(json!({"stdout": "\u{1b}[31mred\u{1b}[0m\n", "exit_code": 0})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert!(rendered.contains(&"  │ red".to_string()));
    }

    #[test]
    fn a_terminal_read_row_reports_its_state_not_the_envelope() {
        let part = tool(
            "terminal_read",
            json!({"id": "term_1"}),
            Some(json!({
                "id": "term_1",
                "output": "\u{1b}[38;2;255;0;0mhello\u{1b}[0m world\nsecond line\nthird line\nfourth line",
                "cursor": 65,
                "retained_from": 0,
                "dropped": 0,
                "truncated": true,
                "exit": null
            })),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, Some("ctrl+x r")));
        assert!(rendered.iter().any(|line| line.contains("terminal read")));
        assert!(rendered.iter().any(|line| line.contains("term_1")));
        assert!(rendered
            .iter()
            .any(|line| line.contains("65 B · more retained · running")));
        assert!(rendered.iter().any(|line| line.contains("hello world")));
        assert!(rendered.iter().any(|line| line.contains("more lines")));
        assert!(!rendered.iter().any(|line| line.contains("retained_from")));
        assert!(!rendered.iter().any(|line| line.contains('\u{1b}')));
    }

    #[test]
    fn an_expanded_terminal_read_shows_every_decoded_line() {
        let part = tool(
            "terminal_read",
            json!({"id": "term_1"}),
            Some(json!({
                "id": "term_1",
                "output": "one\n2 \u{1b}[31mred\u{1b}[0m\nthree",
                "cursor": 20,
                "truncated": false,
                "exit": null
            })),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), true, Some("ctrl+x r")));
        assert!(rendered.iter().any(|line| line.contains("2 red")));
        assert!(rendered.iter().any(|line| line.contains("three")));
        assert!(!rendered.iter().any(|line| line.contains("more lines")));
    }

    /// A full-screen program repaints cells with escapes and never emits a
    /// newline, so a screen of paint is one endless logical line: the row budget
    /// folded nothing and the pane laid the whole window out.
    #[test]
    fn a_terminal_read_window_without_newlines_folds_at_the_row_budget() {
        let paint = format!(
            "{}end",
            "\u{1b}[38;2;252;232;108;48;2;46;52;64m█".repeat(4000)
        );
        let part = tool(
            "terminal_read",
            json!({"id": "term_1"}),
            Some(json!({
                "id": "term_1",
                "output": paint,
                "cursor": 9,
                "dropped": 0,
                "truncated": false,
                "exit": null
            })),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, Some("ctrl+x r")));
        assert!(
            rendered.iter().all(|line| line.chars().count() <= 140),
            "{rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains("more lines")),
            "{rendered:?}"
        );
        assert!(
            !rendered.iter().any(|line| line.contains("38;2;")),
            "a row break must not leave an escape tail as text: {rendered:?}"
        );
    }

    #[test]
    fn a_terminal_start_row_names_its_command_and_size() {
        let part = tool(
            "terminal_start",
            json!({"argv": ["bash"], "rows": 24, "cols": 80}),
            Some(json!({
                "id": "term_9",
                "rows": 24,
                "cols": 80,
                "sandbox_profile": "workspace_write",
                "network_allowed": true,
                "max_lifetime_ms": 86400000
            })),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert!(rendered.iter().any(|line| line.contains("bash")));
        assert!(rendered.iter().any(|line| line.contains("term_9 · 24×80")));
    }

    #[test]
    fn a_terminal_list_row_reads_one_line_per_terminal() {
        let part = tool(
            "terminal_list",
            json!({}),
            Some(json!({"terminals": [
                {"id": "term_1", "exit": null},
                {"id": "term_2", "exit": {"reason": "stopped", "exit_code": 0, "signal": null, "error": null}}
            ]})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), true, None));
        assert!(rendered
            .iter()
            .any(|line| line.contains("term_1 · running")));
        assert!(rendered
            .iter()
            .any(|line| line.contains("term_2 · stopped · exit 0")));
    }

    #[test]
    fn a_terminal_stop_row_reports_how_it_ended() {
        let part = tool(
            "terminal_stop",
            json!({"id": "term_2"}),
            Some(json!({"reason": "stopped", "exit_code": 0, "signal": null, "error": null})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert!(rendered
            .iter()
            .any(|line| line.contains("stopped · exit 0")));
    }

    #[test]
    fn a_read_reports_its_line_count() {
        let part = tool(
            "read_file",
            json!({"path": "a.rs"}),
            Some(json!({"text": "one\ntwo\n", "sha256": "0"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
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
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
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
        let rendered = rendered(&lines(&part, Some(&files), &theme(), false, None));
        assert_eq!(rendered[0], "✓ edit  src/lib.rs");
        assert!(rendered.contains(&"  ⎿ Added 1 line, removed 1 line".to_string()));
        assert!(rendered.contains(&"  ◆ update src/lib.rs +1 −1".to_string()));
        assert!(rendered.contains(&"  1  -a".to_string()), "{rendered:?}");
        assert!(rendered.contains(&"  1  +b".to_string()), "{rendered:?}");
        assert!(!rendered.iter().any(|line| line.contains("Index:")));
    }

    /// A streamed call has no recorded diff yet, and a row that is a bare
    /// filename says nothing about the edit. The input is the only record of the
    /// change then, so the row has to paint it.
    #[test]
    fn an_edit_without_a_recorded_diff_shows_what_it_asked_for() {
        let part = tool(
            "edit_file",
            json!({
                "path": "docs/guide.zh.md",
                "old_string": "旧的一行",
                "new_string": "新的一行",
                "expected_sha256": "0"
            }),
            Some(json!({"path": "docs/guide.zh.md", "sha256": "1"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert_eq!(rendered[0], "✓ edit  docs/guide.zh.md");
        assert!(
            rendered.contains(&"    -旧的一行".to_string()),
            "{rendered:?}"
        );
        assert!(
            rendered.contains(&"    +新的一行".to_string()),
            "{rendered:?}"
        );
    }

    #[test]
    fn a_write_without_a_recorded_diff_shows_the_lines_it_wrote() {
        let part = tool(
            "write_file",
            json!({"path": "notes.md", "text": "first\nsecond", "expected_sha256": null}),
            Some(json!({"path": "notes.md", "sha256": "1"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert_eq!(rendered[0], "✓ write  notes.md");
        // A changed row is padded to the block's width, so the tint ends on one
        // column; the padding carries no text.
        assert!(
            rendered.iter().any(|row| row.trim_end() == "    +first"),
            "{rendered:?}"
        );
        assert!(
            rendered.iter().any(|row| row.trim_end() == "    +second"),
            "{rendered:?}"
        );
    }

    /// A hunk header states where its lines sit, so the row can print the number
    /// the operator would see in an editor. Two hunks are one change to read:
    /// the numbers restart at the second and a seam marks the skipped lines.
    #[test]
    fn a_second_hunk_restarts_its_numbers_under_a_seam() {
        let files = vec![DisplayFile {
            path: "src/lib.rs".into(),
            action: "update".into(),
            patch: "@@ -2,2 +2,2 @@\n-let old = 1;\n+let new = 1;\n@@ -40,2 +40,2 @@\n-let tail = 1;\n+let tail = 2;\n"
                .into(),
            additions: 2,
            deletions: 2,
        }];
        let part = tool(
            "edit_file",
            json!({"path": "src/lib.rs"}),
            Some(json!({"applied": true})),
            false,
        );
        let rendered = rendered(&lines(&part, Some(&files), &theme(), false, None));
        assert!(
            rendered
                .iter()
                .any(|row| row.trim_end() == "   2  -let old = 1;"),
            "{rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .any(|row| row.trim_end() == "  40  -let tail = 1;"),
            "{rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.trim() == "…"),
            "{rendered:?}"
        );
    }

    /// The code keeps its colours: the marker column says what changed, and the
    /// scanner says what the line is.
    #[test]
    fn a_diff_row_is_highlighted_by_the_files_language() {
        let files = vec![DisplayFile {
            path: "src/lib.rs".into(),
            action: "update".into(),
            patch: "@@ -1,3 +1,3 @@\n let header = 0;\n-let old = 1;\n+let new = 1;\n".into(),
            additions: 1,
            deletions: 1,
        }];
        let part = tool(
            "edit_file",
            json!({"path": "src/lib.rs"}),
            Some(json!({"applied": true})),
            false,
        );
        let theme = theme();
        let rendered_lines = lines(&part, Some(&files), &theme, false, None);
        // A changed row is the product's diff block in one flat hue, so the
        // scanner does not put a teal string inside a green row. An unchanged
        // row is still code, and keeps the file's own colours.
        let changed = rendered_lines
            .iter()
            .find(|line| row_text(line) == "  2  -let old = 1;")
            .expect("removed row");
        let (background, text) = theme.palette.diff(false);
        assert!(
            changed
                .spans
                .iter()
                .any(|span| span.content.as_ref() == "let old = 1;"
                    && span.style.fg == Some(text)
                    && span.style.bg == Some(background)),
            "a changed row is flat in the product's removed hue: {:?}",
            changed
        );
        let row = rendered_lines
            .iter()
            .find(|line| row_text(line) == "  1   let header = 0;")
            .expect("context row");
        let keyword = row
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "let")
            .expect("the keyword is its own span");
        assert_eq!(keyword.style.fg, Some(theme.palette.syntax().keyword));
    }

    #[test]
    fn a_long_diff_folds_and_says_how_much_it_hides() {
        let body = (1..=30)
            .map(|number| format!("+line {number}"))
            .collect::<Vec<_>>()
            .join("\n");
        let files = vec![DisplayFile {
            path: "notes.txt".into(),
            action: "create".into(),
            patch: format!("@@ -0,0 +1,30 @@\n{body}\n"),
            additions: 30,
            deletions: 0,
        }];
        let part = tool(
            "write_file",
            json!({"path": "notes.txt"}),
            Some(json!({"applied": true})),
            false,
        );
        let folded = rendered(&lines(&part, Some(&files), &theme(), false, None));
        assert!(
            folded
                .iter()
                .any(|line| line.contains("18 more diff lines")),
            "{folded:?}"
        );
        let expanded = rendered(&lines(&part, Some(&files), &theme(), true, None));
        assert!(
            expanded.iter().any(|line| line.contains("line 30")),
            "{expanded:?}"
        );
    }

    #[test]
    fn todos_render_the_records_the_engine_wrote_back() {
        // The row shows the list the engine recorded, so it can never disagree
        // with the sidebar's copy: the call's input is what the model meant to
        // write, and by the time the row settles the engine has the applied
        // list.
        let part = tool(
            "todowrite",
            json!({"todos": [
                {"id": "1", "content": "write code", "status": "pending"},
                {"id": "2", "content": "test it", "status": "pending"}
            ]}),
            Some(json!({"kind": "todos", "revision": 9, "value": {"todos": [
                {"id": "1", "content": "write code", "status": "completed"},
                {"id": "2", "content": "test it", "status": "in_progress", "depends_on": ["1"]}
            ]}})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert_eq!(rendered[0], "✓ todowrite");
        assert!(rendered.contains(&"  [✓] 1: write code".to_string()));
        assert!(rendered.contains(&"  [•] 2: test it ← 1".to_string()));
        // The input said both were pending; the painted row is the applied list.
        assert!(!rendered.iter().any(|line| line.contains("  [ ] 1")));
    }

    #[test]
    fn a_todo_write_still_in_flight_paints_only_its_header() {
        // A partial stream is not the Session's plan: until the engine answers,
        // the sidebar keeps painting the recorded list, so the row must not
        // paint a half-written one beside it.
        let part = tool(
            "todowrite",
            json!({"todos": [{"id": "1", "content": "write code", "status": "completed"}]}),
            None,
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert_eq!(rendered, vec!["· todowrite".to_string()]);
    }

    #[test]
    fn a_web_fetch_keeps_only_its_url() {
        let part = tool(
            "webfetch",
            json!({"url": "https://example.com/docs"}),
            Some(json!({"content": "an entire page"})),
            false,
        );
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
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
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
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
        let rendered = rendered(&lines(&part, None, &theme(), false, None));
        assert_eq!(rendered[0], "✓ mcp_server_tool  hello");
        assert!(rendered.contains(&"  │ {\"result\":\"world\"}".to_string()));
    }
}
