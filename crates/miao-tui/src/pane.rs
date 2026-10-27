use std::path::Path;

use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthChar;

use crate::editor::Composer;
use crate::session::{Entry, Part, SessionSummary, ToolPart, Transcript};
use crate::theme::Theme;

/// How many output lines one tool row shows before collapsing. The full output
/// stays in the engine; this is a reading surface, not a pager.
const TOOL_PREVIEW_LINES: usize = 8;
/// How many diff lines one changed file shows before collapsing.
const DIFF_PREVIEW_LINES: usize = 12;

const SIDEBAR_MIN_WIDTH: u16 = 100;
const SIDEBAR_WIDTH: u16 = 24;

pub trait Pane {
    fn render(&mut self, frame: &mut Frame, area: Rect);
}

pub struct Shell {
    pub title: TitlePane,
    pub transcript: TranscriptPane,
    pub composer: Composer,
    pub sidebar: Option<SidebarPane>,
}

impl Shell {
    pub fn new(workspace: &Path, theme: Theme) -> Self {
        Self {
            title: TitlePane::new(workspace, theme.clone()),
            transcript: TranscriptPane {
                theme: theme.clone(),
                lines: vec![Line::from("no Session selected")],
                scroll: 0,
                follow: true,
            },
            composer: Composer::new(workspace),
            sidebar: Some(SidebarPane {
                theme,
                session: None,
            }),
        }
    }

    pub fn set_transcript(&mut self, transcript: &Transcript) {
        self.transcript.lines = transcript_lines(transcript, &self.transcript.theme);
        let max = self.transcript.lines.len().saturating_sub(1);
        self.transcript.scroll = self.transcript.scroll.min(max as u16);
    }

    /// Show one status line instead of a transcript: engine failures and other
    /// states where there is no Session content to render.
    pub fn set_message(&mut self, message: &str) {
        let palette = self.transcript.theme.palette;
        self.transcript.lines = vec![Line::from(Span::styled(
            message.to_string(),
            Style::new().fg(palette.error),
        ))];
        self.transcript.scroll = 0;
        self.transcript.follow = false;
    }

    pub fn scroll_transcript(&mut self, delta: i32) {
        // Scrolling up detaches from the bottom; new content then lands above
        // the viewport instead of pulling it along.
        self.transcript.follow = false;
        let max = self.transcript.lines.len().saturating_sub(1);
        let next = self.transcript.scroll as i32 + delta;
        self.transcript.scroll = next.clamp(0, max as i32) as u16;
    }

    pub fn set_session(&mut self, session: Option<&SessionSummary>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.session = session.cloned();
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let [title_area, body_area, composer_area] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(composer_height(&self.composer)),
        ])
        .areas(frame.area());
        self.title.render(frame, title_area);
        if body_area.width >= SIDEBAR_MIN_WIDTH {
            let [transcript_area, sidebar_area] =
                Layout::horizontal([Constraint::Min(1), Constraint::Length(SIDEBAR_WIDTH)])
                    .areas(body_area);
            self.transcript.render(frame, transcript_area);
            if let Some(sidebar) = self.sidebar.as_mut() {
                sidebar.render(frame, sidebar_area);
            }
        } else {
            self.transcript.render(frame, body_area);
        }
        render_composer(frame, composer_area, &self.composer, &self.transcript.theme);
    }
}

pub struct TitlePane {
    label: String,
    theme: Theme,
}

impl TitlePane {
    fn new(workspace: &Path, theme: Theme) -> Self {
        let name = workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.display().to_string());
        Self {
            label: format!(" miao-tui · {name} · {} ", git_branch(workspace)),
            theme,
        }
    }
}

fn git_branch(workspace: &Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(workspace)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "no git".to_string())
}

impl Pane for TitlePane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let style = Style::new()
            .fg(self.theme.palette.primary)
            .bg(self.theme.palette.surface)
            .bold();
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(self.label.as_str(), style))),
            area,
        );
    }
}

