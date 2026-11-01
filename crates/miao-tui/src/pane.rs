use std::path::Path;
use std::time::{Duration, Instant};

use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

use crate::dialogs::{Dialog, ListDialog, ListKind, PaletteDialog};
use crate::editor::{CompletionKind, Composer, Mode};
use crate::session::{ApprovalView, Entry, Part, QuestionView, SessionSummary, Transcript};
use crate::theme::Theme;
use crate::{markdown, tool};

const SIDEBAR_MIN_WIDTH: u16 = 100;
const SIDEBAR_WIDTH: u16 = 24;

pub trait Pane {
    fn render(&mut self, frame: &mut Frame, area: Rect);
}

pub struct Shell {
    pub title: TitlePane,
    pub transcript: TranscriptPane,
    pub composer: Composer,
    /// The row under the composer. It answers "which model, at what cost?"
    /// without opening a dialog, the way the TypeScript status line does.
    pub status: StatusStrip,
    pub panel: Option<Panel>,
    pub sidebar: Option<SidebarPane>,
    /// The projection behind `transcript.lines`, kept so a theme change can
    /// repaint the same content instead of waiting for the next snapshot.
    last: Option<Transcript>,
}

impl Shell {
    pub fn new(workspace: &Path, theme: Theme) -> Self {
        Self {
            title: TitlePane::new(workspace, theme.clone()),
            transcript: TranscriptPane::new(theme.clone()),
            composer: Composer::new(workspace),
            status: StatusStrip::default(),
            panel: None,
            sidebar: Some(SidebarPane {
                theme,
                session: None,
                usage: None,
                goal: None,
                todos: Vec::new(),
            }),
            last: None,
        }
    }

    pub fn set_transcript(&mut self, transcript: &Transcript) {
        self.transcript.set_lines(transcript_lines(
            transcript,
            &self.transcript.theme,
            self.transcript.expanded,
        ));
        let max = self.transcript.max_scroll();
        self.transcript.scroll = self.transcript.scroll.min(max);
        self.last = Some(transcript.clone());
    }

    /// Show what the model is streaming before its message commits. Empty
    /// strings clear it.
    pub fn set_draft(&mut self, text: &str, reasoning: &str) {
        self.transcript.set_draft(text, reasoning);
    }

    /// Where the transcript is scrolled to, in rows from the oldest one. A test
    /// asserts a wheel step exactly instead of inferring it from `following`.
    #[cfg(test)]
    pub fn transcript_scroll(&self) -> u16 {
        self.transcript.scroll
    }

    #[cfg(test)]
    pub fn draft(&mut self) -> &[Line<'static>] {
        // A frame would refresh the throttled draft; a test reads it directly.
        self.transcript.refresh_draft(true);
        &self.transcript.draft
    }

    /// The projection behind the rendered lines, for actions that need the
    /// structured transcript rather than its painted form.
    pub fn transcript(&self) -> Option<&Transcript> {
        self.last.as_ref()
    }

    /// The text of the newest assistant reply, for the copy-to-clipboard
    /// action. Tool calls and reasoning are not part of a reply.
    pub fn last_response(&self) -> Option<String> {
        let transcript = self.last.as_ref()?;
        let reply = transcript
            .entries
            .iter()
            .rev()
            .find_map(|entry| match entry {
                Entry::Assistant { parts, .. } => {
                    let text = parts
                        .iter()
                        .filter_map(|part| match part {
                            Part::Text(text) => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    (!text.trim().is_empty()).then_some(text)
                }
                Entry::User { .. } | Entry::Error { .. } => None,
            })?;
        Some(reply)
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.title.set_theme(theme.clone());
        self.transcript.theme = theme.clone();
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.theme = theme.clone();
        }
        if let Some(last) = &self.last {
            self.transcript
                .set_lines(transcript_lines(last, &theme, self.transcript.expanded));
        }
    }

    pub fn theme(&self) -> &Theme {
        &self.transcript.theme
    }

    /// Show one status line instead of a transcript: engine failures and other
    /// states where there is no Session content to render.
    pub fn set_message(&mut self, message: &str) {
        let palette = self.transcript.theme.palette;
        self.transcript.set_lines(vec![Line::from(Span::styled(
            message.to_string(),
            Style::new().fg(palette.error),
        ))]);
        self.transcript.scroll = 0;
        self.transcript.follow = false;
        self.last = None;
    }

    /// Fold or unfold every tool result and repaint the projection behind the
    /// current lines, so the toggle applies without waiting for a snapshot.
    pub fn toggle_tool_expansion(&mut self) -> bool {
        self.transcript.expanded = !self.transcript.expanded;
        if let Some(last) = &self.last {
            self.transcript.set_lines(transcript_lines(
                last,
                &self.transcript.theme,
                self.transcript.expanded,
            ));
        }
        self.transcript.expanded
    }

    /// Mouse selection lives on the transcript; the shell forwards the drag.
    pub fn begin_selection(&mut self, position: Position) -> bool {
        self.transcript.begin_selection(position)
    }

    pub fn update_selection(&mut self, position: Position) {
        self.transcript.update_selection(position)
    }

    pub fn take_selection(&mut self) -> Option<String> {
        self.transcript.take_selection()
    }

    pub fn scroll_transcript(&mut self, delta: i32) {
        // Scrolling up detaches from the bottom; new content then lands above
        // the viewport instead of pulling it along. Scrolling back down to the
        // last row re-attaches, so an operator never has to rediscover how to
        // resume following.
        let max = self.transcript.max_scroll();
        let next = (self.transcript.scroll as i32 + delta).clamp(0, max as i32) as u16;
        self.transcript.scroll = next;
        self.transcript.follow = next >= max;
    }

    /// Follow the newest entry again, as opening a Session must: a scroll in a
    /// previous Session used to leave the next one parked at its oldest rows.
    pub fn follow_transcript(&mut self) {
        self.transcript.follow = true;
    }

    /// Whether the transcript is showing its newest rows.
    pub fn following(&self) -> bool {
        self.transcript.follow
    }

    pub fn set_usage(&mut self, usage: Option<&crate::status::UsageSummary>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.usage = usage.cloned();
        }
    }

    /// Show the Session's Goal in its own section. It is not a todo list: the
    /// checklist answers "what is this turn doing", the Goal answers "why does
    /// this Session exist and what would prove it done".
    pub fn set_goal(&mut self, goal: Option<&crate::session::GoalView>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.goal = goal.cloned();
        }
    }

    pub fn set_todos(&mut self, todos: &[crate::session::TodoView]) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.todos = todos
                .iter()
                .map(|todo| crate::session::TodoView {
                    content: todo.content.clone(),
                    status: todo.status.clone(),
                })
                .collect();
        }
    }

    pub fn set_session(&mut self, session: Option<&SessionSummary>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.session = session.cloned();
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let panel_height = self.panel.as_ref().map_or(0, Panel::height);
        let [title_area, body_area, panel_area, composer_area, status_area] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(panel_height),
            Constraint::Length(composer_height(&self.composer)),
            Constraint::Length(1),
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
        if let Some(panel) = self.panel.as_ref() {
            panel.render(frame, panel_area, &self.transcript.theme);
        }
        render_composer(frame, composer_area, &self.composer, &self.transcript.theme);
        render_status(frame, status_area, &self.status, &self.transcript.theme);
    }
}

pub struct TitlePane {
    label: String,
    status: Option<String>,
    /// The status reports a problem with the run (for example, the engine
    /// stopped reporting) rather than routine activity.
    status_alert: bool,
    theme: Theme,
}

impl TitlePane {
    fn new(workspace: &Path, theme: Theme) -> Self {
        let name = workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.display().to_string());
        Self {
            label: format!(" {name} · {} · v{}", git_branch(workspace), crate::VERSION),
            status: None,
            status_alert: false,
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

impl TitlePane {
    pub fn set_status(&mut self, status: Option<String>) {
        self.status = status;
    }

    pub fn set_status_alert(&mut self, alert: bool) {
        self.status_alert = alert;
    }

    #[cfg(test)]
    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    #[cfg(test)]
    pub fn status_alert(&self) -> bool {
        self.status_alert
    }

    fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }
}

impl Pane for TitlePane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let style = Style::new().fg(palette.primary).bg(palette.surface).bold();
        let mut spans = vec![Span::styled(format!("{} ", self.label), style)];
        if let Some(status) = &self.status {
            let color = match self.status_alert {
                true => palette.warning,
                false => palette.text_muted,
            };
            spans.push(Span::styled(
                format!("· {status} "),
                Style::new().fg(color).bg(palette.surface),
            ));
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }
}

pub struct TranscriptPane {
    theme: Theme,
    /// The projection's lines, unwrapped. A frame wraps them once per width
    /// into `body` and paints only its viewport, so a keystroke costs the
    /// window rather than the whole Session.
    lines: Vec<Line<'static>>,
    /// The streamed answer that the next projection replaces. Kept apart from
    /// `lines` so a projection can drop it in one assignment.
    draft_source: Option<(String, String)>,
    draft: Vec<Line<'static>>,
    /// A delta arrived and `draft` has not been rebuilt yet.
    draft_dirty: bool,
    draft_built: Option<Instant>,
    /// `lines` and `draft` wrapped to `width`, each cached against the version
    /// and width it was built for.
    body: Vec<Line<'static>>,
    draft_rows: Vec<Line<'static>>,
    width: u16,
    body_version: u64,
    body_built: u64,
    draft_version: u64,
    draft_rows_built: u64,
    scroll: u16,
    /// Follow the tail while new projections arrive. Any manual scroll clears
    /// it, so reading history is not interrupted by committed events.
    follow: bool,
    /// Tool results render at their folded budget unless this is on.
    expanded: bool,
    /// The transcript's inner area from the last frame, in screen coordinates.
    /// Mouse selection is expressed in the same space so a drag copies exactly
    /// the cells the operator sees.
    area: Rect,
    /// Anchor and head of the current drag, in screen coordinates.
    selection: Option<(Position, Position)>,
    /// Symbols of the last rendered frame, one row of cells per line. Wide
    /// characters own their first cell and leave the continuation empty, so a
    /// column index is a screen column.
    rendered: Vec<Vec<String>>,
}

/// How long a streamed draft may lag the deltas that arrived. Re-parsing a long
/// answer per token is quadratic; 20 refreshes a second are indistinguishable
/// from more.
const DRAFT_REFRESH: Duration = Duration::from_millis(50);

impl TranscriptPane {
    fn new(theme: Theme) -> Self {
        Self {
            theme,
            lines: vec![Line::from("no Session selected")],
            draft_source: None,
            draft: Vec::new(),
            draft_dirty: false,
            draft_built: None,
            body: Vec::new(),
            draft_rows: Vec::new(),
            width: 0,
            body_version: 1,
            body_built: 0,
            draft_version: 0,
            draft_rows_built: 0,
            scroll: 0,
            follow: true,
            expanded: false,
            area: Rect::default(),
            selection: None,
            rendered: Vec::new(),
        }
    }

    /// Replace the projection's lines. The bump invalidates the wrapped cache,
    /// which is rebuilt on the next frame at that frame's width.
    fn set_lines(&mut self, lines: Vec<Line<'static>>) {
        self.lines = lines;
        self.body_version += 1;
    }

    /// Record what the model is streaming. The lines are rendered on the next
    /// frame at most `DRAFT_REFRESH` apart instead of once per delta.
    fn set_draft(&mut self, text: &str, reasoning: &str) {
        if text.is_empty() && reasoning.is_empty() {
            self.draft_source = None;
            self.draft.clear();
            self.draft_rows.clear();
            self.draft_dirty = false;
            self.draft_version += 1;
            return;
        }
        self.draft_source = Some((text.to_string(), reasoning.to_string()));
        self.draft_dirty = true;
    }

    /// The largest scrollable row offset. Wrapped rows, because that is what
    /// the viewport scrolls; the logical lines are a fallback before the first
    /// frame.
    fn max_scroll(&self) -> u16 {
        let rows = match self.body.len() + self.draft_rows.len() {
            0 => self.lines.len(),
            rows => rows,
        };
        // `render` parks the tail at `rows - viewport`, so that is the largest
        // offset a scroll may reach. Clamping at `rows - 1` used to leave a
        // wheel scrolling back towards the newest turn short of the tail, and
        // `follow` then stayed off until the operator overscrolled. Before the
        // first frame the viewport is unknown and the logical lines are the
        // fallback.
        rows.saturating_sub(self.area.height as usize) as u16
    }

    fn refresh_draft(&mut self, force: bool) {
        if !self.draft_dirty {
            return;
        }
        if !force
            && self
                .draft_built
                .is_some_and(|at| at.elapsed() < DRAFT_REFRESH)
        {
            return;
        }
        self.draft = match &self.draft_source {
            Some((text, reasoning)) => draft_lines(text, reasoning, &self.theme),
            None => Vec::new(),
        };
        self.draft_dirty = false;
        self.draft_built = Some(Instant::now());
        self.draft_version += 1;
    }
}

impl Pane for TranscriptPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        self.refresh_draft(false);
        let resized = area.width != self.width;
        if resized || self.body_version != self.body_built {
            self.body = wrap_lines(&self.lines, area.width);
            self.body_built = self.body_version;
        }
        if resized || self.draft_version != self.draft_rows_built {
            self.draft_rows = wrap_lines(&self.draft, area.width);
            self.draft_rows_built = self.draft_version;
        }
        self.width = area.width;
        let viewport = area.height as usize;
        let rows = self.body.len() + self.draft_rows.len();
        if self.follow {
            self.scroll = rows.saturating_sub(viewport) as u16;
        }
        let start = (self.scroll as usize).min(rows.saturating_sub(1));
        let visible = (start..rows)
            .take(viewport)
            .map(|row| match row < self.body.len() {
                true => self.body[row].clone(),
                false => self.draft_rows[row - self.body.len()].clone(),
            })
            .collect::<Vec<_>>();
        // Borderless, like the TypeScript layout this mirrors: a frame around
        // the transcript only steals columns from the text.
        frame.render_widget(
            Paragraph::new(visible).style(Style::new().fg(palette.text).bg(palette.background)),
            area,
        );
        self.area = area;
        // Only a drag reads the cells back, so an idle frame does not copy the
        // viewport into strings.
        if self.selection.is_some() {
            self.snapshot(frame, area);
            self.paint_selection(frame, area);
        }
    }
}