pub struct TranscriptPane {
    theme: Theme,
    lines: Vec<Line<'static>>,
    scroll: u16,
    /// Follow the tail while new projections arrive. Any manual scroll clears
    /// it, so reading history is not interrupted by committed events.
    follow: bool,
}

impl Pane for TranscriptPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(
                " transcript ",
                Style::new().fg(palette.primary),
            ))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        if self.follow {
            let viewport = area.height.saturating_sub(2) as usize;
            self.scroll = self.lines.len().saturating_sub(viewport) as u16;
        }
        frame.render_widget(
            Paragraph::new(self.lines.clone())
                .style(Style::new().fg(palette.text))
                .block(block)
                .wrap(Wrap { trim: false })
                .scroll((self.scroll, 0)),
            area,
        );
    }
}

pub struct Home {
    pub rows: Vec<SessionSummary>,
    pub selected: usize,
    notice: Option<String>,
    theme: Theme,
}

impl Home {
    pub fn new(theme: Theme) -> Self {
        Self {
            rows: Vec::new(),
            selected: 0,
            notice: None,
            theme,
        }
    }

    pub fn set_notice(&mut self, notice: Option<String>) {
        self.notice = notice;
    }

    pub fn set_rows(&mut self, rows: Vec<SessionSummary>) {
        let selected_id = self.rows.get(self.selected).map(|row| row.id.clone());
        self.rows = rows;
        self.selected = selected_id
            .and_then(|id| self.rows.iter().position(|row| row.id == id))
            .unwrap_or(0)
            .min(self.rows.len().saturating_sub(1));
    }

    pub fn move_cursor(&mut self, delta: i32) {
        if self.rows.is_empty() {
            self.selected = 0;
            return;
        }
        let next = self.selected as i32 + delta;
        self.selected = next.clamp(0, self.rows.len() as i32 - 1) as usize;
    }

    pub fn current(&self) -> Option<&SessionSummary> {
        self.rows.get(self.selected)
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(
                " sessions · n new ",
                Style::new().fg(palette.primary),
            ))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        if self.rows.is_empty() {
            let message = self
                .notice
                .clone()
                .unwrap_or_else(|| "no sessions yet · press n to start one".to_string());
            frame.render_widget(
                Paragraph::new(message)
                    .style(Style::new().fg(palette.text_muted))
                    .block(block),
                area,
            );
            return;
        }
        let notice = self.notice.iter().flat_map(|notice| {
            [
                Line::from(Span::styled(notice.clone(), Style::new().fg(palette.error))),
                Line::default(),
            ]
        });
        let rows = self.rows.iter().enumerate().map(|(index, row)| {
            let marker = if index == self.selected { "▸ " } else { "  " };
            let style = if index == self.selected {
                Style::new()
                    .fg(palette.primary)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text)
            };
            let detail = match (row.directory.as_deref(), row.updated_at_ms) {
                (Some(directory), Some(updated)) => {
                    let name = Path::new(directory)
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| directory.to_string());
                    format!("{}  ·  {}", relative_time(updated), name)
                }
                _ => String::new(),
            };
            Line::from(vec![
                Span::styled(format!("{marker}{}", row.label()), style),
                Span::styled(
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("   {detail}")
                    },
                    Style::new().fg(palette.text_muted),
                ),
            ])
        });
        frame.render_widget(
            Paragraph::new(notice.chain(rows).collect::<Vec<_>>())
                .block(block)
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}

fn relative_time(updated_at_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(updated_at_ms);
    let delta_ms = now.saturating_sub(updated_at_ms);
    let minutes = delta_ms / 60_000;
    match minutes {
        0 => "just now".to_string(),
        1..=59 => format!("{minutes}m ago"),
        _ => {
            let hours = minutes / 60;
            if hours < 24 {
                format!("{hours}h ago")
            } else {
                format!("{}d ago", hours / 24)
            }
        }
    }
}