/// Split styled lines into rows no wider than `width` display cells, so the
/// transcript is wrapped once per width instead of once per frame. Breaks
/// prefer the last blank on the row, like the word wrapping it replaces, and
/// only a word longer than the row is cut mid-word. Styles and alignment
/// survive the split; a wide character never straddles a row.
fn wrap_lines(lines: &[Line<'static>], width: u16) -> Vec<Line<'static>> {
    let width = width.max(1) as usize;
    let mut rows = Vec::with_capacity(lines.len());
    for line in lines {
        if line.spans.is_empty() || line.width() <= width {
            rows.push(line.clone());
            continue;
        }
        let cells = line
            .spans
            .iter()
            .flat_map(|span| {
                span.content
                    .chars()
                    .map(move |character| (character, span.style))
            })
            .collect::<Vec<_>>();
        let mut start = 0;
        while start < cells.len() {
            let mut used = 0;
            let mut blank = None;
            let mut end = start;
            while end < cells.len() {
                let cell = cells[end].0.width().unwrap_or(0);
                if used + cell > width && used > 0 {
                    break;
                }
                used += cell;
                end += 1;
                if cells[end - 1].0 == ' ' {
                    blank = Some(end);
                }
            }
            let end = match blank {
                Some(index) if index > start && index < end => index,
                _ => end,
            };
            rows.push(row_from(&cells[start..end], line));
            start = end;
        }
    }
    rows
}

/// One wrapped row, with adjacent cells of the same style joined back into a
/// span.
fn row_from(cells: &[(char, Style)], line: &Line<'static>) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (character, style) in cells {
        match spans.last_mut() {
            Some(span) if span.style == *style => span.content.to_mut().push(*character),
            _ => spans.push(Span::styled(character.to_string(), *style)),
        }
    }
    Line::from(spans).style(line.style)
}

impl TranscriptPane {
    /// Remember the symbols this frame drew so a drag can be copied verbatim.
    fn snapshot(&mut self, frame: &mut Frame, inner: Rect) {
        let buffer = frame.buffer_mut();
        self.rendered = (inner.y..inner.bottom())
            .map(|y| {
                (inner.x..inner.right())
                    .map(|x| {
                        buffer
                            .cell(Position::new(x, y))
                            .map(|cell| cell.symbol().to_string())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect();
    }

    /// Reverse the selected cells in place. The transcript is wrapped by
    /// ratatui, so a selection is painted on the cells the operator covered
    /// instead of being re-derived from the logical lines.
    fn paint_selection(&mut self, frame: &mut Frame, inner: Rect) {
        let Some((a, b)) = self.selection else {
            return;
        };
        let (start, end) = if (a.y, a.x) > (b.y, b.x) {
            (b, a)
        } else {
            (a, b)
        };
        let buffer = frame.buffer_mut();
        for y in start.y.max(inner.y)..=end.y.min(inner.bottom().saturating_sub(1)) {
            let from = if y == start.y { start.x } else { inner.x };
            let to = if y == end.y {
                end.x
            } else {
                inner.right().saturating_sub(1)
            };
            for x in from.max(inner.x)..=to.min(inner.right().saturating_sub(1)) {
                if let Some(cell) = buffer.cell_mut(Position::new(x, y)) {
                    cell.set_style(Style::new().add_modifier(Modifier::REVERSED));
                }
            }
        }
    }

    /// Start a drag at a screen position when it lands inside the transcript.
    pub fn begin_selection(&mut self, position: Position) -> bool {
        if !self.area.contains(position) {
            return false;
        }
        self.selection = Some((position, position));
        true
    }

    /// Extend the drag. Positions outside the transcript clamp to its edges so
    /// a drag that leaves the pane still copies what was covered.
    pub fn update_selection(&mut self, position: Position) {
        let Some((anchor, _)) = self.selection else {
            return;
        };
        let clamped = Position::new(
            position
                .x
                .clamp(self.area.x, self.area.right().saturating_sub(1)),
            position
                .y
                .clamp(self.area.y, self.area.bottom().saturating_sub(1)),
        );
        self.selection = Some((anchor, clamped));
    }

    /// Finish the drag: return the selected text and clear the highlight.
    pub fn take_selection(&mut self) -> Option<String> {
        let (a, b) = self.selection.take()?;
        if self.rendered.is_empty() {
            return None;
        }
        let text = selection_text(&self.rendered, self.area, a, b);
        (!text.is_empty()).then_some(text)
    }
}

/// Slice the snapshot by screen coordinates. Rows keep their cell symbols, so a
/// wide character contributes its symbol once and its continuation contributes
/// nothing.
fn selection_text(rendered: &[Vec<String>], inner: Rect, a: Position, b: Position) -> String {
    let (start, end) = if (a.y, a.x) > (b.y, b.x) {
        (b, a)
    } else {
        (a, b)
    };
    let mut lines: Vec<String> = Vec::new();
    for y in start.y.max(inner.y)..=end.y.min(inner.bottom().saturating_sub(1)) {
        let Some(row) = rendered.get((y - inner.y) as usize) else {
            continue;
        };
        let from = if y == start.y {
            start.x.saturating_sub(inner.x)
        } else {
            0
        };
        let to = if y == end.y {
            end.x.saturating_sub(inner.x)
        } else {
            row.len().saturating_sub(1) as u16
        };
        let mut text = String::new();
        for x in from..=to {
            if let Some(symbol) = row.get(x as usize) {
                text.push_str(symbol);
            }
        }
        lines.push(text.trim_end().to_string());
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Rows the home list shows before the operator asks for more: a long history
/// is scannable at ten, and the rest is one keypress away.
const HOME_PAGE: usize = 10;

pub struct Home {
    pub rows: Vec<SessionSummary>,
    pub selected: usize,
    /// How many matching rows the list currently reveals.
    limit: usize,
    /// Case-insensitive substring the list is narrowed to. Empty shows
    /// everything, so filtering is a mode of the same list rather than a
    /// second screen whose selection has to be kept in step.
    query: String,
    /// Whether printable keys belong to the filter. An explicit mode keeps
    /// single-letter commands (`n`, `r`, `p`, `j`, `k`) usable and still lets a
    /// filter contain those letters.
    filtering: bool,
    notice: Option<String>,
    /// A configuration problem that outlives one load: the catalog arriving is
    /// not an answer to it, so it is kept apart from the transient notice.
    warning: Option<String>,
    /// Set once the engine has answered the first `sessions` request. Until
    /// then an empty list is a load in flight, not an empty catalog.
    loaded: bool,
    theme: Theme,
}

impl Home {
    pub fn new(theme: Theme) -> Self {
        Self {
            rows: Vec::new(),
            selected: 0,
            limit: HOME_PAGE,
            query: String::new(),
            filtering: false,
            notice: None,
            warning: None,
            loaded: false,
            theme,
        }
    }

    pub fn set_notice(&mut self, notice: Option<String>) {
        self.notice = notice;
    }

    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn set_warning(&mut self, warning: Option<String>) {
        self.warning = warning;
    }

    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    /// What an empty list shows: a load still in flight reads differently from
    /// a catalog that really has nothing in it.
    fn placeholder(&self) -> &str {
        if self.loaded {
            "no sessions yet · tab to type a prompt · n for an empty session"
        } else {
            "loading sessions…"
        }
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }

    pub fn set_rows(&mut self, rows: Vec<SessionSummary>) {
        self.loaded = true;
        let selected_id = self.current().map(|row| row.id.clone());
        self.rows = rows;
        let visible = self.visible_len();
        self.selected = selected_id
            .and_then(|id| self.visible().iter().position(|row| row.id == id))
            .unwrap_or(0)
            .min(visible.saturating_sub(1));
    }

    /// The rows the list shows right now, in list order. Pinning and filtering
    /// both change this view, so every caller reads it instead of `rows`.
    /// Reveal one more page of history.
    pub fn more(&mut self) {
        self.limit = self.limit.saturating_add(HOME_PAGE);
    }

    /// Matching rows the list is not showing yet.
    fn hidden(&self) -> usize {
        self.matched().len().saturating_sub(self.limit)
    }

    fn visible(&self) -> Vec<&SessionSummary> {
        self.matched().into_iter().take(self.limit).collect()
    }

    fn matched(&self) -> Vec<&SessionSummary> {
        if self.query.is_empty() {
            return self.rows.iter().collect();
        }
        let needle = self.query.to_lowercase();
        self.rows
            .iter()
            .filter(|row| {
                row.label().to_lowercase().contains(&needle)
                    || row
                        .directory
                        .as_deref()
                        .is_some_and(|directory| directory.to_lowercase().contains(&needle))
            })
            .collect()
    }

    fn visible_len(&self) -> usize {
        self.visible().len()
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn filtering(&self) -> bool {
        self.filtering
    }

    /// Enter filter mode with an empty query, so the next printable key starts
    /// a search instead of running a command.
    pub fn start_filter(&mut self) {
        self.filtering = true;
        self.query.clear();
        self.selected = 0;
    }

    /// Leave filter mode and show the whole list again.
    pub fn stop_filter(&mut self) {
        self.filtering = false;
        self.query.clear();
        self.selected = 0;
    }

    /// Narrow the list one character at a time; the selection goes back to the
    /// first match so the operator sees the result immediately.
    pub fn filter(&mut self, c: char) {
        self.query.push(c);
        self.selected = 0;
    }

    pub fn filter_backspace(&mut self) -> bool {
        if self.query.pop().is_none() {
            return false;
        }
        self.selected = 0;
        true
    }

    /// Clearing the filter keeps filter mode but shows the whole list again.
    pub fn clear_filter(&mut self) -> bool {
        if self.query.is_empty() {
            return false;
        }
        self.query.clear();
        self.selected = 0;
        true
    }

    pub fn move_cursor(&mut self, delta: i32) {
        let visible = self.visible_len();
        if visible == 0 {
            self.selected = 0;
            return;
        }
        let next = self.selected as i32 + delta;
        self.selected = next.clamp(0, visible as i32 - 1) as usize;
    }

    /// The row a numbered slot opens. Slots follow the list as shown, and the
    /// first nine are the ones a terminal keyboard can reach without a chord.
    pub fn slot(&self, index: usize) -> Option<&SessionSummary> {
        self.visible().into_iter().nth(index)
    }

    pub fn current(&self) -> Option<&SessionSummary> {
        self.visible().into_iter().nth(self.selected)
    }

    fn warning_lines(&self) -> Vec<Line<'static>> {
        let palette = self.theme.palette;
        self.warning
            .iter()
            .flat_map(|warning| {
                [
                    Line::from(Span::styled(
                        warning.clone(),
                        Style::new().fg(palette.error),
                    )),
                    Line::default(),
                ]
            })
            .collect()
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(
                if self.query.is_empty() {
                    format!(" sessions · {} ", self.rows.len())
                } else {
                    format!(" sessions · filter \"{}\" · esc clear ", self.query)
                },
                Style::new().fg(palette.text_muted),
            ))
            .border_style(Style::new().fg(palette.border_active))
            .style(Style::new().bg(palette.surface));
        let visible = self.visible();
        if visible.is_empty() {
            let mut lines = self.warning_lines();
            let message = self.notice.clone().unwrap_or_else(|| {
                if self.rows.is_empty() {
                    self.placeholder().to_string()
                } else {
                    format!("nothing matches \"{}\"", self.query)
                }
            });
            lines.push(Line::from(Span::styled(
                message,
                Style::new().fg(palette.text_muted),
            )));
            frame.render_widget(
                Paragraph::new(lines)
                    .style(Style::new().fg(palette.text_muted))
                    .block(block)
                    .wrap(Wrap { trim: false }),
                area,
            );
            return;
        }
        let mut notice_lines: Vec<Line<'static>> = self.warning_lines();
        if let Some(notice) = &self.notice {
            notice_lines.push(Line::from(Span::styled(
                notice.clone(),
                Style::new().fg(palette.error),
            )));
            notice_lines.push(Line::default());
        }
        // Group by recency, the way comparable session pickers do: a flat wall
        // of titles stops being scannable once a project has weeks of history.
        let inner = block.inner(area);
        let inner_width = inner.width as usize;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let mut body: Vec<Line<'static>> = Vec::new();
        let mut selected_line = 0usize;
        let mut selected_tail = 0usize;
        let mut bucket: Option<&'static str> = None;
        for (index, row) in visible.iter().enumerate() {
            let group = match row.updated_at_ms {
                Some(updated) => session_group(now, updated),
                None => "Earlier",
            };
            if bucket != Some(group) {
                if !body.is_empty() {
                    body.push(Line::default());
                }
                body.push(Line::from(Span::styled(
                    group.to_string(),
                    Style::new()
                        .fg(palette.text_muted)
                        .add_modifier(Modifier::BOLD),
                )));
                bucket = Some(group);
            }
            let selected = index == self.selected;
            if selected {
                selected_line = notice_lines.len() + body.len();
            }
            let style = if selected {
                Style::new()
                    .fg(palette.primary)
                    .bg(palette.element)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text)
            };
            let marker = if selected { "▸ " } else { "  " };
            let mut meta = row.updated_at_ms.map(relative_time).unwrap_or_default();
            if row.pinned_at_ms.is_some() {
                meta = if meta.is_empty() {
                    "pinned".to_string()
                } else {
                    format!("pinned · {meta}")
                };
            }
            // Fit the title so the right edge keeps holding the age: at a
            // mixed-width font the character count and the cell count differ.
            let fitted = match inner_width.checked_sub(meta.len() + 3) {
                Some(room) => format!("{marker}{}", fit(row.label(), room)),
                None => String::new(),
            };
            let pad =
                inner_width.saturating_sub(UnicodeWidthStr::width(fitted.as_str()) + meta.len());
            body.push(Line::from(vec![
                Span::styled(fitted, style),
                Span::styled(
                    format!("{}{}", " ".repeat(pad), meta),
                    Style::new().fg(palette.text_muted),
                ),
            ]));
            // The preview answers "which conversation was this?" without
            // opening it. One muted line under the row keeps the main line
            // scannable; the engine already bounded the text.
            if let Some(preview) = row.preview.as_deref() {
                if selected {
                    selected_tail += 1;
                }
                // A preview is a hint, not the conversation: one clipped line
                // keeps the list scannable, and the engine already bounded it.
                body.push(Line::from(Span::styled(
                    format!("    {}", fit(preview, inner_width.saturating_sub(4))),
                    Style::new().fg(palette.text_muted),
                )));
            }
        }
        // Key hints belong at the bottom edge, where every comparable CLI puts
        // them, instead of permanently occupying the list header.
        let body_height = inner.height.saturating_sub(1) as usize;
        let notice_take = notice_lines.len().min(body_height);
        let list_height = body_height - notice_take;
        let selected_body = selected_line.saturating_sub(notice_take);
        // A selected row's preview counts toward the window, so both lines
        // stay on screen when the selection rides the bottom edge.
        let offset = if list_height == 0 {
            0
        } else {
            (selected_body + selected_tail)
                .saturating_sub(list_height.saturating_sub(1))
                .min(body.len().saturating_sub(list_height))
        };
        let body_area = Rect {
            height: inner.height.saturating_sub(1),
            ..inner
        };
        let hint_area = Rect {
            y: inner.bottom().saturating_sub(1),
            height: 1,
            ..inner
        };
        frame.render_widget(block, area);
        let notice_skip = notice_lines.len() - notice_take;
        let all: Vec<Line> = notice_lines
            .into_iter()
            .skip(notice_skip)
            .chain(body.into_iter().skip(offset).take(list_height))
            .collect();
        frame.render_widget(
            Paragraph::new(all)
                .style(Style::new().bg(palette.surface))
                .wrap(Wrap { trim: false }),
            body_area,
        );
        // The hint names how much history is still folded away, so the extra
        // rows are discoverable without reading the help.
        let hidden = self.hidden();
        let hint = match hidden {
            0 => " / filter · p pin · tab prompt · n new · 1-9 open · ? help".to_string(),
            hidden => format!(
                " / filter · p pin · tab prompt · n new · 1-9 open · ? help · space more ({hidden})"
            ),
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                hint,
                Style::new().fg(palette.text_muted),
            ))),
            hint_area,
        );
    }
}

/// The section a Session belongs to in the home list. Days are bucketed on the
/// local wall clock; "This week" covers the six days before yesterday.
fn session_group(now_ms: u64, updated_ms: u64) -> &'static str {
    let day = 86_400_000i64;
    let offset = local_utc_offset_ms();
    let local_now = now_ms as i64 + offset;
    let today = local_now.div_euclid(day) * day - offset;
    let updated = updated_ms as i64;
    if updated >= today {
        "Today"
    } else if updated >= today - day {
        "Yesterday"
    } else if updated >= today - 7 * day {
        "This week"
    } else {
        "Earlier"
    }
}

#[cfg(unix)]
fn local_utc_offset_ms() -> i64 {
    // SAFETY: localtime_r writes into a caller-owned tm and retains no pointer.
    unsafe {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as libc::time_t)
            .unwrap_or(0);
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return 0;
        }
        (tm.tm_gmtoff as i64) * 1000
    }
}

#[cfg(not(unix))]
fn local_utc_offset_ms() -> i64 {
    0
}

fn relative_time(updated_at_ms: u64) -> String {
    relative_time_at(updated_at_ms, now_ms())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn relative_time_at(updated_at_ms: u64, now: u64) -> String {
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

/// How long a painted relative timestamp stays true. A label with minute
/// resolution only changes on the next minute, one reading in hours only on the
/// next hour, and so on; sleeping exactly that long is what keeps an idle TUI
/// from repainting 60 times an hour to redraw text that cannot have changed.
pub fn next_relative_change(updated_at_ms: u64, now: u64) -> std::time::Duration {
    let delta_ms = now.saturating_sub(updated_at_ms);
    let minutes = delta_ms / 60_000;
    let until_ms = match minutes {
        // "just now" becomes "1m ago" when the age reaches a minute.
        0 => 60_000,
        1..=59 => (minutes + 1) * 60_000,
        _ => {
            let hours = minutes / 60;
            match hours {
                // "Nh ago" changes when the hour rolls over.
                1..=23 => (hours + 1) * 3_600_000,
                _ => (hours / 24 + 1) * 86_400_000,
            }
        }
    };
    std::time::Duration::from_millis(until_ms.saturating_sub(delta_ms))
}

/// The streamed answer, rendered like the assistant entry it will become: the
/// provisional block gains its header when the committed message arrives.
fn draft_lines(text: &str, reasoning: &str, theme: &Theme) -> Vec<Line<'static>> {
    let palette = theme.palette;
    let mut lines = Vec::new();
    if !reasoning.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("▸ thinking · {} chars", reasoning.chars().count()),
            Style::new().fg(palette.text_muted),
        )));
    }
    if !text.is_empty() {
        lines.extend(markdown::lines(text, theme));
    }
    lines
}

fn transcript_lines(transcript: &Transcript, theme: &Theme, expanded: bool) -> Vec<Line<'static>> {
    let palette = theme.palette;
    let mut lines = Vec::new();
    for entry in &transcript.entries {
        match entry {
            Entry::User { text, .. } => {
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
                        Part::Text(text) => lines.extend(markdown::lines(text, theme)),
                        Part::Reasoning(text) => lines.push(Line::from(Span::styled(
                            format!("▸ thinking · {} chars", text.chars().count()),
                            Style::new().fg(palette.text_muted),
                        ))),
                        Part::Tool(call) => lines.extend(tool::lines(
                            call,
                            transcript.displays.get(&call.id).map(Vec::as_slice),
                            theme,
                            expanded,
                        )),
                    }
                }
                lines.push(Line::default());
            }
            Entry::Error { message } => {
                for (index, line) in message.lines().enumerate() {
                    lines.push(Line::from(vec![
                        Span::styled(
                            if index == 0 { "✗ " } else { "  " },
                            Style::new().fg(palette.error),
                        ),
                        Span::styled(line.to_string(), Style::new().fg(palette.error)),
                    ]));
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

fn compact(text: &str) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= 80 {
        return single;
    }
    let mut cut = single.chars().take(77).collect::<String>();
    cut.push('…');
    cut
}

/// What the open Session runs on and has cost so far. The row stays empty
/// until a Session is open, so the home list keeps its full height.
#[derive(Default)]
pub struct StatusStrip {
    pub model: Option<String>,
    pub usage: Option<String>,
    /// What the run waits on and what the next key does, right-aligned: an
    /// approval that blocks the turn, a queued prompt, the interrupt key.
    pub hints: Vec<StatusHint>,
}

/// One right-aligned status hint. `warning` marks something the operator must
/// act on rather than a fact about the run.
pub struct StatusHint {
    pub text: String,
    pub warning: bool,
}

fn render_status(frame: &mut Frame, area: Rect, status: &StatusStrip, theme: &Theme) {
    let palette = theme.palette;
    let mut spans = Vec::new();
    if let Some(model) = &status.model {
        spans.push(Span::styled(
            format!(" {model} "),
            Style::new().fg(palette.primary).bg(palette.surface),
        ));
    }
    if let Some(usage) = &status.usage {
        spans.push(Span::styled(
            format!("· {usage} "),
            Style::new().fg(palette.text_muted).bg(palette.surface),
        ));
    }
    if spans.is_empty() && status.hints.is_empty() {
        return;
    }
    let hints = status
        .hints
        .iter()
        .map(|hint| hint.text.as_str())
        .collect::<Vec<_>>()
        .join(" · ");
    let width = (UnicodeWidthStr::width(hints.as_str()) as u16 + 2).min(area.width);
    let [left_area, right_area] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(width)]).areas(area);
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::new().bg(palette.surface)),
        left_area,
    );
    if status.hints.is_empty() {
        return;
    }
    let mut spans = Vec::new();
    for (index, hint) in status.hints.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(
                " · ",
                Style::new().fg(palette.text_muted).bg(palette.surface),
            ));
        }
        let tone = match hint.warning {
            true => palette.warning,
            false => palette.text_muted,
        };
        spans.push(Span::styled(
            hint.text.clone(),
            Style::new().fg(tone).bg(palette.surface),
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans))
            .style(Style::new().bg(palette.surface))
            .alignment(ratatui::layout::Alignment::Right),
        right_area,
    );
}

/// Input rows the composer grows to before it scrolls; the border and the
/// completion list live outside this budget.
const COMPOSER_INPUT_ROWS: usize = 8;
const COMPOSER_COMPLETION_ROWS: usize = 6;
/// Display cells the `!` shell marker occupies left of the input.
const SHELL_GUTTER: u16 = 2;

fn composer_height(composer: &Composer) -> u16 {
    let input = composer.editor.line_count().clamp(1, COMPOSER_INPUT_ROWS);
    let completion = composer
        .completion
        .items
        .len()
        .min(COMPOSER_COMPLETION_ROWS);
    (2 + input + completion) as u16
}

/// The home screen shows the same composer as a Session, so a prompt can be
/// typed before any Session exists.
pub fn render_home_composer(frame: &mut Frame, area: Rect, composer: &Composer, theme: &Theme) {
    render_composer(frame, area, composer, theme)
}