fn transcript_lines(transcript: &Transcript, theme: &Theme) -> Vec<Line<'static>> {
    let palette = theme.palette;
    let mut lines = Vec::new();
    for entry in &transcript.entries {
        match entry {
            Entry::User { text } => {
                for line in text.lines() {
                    lines.push(Line::from(vec![
                        Span::styled("❯ ", Style::new().fg(palette.primary)),
                        Span::styled(line.to_string(), Style::new().fg(palette.text)),
                    ]));
                }
                lines.push(Line::default());
            }
            Entry::Assistant {
                agent,
                model,
                parts,
            } => {
                let label = match (agent.as_deref(), model.as_deref()) {
                    (Some(agent), Some(model)) => format!("✳ {agent} · {model}"),
                    (Some(agent), None) => format!("✳ {agent}"),
                    (None, Some(model)) => format!("✳ {model}"),
                    (None, None) => "✳ assistant".to_string(),
                };
                lines.push(Line::from(Span::styled(
                    label,
                    Style::new().fg(palette.text_muted),
                )));
                for part in parts {
                    match part {
                        Part::Text(text) => {
                            for line in text.lines() {
                                lines.push(Line::from(line.to_string()));
                            }
                        }
                        Part::Reasoning(text) => lines.push(Line::from(Span::styled(
                            format!("▸ thinking · {} chars", text.chars().count()),
                            Style::new().fg(palette.text_muted),
                        ))),
                        Part::Tool(tool) => transparent_tool(&mut lines, tool, transcript, theme),
                    }
                }
                lines.push(Line::default());
            }
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "this Session has no messages yet",
            Style::new().fg(palette.text_muted),
        )));
    }
    lines
}

fn transparent_tool(
    lines: &mut Vec<Line<'static>>,
    tool: &ToolPart,
    transcript: &Transcript,
    theme: &Theme,
) {
    let palette = theme.palette;
    let (glyph, style) = if tool.failed {
        ("✗", Style::new().fg(palette.error))
    } else if tool.output.is_some() {
        ("✓", Style::new().fg(palette.success))
    } else {
        ("·", Style::new().fg(palette.warning))
    };
    lines.push(Line::from(vec![
        Span::styled(format!("{glyph} "), style),
        Span::styled(tool.name.clone(), Style::new().fg(palette.secondary)),
        Span::styled(
            format!("  {}", input_summary(&tool.input)),
            Style::new().fg(palette.text_muted),
        ),
    ]));
    if let Some(output) = &tool.output {
        for line in output.lines().take(TOOL_PREVIEW_LINES) {
            lines.push(Line::from(Span::styled(
                format!("  │ {line}"),
                Style::new().fg(if tool.failed {
                    palette.error
                } else {
                    palette.text_muted
                }),
            )));
        }
        let total = output.lines().count();
        if total > TOOL_PREVIEW_LINES {
            lines.push(Line::from(Span::styled(
                format!("  │ … {} more lines", total - TOOL_PREVIEW_LINES),
                Style::new().fg(palette.text_muted),
            )));
        }
    }
    if let Some(files) = transcript.displays.get(&tool.id) {
        for file in files {
            lines.push(Line::from(Span::styled(
                format!(
                    "  ◆ {} {} +{} −{}",
                    file.action, file.path, file.additions, file.deletions
                ),
                Style::new().fg(palette.accent),
            )));
            for line in file.patch.lines().take(DIFF_PREVIEW_LINES) {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::new().fg(diff_color(line, theme)),
                )));
            }
            let total = file.patch.lines().count();
            if total > DIFF_PREVIEW_LINES {
                lines.push(Line::from(Span::styled(
                    format!("  … {} more diff lines", total - DIFF_PREVIEW_LINES),
                    Style::new().fg(palette.text_muted),
                )));
            }
        }
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