fn render_composer(frame: &mut Frame, area: Rect, composer: &Composer, theme: &Theme) {
    let palette = theme.palette;
    // The queue count rides the same title line as a transient notice so the
    // composer answers "is my prompt waiting?" without a second row.
    let queued = (composer.queued > 0).then(|| {
        if composer.queued == 1 {
            "1 queued".to_string()
        } else {
            format!("{} queued", composer.queued)
        }
    });
    // Shell mode says so in the title and on the input: a `!` line goes to the
    // host shell, not the model, and Esc leaves it.
    let shell = composer.mode() == Mode::Shell;
    // INP-06: the rule that decides whether shell output reaches the model has
    // to be visible rather than implied. A `!` line runs on the host, records in
    // this Session (so the next turn's context contains it) and starts no turn
    // of its own.
    let name = if shell {
        "shell · runs locally · output stays in this Session · esc exit"
    } else {
        "composer"
    };
    // What the run is doing rides beside the input: the answer to "is it
    // working, queued, or waiting on me?" belongs where the operator types,
    // not only in the title bar at the top of the screen.
    let mut parts = composer.phase.iter().cloned().collect::<Vec<_>>();
    parts.extend(queued);
    parts.extend(composer.notice.iter().cloned());
    let title = match parts.is_empty() {
        true => format!(" {name} "),
        false => format!(" {name} · {} ", parts.join(" · ")),
    };
    let accent = if shell {
        palette.warning
    } else {
        palette.primary
    };
    let block = Block::bordered()
        .title(Span::styled(title, Style::new().fg(accent)))
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
    let input_rows = Rect {
        height: inner.height.saturating_sub(completion_rows),
        ..inner
    };
    // Shell mode prints a gutter marker and shifts the input right by it, so
    // the operator sees `! ` before the command while the buffer still holds
    // only the command and the cursor keeps its cell offset.
    let gutter = if shell { SHELL_GUTTER } else { 0 };
    let input_area = Rect {
        x: input_rows.x.saturating_add(gutter),
        width: input_rows.width.saturating_sub(gutter),
        ..input_rows
    };
    if shell && input_rows.width >= SHELL_GUTTER {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "! ",
                Style::new().fg(accent).add_modifier(Modifier::BOLD),
            ))),
            Rect {
                width: SHELL_GUTTER,
                ..input_rows
            },
        );
    }
    let (cursor_line, cursor_cell) = composer.editor.cursor_position();
    let row_offset = cursor_line.saturating_sub(input_area.height.saturating_sub(1) as usize);
    let cell_offset = cursor_cell.saturating_sub(input_area.width.saturating_sub(1) as usize);
    let text_color = if shell { accent } else { palette.text };
    let lines = composer
        .editor
        .lines()
        .skip(row_offset)
        .take(input_area.height as usize)
        .map(|line| {
            Line::from(Span::styled(
                clip_cells(&line, cell_offset, input_area.width),
                Style::new().fg(text_color),
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
    // A command row says what the command does, so the operator does not have
    // to remember which of `status` and `sessions` prints usage. File
    // completion keeps the bare path.
    let names = composer
        .completion
        .items
        .iter()
        .take(COMPOSER_COMPLETION_ROWS)
        .map(|path| UnicodeWidthStr::width(path.as_str()))
        .max()
        .unwrap_or(0);
    let items = composer
        .completion
        .items
        .iter()
        .take(COMPOSER_COMPLETION_ROWS)
        .enumerate()
        .map(|(index, path)| {
            let selected = index == composer.completion.selected;
            let mut spans = vec![Span::styled(
                format!("{}{path}", if selected { "▸ " } else { "  " }),
                if selected {
                    Style::new()
                        .fg(palette.primary)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(palette.text_muted)
                },
            )];
            if let Some(detail) = composer
                .details
                .get(path)
                .filter(|_| composer.completion.kind == CompletionKind::Command)
            {
                let pad = names.saturating_sub(UnicodeWidthStr::width(path.as_str())) + 2;
                spans.push(Span::styled(
                    format!("{}{detail}", " ".repeat(pad)),
                    Style::new().fg(palette.text_muted),
                ));
            }
            Line::from(spans)
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(items), completion_area);
}

/// Skip `offset` display cells and take at most `width` cells of a line.
/// One display row of text: newlines and runs of spaces collapse, and an
/// overlong value is cut with an ellipsis so rows keep their alignment.
fn fit(text: &str, width: usize) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if UnicodeWidthStr::width(single.as_str()) <= width {
        return single;
    }
    let room = width.saturating_sub(1) as u16;
    format!("{}…", clip_cells(&single, 0, room))
}

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
    usage: Option<crate::status::UsageSummary>,
    /// The durable Goal, painted above the checklist and never mixed into it.
    goal: Option<crate::session::GoalView>,
    todos: Vec<crate::session::TodoView>,
}

impl Pane for SidebarPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        // The sidebar is a column of sections, not a framed panel: the frame
        // ate two columns per side for a label the sections already carry.
        let mut lines = match &self.session {
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
        if self.session.is_some() {
            // Context: the same billed usage the status dialog reads, kept
            // beside the transcript so cost and throughput stay glanceable.
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                "context",
                Style::new()
                    .fg(palette.primary)
                    .add_modifier(Modifier::BOLD),
            )));
            match &self.usage {
                None => lines.push(Line::from(Span::styled(
                    "no usage yet",
                    Style::new().fg(palette.text_muted),
                ))),
                Some(usage) => {
                    if let Some(lineage) = usage.lineage.first() {
                        lines.push(Line::from(Span::styled(
                            lineage.clone(),
                            Style::new().fg(palette.text),
                        )));
                    }
                    lines.push(Line::from(Span::styled(
                        format!("in {}  ·  out {}", usage.input_tokens, usage.output_tokens),
                        Style::new().fg(palette.text_muted),
                    )));
                    lines.push(Line::from(Span::styled(
                        format!(
                            "cache {}  ·  turns {}",
                            usage.cache_read_tokens, usage.turns
                        ),
                        Style::new().fg(palette.text_muted),
                    )));
                    // A retry is billed work: saying "1 turn" while three
                    // attempts were made hides where the money went.
                    // A subagent bills on its own Session, so a parent screen
                    // that only shows its own tokens understates the cost.
                    if usage.subagent_sessions > 0 {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "subagents {}  ·  {} turn{}  ·  in {}",
                                usage.subagent_sessions,
                                usage.subagent_turns,
                                if usage.subagent_turns == 1 { "" } else { "s" },
                                usage.subagent_input_tokens,
                            ),
                            Style::new().fg(palette.text_muted),
                        )));
                    }
                    // What a person had to decide, and what the model had to
                    // redo: supervision cost and rework, in one glance.
                    let decisions =
                        usage.approvals + usage.answers + usage.rejections + usage.cancels;
                    if decisions > 0 || usage.input_edits > 0 {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "needs you {}  ·  {} answer{}  ·  {} reject{}  ·  {} cancel{}",
                                usage.approvals,
                                usage.answers,
                                if usage.answers == 1 { "" } else { "s" },
                                usage.rejections,
                                if usage.rejections == 1 { "" } else { "s" },
                                usage.cancels,
                                if usage.cancels == 1 { "" } else { "s" },
                            ),
                            Style::new().fg(palette.text_muted),
                        )));
                    }
                    // Compaction runs as an auxiliary role, so its spend is
                    // real and absent from every main-model line above.
                    if usage.auxiliary_calls > 0 {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "auxiliary {} call{}  ·  in {}  ·  out {}",
                                usage.auxiliary_calls,
                                if usage.auxiliary_calls == 1 { "" } else { "s" },
                                usage.auxiliary_input_tokens,
                                usage.auxiliary_output_tokens,
                            ),
                            Style::new().fg(palette.text_muted),
                        )));
                    }
                    if usage.tool_input_errors > 0 {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "rework {}  ·  tool-input error{}",
                                usage.tool_input_errors,
                                if usage.tool_input_errors == 1 {
                                    ""
                                } else {
                                    "s"
                                },
                            ),
                            Style::new().fg(palette.warning),
                        )));
                    }
                    if usage.replayed_turns > 0 || usage.failed_attempts > 0 {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "retried {}  ·  {} failed attempt{}  ·  {} attempt{}",
                                usage.replayed_turns,
                                usage.failed_attempts,
                                if usage.failed_attempts == 1 { "" } else { "s" },
                                usage.attempts,
                                if usage.attempts == 1 { "" } else { "s" },
                            ),
                            Style::new().fg(palette.warning),
                        )));
                    }
                }
            }
            lines.push(Line::default());
            if let Some(goal) = &self.goal {
                lines.push(Line::from(Span::styled(
                    format!("goal · {}", goal.status),
                    Style::new()
                        .fg(palette.primary)
                        .add_modifier(Modifier::BOLD),
                )));
                let width = area.width.saturating_sub(3);
                lines.push(Line::from(Span::styled(
                    clip_cells(&goal.objective, 0, width),
                    Style::new().fg(palette.text),
                )));
                if let Some(budget) = &goal.budget {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "budget · {}",
                            clip_cells(budget, 0, width.saturating_sub(9))
                        ),
                        Style::new().fg(palette.text_muted),
                    )));
                }
                lines.push(Line::default());
            }
            let done = self
                .todos
                .iter()
                .filter(|todo| todo.status == "completed")
                .count();
            let open = self
                .todos
                .iter()
                .filter(|todo| todo.status != "completed" && todo.status != "cancelled")
                .count();
            lines.push(Line::from(Span::styled(
                format!("todo {}  ·  {} open", done, open),
                Style::new()
                    .fg(palette.primary)
                    .add_modifier(Modifier::BOLD),
            )));
            if self.todos.is_empty() {
                lines.push(Line::from(Span::styled(
                    "no todo list",
                    Style::new().fg(palette.text_muted),
                )));
            }
            let width = area.width.saturating_sub(3) as usize;
            for todo in &self.todos {
                let (glyph, style) = match todo.status.as_str() {
                    "completed" => ("✓ ", Style::new().fg(palette.success)),
                    "in_progress" => ("▸ ", Style::new().fg(palette.primary)),
                    "cancelled" => ("✗ ", Style::new().fg(palette.text_muted)),
                    "waiting" | "blocked" => ("· ", Style::new().fg(palette.warning)),
                    _ => ("· ", Style::new().fg(palette.text_muted)),
                };
                let mut text = todo.content.clone();
                if text.chars().count() > width.saturating_sub(2) {
                    text = text
                        .chars()
                        .take(width.saturating_sub(3))
                        .collect::<String>()
                        + "…";
                }
                lines.push(Line::from(vec![
                    Span::styled(glyph, style),
                    Span::styled(text, Style::new().fg(palette.text)),
                ]));
            }
        }
        frame.render_widget(
            Paragraph::new(lines)
                .style(Style::new().bg(palette.background))
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}

/// Draw a modal dialog centered over the current screen. `Clear` hides the
/// page underneath so the dialog never blends with the transcript.
pub fn render_dialog(frame: &mut Frame, area: Rect, dialog: &Dialog, theme: &Theme) {
    if area.width < 20 || area.height < 5 {
        return;
    }
    let palette = theme.palette;
    let width = ((area.width as u32 * 60 / 100) as u16)
        .clamp(40, 80)
        .min(area.width);
    let height = dialog.height().min(area.height);
    let rect = Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    };
    frame.render_widget(Clear, rect);
    let block = Block::bordered()
        .title(Span::styled(
            format!(" {} ", dialog.title()),
            Style::new()
                .fg(palette.primary)
                .add_modifier(Modifier::BOLD),
        ))
        .border_style(Style::new().fg(palette.primary))
        .style(Style::new().bg(palette.surface));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    if let Dialog::SavedPermissions(saved) = dialog {
        saved.render(frame, inner, theme);
        return;
    }
    if let Dialog::Message(text) = dialog {
        let lines = text
            .lines
            .iter()
            .map(|line| Line::from(line.clone()))
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(lines)
                .style(Style::new().fg(palette.text).bg(palette.surface))
                .wrap(Wrap { trim: false })
                .scroll((text.scroll.min(u16::MAX as usize) as u16, 0)),
            inner,
        );
        return;
    }
    if let Some(list) = dialog.list() {
        render_list(frame, inner, list, theme);
        return;
    }
    if let Some(palette) = dialog.palette() {
        render_palette(frame, inner, palette, theme);
        return;
    }
    if let Some(input) = dialog.rename_input() {
        render_rename(frame, inner, input, theme);
        return;
    }
    if let Some(confirm) = dialog.confirm() {
        render_confirm(frame, inner, confirm, theme);
    }
}

fn render_list(frame: &mut Frame, area: Rect, list: &ListDialog, theme: &Theme) {
    let palette = theme.palette;
    let hint_area = Rect {
        y: area.y + area.height - 1,
        height: 1,
        ..area
    };
    // Plain lists carry a type-ahead filter, and a Session list arms the same
    // filter through `/`; either way the line shows what has been typed so the
    // reviewer can see why rows disappeared.
    let filtered = list.kind == ListKind::Plain || list.search;
    let filter_area = filtered.then_some(Rect { height: 1, ..area });
    let list_area = Rect {
        y: area.y + if filtered { 1 } else { 0 },
        height: area.height - 1 - if filtered { 1 } else { 0 },
        ..area
    };
    if let Some(filter_area) = filter_area {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("› ", Style::new().fg(palette.primary)),
                Span::styled(
                    list.filter.text().to_string(),
                    Style::new().fg(palette.text),
                ),
            ])),
            filter_area,
        );
    }
    if list.visible.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                if list.rows.is_empty() {
                    "nothing to show"
                } else {
                    "no match"
                },
                Style::new().fg(palette.text_muted),
            )),
            list_area,
        );
    } else {
        let visible = list_area.height as usize;
        let offset = list
            .selected
            .saturating_sub(visible.saturating_sub(1))
            .min(list.visible.len().saturating_sub(visible));
        let lines = list
            .visible
            .iter()
            .enumerate()
            .skip(offset)
            .take(visible)
            .map(|(position, row_index)| {
                let row = &list.rows[*row_index];
                let index = position;
                // A read-only list has nothing to select, so it draws no
                // marker and keeps every row in the same weight.
                let read_only = list.kind == ListKind::ReadOnly;
                let selected = !read_only && index == list.selected;
                let marker = if selected {
                    "▸ "
                } else if read_only {
                    ""
                } else {
                    "  "
                };
                let style = if selected {
                    Style::new()
                        .fg(palette.primary)
                        .bg(palette.element)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(palette.text)
                };
                let label = clip_cells(&row.label, 0, list_area.width.saturating_sub(2));
                let used = label
                    .chars()
                    .map(|c| UnicodeWidthChar::width(c).unwrap_or(0))
                    .sum::<usize>();
                let detail = if row.detail.is_empty() {
                    String::new()
                } else {
                    clip_cells(
                        &format!("   {}", row.detail),
                        0,
                        (list_area.width as usize).saturating_sub(used + 2) as u16,
                    )
                };
                Line::from(vec![
                    Span::styled(format!("{marker}{label}"), style),
                    Span::styled(detail, Style::new().fg(palette.text_muted)),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), list_area);
    }
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            list.hint,
            Style::new().fg(palette.text_muted),
        ))),
        hint_area,
    );
}

fn render_palette(frame: &mut Frame, area: Rect, palette: &PaletteDialog, theme: &Theme) {
    let colors = theme.palette;
    let input_area = Rect { height: 1, ..area };
    let list_area = Rect {
        y: area.y + 1,
        height: area.height.saturating_sub(1),
        ..area
    };
    let text = clip_cells(palette.input.text(), 0, input_area.width.saturating_sub(2));
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("› ", Style::new().fg(colors.primary)),
            Span::styled(text, Style::new().fg(colors.text)),
        ])),
        input_area,
    );
    let (_, cells) = palette.input.cursor_position();
    if input_area.width > 0 {
        let column = (2 + cells).min(input_area.width as usize - 1) as u16;
        frame.set_cursor_position(Position::new(input_area.x + column, input_area.y));
    }
    if palette.visible.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "no matching command",
                Style::new().fg(colors.text_muted),
            )),
            list_area,
        );
        return;
    }
    let visible = list_area.height as usize;
    let offset = palette
        .selected
        .saturating_sub(visible.saturating_sub(1))
        .min(palette.visible.len().saturating_sub(visible));
    let lines = palette
        .visible
        .iter()
        .enumerate()
        .skip(offset)
        .take(visible)
        .map(|(index, row_index)| {
            let row = &palette.rows[*row_index];
            let selected = index == palette.selected;
            let marker = if selected { "▸ " } else { "  " };
            let style = if selected {
                Style::new().fg(colors.primary).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(colors.text)
            };
            let label = clip_cells(&row.label, 0, list_area.width.saturating_sub(2));
            let used = label
                .chars()
                .map(|c| UnicodeWidthChar::width(c).unwrap_or(0))
                .sum::<usize>();
            let detail = if row.detail.is_empty() {
                String::new()
            } else {
                clip_cells(
                    &format!("   {}", row.detail),
                    0,
                    (list_area.width as usize).saturating_sub(used + 2) as u16,
                )
            };
            Line::from(vec![
                Span::styled(format!("{marker}{label}"), style),
                Span::styled(detail, Style::new().fg(colors.text_muted)),
            ])
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), list_area);
}

fn render_rename(frame: &mut Frame, area: Rect, input: &crate::editor::Editor, theme: &Theme) {
    let palette = theme.palette;
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "title",
            Style::new().fg(palette.text_muted),
        ))),
        Rect { height: 1, ..area },
    );
    let input_area = Rect {
        y: area.y + 1,
        height: 1,
        ..area
    };
    if input_area.width == 0 {
        return;
    }
    let text = clip_cells(input.text(), 0, input_area.width);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            text,
            Style::new().fg(palette.text),
        ))),
        input_area,
    );
    let (_, cells) = input.cursor_position();
    let column = cells.min(input_area.width as usize - 1) as u16;
    frame.set_cursor_position(Position::new(input_area.x + column, input_area.y));
}

fn render_confirm(
    frame: &mut Frame,
    area: Rect,
    confirm: &crate::dialogs::ConfirmDialog,
    theme: &Theme,
) {
    let palette = theme.palette;
    let button_area = Rect {
        y: area.y + area.height - 1,
        height: 1,
        ..area
    };
    let message_area = Rect {
        height: area.height.saturating_sub(2),
        ..area
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            confirm.message.clone(),
            Style::new().fg(palette.text),
        )))
        .wrap(Wrap { trim: false }),
        message_area,
    );
    let selected = Style::new()
        .fg(palette.primary)
        .add_modifier(Modifier::BOLD);
    let idle = Style::new().fg(palette.text_muted);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!("{} cancel   ", if confirm.confirmed { " " } else { "▸" }),
                if confirm.confirmed { idle } else { selected },
            ),
            Span::styled(
                format!(
                    "{} {}",
                    if confirm.confirmed { "▸" } else { " " },
                    confirm.action_label()
                ),
                if confirm.confirmed {
                    Style::new().fg(palette.error).add_modifier(Modifier::BOLD)
                } else {
                    idle
                },
            ),
        ])),
        button_area,
    );
}

/// A blocking engine decision drawn above the composer. Only one request is
/// surfaced at a time; the engine serializes them within a Session.
pub struct Panel {
    pub kind: PanelKind,
}

pub enum PanelKind {
    Approval(ApprovalView),
    Question(QuestionProgress),
}

pub struct QuestionProgress {
    pub view: QuestionView,
    focus: usize,
    cursor: Vec<usize>,
    chosen: Vec<Vec<bool>>,
    /// Set once the answer left this process: the panel stays on screen until
    /// the engine's snapshot settles it, and a second Enter must not answer it
    /// twice.
    submitted: bool,
    /// Accepted custom answers, one per question.
    typed: Vec<Option<String>>,
    /// The custom answer being typed for the focused question.
    typing: Option<String>,
}

const PANEL_ROWS: usize = 12;

/// The extra "type your own answer" row, when the question allows one. It is a
/// single-select affordance: a multi-select question collects labels.
fn custom_row(view: &QuestionView, index: usize) -> Option<usize> {
    let question = &view.questions[index];
    (question.custom && !question.multi_select).then_some(question.options.len())
}

impl Panel {
    pub fn approval(view: ApprovalView) -> Self {
        Self {
            kind: PanelKind::Approval(view),
        }
    }

    pub fn question(view: QuestionView) -> Self {
        let questions = view.questions.len();
        let cursor = vec![0; questions];
        let chosen = view
            .questions
            .iter()
            .map(|question| vec![false; question.options.len()])
            .collect();
        Self {
            kind: PanelKind::Question(QuestionProgress {
                view,
                focus: 0,
                cursor,
                chosen,
                submitted: false,
                typed: vec![None; questions],
                typing: None,
            }),
        }
    }

    /// The engine-side identity of the request being shown.
    pub fn request_id(&self) -> &str {
        match &self.kind {
            PanelKind::Approval(view) => &view.request_id,
            PanelKind::Question(progress) => &progress.view.question_id,
        }
    }

    pub fn approval_view(&self) -> Option<&ApprovalView> {
        match &self.kind {
            PanelKind::Approval(view) => Some(view),
            PanelKind::Question(_) => None,
        }
    }

    pub fn height(&self) -> u16 {
        let rows = match &self.kind {
            PanelKind::Approval(_) => 4,
            PanelKind::Question(progress) => {
                progress.view.questions[progress.focus].options.len() + 4
            }
        };
        (rows.min(PANEL_ROWS) + 2) as u16
    }

    pub fn move_cursor(&mut self, delta: i32) {
        let PanelKind::Question(progress) = &mut self.kind else {
            return;
        };
        let focus = progress.focus;
        let question = &progress.view.questions[focus];
        let last = custom_row(&progress.view, focus).unwrap_or(question.options.len() - 1);
        let next = progress.cursor[focus] as i32 + delta;
        progress.cursor[focus] = next.clamp(0, last as i32) as usize;
    }

    /// Toggle the focused option for a multi-select question; a single-select
    /// question just moves the mark.
    pub fn toggle(&mut self) {
        let PanelKind::Question(progress) = &mut self.kind else {
            return;
        };
        let focus = progress.focus;
        let cursor = progress.cursor[focus];
        let multi = progress.view.questions[focus].multi_select;
        if !multi && cursor >= progress.chosen[focus].len() {
            return;
        }
        let chosen = &mut progress.chosen[focus];
        if multi {
            chosen[cursor] = !chosen[cursor];
            return;
        }
        chosen.iter_mut().for_each(|mark| *mark = false);
        chosen[cursor] = true;
    }