fn input_summary(input: &serde_json::Value) -> String {
    let candidate = ["command", "path", "pattern", "query", "url", "description"]
        .iter()
        .find_map(|key| input.get(key).and_then(serde_json::Value::as_str));
    match candidate {
        Some(text) => compact(text),
        None => compact(&input.to_string()),
    }
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

/// Input rows the composer grows to before it scrolls; the border and the
/// completion list live outside this budget.
const COMPOSER_INPUT_ROWS: usize = 8;
const COMPOSER_COMPLETION_ROWS: usize = 6;

fn composer_height(composer: &Composer) -> u16 {
    let input = composer.editor.line_count().clamp(1, COMPOSER_INPUT_ROWS);
    let completion = composer
        .completion
        .items
        .len()
        .min(COMPOSER_COMPLETION_ROWS);
    (2 + input + completion) as u16
}

fn render_composer(frame: &mut Frame, area: Rect, composer: &Composer, theme: &Theme) {
    let palette = theme.palette;
    let title = match &composer.notice {
        Some(notice) => format!(" composer · {notice} "),
        None => " composer ".to_string(),
    };
    let block = Block::bordered()
        .title(Span::styled(title, Style::new().fg(palette.primary)))
        .border_style(Style::new().fg(palette.border))
        .style(Style::new().bg(palette.background));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let completion_rows = composer
        .completion
        .items
        .len()
        .min(COMPOSER_COMPLETION_ROWS) as u16;
    let input_area = Rect {
        height: inner.height.saturating_sub(completion_rows),
        ..inner
    };
    let (cursor_line, cursor_cell) = composer.editor.cursor_position();
    let row_offset = cursor_line.saturating_sub(input_area.height.saturating_sub(1) as usize);
    let cell_offset = cursor_cell.saturating_sub(input_area.width.saturating_sub(1) as usize);
    let lines = composer
        .editor
        .lines()
        .skip(row_offset)
        .take(input_area.height as usize)
        .map(|line| {
            Line::from(Span::styled(
                clip_cells(&line, cell_offset, input_area.width),
                Style::new().fg(palette.text),
            ))
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), input_area);

    let cursor_row = cursor_line - row_offset;
    let cursor_column = cursor_cell - cell_offset;
    if cursor_row < input_area.height as usize && cursor_column < input_area.width as usize {
        frame.set_cursor_position(Position::new(
            input_area.x + cursor_column as u16,
            input_area.y + cursor_row as u16,
        ));
    }

    let completion_area = Rect {
        y: inner.y + input_area.height,
        height: completion_rows,
        ..inner
    };
    let items = composer
        .completion
        .items
        .iter()
        .take(COMPOSER_COMPLETION_ROWS)
        .enumerate()
        .map(|(index, path)| {
            let selected = index == composer.completion.selected;
            Line::from(Span::styled(
                format!("{}{path}", if selected { "▸ " } else { "  " }),
                if selected {
                    Style::new()
                        .fg(palette.primary)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(palette.text_muted)
                },
            ))
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(items), completion_area);
}

/// Skip `offset` display cells and take at most `width` cells of a line.
fn clip_cells(line: &str, offset: usize, width: u16) -> String {
    let mut skipped = 0;
    let mut taken = 0;
    let limit = width as usize;
    let mut out = String::new();
    for c in line.chars() {
        let cells = UnicodeWidthChar::width(c).unwrap_or(0);
        if skipped < offset {
            skipped += cells;
            continue;
        }
        if taken + cells > limit {
            break;
        }
        taken += cells;
        out.push(c);
    }
    out
}

pub struct SidebarPane {
    theme: Theme,
    session: Option<SessionSummary>,
}

impl Pane for SidebarPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(" session ", Style::new().fg(palette.primary)))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        let lines = match &self.session {
            None => vec![Line::from(Span::styled(
                "no Session selected",
                Style::new().fg(palette.text_muted),
            ))],
            Some(session) => vec![
                Line::from(Span::styled(
                    session.label().to_string(),
                    Style::new().fg(palette.text).add_modifier(Modifier::BOLD),
                )),
                Line::default(),
                Line::from(Span::styled(
                    session.directory.clone().unwrap_or_default(),
                    Style::new().fg(palette.text_muted),
                )),
                Line::from(Span::styled(
                    session
                        .updated_at_ms
                        .map(|updated| format!("updated {}", relative_time(updated)))
                        .unwrap_or_default(),
                    Style::new().fg(palette.text_muted),
                )),
            ],
        };
        frame.render_widget(
            Paragraph::new(lines)
                .block(block)
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}