    /// Confirm the focused question. Returns the `answer_question` payload once
    /// every question has at least one label, otherwise advances the focus.
    pub fn submit(&mut self) -> Option<serde_json::Value> {
        let PanelKind::Question(progress) = &mut self.kind else {
            return None;
        };
        if progress.submitted {
            return None;
        }
        let focus = progress.focus;
        let cursor = progress.cursor[focus];
        if !progress.view.questions[focus].multi_select {
            progress.chosen[focus]
                .iter_mut()
                .for_each(|mark| *mark = false);
            // The custom row has no mark of its own: its answer is the text.
            if cursor < progress.chosen[focus].len() {
                progress.chosen[focus][cursor] = true;
            }
        }
        let next = progress
            .chosen
            .iter()
            .enumerate()
            .skip(focus + 1)
            .find(|(_, marks)| !marks.iter().any(|mark| *mark))
            .map(|(index, _)| index);
        if let Some(index) = next {
            progress.focus = index;
            return None;
        }
        if progress.chosen.iter().enumerate().any(|(index, marks)| {
            let custom = custom_row(&progress.view, index) == Some(progress.cursor[index]);
            if custom {
                return progress.typed[index].as_deref().is_none_or(str::is_empty);
            }
            !marks.iter().any(|mark| *mark)
        }) {
            progress.focus = focus;
            return None;
        }
        let answers = progress
            .view
            .questions
            .iter()
            .enumerate()
            .zip(&progress.chosen)
            .map(|((index, question), marks)| {
                if custom_row(&progress.view, index) == Some(progress.cursor[index]) {
                    return vec![progress.typed[index].clone().unwrap_or_default()];
                }
                question
                    .options
                    .iter()
                    .zip(marks)
                    .filter(|(_, mark)| **mark)
                    .map(|(option, _)| option.label.clone())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        progress.submitted = true;
        Some(progress.view.answer(answers))
    }

    /// The custom answer being typed, if any. While this is `Some`, characters
    /// belong to the answer instead of the panel's keys.
    pub fn typing(&self) -> Option<&str> {
        match &self.kind {
            PanelKind::Question(progress) => progress.typing.as_deref(),
            _ => None,
        }
    }

    /// Enter on the custom row starts typing; anywhere else it submits.
    pub fn begin_typing(&mut self) -> bool {
        let PanelKind::Question(progress) = &mut self.kind else {
            return false;
        };
        let focus = progress.focus;
        if custom_row(&progress.view, focus) != Some(progress.cursor[focus]) {
            return false;
        }
        progress.typing = Some(String::new());
        true
    }

    pub fn type_char(&mut self, character: char) {
        let PanelKind::Question(progress) = &mut self.kind else {
            return;
        };
        if let Some(buffer) = progress.typing.as_mut() {
            buffer.push(character);
        }
    }

    pub fn backspace_typing(&mut self) {
        let PanelKind::Question(progress) = &mut self.kind else {
            return;
        };
        if let Some(buffer) = progress.typing.as_mut() {
            buffer.pop();
        }
    }

    /// Accept the typed answer into the question it belongs to.
    pub fn accept_typing(&mut self) -> bool {
        let PanelKind::Question(progress) = &mut self.kind else {
            return false;
        };
        let Some(buffer) = progress.typing.take() else {
            return false;
        };
        let focus = progress.focus;
        if buffer.trim().is_empty() {
            return false;
        }
        progress.typed[focus] = Some(buffer);
        true
    }

    pub fn cancel_typing(&mut self) -> bool {
        let PanelKind::Question(progress) = &mut self.kind else {
            return false;
        };
        progress.typing.take().is_some()
    }

    pub fn rejection(&self) -> Option<serde_json::Value> {
        match &self.kind {
            PanelKind::Approval(_) => None,
            PanelKind::Question(progress) => Some(progress.view.rejection()),
        }
    }

    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let palette = theme.palette;
        let title = match &self.kind {
            PanelKind::Approval(_) => " approval ",
            PanelKind::Question(_) => " question ",
        };
        let block = Block::bordered()
            .title(Span::styled(title, Style::new().fg(palette.warning)))
            .border_style(Style::new().fg(palette.warning))
            .style(Style::new().bg(palette.background));
        frame.render_widget(
            Paragraph::new(panel_lines(self, theme))
                .block(block)
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}

fn panel_lines(panel: &Panel, theme: &Theme) -> Vec<Line<'static>> {
    let palette = theme.palette;
    match &panel.kind {
        PanelKind::Approval(view) => vec![
            Line::from(vec![
                Span::styled(view.tool.clone(), Style::new().fg(palette.secondary)),
                Span::styled(
                    format!("  {}", compact(&view.resource)),
                    Style::new().fg(palette.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                compact(&view.input.to_string()),
                Style::new().fg(palette.text),
            )),
            Line::default(),
            Line::from(Span::styled(
                "1 allow once · 2 always allow · 3 deny",
                Style::new().fg(palette.text_muted),
            )),
        ],
        PanelKind::Question(progress) => {
            let question = &progress.view.questions[progress.focus];
            let heading = if question.header.is_empty() {
                question.question.clone()
            } else {
                format!("{} · {}", question.header, question.question)
            };
            let mut lines = vec![
                Line::from(Span::styled(heading, Style::new().fg(palette.text))),
                Line::default(),
            ];
            for (index, option) in question.options.iter().enumerate() {
                let marked = progress.chosen[progress.focus][index];
                let focused = index == progress.cursor[progress.focus];
                let glyph = match (question.multi_select, marked, focused) {
                    (true, true, true) => "▸ [x] ",
                    (true, true, false) => "  [x] ",
                    (true, false, true) => "▸ [ ] ",
                    (true, false, false) => "  [ ] ",
                    (false, _, true) => "▸ ",
                    (false, _, false) => "  ",
                };
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{glyph}{}", option.label),
                        if focused {
                            Style::new()
                                .fg(palette.primary)
                                .add_modifier(Modifier::BOLD)
                        } else {
                            Style::new().fg(palette.text)
                        },
                    ),
                    Span::styled(
                        if option.description.is_empty() {
                            String::new()
                        } else {
                            format!("  {}", compact(&option.description))
                        },
                        Style::new().fg(palette.text_muted),
                    ),
                ]));
            }
            if let Some(index) = custom_row(&progress.view, progress.focus) {
                let focused = progress.cursor[progress.focus] == index;
                let glyph = if focused { "▸ " } else { "  " };
                let written = progress
                    .typing
                    .as_deref()
                    .or(progress.typed[progress.focus].as_deref());
                let detail = match written {
                    Some(text) => format!("{glyph}Type your own answer: {text}"),
                    None => format!("{glyph}Type your own answer"),
                };
                lines.push(Line::from(Span::styled(
                    detail,
                    if focused {
                        Style::new()
                            .fg(palette.primary)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::new().fg(palette.text_muted)
                    },
                )));
            }
            let last = progress.focus + 1 == progress.view.questions.len();
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                if question.multi_select {
                    "space toggle · enter continue · esc reject"
                } else if last {
                    "enter submit · esc reject"
                } else {
                    "enter continue · esc reject"
                },
                Style::new().fg(palette.text_muted),
            )));
            lines
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Choice, QuestionItem};

    #[test]
    fn the_goal_has_its_own_section_above_the_todo_list() {
        // AGT-04: a displayed plan is not an implemented one, and a checklist is
        // not a Goal. Both are painted, and the Goal comes first with its own
        // header so the operator cannot read the todo list as the objective.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_session(Some(&SessionSummary {
            id: "ses_a".into(),
            title: Some("offset fix".into()),
            parent_id: None,
            updated_at_ms: Some(10),
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: Some("/work/miao".into()),
            model: None,
            credential_id: None,
            preview: None,
        }));
        shell.set_goal(Some(&crate::session::GoalView {
            objective: "ship the offset reporting".into(),
            status: "active".into(),
            budget: Some("two hours".into()),
            evidence: None,
        }));
        shell.set_todos(&[crate::session::TodoView {
            content: "wire the parser".into(),
            status: "completed".into(),
        }]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 20)).expect("terminal");
        terminal
            .draw(|frame| {
                let sidebar = shell.sidebar.as_mut().expect("sidebar");
                sidebar.render(frame, frame.area());
            })
            .expect("draw");
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let goal = text.find("goal · active").expect("goal header");
        let objective = text.find("ship the offset reporting").expect("objective");
        let budget = text.find("budget · two hours").expect("budget");
        let todos = text.find("todo 1").expect("todo header");
        assert!(goal < objective && objective < budget, "{text}");
        assert!(
            budget < todos,
            "the Goal stays above the checklist instead of inside it: {text}"
        );
        assert!(
            text.contains("wire the parser"),
            "the checklist is still shown: {text}"
        );
    }

    #[test]
    fn a_relative_timestamp_only_repaints_when_its_label_would_change() {
        // PERF-04: an idle TUI must not wake once a minute to redraw text that
        // cannot have changed. The wait is the distance to the next boundary.
        let now = 1_000_000_000u64;
        assert_eq!(
            next_relative_change(now, now),
            std::time::Duration::from_secs(60),
            "\"just now\" becomes \"1m ago\" at the minute"
        );
        assert_eq!(
            next_relative_change(now - 10_000, now),
            std::time::Duration::from_secs(50)
        );
        assert_eq!(
            next_relative_change(now - 330_000, now),
            std::time::Duration::from_secs(30),
            "5m30s becomes 6m ago in thirty seconds"
        );
        assert_eq!(
            next_relative_change(now - 90 * 60_000, now),
            std::time::Duration::from_secs(30 * 60),
            "\"1h ago\" waits for the next hour, not the next minute"
        );
        assert_eq!(
            next_relative_change(now - 3 * 86_400_000, now),
            std::time::Duration::from_secs(86_400),
            "a day-old label waits for the next day"
        );
    }

    #[test]
    fn the_composer_shows_its_text_from_forty_to_one_hundred_twenty_columns() {
        // UX-03: approval, questions, diffs and input all have to work at 40
        // columns, not just at the wide default.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut composer = Composer::new(Path::new("."));
        composer.paste("fix the parser at forty columns");
        for width in [40u16, 80, 120] {
            let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 8))
                .expect("terminal");
            terminal
                .draw(|frame| render_composer(frame, frame.area(), &composer, &theme))
                .expect("draw");
            let text = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(
                text.contains("fix the parser"),
                "the prompt is still readable at {width} columns: {text}"
            );
        }
    }

    #[test]
    fn state_survives_without_colour() {
        // UX-03: with every colour dropped, the glyph is what still says what
        // happened. A monochrome theme must not turn a checklist into one
        // undifferentiated column of text.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME)
            .expect("theme")
            .monochrome();
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        // The sidebar only paints its sections for an open Session.
        shell.set_session(Some(&SessionSummary {
            id: "ses_a".into(),
            title: Some("offset fix".into()),
            parent_id: None,
            updated_at_ms: Some(10),
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: Some("/work/miao".into()),
            model: None,
            credential_id: None,
            preview: None,
        }));
        shell.set_todos(&[
            crate::session::TodoView {
                content: "wire the parser".into(),
                status: "completed".into(),
            },
            crate::session::TodoView {
                content: "measure the window".into(),
                status: "in_progress".into(),
            },
        ]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 20)).expect("terminal");
        terminal
            .draw(|frame| {
                let sidebar = shell.sidebar.as_mut().expect("sidebar");
                sidebar.render(frame, frame.area());
            })
            .expect("draw");
        let cells = &terminal.backend().buffer().content;
        assert!(
            cells
                .iter()
                .all(|cell| cell.fg == ratatui::style::Color::Reset),
            "no colour is painted when the palette has none"
        );
        let text = cells.iter().map(|cell| cell.symbol()).collect::<String>();
        assert!(
            text.contains('✓'),
            "a finished item still reads as done: {text}"
        );
        assert!(
            text.contains('▸'),
            "the running item still reads as running: {text}"
        );
        assert!(text.contains("wire the parser") && text.contains("measure the window"));
    }

    #[test]
    fn an_alerting_status_is_painted_in_the_warning_color() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.title.set_status(Some(
            "waiting for model · 40s · no engine signal 20s".into(),
        ));
        shell.title.set_status_alert(true);
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 1))
            .expect("test terminal");
        terminal
            .draw(|frame| shell.title.render(frame, frame.area()))
            .expect("draw");
        let cells = &terminal.backend().buffer().content;
        assert!(cells.iter().any(|cell| cell.fg == palette.warning));
        shell.title.set_status_alert(false);
        terminal
            .draw(|frame| shell.title.render(frame, frame.area()))
            .expect("draw");
        let cells = &terminal.backend().buffer().content;
        assert!(cells.iter().all(|cell| cell.fg != palette.warning));
    }

    fn wrapped_text(rows: &[Line<'static>]) -> Vec<String> {
        rows.iter()
            .map(|row| {
                row.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn wrapped_rows_break_on_the_last_blank() {
        let rows = wrap_lines(&[Line::from("hello world again")], 10);
        assert_eq!(wrapped_text(&rows), vec!["hello ", "world ", "again"]);
    }

    #[test]
    fn a_word_longer_than_the_row_is_cut_at_the_edge() {
        let rows = wrap_lines(&[Line::from("abcdefghijkl")], 10);
        assert_eq!(wrapped_text(&rows), vec!["abcdefghij", "kl"]);
    }

    #[test]
    fn a_wide_character_never_straddles_a_row() {
        let rows = wrap_lines(&[Line::from("中文字符")], 5);
        assert_eq!(wrapped_text(&rows), vec!["中文", "字符"]);
    }

    #[test]
    fn wrapped_rows_keep_the_span_styles() {
        let line = Line::from(vec![
            Span::styled("plain ", Style::new().fg(ratatui::style::Color::Red)),
            Span::styled("tail", Style::new().fg(ratatui::style::Color::Blue)),
        ]);
        let rows = wrap_lines(&[line], 7);
        assert_eq!(wrapped_text(&rows), vec!["plain ", "tail"]);
        assert_eq!(rows[1].spans[0].style.fg, Some(ratatui::style::Color::Blue));
    }

    #[test]
    fn a_streamed_draft_is_parsed_on_demand_not_per_delta() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft("streamed words", "");
        assert!(
            shell.transcript.draft.is_empty(),
            "a delta must not re-parse the whole draft"
        );
        assert!(wrapped_text(shell.draft())
            .join("")
            .contains("streamed words"));
    }

    #[test]
    fn a_row_value_is_one_clipped_line() {
        assert_eq!(fit("first\nsecond", 40), "first second");
        assert_eq!(fit("a    b", 40), "a b");
        let clipped = fit("x".repeat(30).as_str(), 10);
        assert_eq!(UnicodeWidthStr::width(clipped.as_str()), 10);
        assert!(clipped.ends_with('…'));
        // Wide characters count two cells, so the clip never overflows.
        let wide = fit("中文中文中文中文", 9);
        assert!(UnicodeWidthStr::width(wide.as_str()) <= 9, "{wide:?}");
    }

    #[test]
    fn the_draft_shows_the_answer_before_it_is_committed() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft("streamed words", "considering");
        let draft = shell
            .draft()
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(draft.starts_with("▸ thinking · 11 chars"));
        assert!(draft.contains("streamed words"));
        // A projection, or a run that ends, clears it in one assignment.
        shell.set_draft("", "");
        assert!(shell.draft().is_empty());
    }

    #[test]
    fn a_failed_turn_renders_its_message_as_an_error_line() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let transcript = Transcript {
            entries: vec![Entry::Error {
                message: "provider unavailable".into(),
            }],
            ..Transcript::default()
        };
        let lines = transcript_lines(&transcript, &theme, false);
        assert_eq!(lines[0].to_string(), "✗ provider unavailable");
        assert_eq!(lines[0].spans[0].style.fg, Some(theme.palette.error));
    }

    #[test]
    fn the_last_response_is_the_newest_assistant_text() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        let transcript = Transcript {
            entries: vec![
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![Part::Text("first".into())],
                },
                Entry::User {
                    text: "question".into(),
                    seq: 3,
                },
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![
                        Part::Reasoning("thinking".into()),
                        Part::Text("second".into()),
                    ],
                },
            ],
            ..Transcript::default()
        };
        shell.set_transcript(&transcript);
        assert_eq!(shell.last_response().as_deref(), Some("second"));
        assert_eq!(
            Shell::new(Path::new("."), shell.theme().clone()).last_response(),
            None
        );
    }

    fn question(multi: bool) -> QuestionView {
        QuestionView {
            question_id: "run-1/call_2".into(),
            input_hash: "b".repeat(64),
            questions: vec![QuestionItem {
                question: "Which files?".into(),
                header: "Files".into(),
                options: vec![
                    Choice {
                        label: "src".into(),
                        description: String::new(),
                    },
                    Choice {
                        label: "docs".into(),
                        description: String::new(),
                    },
                ],
                multi_select: multi,
                custom: true,
            }],
        }
    }

    #[test]
    fn a_single_choice_question_answers_on_enter() {
        let mut panel = Panel::question(question(false));
        panel.move_cursor(1);
        let answer = panel.submit().expect("answer");
        assert_eq!(answer["question_id"], "run-1/call_2");
        assert_eq!(answer["input_hash"], "b".repeat(64));
        assert_eq!(answer["answers"], serde_json::json!([["docs"]]));
    }

    #[test]
    fn an_empty_home_reads_as_loading_until_the_engine_answers() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut home = Home::new(theme);
        assert_eq!(home.placeholder(), "loading sessions…");
        home.set_rows(Vec::new());
        assert_eq!(
            home.placeholder(),
            "no sessions yet · tab to type a prompt · n for an empty session"
        );
    }

    #[test]
    fn a_command_completion_row_says_what_the_command_does() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut composer = Composer::new(Path::new("."));
        composer.completion = crate::editor::Completion {
            kind: CompletionKind::Command,
            query: String::new(),
            token_start: 0,
            items: vec!["status".to_string()],
            selected: 0,
        };
        composer.set_command_details(vec![(
            "status".to_string(),
            "Session status and usage".to_string(),
        )]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(70, 8)).expect("terminal");
        terminal
            .draw(|frame| render_composer(frame, frame.area(), &composer, &theme))
            .expect("draw");
        let visible = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .flat_map(|cell| cell.symbol().chars())
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        assert!(visible.contains("status"), "{visible}");
        assert!(visible.contains("Sessionstatusandusage"), "{visible}");
    }

    #[test]
    fn an_empty_home_wraps_the_actionable_startup_refusal() {
        let mut home = Home::new(Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        });
        home.set_notice(Some("engine engine_closed: miao-engine exited (exit code: 1): miao engine-shim: could not prepare the product engine plan: Native TUI requires default-agent capture support".into()));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 10)).expect("terminal");
        terminal
            .draw(|frame| home.render(frame, frame.area()))
            .expect("draw");
        let visible = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .flat_map(|cell| cell.symbol().chars())
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        assert!(
            visible.contains("NativeTUIrequiresdefault-agentcapturesupport"),
            "{visible}"
        );
    }

    #[test]
    fn a_session_row_shows_its_preview_under_the_label() {
        let mut home = Home::new(Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        });
        home.set_rows(vec![SessionSummary {
            id: "ses_p".into(),
            title: Some("login fix".into()),
            parent_id: None,
            updated_at_ms: Some(10),
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: None,
            model: None,
            credential_id: None,
            preview: Some("it was the stub config".into()),
        }]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 10)).expect("terminal");
        terminal
            .draw(|frame| home.render(frame, frame.area()))
            .expect("draw");
        let visible = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .flat_map(|cell| cell.symbol().chars())
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        assert!(visible.contains("itwasthestubconfig"), "{visible}");
        assert!(visible.contains("loginfix"), "{visible}");
    }

    #[test]
    fn a_multi_select_question_collects_every_toggled_label() {
        let mut panel = Panel::question(question(true));
        assert!(panel.submit().is_none(), "nothing chosen yet");
        panel.toggle();
        panel.move_cursor(1);
        panel.toggle();
        let answer = panel.submit().expect("answer");
        assert_eq!(answer["answers"], serde_json::json!([["src", "docs"]]));
    }

    #[test]
    fn a_submitted_answer_is_not_sent_twice_while_the_panel_waits() {
        let mut panel = Panel::question(question(false));
        assert!(panel.submit().is_some(), "first Enter answers");
        assert!(
            panel.submit().is_none(),
            "a second Enter must not answer the same question again"
        );
    }

    #[test]
    fn a_single_choice_question_accepts_a_typed_answer() {
        let mut panel = Panel::question(question(false));
        // The custom row sits directly after the two options.
        panel.move_cursor(2);
        assert!(panel.begin_typing(), "the custom row starts typing");
        for character in "src/new.rs".chars() {
            panel.type_char(character);
        }
        assert!(panel.accept_typing());
        let answer = panel.submit().expect("answer");
        assert_eq!(answer["answers"], serde_json::json!([["src/new.rs"]]));
    }

    #[test]
    fn a_typed_answer_must_not_be_blank() {
        let mut panel = Panel::question(question(false));
        panel.move_cursor(2);
        assert!(panel.begin_typing());
        assert!(!panel.accept_typing(), "an empty answer is refused");
        assert!(panel.submit().is_none(), "nothing chosen yet");
    }

    #[test]
    fn a_question_panel_rejects_with_its_bound_hash() {
        let panel = Panel::question(question(false));
        let rejection = panel.rejection().expect("rejection");
        assert_eq!(rejection["question_id"], "run-1/call_2");
        assert_eq!(rejection["input_hash"], "b".repeat(64));
    }

    #[test]
    fn an_approval_response_echoes_the_binding_identities() {
        let view = ApprovalView {
            request_id: "run-1/call_1".into(),
            tool: "bash".into(),
            resource: "ls".into(),
            input: serde_json::json!({}),
            input_hash: "c".repeat(64),
            policy_revision: "rev-2".into(),
            matcher: Some(serde_json::json!({"kind": "builtin"})),
            expires_at_ms: None,
        };
        let response = view.response("allow");
        assert_eq!(response["request_id"], "run-1/call_1");
        assert_eq!(response["decision"], "allow");
        assert_eq!(response["policy_revision"], "rev-2");
        assert_eq!(response["matcher"]["kind"], "builtin");
    }

    #[test]
    fn a_mouse_drag_copies_the_cells_it_covered() {
        let inner = Rect::new(1, 2, 6, 3);
        let cells = |text: &str| text.chars().map(|c| c.to_string()).collect::<Vec<_>>();
        let rendered = vec![cells("abc   "), cells("def   "), cells("ghi   ")];
        // One row, trailing blanks trimmed.
        assert_eq!(
            selection_text(&rendered, inner, Position::new(2, 2), Position::new(4, 2)),
            "bc"
        );
        // A drag that crosses rows reads left-to-right, top-to-bottom.
        assert_eq!(
            selection_text(&rendered, inner, Position::new(2, 2), Position::new(3, 3)),
            "bc\ndef"
        );
        // A drag that leaves the pane clamps instead of panicking.
        assert_eq!(
            selection_text(&rendered, inner, Position::new(1, 2), Position::new(9, 9)),
            "abc\ndef\nghi"
        );
        // Blank cells copy nothing.
        assert_eq!(
            selection_text(&rendered, inner, Position::new(5, 2), Position::new(6, 2)),
            ""
        );
    }
}
