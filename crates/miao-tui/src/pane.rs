use std::path::Path;
use std::time::{Duration, Instant};

use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

use crate::dialogs::{Dialog, ListDialog, ListKind, PaletteDialog};
use crate::editor::{CompletionKind, Composer, Mode};
use crate::session::{
    ApprovalView, Entry, Part, QuestionView, Reasoning, SessionSummary, Transcript,
};
use crate::theme::Theme;
use crate::{markdown, tool};

const SIDEBAR_MIN_WIDTH: u16 = 100;

/// The width the input is painted at on a Session screen: the prose column it
/// sits in, which fills the body, so the caret stays under the text it answers.
fn composer_column(width: u16) -> u16 {
    width
}

/// Where the body splits between the transcript and the sidebar.
///
fn body_columns(area: Rect) -> (Rect, Option<Rect>) {
    if area.width < SIDEBAR_MIN_WIDTH {
        return (area, None);
    }
    let split = area.width.saturating_sub(SIDEBAR_WIDTH + 1);
    (
        Rect {
            x: area.x,
            width: split,
            ..area
        },
        Some(Rect {
            x: area.x + split + 1,
            width: SIDEBAR_WIDTH,
            ..area
        }),
    )
}

const SIDEBAR_WIDTH: u16 = 40;

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
    /// The armed leader's menu, painted in the status row while it waits.
    pub leader_hint: Option<String>,
    /// The projection behind `transcript.lines`, kept so a theme change can
    /// repaint the same content instead of waiting for the next snapshot.
    last: Option<Transcript>,
    /// The chord that unfolds a tool result, resolved from the live keymap so
    /// the elision line names a key the operator has. `None` means the action
    /// is unbound, and then the line promises no chord at all.
    toggle_chord: Option<String>,
}

impl Shell {
    pub fn new(workspace: &Path, theme: Theme) -> Self {
        Self {
            title: TitlePane::new(workspace, theme.clone()),
            transcript: TranscriptPane::new(theme.clone()),
            composer: Composer::new(workspace),
            status: StatusStrip::default(),
            panel: None,
            leader_hint: None,
            sidebar: Some(SidebarPane {
                theme,
                session: None,
                usage: None,
                goal: None,
                todos: Vec::new(),
            }),
            last: None,
            toggle_chord: None,
        }
    }

    /// Name the unfold chord the way the operator's keymap spells it. The
    /// projection is repainted so the hint follows a remap without waiting for
    /// the next snapshot.
    pub fn set_toggle_chord(&mut self, chord: Option<String>) {
        if self.toggle_chord == chord {
            return;
        }
        self.toggle_chord = chord;
        if let Some(last) = &self.last {
            let projected = transcript_lines(
                last,
                &self.transcript.theme,
                self.transcript.expanded,
                self.toggle_chord.as_deref(),
            );
            self.transcript.set_rows(projected.rows);
            self.transcript.user_anchors = projected.anchors;
        }
    }

    pub fn set_transcript(&mut self, transcript: &Transcript) {
        let projected = transcript_lines(
            transcript,
            &self.transcript.theme,
            self.transcript.expanded,
            self.toggle_chord.as_deref(),
        );
        self.transcript.set_rows(projected.rows);
        self.transcript.user_anchors = projected.anchors;
        let max = self.transcript.max_scroll();
        self.transcript.scroll = self.transcript.scroll.min(max);
        self.last = Some(transcript.clone());
    }

    /// Show what the model is streaming before its message commits. Empty
    /// strings clear it.
    pub fn set_draft(&mut self, text: &str, reasoning: &str) {
        self.transcript.set_draft(text, reasoning);
    }

    /// Name the tool call the run is waiting on; `None` clears it.
    pub fn set_running_tool(&mut self, label: Option<String>) {
        self.transcript.running_tool = label;
    }

    /// Where the transcript is scrolled to, in rows from the oldest one. A test
    /// asserts a wheel step exactly instead of inferring it from `following`.
    #[cfg(test)]
    pub fn transcript_scroll(&self) -> u16 {
        self.transcript.scroll
    }

    #[cfg(test)]
    pub fn draft(&mut self) -> &[Row] {
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
                Entry::User { .. } | Entry::Error { .. } | Entry::Context { .. } => None,
            })?;
        Some(reply)
    }

    /// Show the armed leader's menu in the status row.
    pub fn set_leader_hint(&mut self, hint: Option<String>) {
        self.leader_hint = hint;
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.title.set_theme(theme.clone());
        self.transcript.theme = theme.clone();
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.theme = theme.clone();
        }
        if let Some(last) = &self.last {
            let projected = transcript_lines(
                last,
                &theme,
                self.transcript.expanded,
                self.toggle_chord.as_deref(),
            );
            self.transcript.set_rows(projected.rows);
            self.transcript.user_anchors = projected.anchors;
        }
    }

    pub fn theme(&self) -> &Theme {
        &self.transcript.theme
    }

    /// Show one status line instead of a transcript: engine failures and other
    /// states where there is no Session content to render.
    pub fn set_message(&mut self, message: &str) {
        let palette = self.transcript.theme.palette;
        self.transcript
            .set_rows(vec![Row::plain(Line::from(Span::styled(
                message.to_string(),
                Style::new().fg(palette.error),
            )))]);
        self.transcript.user_anchors = Vec::new();
        self.transcript.scroll = 0;
        self.transcript.follow = false;
        self.last = None;
    }

    /// Fold or unfold every tool result and repaint the projection behind the
    /// current lines, so the toggle applies without waiting for a snapshot.
    pub fn toggle_tool_expansion(&mut self) -> bool {
        self.transcript.expanded = !self.transcript.expanded;
        if let Some(last) = &self.last {
            let projected = transcript_lines(
                last,
                &self.transcript.theme,
                self.transcript.expanded,
                self.toggle_chord.as_deref(),
            );
            self.transcript.set_rows(projected.rows);
            self.transcript.user_anchors = projected.anchors;
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
        // No title row: the workspace, branch and version fold into the status
        // strip at the bottom, so the whole screen above the composer is
        // content. The terminal tab already names the workspace too.
        // Air above the composer: the TS prompt keeps one band there for the
        // run's phase, the queue, and notices (`composer_air`). The row below
        // is only spacing.
        let [body_area, panel_area, air_above, composer_area, _air_below, status_area] =
            Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(panel_height),
                Constraint::Length(1),
                Constraint::Length(composer_height(
                    &self.composer,
                    composer_column(frame.area().width),
                )),
                Constraint::Length(1),
                Constraint::Length(1),
            ])
            .areas(frame.area());
        let (transcript_area, sidebar_area) = body_columns(body_area);
        self.transcript.render(frame, transcript_area);
        if let (Some(sidebar), Some(sidebar_area)) = (self.sidebar.as_mut(), sidebar_area) {
            sidebar.render(frame, sidebar_area);
        }
        if let Some(panel) = self.panel.as_ref() {
            panel.render(frame, panel_area, &self.transcript.theme);
        }
        // The TS compact activity row is one line above the input: state on
        // the left, elapsed time right-aligned. The two columns re-create that
        // space-between split; a narrow band drops the right side, as the TS
        // row does under 32 columns.
        if let Some(elapsed) = &self.composer.phase_elapsed {
            if air_above.width >= 32 {
                let width = elapsed.width() as u16;
                let [left, right] =
                    Layout::horizontal([Constraint::Min(1), Constraint::Length(width)])
                        .areas(air_above);
                frame.render_widget(
                    Paragraph::new(composer_air(&self.composer, &self.transcript.theme)),
                    left,
                );
                frame.render_widget(
                    Paragraph::new(Line::from(Span::styled(
                        elapsed.clone(),
                        Style::new().fg(self.transcript.theme.palette.text_muted),
                    ))),
                    right,
                );
            } else {
                frame.render_widget(
                    Paragraph::new(composer_air(&self.composer, &self.transcript.theme)),
                    air_above,
                );
            }
        } else {
            frame.render_widget(
                Paragraph::new(composer_air(&self.composer, &self.transcript.theme)),
                air_above,
            );
        }
        // The input spans the whole window width, covering the sidebar's
        // bottom band the way the TS layout draws it: the sidebar's content
        // ends high, and a prose-width input left that band looking cut off.
        render_composer(frame, composer_area, &self.composer, &self.transcript.theme);
        match &self.leader_hint {
            Some(menu) => frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    fit_chords(menu, status_area.width as usize),
                    Style::new().fg(self.transcript.theme.palette.primary),
                ))),
                status_area,
            ),
            None => render_status(frame, status_area, &self.status, &self.transcript.theme),
        }
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
        // The header names what this screen is: the workspace and branch carry
        // the body colour so the eye has an anchor at the top, while the status
        // stays quiet and colour is reserved for the state that needs the
        // operator (`status_alert`).
        let style = Style::new().fg(palette.text).bg(palette.background);
        let mut spans = vec![Span::styled(format!("{} ", self.label), style)];
        if let Some(status) = &self.status {
            let color = match self.status_alert {
                true => palette.warning,
                false => palette.text_muted,
            };
            spans.push(Span::styled(
                format!("· {status} "),
                Style::new().fg(color).bg(palette.background),
            ));
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }
}

pub struct TranscriptPane {
    theme: Theme,
    /// The projection's rows, unwrapped. A frame wraps them once per width
    /// into `body` and paints only its viewport, so a keystroke costs the
    /// window rather than the whole Session.
    rows: Vec<Row>,
    /// The streamed answer that the next projection replaces. Kept apart from
    /// `rows` so a projection can drop it in one assignment.
    draft_source: Option<(String, String)>,
    draft: Vec<Row>,
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
    /// Row-flow position of each operator prompt and its first line, so a
    /// scrolled-back viewport names the question its top row belongs to.
    user_anchors: Vec<(usize, String)>,
    /// A tool the run has started but not finished. It streams into the tail
    /// as the spinner row the TS transcript keeps under the running step.
    running_tool: Option<String>,
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
            rows: vec![Row::plain(Line::from("no Session selected"))],
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
            user_anchors: Vec::new(),
            running_tool: None,
            expanded: false,
            area: Rect::default(),
            selection: None,
            rendered: Vec::new(),
        }
    }

    /// Replace the projection's rows. The bump invalidates the wrapped cache,
    /// which is rebuilt on the next frame at that frame's width.
    fn set_rows(&mut self, rows: Vec<Row>) {
        self.rows = rows;
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
            0 => self.rows.len(),
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
            Some((text, reasoning)) => draft_lines(text, reasoning, &self.theme, now_ms()),
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
        // The TS message column is inset one cell on each side inside its
        // body row (`paddingLeft=1 paddingRight=1`), which is what keeps the
        // user panel's `┃` edge off the very screen edge. Mirroring that inset
        // here moves the whole pane, wrap budget included.
        let content = Rect {
            x: area.x + 1,
            width: area.width.saturating_sub(2),
            ..area
        };
        let resized = content.width != self.width;
        if resized || self.body_version != self.body_built {
            self.body = wrap_rows(&self.rows, content.width);
            self.body_built = self.body_version;
        }
        if resized || self.draft_version != self.draft_rows_built {
            self.draft_rows = wrap_rows(&self.draft, content.width);
            self.draft_rows_built = self.draft_version;
        }
        self.width = content.width;
        let viewport = area.height as usize;
        let rows = self.body.len() + self.draft_rows.len();
        if self.follow {
            self.scroll = rows.saturating_sub(viewport) as u16;
        }
        let start = (self.scroll as usize).min(rows.saturating_sub(1));
        let mut visible = (start..rows)
            .take(viewport)
            .map(|row| match row < self.body.len() {
                true => self.body[row].clone(),
                false => self.draft_rows[row - self.body.len()].clone(),
            })
            .collect::<Vec<_>>();
        // The call in flight rides the tail as one spinner row. It takes the
        // bottom slot from the oldest visible row, so the newest output stays
        // on screen with the step that is still working.
        if let Some(label) = self.running_tool.as_ref().filter(|_| self.follow) {
            if visible.len() == viewport {
                visible.remove(0);
            }
            let frame = SPINNER_FRAMES[(now_ms() / 160) as usize % SPINNER_FRAMES.len()];
            visible.push(Line::from(Span::styled(
                format!("{frame} running {label}"),
                Style::new().fg(palette.text_muted),
            )));
        }
        // Scrolling back loses the question a view belongs to: the viewport's
        // first row names the nearest prompt at or above it, painted over that
        // row the way a sticky header is. The prompt's own first row needs no
        // reminder, so the marker starts one row past it.
        if !self.follow && start < self.body.len() {
            if let Some((_, prompt)) = self.user_anchors.iter().rev().find(|(row, _)| *row < start)
            {
                let first = prompt.lines().next().unwrap_or_default();
                if !first.is_empty() {
                    let width = (content.width as usize).saturating_sub(2);
                    visible[0] = Line::from(Span::styled(
                        format!("❯ {}", fit(first, width.saturating_sub(2))),
                        Style::new().fg(palette.primary),
                    ))
                    .style(Style::new().bg(palette.surface));
                }
            }
        }
        // A row that carries its own background is a panel band: padding it to
        // the pane's edge paints the block the way a box background would,
        // instead of a grey smear that stops at the last character.
        let width = content.width as usize;
        for line in &mut visible {
            if line.style.bg.is_some() {
                let used = line.width();
                if used < width {
                    line.spans.push(Span::styled(
                        " ".repeat(width - used),
                        Style::new().bg(palette.surface),
                    ));
                }
            }
        }
        // Borderless, like the TypeScript layout this mirrors: a frame around
        // the transcript only steals columns from the text.
        frame.render_widget(
            Paragraph::new(visible).style(Style::new().fg(palette.text).bg(palette.background)),
            content,
        );
        self.area = content;
        // Only a drag reads the cells back, so an idle frame does not copy the
        // viewport into strings.
        if self.selection.is_some() {
            self.snapshot(frame, content);
            self.paint_selection(frame, content);
        }
    }
}

/// A projected transcript line plus its wrap behavior, mirroring the TS
/// layout's container model: `hang` is the display-cell width of the leading
/// prefix (the `● ` bullet, the `┃` user panel edge) that stays painted on
/// every wrapped row, so the text wraps inside the width that remains — the
/// way the TS markdown box wraps inside its padded container. `keep` is the
/// leading slice of that prefix that is structural and survives on every
/// continuation unchanged (the user panel's `┃` edge); the rest of the prefix
/// is blanked on continuations, the way the TS `❯` marker leads only the first
/// row. `wrap: false` is TS `wrapMode="none"`: the row is clipped to the
/// width, never folded.
pub struct Row {
    pub(crate) line: Line<'static>,
    pub(crate) hang: u16,
    pub(crate) keep: u16,
    pub(crate) wrap: bool,
}

impl Row {
    /// A full-width wrapping row with no hanging prefix.
    pub(crate) fn plain(line: Line<'static>) -> Self {
        Self {
            line,
            hang: 0,
            keep: 0,
            wrap: true,
        }
    }

    /// A row whose text wraps under a fixed leading prefix that continuations
    /// blank out (the `● ` bullet, the `❯` marker column).
    fn hung(line: Line<'static>, hang: u16) -> Self {
        Self {
            line,
            hang,
            keep: 0,
            wrap: true,
        }
    }

    /// Like [`Row::hung`], but the first `keep` cells of the prefix are
    /// structural and repeat on every continuation (the `┃` panel edge).
    fn hung_with_edge(line: Line<'static>, hang: u16, keep: u16) -> Self {
        Self {
            line,
            hang,
            keep,
            wrap: true,
        }
    }

    /// A row that clips instead of folding (`wrapMode="none"`).
    fn clipped(line: Line<'static>) -> Self {
        Self {
            line,
            hang: 0,
            keep: 0,
            wrap: false,
        }
    }
}

/// The display width of a line's leading indentation.
///
/// Tool rows are indented by design: a header opens with its `● ` bullet and a
/// result with the `  ⎿ ` gutter. Wrapped as plain text, a continuation started
/// at column zero and `  ⎿ Read 2 lines` read as two unrelated rows — which is
/// what made a narrow pane look like the prose wrapped early. The continuation
/// hangs under the indent the row was projected with instead.
fn leading_indent(line: &Line<'static>) -> u16 {
    let Some(first) = line.spans.first() else {
        return 0;
    };
    match first.content.chars().take_while(|c| *c == ' ').count() {
        // The row opens with the `● ` bullet; its two-cell marker column is
        // what a continuation hangs under.
        0 => 2,
        spaces => spaces as u16,
    }
}

/// Split styled lines into rows no wider than `width` display cells, so the
/// transcript is wrapped once per width instead of once per frame. Breaks
/// prefer the last blank on the row, like the word wrapping it replaces, and
/// only a word longer than the row is cut mid-word. Styles and alignment
/// survive the split; a wide character never straddles a row.
#[cfg(test)]
fn wrap_lines(lines: &[Line<'static>], width: u16) -> Vec<Line<'static>> {
    let rows: Vec<Row> = lines.iter().cloned().map(Row::plain).collect();
    wrap_rows(&rows, width)
}

/// Wrap projected rows to `width` display cells, honoring each row's hanging
/// prefix and clip mode.
fn wrap_rows(rows: &[Row], width: u16) -> Vec<Line<'static>> {
    let width = width.max(1) as usize;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        // Blank rows are spacing, not content: they pass through untouched.
        if row.line.spans.is_empty() {
            out.push(row.line.clone());
            continue;
        }
        let cells = row
            .line
            .spans
            .iter()
            .flat_map(|span| {
                span.content
                    .chars()
                    .map(move |character| (character, span.style))
            })
            .collect::<Vec<_>>();
        if !row.wrap {
            // A clipped row keeps its start and drops the overflow, the way
            // TS `wrapMode="none"` never folds a status line.
            let mut used = 0;
            let mut end = 0;
            while end < cells.len() {
                let cell = cells[end].0.width().unwrap_or(0);
                if used + cell > width {
                    break;
                }
                used += cell;
                end += 1;
            }
            out.push(row_from(&cells[..end], &row.line));
            continue;
        }
        let hang = (row.hang as usize).min(width.saturating_sub(1));
        if hang == 0 || cells_width(&cells) <= width {
            if hang == 0 {
                out.extend(wrap_cells(&cells, width, &row.line));
            } else {
                out.push(row_from(&cells, &row.line));
            }
            continue;
        }
        // Container model: the prefix stays fixed on every row and the text
        // wraps inside the width that remains. The first row reuses the
        // projected prefix verbatim; continuation rows keep the structural
        // leading slice (`keep`, the `┃` panel edge) and blank the rest to the
        // prefix's trailing style, which is where the TS text element starts
        // its wrapped lines.
        let prefix = &cells[..hang];
        let text = &cells[hang..];
        let budget = width - hang;
        let blank = prefix
            .last()
            .map(|(_, style)| (' ', *style))
            .unwrap_or((' ', Style::new()));
        let keep = (row.keep as usize).min(hang);
        let mut first = true;
        for chunk in chunk_cells(text, budget) {
            let row = match first {
                true => {
                    first = false;
                    row_from(prefix.iter().chain(chunk.iter()), &row.line)
                }
                false => row_from(
                    prefix[..keep]
                        .iter()
                        .chain(std::iter::repeat_n(&blank, hang - keep))
                        .chain(chunk.iter()),
                    &row.line,
                ),
            };
            out.push(row);
        }
    }
    out
}

fn cells_width(cells: &[(char, Style)]) -> usize {
    cells
        .iter()
        .map(|(character, _)| character.width().unwrap_or(0))
        .sum()
}

/// Split cells into chunks of at most `width` display cells, preferring the
/// last blank of each chunk as the break.
fn chunk_cells(cells: &[(char, Style)], width: usize) -> Vec<&[(char, Style)]> {
    let mut chunks = Vec::new();
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
        chunks.push(&cells[start..end]);
        start = end;
    }
    chunks
}

fn wrap_cells(cells: &[(char, Style)], width: usize, line: &Line<'static>) -> Vec<Line<'static>> {
    chunk_cells(cells, width)
        .into_iter()
        .map(|chunk| row_from(chunk, line))
        .collect()
}

/// One wrapped row, with adjacent cells of the same style joined back into a
/// span.
fn row_from<'a, I>(cells: I, line: &Line<'static>) -> Line<'static>
where
    I: IntoIterator<Item = &'a (char, Style)>,
{
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
        // A wide glyph (CJK, emoji) takes one cell and leaves the next one as its
        // continuation. Copying that continuation appends a space after every
        // wide character, which is why a selected sentence used to come back
        // with 一 个 空 格 between every pair.
        let mut wide = false;
        for x in from..=to {
            if let Some(symbol) = row.get(x as usize) {
                if wide {
                    wide = false;
                    continue;
                }
                text.push_str(symbol);
                wide = UnicodeWidthStr::width(symbol.as_str()) > 1;
            }
        }
        lines.push(text.trim_end().to_string());
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

pub struct Home {
    /// A transient problem (an engine restart, a failed submit): painted under
    /// the prompt.
    notice: Option<String>,
    /// A configuration problem that outlives one load: painted the same way,
    /// in the warning colour.
    warning: Option<String>,
    theme: Theme,
}

impl Home {
    pub fn new(theme: Theme) -> Self {
        Self {
            notice: None,
            warning: None,
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

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }

    /// The launcher screen, drawn the way the TS home draws it: the wordmark
    /// banner and the version centred in the vertical leftover, the prompt
    /// beneath, and any notice under that. There is no session list here —
    /// history lives in the session dialog, reachable from the prompt.
    pub fn render(&mut self, frame: &mut Frame, area: Rect, composer: &mut Composer) {
        let palette = self.theme.palette;
        let width = area.width as usize;
        // The banner art: cat on the left, the MIAO wordmark beside it.
        let cat = [r"       ", r" /\/\  ", r"( o.o )", r" > ^ < ", r"       "];
        let wordmark = [
            ["█   █", "█", " ███ ", "█████"],
            ["██ ██", "█", "█   █", "█   █"],
            ["█ █ █", "█", "█   █", "█████"],
            ["█   █", "█", "█   █", "█████"],
            ["█   █", "█", "█   █", "█████"],
        ];
        let gap = "  ";
        let banner_rows: Vec<String> = (0..5)
            .map(|row| format!("{}  {}", cat[row], wordmark[row].join(gap)))
            .collect();

        let version = match option_env!("MIAO_TUI_VERSION") {
            Some(version) => version,
            None => env!("CARGO_PKG_VERSION"),
        };

        let prompt_width = ((area.width as usize) * 7 / 10).max(75).min(width);
        let prompt_h = crate::pane::composer_height(composer, area.width).max(3);
        let notice_h = usize::from(self.notice.is_some()) + usize::from(self.warning.is_some());

        // Vertical: the used block (banner + version + gap + prompt + notices)
        // is centred, riding two-fifths high the way the TS flex layout lands.
        let used = 5 + 1 + 1 + 1 + prompt_h as usize + notice_h;
        let free = (area.height as usize).saturating_sub(used);
        let gap_top = free * 2 / 5;
        let gap_bottom = free.saturating_sub(gap_top);

        let mut y = area.y as usize;
        // Every block centres across the full window width, and the whole
        // group sits in the vertical leftover — banner, version, one blank
        // row, then the prompt, exactly the stack the TS home draws.
        let centre = |text: &str, style: Style| -> Line<'static> {
            let pad = (width.saturating_sub(text.width())) / 2;
            Line::from(Span::styled(format!("{}{}", " ".repeat(pad), text), style))
        };
        let mut put_lines: Vec<Line<'static>> = Vec::new();
        for row in &banner_rows {
            put_lines.push(centre(row, Style::new().fg(palette.primary)));
        }
        put_lines.push(centre(
            &format!("v{version}"),
            Style::new().fg(palette.text_muted),
        ));
        put_lines.push(Line::default()); // the blank row between banner and prompt
        y += gap_top.min(free);
        let prompt_x = width.saturating_sub(prompt_width) / 2;
        let prompt_area = Rect {
            x: area.x + prompt_x as u16,
            width: prompt_width as u16,
            y: (y + put_lines.len()) as u16,
            height: prompt_h + 1,
        };
        for (offset, line) in put_lines.iter().enumerate() {
            frame.render_widget(
                Paragraph::new(line.clone()),
                Rect {
                    y: y as u16 + offset as u16,
                    height: 1,
                    ..area
                },
            );
        }
        render_composer(frame, prompt_area, composer, &self.theme);
        let mut notice_y = prompt_area.y + prompt_h + 1;
        if let Some(warning) = &self.warning {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    warning.clone(),
                    Style::new().fg(palette.warning),
                )),
                Rect {
                    y: notice_y,
                    height: 1,
                    ..area
                },
            );
            notice_y += 1;
        }
        if let Some(notice) = &self.notice {
            frame.render_widget(
                Paragraph::new(Span::styled(notice.clone(), Style::new().fg(palette.error))),
                Rect {
                    y: notice_y,
                    height: 1,
                    ..area
                },
            );
        }
        let _ = gap_bottom;
    }
}

/// The bottom-row key hint. `Tab` reaches whichever side does not hold the
/// keyboard, so the line names that place instead of promising one direction:
/// the prompt owns the landing screen, and a fixed `tab prompt` would point at
/// the keyboard it already has.
///
/// While the prompt holds the keyboard every other chord on this line reaches
/// the composer as text — `/`, `p`, `n`, `1-9` and `?` all type themselves — so
/// Trim a which-key menu at a chord boundary.
///
/// `fit` cuts a line at a cell, which turns `n session new` into `n session n…`
/// and tells the operator nothing. A menu is a list, so the tail is dropped by
/// the chord and the row says how many are left — the rest are one `/help` away.
fn fit_chords(menu: &str, width: usize) -> String {
    if UnicodeWidthStr::width(menu) <= width {
        return menu.to_string();
    }
    let mut parts = menu.split(" · ");
    let Some(leader) = parts.next() else {
        return fit(menu, width);
    };
    let chords = parts.collect::<Vec<_>>();
    for take in (0..=chords.len()).rev() {
        let head = match take {
            0 => leader.to_string(),
            _ => format!("{leader} · {}", chords[..take].join(" · ")),
        };
        let hidden = chords.len() - take;
        let line = match hidden {
            0 => head,
            _ => format!("{head} · … +{hidden}"),
        };
        if UnicodeWidthStr::width(line.as_str()) <= width {
            return line;
        }
    }
    fit(leader, width)
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

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
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

/// The braille frames the TS TUI animates, one step every 160ms.
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Milliseconds spelled the way the TS Locale spells them: `3.2s`, `1m 20s`.
pub(crate) fn duration_ms(input: u64) -> String {
    if input < 1_000 {
        format!("{input}ms")
    } else if input < 60_000 {
        format!("{:.1}s", input as f64 / 1_000.0)
    } else if input < 3_600_000 {
        format!("{}m {}s", input / 60_000, (input % 60_000) / 1_000)
    } else if input < 86_400_000 {
        format!("{}h {}m", input / 3_600_000, (input % 3_600_000) / 60_000)
    } else {
        format!(
            "{}d {}h",
            input / 86_400_000,
            (input % 86_400_000) / 3_600_000
        )
    }
}

/// The `**Title**\n\nbody` opener some providers put on reasoning summaries,
/// which the TS header lifts out so the title can stand alone on the line.
fn reasoning_title(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("**")?;
    let end = rest.find("**")?;
    let title = &rest[..end];
    if title.is_empty() || title.contains('*') || title.contains('\n') {
        return None;
    }
    let after = &rest[end + 2..];
    if !(after.is_empty() || after.starts_with("\n\n") || after.starts_with("\r\n\r\n")) {
        return None;
    }
    Some(title.trim().to_string())
}

/// The one line of reasoning the header names: the provider's title, or the
/// first line that says anything.
fn reasoning_summary(text: &str) -> String {
    match reasoning_title(text) {
        Some(title) => title,
        None => text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or_default()
            .to_string(),
    }
}

/// The settled thinking header: `Thought for 3.2s · summary`, falling back to
/// `Thought · summary` and then bare `Thought` as the facts it needs drop out.
fn thought_header(reasoning: &Reasoning, theme: &Theme) -> Line<'static> {
    let palette = theme.palette;
    let duration = match (reasoning.created_ms, reasoning.completed_ms) {
        (Some(created), Some(completed)) if completed > created => {
            format!("Thought for {} · ", duration_ms(completed - created))
        }
        _ => "Thought · ".to_string(),
    };
    let summary = reasoning_summary(&reasoning.text);
    let label = if summary.is_empty() {
        duration.trim_end_matches(" · ").to_string()
    } else {
        format!("{duration}{}", fit(&summary, COMPACT_CELLS))
    };
    Line::from(Span::styled(
        format!("  {label}"),
        Style::new().fg(palette.text_muted),
    ))
}

/// Assistant prose as the TS TextPart paints it: a muted bullet on the first
/// row and the markdown block indented under that bullet's two cells. The two
/// prefix cells hang on every wrapped row, so the text wraps inside the same
/// width the TS markdown container gets.
fn prose_lines(text: &str, theme: &Theme) -> Vec<Row> {
    let palette = theme.palette;
    let bullet = Style::new().fg(palette.text_muted);
    markdown::lines(text, theme)
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            let mut spans = Vec::with_capacity(line.spans.len() + 1);
            spans.push(Span::styled(if index == 0 { "● " } else { "  " }, bullet));
            spans.extend(line.spans);
            Row::hung(Line::from(spans).style(line.style), 2)
        })
        .collect()
}

/// The streamed answer, rendered like the assistant entry it will become: the
/// provisional block gains its header when the committed message arrives.
fn draft_lines(text: &str, reasoning: &str, theme: &Theme, now_ms: u64) -> Vec<Row> {
    let palette = theme.palette;
    let mut rows = Vec::new();
    if !reasoning.is_empty() {
        // Thinking streams as one muted header line the TS transcript shows: a
        // spinner naming where the thought is heading, never the run of text
        // itself, which would tile the screen with everything it produced.
        let frame = SPINNER_FRAMES[(now_ms / 160) as usize % SPINNER_FRAMES.len()];
        let summary = fit(&reasoning_summary(reasoning), COMPACT_CELLS);
        let label = if summary.is_empty() {
            "Thinking".to_string()
        } else {
            format!("Thinking · {summary}")
        };
        rows.push(Row::clipped(Line::from(Span::styled(
            format!("{frame} {label}"),
            Style::new().fg(palette.text_muted),
        ))));
    }
    if !text.is_empty() {
        rows.extend(prose_lines(text, theme));
    }
    rows
}

fn transcript_lines(
    transcript: &Transcript,
    theme: &Theme,
    expanded: bool,
    toggle: Option<&str>,
) -> Projected {
    let palette = theme.palette;
    let mut rows = Vec::new();
    let mut anchors: Vec<(usize, String)> = Vec::new();
    // The TS scrollbox opens with one blank row above the oldest message.
    rows.push(Row::plain(Line::default()));
    // Whether the previous assistant part rendered as a single inline row. TS
    // butts consecutive single-row tools together and separates everything
    // else with one blank row.
    let mut inline_run = false;
    for entry in &transcript.entries {
        match entry {
            Entry::User { text, .. } => {
                inline_run = false;
                // The TS prompt block: two blank rows above, then a left-edged
                // panel with one row of padding above and below the text. The
                // panel background rides each row so the band reads as one
                // block once `wrap_rows` pads it to the pane's width. The
                // edge takes the agent's color slot (the TS default palette
                // rotation starts at `secondary`), and the `❯` marker only
                // leads the first row: wrapped and multi-line continuations
                // start at the marker column without repeating it.
                let surface = Style::new().bg(palette.surface);
                let edge = Style::new().fg(palette.secondary);
                let marker = Style::new().fg(palette.text_muted);
                let text_style = Style::new().fg(palette.text);
                rows.push(Row::plain(Line::default()));
                rows.push(Row::plain(Line::default()));
                rows.push(Row::clipped(
                    Line::from(vec![Span::styled("┃", edge), Span::styled("  ", surface)])
                        .style(surface),
                ));
                anchors.push((
                    rows.len(),
                    text.lines().next().unwrap_or_default().to_string(),
                ));
                for (index, line) in text.lines().enumerate() {
                    let mut spans = vec![Span::styled("┃", edge), Span::styled("  ", surface)];
                    if index == 0 {
                        spans.push(Span::styled("❯ ", marker));
                    } else {
                        spans.push(Span::styled("  ", marker));
                    }
                    spans.push(Span::styled(line.to_string(), text_style));
                    // The five prefix cells (edge, panel padding, marker) stay
                    // fixed while the prompt text wraps inside the panel; the
                    // `┃` edge is structural and repeats on continuations, the
                    // marker is not.
                    rows.push(Row::hung_with_edge(Line::from(spans).style(surface), 5, 1));
                }
                rows.push(Row::clipped(
                    Line::from(vec![Span::styled("┃", edge), Span::styled("  ", surface)])
                        .style(surface),
                ));
            }
            Entry::Context { source, text } => {
                // Injected context is a history fact, not something the operator
                // said. Painting it behind `❯` claimed it as input and put words
                // in their mouth; a quiet labelled block keeps the facts
                // readable without changing who said what.
                inline_run = false;
                rows.push(Row::plain(Line::default()));
                rows.push(Row::plain(Line::from(vec![
                    Span::styled("⋯ ", Style::new().fg(palette.border)),
                    Span::styled(
                        format!("context · {source}"),
                        Style::new().fg(palette.text_muted),
                    ),
                ])));
                for line in text.lines() {
                    rows.push(Row::plain(Line::from(Span::styled(
                        format!("  {line}"),
                        Style::new().fg(palette.text_muted),
                    ))));
                }
            }
            Entry::Assistant {
                agent,
                model,
                parts,
            } => {
                for part in parts {
                    match part {
                        Part::Text(text) => {
                            // TS TextPart: one blank row above the bullet and
                            // its markdown block.
                            inline_run = false;
                            rows.push(Row::plain(Line::default()));
                            rows.extend(prose_lines(text, theme));
                        }
                        Part::Reasoning(reasoning) => {
                            // The TS default ("hide") keeps thinking out of the
                            // transcript once the step produced prose of its
                            // own; it keeps one duration header only when the
                            // step has no text, so a model that narrates
                            // between tool calls does not look like it never
                            // reasoned.
                            inline_run = false;
                            let has_prose = parts.iter().any(
                                |part| matches!(part, Part::Text(text) if !text.trim().is_empty()),
                            );
                            if !has_prose {
                                rows.push(Row::plain(Line::default()));
                                rows.push(Row::clipped(thought_header(reasoning, theme)));
                            }
                        }
                        Part::Tool(call) => {
                            let tool_rows = tool::lines(
                                call,
                                transcript.displays.get(&call.id).map(Vec::as_slice),
                                theme,
                                expanded,
                                toggle,
                            );
                            if tool_rows.len() > 1 || !inline_run {
                                rows.push(Row::plain(Line::default()));
                            }
                            inline_run = tool_rows.len() == 1;
                            // A tool row carries its own indentation: the
                            // header's `● ` bullet and the result's `  ⎿ `
                            // gutter. Folding such a row as plain text broke
                            // `  ⎿ Read 2 lines` across two rows with no
                            // indent, which is what made a narrow pane look
                            // like the text wrapped early. Hang each row under
                            // the cells it opens with.
                            rows.extend(tool_rows.into_iter().map(|line| {
                                let hang = leading_indent(&line);
                                Row::hung(line, hang)
                            }));
                        }
                    }
                }
                // The step footer the TS message ends with: the check names the
                // agent and the model that answered, and its blank row is the
                // seam between consecutive assistant messages.
                rows.push(Row::plain(Line::default()));
                let name = match (agent.as_deref(), model.as_deref()) {
                    (Some(agent), Some(model)) => format!("{} · {model}", titlecase(agent)),
                    (Some(agent), None) => titlecase(agent),
                    (None, Some(model)) => model.to_string(),
                    (None, None) => "assistant".to_string(),
                };
                rows.push(Row::hung(
                    Line::from(vec![
                        Span::styled("  ", Style::new()),
                        Span::styled("✓ ", Style::new().fg(palette.success)),
                        Span::styled(name, Style::new().fg(palette.text_muted)),
                    ]),
                    2,
                ));
            }
            Entry::Error { message } => {
                inline_run = false;
                rows.push(Row::plain(Line::default()));
                for (index, line) in message.lines().enumerate() {
                    rows.push(Row::plain(Line::from(vec![
                        Span::styled(
                            if index == 0 { "✗ " } else { "  " },
                            Style::new().fg(palette.error),
                        ),
                        Span::styled(line.to_string(), Style::new().fg(palette.error)),
                    ])));
                }
            }
        }
    }
    if rows.len() <= 1 {
        rows.push(Row::plain(Line::from(Span::styled(
            "this Session has no messages yet",
            Style::new().fg(palette.text_muted),
        ))));
    }
    Projected { rows, anchors }
}

/// Capitalize each word like the TS `Locale.titlecase` the footer and live
/// labels render through.
fn titlecase(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut boundary = true;
    for character in text.chars() {
        if boundary && character.is_alphanumeric() {
            out.extend(character.to_uppercase());
        } else {
            out.push(character);
        }
        boundary = !character.is_alphanumeric();
    }
    out
}

/// The transcript's painted rows plus where each operator prompt starts in
/// that row flow, so a scrolled-back viewport can name the question its top
/// row belongs to.
pub(crate) struct Projected {
    rows: Vec<Row>,
    /// `(first row of the prompt, its first line of text)`, in flow order.
    anchors: Vec<(usize, String)>,
}

/// Cap a single line of prose to `COMPACT_CELLS` display cells. Counting
/// characters let a CJK line twice the width through, and the widget then
/// clipped it mid-word.
fn compact(text: &str) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    fit(&single, COMPACT_CELLS)
}

/// How much of a compacted line survives: enough for a sentence, short of a
/// paragraph.
const COMPACT_CELLS: usize = 80;

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

pub fn render_status(frame: &mut Frame, area: Rect, status: &StatusStrip, theme: &Theme) {
    let palette = theme.palette;
    // The TS status line is one left-aligned row two cells in from the edge:
    // the run's hints first, then the model, then what the session has cost.
    // Nothing paints a surface behind it; the bar look was this pane's own.
    let muted = Style::new().fg(palette.text_muted);
    let mut spans: Vec<Span<'static>> = Vec::new();
    for hint in &status.hints {
        if !spans.is_empty() {
            spans.push(Span::styled(" · ", muted));
        }
        spans.push(Span::styled(
            match hint.warning {
                // A warning keeps its glyph, so it still reads on a monochrome
                // terminal; facts about the run carry the tone alone.
                true => format!("! {}", hint.text),
                false => hint.text.clone(),
            },
            match hint.warning {
                true => Style::new().fg(palette.warning),
                false => muted,
            },
        ));
    }
    if let Some(model) = &status.model {
        if !spans.is_empty() {
            spans.push(Span::styled(" · ", muted));
        }
        spans.push(Span::styled(model.clone(), Style::new().fg(palette.text)));
    }
    if let Some(usage) = &status.usage {
        if !spans.is_empty() {
            spans.push(Span::styled(" · ", muted));
        }
        spans.push(Span::styled(usage.clone(), muted));
    }
    if spans.is_empty() {
        return;
    }
    let area = Rect {
        x: area.x + 2,
        width: area.width.saturating_sub(2),
        ..area
    };
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// Input rows the composer grows to before it scrolls; the border and the
/// completion list live outside this budget.
const COMPOSER_INPUT_ROWS: usize = 8;
const COMPOSER_COMPLETION_ROWS: usize = 6;
/// Display cells the `!` shell marker occupies left of the input.
const SHELL_GUTTER: u16 = 2;

/// The examples an empty composer offers, the TS prompt's own list. One is
/// picked per mount and re-rolled when a Session opens, like the TS prompt.
const PLACEHOLDERS: [&str; 3] = [
    "Fix a TODO in the codebase",
    "What is the tech stack of this project?",
    "Fix broken tests",
];
const SHELL_PLACEHOLDERS: [&str; 3] = ["ls -la", "git status", "pwd"];

/// The one-line band the TS prompt keeps between the transcript and the input:
/// what the run is doing, and anything the operator must know. The TS compact
/// row is a spinner frame plus the state text on the left and the elapsed time
/// right-aligned (`justifyContent: space-between`), so the elapsed value is
/// painted in [`render`] from `composer.phase_elapsed`, not folded into this
/// line.
fn composer_air(composer: &Composer, theme: &Theme) -> Line<'static> {
    let palette = theme.palette;
    let mut spans: Vec<Span<'static>> = Vec::new();
    let push = |spans: &mut Vec<Span<'static>>, text: String, style: Style| {
        if !spans.is_empty() {
            spans.push(Span::styled(" · ", Style::new().fg(palette.border)));
        }
        spans.push(Span::styled(text, style));
    };
    if let Some(phase) = &composer.phase {
        // Past half a minute of waiting the TS spinner turns warning-colored;
        // the frame carries that tone here.
        let alert = composer.phase_alert;
        let tone = match alert {
            true => palette.warning,
            false => palette.text_muted,
        };
        let frame = SPINNER_FRAMES[(now_ms() / 160) as usize % SPINNER_FRAMES.len()];
        push(
            &mut spans,
            format!("{frame} {phase}"),
            Style::new().fg(tone),
        );
    }
    if let Some(notice) = &composer.notice {
        push(&mut spans, notice.clone(), Style::new().fg(palette.warning));
    }
    if composer.mode() == Mode::Shell {
        push(
            &mut spans,
            "Shell · esc exit".to_string(),
            Style::new().fg(palette.warning),
        );
    }
    Line::from(spans)
}

/// The composer's height in rows, widened to the draft: a prompt that wraps or
/// has several lines is shown whole up to [`COMPOSER_INPUT_ROWS`], so an
/// operator can read what they are about to send instead of only the line the
/// cursor happens to sit on.
pub fn composer_height(composer: &Composer, width: u16) -> u16 {
    let usable = width.saturating_sub(2).max(1) as usize;
    let input = composer
        .editor
        .display_rows(usable)
        .clamp(1, COMPOSER_INPUT_ROWS);
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
    // The landing composer is the Session composer, in the Session's column: the
    // band grows with the draft on both screens, so a fixed full width here was
    // never needed and made the input change shape between screens.
    render_composer(frame, area, composer, theme)
}

fn render_composer(frame: &mut Frame, area: Rect, composer: &Composer, theme: &Theme) {
    render_composer_in(frame, area, composer, theme, composer_column(area.width))
}

fn render_composer_in(
    frame: &mut Frame,
    area: Rect,
    composer: &Composer,
    theme: &Theme,
    column: u16,
) {
    let palette = theme.palette;
    let column = column.min(area.width);
    let area = Rect {
        x: area.x + area.width.saturating_sub(column) / 2,
        width: column,
        ..area
    };
    // Shell mode says so in colour: a `!` line goes to the host shell, not the
    // model, and Esc leaves it.
    let shell = composer.mode() == Mode::Shell;
    let accent = if shell {
        palette.warning
    } else {
        palette.primary
    };
    // The TS prompt is one rule above and below the input, an element
    // background, two cells of padding on each side, and no title.
    let set = ratatui::symbols::border::Set {
        horizontal_top: "─",
        horizontal_bottom: "─",
        ..ratatui::symbols::border::EMPTY
    };
    let block = Block::default()
        .borders(Borders::TOP | Borders::BOTTOM)
        .border_set(set)
        .border_style(Style::new().fg(if shell {
            palette.warning
        } else {
            palette.border
        }))
        .style(Style::new().bg(palette.element));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width <= 4 || inner.height == 0 {
        return;
    }
    let padded = Rect {
        x: inner.x + 2,
        width: inner.width - 4,
        ..inner
    };

    let completion_rows = composer
        .completion
        .items
        .len()
        .min(COMPOSER_COMPLETION_ROWS) as u16;
    let input_rows = Rect {
        height: padded.height.saturating_sub(completion_rows),
        ..padded
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
    // The selection is painted in the accent on the composer's own background,
    // so the text stays readable while the covered cells read as chosen.
    let selection_style = Style::new().fg(palette.background).bg(accent);
    let selection_cells = composer.editor.selection_cells();
    if composer.editor.is_empty() && composer.completion.items.is_empty() {
        // An empty composer offers the example the TS prompt cycles through:
        // one quiet sentence, `Run a command…` on a `!` line. The pick is the
        // stored per-mount roll, not a clock drift, so the example stays put
        // the way the TS one does between Session changes.
        let examples: &[&str] = if shell {
            &SHELL_PLACEHOLDERS
        } else {
            &PLACEHOLDERS
        };
        let verb = if shell {
            "Run a command…"
        } else {
            "Ask anything…"
        };
        let example = examples[composer.placeholder % examples.len()];
        frame.render_widget(
            Paragraph::new(Span::styled(
                format!("{verb} \u{201c}{example}\u{201d}"),
                Style::new().fg(palette.text_muted),
            )),
            input_area,
        );
    } else {
        let lines = composer
            .editor
            .lines()
            .enumerate()
            .skip(row_offset)
            .take(input_area.height as usize)
            .map(|(index, line)| {
                let selection = selection_cells
                    .iter()
                    .find(|(line_index, _, _)| *line_index == index)
                    .map(|(_, start, end)| (*start, *end));
                composer_line(
                    &line,
                    cell_offset,
                    input_area.width,
                    selection,
                    Style::new().fg(text_color),
                    selection_style,
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), input_area);
    }

    let cursor_row = cursor_line - row_offset;
    let cursor_column = cursor_cell - cell_offset;
    if cursor_row < input_area.height as usize && cursor_column < input_area.width as usize {
        frame.set_cursor_position(Position::new(
            input_area.x + cursor_column as u16,
            input_area.y + cursor_row as u16,
        ));
    }

    let completion_area = Rect {
        y: padded.y + input_rows.height,
        height: completion_rows,
        ..padded
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
fn fit(text: &str, width: usize) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if UnicodeWidthStr::width(single.as_str()) <= width {
        return single;
    }
    let room = width.saturating_sub(1) as u16;
    format!("{}…", clip_cells(&single, 0, room))
}

/// One composer line as spans, with the selected cells carrying the highlight.
/// Clipping and scrolling happen on display cells, exactly as they do for the
/// cursor, so a selection over CJK text covers the width the terminal shows and
/// the horizontal offset stays consistent with the caret.
fn composer_line(
    line: &str,
    offset: usize,
    width: u16,
    selection: Option<(usize, usize)>,
    text: ratatui::style::Style,
    highlighted: ratatui::style::Style,
) -> ratatui::text::Line<'static> {
    let limit = width as usize;
    let mut spans: Vec<ratatui::text::Span<'static>> = Vec::new();
    let mut current = String::new();
    let mut current_highlighted = false;
    let mut cell = 0usize;
    for c in line.chars() {
        let cells = UnicodeWidthChar::width(c).unwrap_or(0);
        if cell < offset {
            cell += cells;
            continue;
        }
        if cell + cells > offset + limit {
            break;
        }
        let highlighted_cell = selection.is_some_and(|(start, end)| cell >= start && cell < end);
        if highlighted_cell != current_highlighted && !current.is_empty() {
            let style = if current_highlighted {
                highlighted
            } else {
                text
            };
            spans.push(ratatui::text::Span::styled(
                std::mem::take(&mut current),
                style,
            ));
        }
        current_highlighted = highlighted_cell;
        current.push(c);
        cell += cells;
    }
    if !current.is_empty() {
        let style = if current_highlighted {
            highlighted
        } else {
            text
        };
        spans.push(ratatui::text::Span::styled(current, style));
    }
    if spans.is_empty() {
        spans.push(ratatui::text::Span::styled(String::new(), text));
    }
    ratatui::text::Line::from(spans)
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
        // A single hairline, the way the TypeScript layout separates this column
        // from the transcript: no frame around it, but the edge is visible.
        let outer = area;
        let edge = Block::new()
            .borders(Borders::LEFT)
            .border_style(Style::new().fg(palette.text_muted));
        let area = edge.inner(outer);
        frame.render_widget(edge, outer);
        // The column never wraps, so a title or path longer than it is cut with
        // an ellipsis instead of pushing the rest of the column down.
        let text_width = area.width as usize;
        let mut lines = match &self.session {
            None => vec![Line::from(Span::styled(
                "no Session selected",
                Style::new().fg(palette.text_muted),
            ))],
            Some(session) => vec![
                Line::from(Span::styled(
                    fit(session.label(), text_width),
                    Style::new().fg(palette.text).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    fit(&session.directory.clone().unwrap_or_default(), text_width),
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
                "▾ Context",
                Style::new().fg(palette.text_muted),
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
                        format!(
                            "in {}  ·  out {}",
                            crate::status::compact_tokens(usage.input_tokens),
                            crate::status::compact_tokens(usage.output_tokens)
                        ),
                        Style::new().fg(palette.text_muted),
                    )));
                    lines.push(Line::from(Span::styled(
                        format!(
                            "cache {}  ·  turns {}",
                            crate::status::compact_tokens(usage.cache_read_tokens),
                            usage.turns
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
                                crate::status::compact_tokens(usage.subagent_input_tokens),
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
                                crate::status::compact_tokens(usage.auxiliary_input_tokens),
                                crate::status::compact_tokens(usage.auxiliary_output_tokens),
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
                // The status word is the one thing here that can need the
                // operator, so it keeps colour only when it does.
                let goal_style = match goal.status.as_str() {
                    "blocked" => Style::new().fg(palette.warning),
                    "done" => Style::new().fg(palette.success),
                    _ => Style::new().fg(palette.text_muted),
                };
                lines.push(Line::from(Span::styled(
                    format!("▾ Goal · {}", goal.status),
                    goal_style,
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
            lines.push(Line::from(Span::styled(
                format!("▾ Todo {done}/{}", self.todos.len()),
                Style::new().fg(palette.text_muted),
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
                // The glyph takes two cells, so the text gets the rest of the
                // row measured the way the terminal draws it.
                let text = fit(&todo.content, width.saturating_sub(2));
                // The text stays at the muted weight the transcript uses for
                // tool output, so the sidebar reads as a summary rather than
                // competing with the conversation for attention.
                lines.push(Line::from(vec![
                    Span::styled(glyph, style),
                    Span::styled(text, Style::new().fg(palette.text_muted)),
                ]));
            }
        }
        // No wrapping: a long title or todo would otherwise split into several
        // rows, pushing the rest of the column off the screen and reading as one
        // character per line for CJK.
        frame.render_widget(
            Paragraph::new(lines).style(Style::new().bg(palette.background)),
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
    // The changes dialog renders its own body: the generic list, palette and
    // input accessors below do not describe a change set, so without this arm
    // the box is drawn with a title and an empty body.
    if let Dialog::WorkspaceChanges(changes) = dialog {
        changes.render(frame, inner, theme);
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
    // A filterable list carries a type-ahead row, and a Session list arms the
    // same filter through `/`; either way the line shows what has been typed so
    // the reviewer can see why rows disappeared. The dialog decides, so the
    // keyboard and the paint cannot disagree about whether typing filters.
    let filtered = list.shows_filter();
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
                // A provider header reads as a section label: muted weight, no
                // marker, and no selection band (the cursor never rests on it).
                if row.is_header() {
                    return Line::from(Span::styled(
                        row.label.clone(),
                        Style::new()
                            .fg(palette.secondary)
                            .add_modifier(Modifier::BOLD),
                    ));
                }
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

fn relative_time(updated_at_ms: u64) -> String {
    relative_time_at(updated_at_ms, now_ms())
}
#[cfg(test)]
mod tests {

    #[test]
    fn a_scrolled_back_viewport_names_the_question_it_belongs_to() {
        let workspace = std::path::Path::new("/tmp/pane-test");
        let mut shell = Shell::new(workspace, home_theme());
        let transcript = Transcript {
            entries: vec![
                Entry::User {
                    text: "first question about the parser".into(),
                    seq: 1,
                },
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![Part::Text("answer one. ".repeat(20).trim_end().into())],
                },
                Entry::User {
                    text: "second question".into(),
                    seq: 2,
                },
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![Part::Text("answer two. ".repeat(20).trim_end().into())],
                },
            ],
            ..Transcript::default()
        };
        shell.set_transcript(&transcript);
        // One frame fixes the viewport height, so the scroll offset that
        // follows is measured against the real tail.
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        // Scroll back a few rows from the tail: the viewport now sits inside
        // the second turn, whose question is off-screen above it.
        shell.scroll_transcript(-8);
        assert!(!shell.following(), "a manual scroll reads history");
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        let rows: Vec<String> = (0..12)
            .map(|y| {
                (0..60)
                    .map(|x| {
                        terminal
                            .backend()
                            .buffer()
                            .cell(ratatui::prelude::Position::new(x, y))
                            .map(|cell| cell.symbol().to_string())
                            .unwrap_or_default()
                    })
                    .collect::<String>()
            })
            .collect();
        let top = rows[0].trim_end().to_string();
        assert!(
            top.trim_start().starts_with('❯') && top.contains("first question"),
            "the sticky header names the owning prompt: {top:?}"
        );
        // At the tail the transcript follows again, and the marker is gone.
        shell.follow_transcript();
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        let top = (0..60)
            .map(|x| {
                terminal
                    .backend()
                    .buffer()
                    .cell(ratatui::prelude::Position::new(x, 0))
                    .map(|cell| cell.symbol().to_string())
                    .unwrap_or_default()
            })
            .collect::<String>();
        assert!(
            !top.contains("first question"),
            "a following viewport shows no marker: {top:?}"
        );
    }
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
        let goal = text.find("▾ Goal · active").expect("goal header");
        let objective = text.find("ship the offset reporting").expect("objective");
        let budget = text.find("budget · two hours").expect("budget");
        let todos = text.find("▾ Todo 1/1").expect("todo header");
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
    fn the_decision_panels_fit_forty_columns() {
        // UX-03: approval and questions are decision surfaces. At 40 columns
        // the operator still has to see what is being asked and what the keys
        // do, not a clipped fragment of it.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let approval = crate::session::ApprovalView {
            request_id: "run-1/call_1".into(),
            tool: "bash".into(),
            resource: "cargo test".into(),
            input: serde_json::json!({ "command": "cargo test" }),
            input_hash: "a".repeat(64),
            policy_revision: "rev-1".into(),
            matcher: None,
            expires_at_ms: None,
        };
        for width in [40u16, 80, 120] {
            let mut panel = Panel::approval(approval.clone());
            let text = rendered_at(&mut panel, width, &theme);
            assert!(
                text.contains("bash"),
                "the tool is named at {width}: {text}"
            );
            assert!(
                text.contains("allow once"),
                "the keys are readable at {width}: {text}"
            );

            let mut panel = Panel::question(question(false));
            let text = rendered_at(&mut panel, width, &theme);
            assert!(
                text.contains("Which files?"),
                "the question is readable at {width}: {text}"
            );
            assert!(
                text.contains("src"),
                "the options are readable at {width}: {text}"
            );
        }
    }

    /// Paint one panel at `width` columns and return everything it drew.
    fn rendered_at(panel: &mut Panel, width: u16, theme: &Theme) -> String {
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 12))
            .expect("terminal");
        terminal
            .draw(|frame| panel.render(frame, frame.area(), theme))
            .expect("draw");
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
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

    #[test]
    fn a_status_warning_reads_without_colour() {
        // UX-03: state may not depend on colour alone. A hint that waits on the
        // operator carries a glyph, so it still reads on a monochrome terminal
        // or in a low-colour profile. The TS order keeps the hints at the left
        // of the row, ahead of the model.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let status = StatusStrip {
            model: Some("fake/model".into()),
            usage: None,
            hints: vec![
                StatusHint {
                    text: "approve or deny".into(),
                    warning: true,
                },
                StatusHint {
                    text: "ctrl+c to interrupt".into(),
                    warning: false,
                },
            ],
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 1)).expect("terminal");
        terminal
            .draw(|frame| render_status(frame, frame.area(), &status, &theme))
            .expect("draw");
        let painted = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(painted.contains("! approve or deny"), "{painted}");
        assert!(!painted.contains("! ctrl+c"), "{painted}");
        assert!(painted.contains("ctrl+c to interrupt"), "{painted}");
        let model = painted.find("fake/model").expect("the model is painted");
        let warning = painted.find("! approve").expect("the warning is painted");
        assert!(warning < model, "hints lead the row: {painted}");
    }

    /// One routable model paints its label. The 0.3.26 models dialog came up
    /// an empty box: whatever the catalog carried, the frame drew only the
    /// border, the filter row and the hint.
    #[test]
    fn the_models_dialog_paints_its_rows() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let models = crate::dialogs::ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "deepseek-v4-1-flash-261017"}
        ]));
        assert_eq!(models.len(), 1);
        let dialog = crate::dialogs::Dialog::models(&models, None);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).expect("terminal");
        terminal
            .draw(|frame| super::render_dialog(frame, frame.area(), &dialog, &theme))
            .expect("draw");
        let painted = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol().to_string())
            .collect::<String>();
        assert!(
            painted.contains("deepseek-v4-1-flash-261017"),
            "the model label paints: {painted}"
        );
        assert!(!painted.contains("nothing to show"), "{painted}");
    }

    /// An empty composer hints at what it accepts, the way the agent CLIs do;
    /// a draft replaces the hint instead of stacking on it.
    #[test]
    fn an_empty_composer_hints_at_the_completions() {
        let theme = home_theme();
        let composer = crate::editor::Composer::new(Path::new("."));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 6)).expect("terminal");
        terminal
            .draw(|frame| {
                super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                )
            })
            .expect("draw");
        let painted = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol().to_string())
            .collect::<String>();
        assert!(painted.contains("Ask anything"), "{painted}");

        let mut composer = crate::editor::Composer::new(Path::new("."));
        composer.editor.insert_str("hello");
        terminal
            .draw(|frame| {
                super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                )
            })
            .expect("draw");
        let painted = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol().to_string())
            .collect::<String>();
        assert!(painted.contains("hello"), "{painted}");
        assert!(!painted.contains("Ask anything"), "{painted}");
    }

    /// Context the engine injected is a history note. Painting it behind the
    /// prompt marker claimed the operator typed words they never wrote.
    #[test]
    fn injected_context_renders_as_a_note_not_a_prompt() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let transcript = Transcript {
            entries: vec![Entry::Context {
                source: "engine".into(),
                text: "Task paused: no todo moved.".into(),
            }],
            ..Transcript::default()
        };
        let painted =
            wrapped_text(&transcript_lines(&transcript, &theme, false, None).rows).join("\n");
        assert!(painted.contains("context · engine"), "{painted}");
        assert!(painted.contains("Task paused: no todo moved."), "{painted}");
        assert!(
            !painted.contains('❯'),
            "injected context is not a prompt: {painted}"
        );
        assert!(!painted.contains("<injected-context"), "{painted}");
    }

    fn wrapped_text(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|row| {
                row.line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn line_texts(lines: &[Line<'static>]) -> Vec<String> {
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

    fn row_text(row: &Row) -> String {
        row.line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn wrapped_rows_break_on_the_last_blank() {
        let rows = wrap_lines(&[Line::from("hello world again")], 10);
        assert_eq!(line_texts(&rows), vec!["hello ", "world ", "again"]);
    }

    #[test]
    fn a_word_longer_than_the_row_is_cut_at_the_edge() {
        let rows = wrap_lines(&[Line::from("abcdefghijkl")], 10);
        assert_eq!(line_texts(&rows), vec!["abcdefghij", "kl"]);
    }

    #[test]
    fn a_wide_character_never_straddles_a_row() {
        let rows = wrap_lines(&[Line::from("中文字符")], 5);
        assert_eq!(line_texts(&rows), vec!["中文", "字符"]);
    }

    #[test]
    fn wrapped_rows_keep_the_span_styles() {
        let line = Line::from(vec![
            Span::styled("plain ", Style::new().fg(ratatui::style::Color::Red)),
            Span::styled("tail", Style::new().fg(ratatui::style::Color::Blue)),
        ]);
        let rows = wrap_lines(&[line], 7);
        assert_eq!(line_texts(&rows), vec!["plain ", "tail"]);
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
            .map(|row| {
                row.line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(draft.contains("Thinking · considering"), "{draft}");
        assert!(draft.contains("streamed words"));
        // A projection, or a run that ends, clears it in one assignment.
        shell.set_draft("", "");
        assert!(shell.draft().is_empty());
    }

    #[test]
    fn the_draft_names_the_thinking_in_one_muted_header() {
        // The TS transcript shows thinking as one header line while it streams
        // and keeps that line once the answer starts; the reasoning text itself
        // never tiles the screen.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft("", "reading the diff\nthen the tests");
        let draft = shell
            .draft()
            .iter()
            .map(|row| {
                row.line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(draft.matches("reading the diff").count(), 1, "{draft}");
        assert!(draft.contains("Thinking · reading the diff"), "{draft}");
        // The first answer token keeps the header and starts the prose.
        shell.set_draft("partial", "reading the diff\nthen the tests");
        let draft = shell
            .draft()
            .iter()
            .map(|row| {
                row.line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(draft.contains("Thinking · reading the diff"), "{draft}");
        assert!(draft.contains("● partial"), "{draft}");
    }

    #[test]
    fn the_prompt_block_mirrors_the_typescript_panel() {
        // packages/tui renders each prompt as a left-edged panel with two blank
        // rows above it and one row of padding inside; the background band runs
        // the full row width once the pane pads it.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let transcript = Transcript {
            entries: vec![
                Entry::User {
                    text: "question".into(),
                    seq: 1,
                },
                Entry::Assistant {
                    agent: Some("general".into()),
                    model: Some("glm-5".into()),
                    parts: vec![Part::Text("answer".into())],
                },
            ],
            ..Transcript::default()
        };
        let lines = transcript_lines(&transcript, &theme, false, None).rows;
        let text = row_text;
        assert_eq!(text(&lines[0]), "", "the scrollbox opens with a blank row");
        assert_eq!(text(&lines[1]), "");
        assert_eq!(text(&lines[2]), "");
        assert_eq!(text(&lines[3]), "┃  ", "the panel's top padding row");
        assert_eq!(text(&lines[4]), "┃  ❯ question");
        assert_eq!(text(&lines[5]), "┃  ", "the panel's bottom padding row");
        assert_eq!(lines[4].line.style.bg, Some(palette.surface));
        // Prose follows one blank row in, under a muted bullet, and the step
        // closes with the check footer naming the agent and the model.
        assert_eq!(text(&lines[6]), "");
        assert!(
            text(&lines[7]).starts_with("● answer"),
            "{:?}",
            text(&lines[7])
        );
        assert_eq!(text(&lines[8]), "");
        assert_eq!(text(&lines[9]), "  ✓ General · glm-5");
    }

    #[test]
    fn consecutive_inline_tools_butt_together_like_the_typescript_rows() {
        // Two single-row tools read as one list; prose reopens the gap the way
        // the TS sibling margin does.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let tool = |id: &str, name: &str, input: serde_json::Value| crate::session::ToolPart {
            id: id.into(),
            name: name.into(),
            input,
            output: None,
            failed: false,
        };
        let transcript = Transcript {
            entries: vec![Entry::Assistant {
                agent: None,
                model: None,
                parts: vec![
                    Part::Tool(tool(
                        "c1",
                        "webfetch",
                        serde_json::json!({"url": "http://a"}),
                    )),
                    Part::Tool(tool("c2", "websearch", serde_json::json!({"query": "q"}))),
                    Part::Text("note".into()),
                    Part::Tool(tool(
                        "c3",
                        "webfetch",
                        serde_json::json!({"url": "http://b"}),
                    )),
                ],
            }],
            ..Transcript::default()
        };
        let lines = transcript_lines(&transcript, &theme, false, None).rows;
        let rendered = wrapped_text(&lines);
        let fetch_a = rendered
            .iter()
            .position(|line| line.contains("http://a"))
            .expect("first fetch");
        assert_eq!(
            rendered[fetch_a + 1],
            "● WebSearch  q",
            "the second inline row follows with no blank row"
        );
        let note = rendered
            .iter()
            .position(|line| line.contains("note"))
            .expect("prose");
        assert_eq!(rendered[note - 1], "", "prose opens with a blank row");
        assert_eq!(
            rendered[note + 1],
            "",
            "and leaves one before the next tool"
        );
        assert!(rendered[note + 2].contains("http://b"));
    }

    #[test]
    fn the_composer_air_names_the_run_the_queue_and_notices() {
        // The band above the input is the TS prompt's compact activity line:
        // what the run is doing, what is waiting, and anything the operator
        // must know, and nothing when there is none of those.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut composer = crate::editor::Composer::new(Path::new("."));
        assert!(
            composer_air(&composer, &theme).spans.is_empty(),
            "an idle session paints no band"
        );
        composer.phase = Some("running bash · 3s".into());
        composer.queued = 2;
        let text: String = composer_air(&composer, &theme)
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(text.contains("running bash · 3s"), "{text}");
    }

    #[test]
    fn the_status_strip_carries_the_queued_count_like_the_typescript_hints() {
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut status = StatusStrip {
            model: Some("glm-5".into()),
            ..StatusStrip::default()
        };
        status.hints.push(StatusHint {
            text: "queued (2)".to_string(),
            warning: false,
        });
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 1)).expect("terminal");
        terminal
            .draw(|frame| render_status(frame, frame.area(), &status, &theme))
            .expect("draw");
        let text: String = (0..80)
            .map(|x| {
                terminal
                    .backend()
                    .buffer()
                    .cell(ratatui::prelude::Position::new(x, 0))
                    .map(|cell| cell.symbol().to_string())
                    .unwrap_or_default()
            })
            .collect();
        assert!(text.contains("queued (2)"), "{text}");
        assert!(text.contains("glm-5"), "{text}");
    }

    #[test]
    fn a_running_tool_rides_the_tail_as_one_spinner_row() {
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
                Entry::User {
                    text: "question".into(),
                    seq: 1,
                },
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![Part::Text("answer. ".repeat(30).trim_end().into())],
                },
            ],
            ..Transcript::default()
        };
        shell.set_transcript(&transcript);
        shell.set_running_tool(Some("bash".into()));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        let text = |terminal: &ratatui::Terminal<ratatui::backend::TestBackend>| {
            (0..12)
                .map(|y| {
                    (0..60)
                        .map(|x| {
                            terminal
                                .backend()
                                .buffer()
                                .cell(ratatui::prelude::Position::new(x, y))
                                .map(|cell| cell.symbol().to_string())
                                .unwrap_or_default()
                        })
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        };
        let rows = text(&terminal);
        assert!(
            rows.iter().any(|row| row.contains("running bash")),
            "{rows:?}"
        );
        // Scrolling back detaches from the tail, and the row belongs to the
        // tail: history keeps the rows the run has already produced.
        shell.scroll_transcript(-5);
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        assert!(
            !text(&terminal)
                .iter()
                .any(|row| row.contains("running bash")),
            "{:?}",
            text(&terminal)
        );
    }

    #[test]
    fn thinking_folds_away_once_the_step_has_prose() {
        // The TS default ("hide") drops reasoning that produced prose; a step
        // with no text keeps one duration header so a model that narrates
        // between tools still reads as having thought.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let reasoning = Part::Reasoning(crate::session::Reasoning {
            text: "**Plan**\n\nread the files first".into(),
            created_ms: Some(1_000),
            completed_ms: Some(4_200),
        });
        let rendered = |parts: Vec<Part>| {
            transcript_lines(
                &Transcript {
                    entries: vec![Entry::Assistant {
                        agent: None,
                        model: None,
                        parts,
                    }],
                    ..Transcript::default()
                },
                &theme,
                false,
                None,
            )
            .rows
            .iter()
            .map(|row| {
                row.line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
        };
        let with_prose = rendered(vec![reasoning.clone(), Part::Text("the answer".into())]);
        assert!(
            with_prose
                .iter()
                .all(|line| !line.contains("Thought") && !line.contains("Plan")),
            "{with_prose:?}"
        );
        let without_prose = rendered(vec![reasoning]);
        let header = without_prose
            .iter()
            .find(|line| line.contains("Plan"))
            .expect("the step without prose keeps its thinking header");
        assert!(header.contains("Thought for 3.2s"), "{header}");
    }

    #[test]
    fn a_reasoning_summary_prefers_the_bold_title() {
        // OpenAI-style summaries open with a bolded title block; the header
        // names that instead of the body's first line.
        assert_eq!(
            reasoning_title("**Plan**\n\nbody"),
            Some("Plan".to_string())
        );
        assert_eq!(reasoning_title("not closed **"), None);
        assert_eq!(
            reasoning_summary("plain first line\nsecond"),
            "plain first line"
        );
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
        let lines = transcript_lines(&transcript, &theme, false, None).rows;
        assert_eq!(row_text(&lines[2]), "✗ provider unavailable");
        assert_eq!(lines[2].line.spans[0].style.fg, Some(theme.palette.error));
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
                        Part::Reasoning(crate::session::Reasoning {
                            text: "thinking".into(),
                            created_ms: None,
                            completed_ms: None,
                        }),
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

    #[test]
    fn the_status_line_lines_up_with_the_body() {
        // The TS status line starts two cells in from the edge, whatever the
        // body or the sidebar is doing beside it.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut shell = Shell::new(Path::new("."), theme);
        shell.status.model = Some("fake/model".into());
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(200, 20)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let area = buffer.area;
        let status = buffer
            .content
            .chunks(area.width as usize)
            .last()
            .expect("the status row");
        let first = status
            .iter()
            .position(|cell| !cell.symbol().trim().is_empty())
            .expect("the model is painted");
        assert_eq!(first, 2, "the row starts two cells in, as the TS one does");
        assert!(
            status
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("fake/model"),
            "and it is still painted"
        );
    }

    #[test]
    fn the_body_fills_the_window() {
        // The prose keeps everything the sidebar does not: a capped, centred
        // column left a band of empty cells on both sides of a wide terminal.
        let area = Rect::new(0, 0, 200, 20);
        let (prose, sidebar) = body_columns(area);
        let sidebar = sidebar.expect("wide enough for both");
        assert_eq!(prose.x, 0, "the prose starts at the window's edge");
        assert_eq!(prose.width, 200 - SIDEBAR_WIDTH - 1);
        assert_eq!(sidebar.width, SIDEBAR_WIDTH);
        assert_eq!(
            sidebar.x,
            prose.right() + 1,
            "one column of air between them"
        );
        assert_eq!(sidebar.right(), area.right(), "and it holds the right edge");
    }

    #[test]
    fn a_narrow_body_still_gives_the_sidebar_its_columns() {
        // Below the width that holds both with air between them, the sidebar
        // takes its columns from the right and the prose uses what is left.
        let area = Rect::new(0, 0, 120, 20);
        let (prose, sidebar) = body_columns(area);
        let sidebar = sidebar.expect("120 columns show it");
        assert_eq!(sidebar.x, prose.right() + 1);
        assert_eq!(sidebar.width, SIDEBAR_WIDTH);
        assert_eq!(prose.width, 120 - SIDEBAR_WIDTH - 1);
        // A body narrower than the threshold has no sidebar at all.
        let (prose, sidebar) = body_columns(Rect::new(0, 0, 99, 20));
        assert!(sidebar.is_none());
        assert_eq!(prose.width, 99);
    }

    #[test]
    fn a_wide_frame_paints_the_input_across_the_whole_window() {
        // The input covers the window width — the sidebar's bottom band
        // included — the way the TS layout draws it, instead of stopping at
        // the prose column and leaving that band looking cut off.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut shell = Shell::new(Path::new("."), theme);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(200, 20)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let rows = buffer.content.chunks(200).collect::<Vec<_>>();
        let placeholder = rows
            .iter()
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("Ask anything")
            })
            .expect("the composer is painted");
        // The rule above the placeholder spans the whole window: the composer
        // has no side borders to stop at.
        let top = &rows[placeholder - 1];
        assert_eq!(top[0].symbol(), "─", "the rule starts on the window's edge");
        assert_eq!(top[199].symbol(), "─", "and ends on the other edge");
    }

    /// The composer must start on the same column as the text it answers. It
    /// used to be centred over the window, so on any frame wide enough for the
    /// sidebar the input sat ~20 columns to the right of the transcript.
    #[test]
    fn the_input_starts_on_the_transcripts_column() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut shell = Shell::new(Path::new("."), theme);
        shell.set_transcript(&Transcript {
            entries: vec![Entry::User {
                text: "hello".into(),
                seq: 1,
            }],
            ..Transcript::default()
        });
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(200, 24)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let rows = buffer.content.chunks(200).collect::<Vec<_>>();
        let column_of = |needle: &str| {
            rows.iter()
                .find(|row| {
                    row.iter()
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains(needle)
                })
                .map(|row| {
                    row.iter()
                        .position(|cell| cell.symbol() != " ")
                        .expect("a painted cell")
                })
                .expect("the row is painted")
        };
        // The composer's top rule spans the full window the way the TS prompt
        // border does, while the TS message column is inset one cell on each
        // side — so the transcript's `┃` edge sits one cell in from the rule.
        let input = column_of("─");
        let prose = column_of("┃");
        assert_eq!(input, 0, "the composer rule hugs the window edge");
        assert_eq!(prose, 1, "the prompt edge is inset one cell");
    }

    #[test]
    fn a_wide_frame_keeps_the_transcript_at_a_readable_measure() {
        // A 200-column terminal should give the prose margins rather than
        // 200-column lines: the same rule the session list follows.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let mut shell = Shell::new(Path::new("."), theme);
        shell.set_transcript(&Transcript {
            entries: vec![Entry::User {
                text: "a sentence long enough to need the whole measure of the column".into(),
                seq: 1,
            }],
            ..Transcript::default()
        });
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(200, 10)).expect("terminal");
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        // The transcript owns the whole area it is given: text may paint anywhere
        // in it, and nothing spills past its right edge.
        let buffer = terminal.backend().buffer();
        let painted = buffer
            .content
            .iter()
            .enumerate()
            .filter(|(_, cell)| cell.symbol() != " ")
            .map(|(index, _)| index % 200)
            .max()
            .expect("the sentence is painted");
        assert!(painted < 200, "the text stays inside the window");
        let painted = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(
            painted.contains("a sentence long enough"),
            "the text is still painted: {painted}"
        );
    }

    #[test]
    fn prose_wrap_continuations_keep_the_bullet_indent() {
        // The TS TextPart wraps its markdown inside a container indented under
        // the `● ` bullet: every wrapped row — first and continuation alike —
        // keeps the text inside the same width, and continuations start at the
        // bullet column, never at column zero.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let rows = wrap_rows(&prose_lines("word ".repeat(30).trim_end(), &theme), 30);
        assert!(rows.len() > 1, "the prose wraps: {:?}", line_texts(&rows));
        let painted = line_texts(&rows);
        assert!(painted[0].starts_with("● "), "{painted:?}");
        for row in &painted[1..] {
            // The two hanging cells are blank on continuations, so the text
            // starts at the bullet's text column rather than at column zero.
            assert!(
                row.starts_with("  "),
                "a continuation row hangs under the bullet column: {row:?}"
            );
        }
        // Every row keeps its text inside the container width: the bullet's
        // two cells plus the wrap budget, never the full row width.
        let body_width = 30 - 2;
        for row in &painted {
            let text: String = row.chars().skip(2).collect();
            let text = text.trim_end();
            assert!(
                UnicodeWidthStr::width(text) <= body_width,
                "row text exceeds the container budget: {row:?}"
            );
        }
    }

    #[test]
    fn a_long_prompt_wraps_under_the_panel_edge_without_repeating_the_marker() {
        // The TS prompt panel paints `❯ ` once, before the first row; wrapped
        // and multi-line continuations start at the marker column with the
        // panel edge and background intact.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let transcript = Transcript {
            entries: vec![Entry::User {
                text: "please check whether ".to_string()
                    + &"the build ".repeat(12)
                    + "is reproducible",
                seq: 1,
            }],
            ..Transcript::default()
        };
        let rows = transcript_lines(&transcript, &theme, false, None).rows;
        let wrapped = wrap_rows(&rows, 30);
        let painted = line_texts(&wrapped);
        let marker_rows = painted
            .iter()
            .filter(|row| row.contains("❯"))
            .collect::<Vec<_>>();
        assert_eq!(
            marker_rows.len(),
            1,
            "the ❯ marker leads exactly one row: {painted:?}"
        );
        let text_rows = painted
            .iter()
            .filter(|row| row.contains("build") || row.contains("please"))
            .collect::<Vec<_>>();
        assert!(text_rows.len() > 1, "the prompt wraps: {painted:?}");
        for row in &text_rows[1..] {
            assert!(
                row.starts_with("┃    "),
                "a continuation keeps the panel edge and marker column: {row:?}"
            );
        }
        // The panel background rides every row of the block, continuations
        // included.
        let surface_rows = wrapped
            .iter()
            .filter(|row| row.style.bg == Some(palette.surface))
            .count();
        assert!(
            surface_rows >= text_rows.len() + 2,
            "the whole panel band carries the surface: {painted:?}"
        );
    }

    #[test]
    fn the_thought_header_clips_instead_of_folding() {
        // TS ReasoningHeader is `wrapMode="none"`: a long summary is cut at the
        // row, never folded into a second line.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let reasoning = Part::Reasoning(crate::session::Reasoning {
            text: "a very long thought that will not fit".into(),
            created_ms: None,
            completed_ms: None,
        });
        let transcript = Transcript {
            entries: vec![Entry::Assistant {
                agent: None,
                model: None,
                parts: vec![reasoning],
            }],
            ..Transcript::default()
        };
        let rows = transcript_lines(&transcript, &theme, false, None).rows;
        let header = rows
            .iter()
            .find(|row| {
                row.line
                    .spans
                    .iter()
                    .any(|span| span.content.contains("Thought"))
            })
            .expect("the thought header is projected");
        assert!(!header.wrap, "the header clips, it never folds");
        let wrapped = wrap_rows(&rows, 20);
        assert_eq!(
            wrapped.len(),
            rows.len(),
            "clipping adds no rows: {:?}",
            line_texts(&wrapped)
        );
    }

    #[test]
    fn the_phase_row_right_aligns_the_elapsed_time_like_the_typescript_row() {
        // The TS compact activity row is space-between: state on the left,
        // elapsed on the right edge. The elapsed value is a separate slot, so
        // it is not folded into the state text.
        let palette = crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.composer.phase = Some("Waiting for model".into());
        shell.composer.phase_elapsed = Some("2.0s".into());
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let row_at = |y: u16| {
            (0..60)
                .map(|x| {
                    buffer
                        .cell(ratatui::prelude::Position::new(x, y))
                        .map(|cell| cell.symbol().to_string())
                        .unwrap_or_default()
                })
                .collect::<String>()
        };
        let air_row = (0..12)
            .map(row_at)
            .find(|row| row.contains("Waiting for model"))
            .expect("the phase row is painted");
        assert!(
            air_row.trim_end().ends_with("2.0s"),
            "the elapsed value hugs the right edge: {air_row:?}"
        );
    }

    fn question(multi: bool) -> QuestionView {
        QuestionView {
            question_id: "run-1/call_2".into(),
            input_hash: "b".repeat(64),
            expires_at_ms: None,
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

    /// The renderer marks exactly the selected cells, and clipping still works
    /// with wide characters and a horizontal offset.
    #[test]
    fn the_composer_line_highlights_only_the_selected_cells() {
        let text = Style::new().fg(ratatui::style::Color::Reset);
        let highlighted = Style::new().bg(ratatui::style::Color::Indexed(4));
        let line = composer_line("ab cd", 0, 10, Some((1, 3)), text, highlighted);
        let spans = line
            .spans
            .iter()
            .map(|span| (span.content.to_string(), span.style))
            .collect::<Vec<_>>();
        assert_eq!(spans.len(), 3, "before, selected, after: {spans:?}");
        assert_eq!(spans[0], ("a".to_string(), text));
        assert_eq!(spans[1].0, "b ");
        assert_eq!(spans[1].1, highlighted);
        assert_eq!(spans[2], ("cd".to_string(), text));

        // Two CJK characters are four cells: the selection covers both, and an
        // offset of one cell drops the first character entirely.
        let line = composer_line("你好世界", 0, 20, Some((0, 4)), text, highlighted);
        assert_eq!(line.spans.len(), 2);
        assert_eq!(line.spans[0].content.to_string(), "你好");
        let line = composer_line("你好世界", 2, 20, None, text, highlighted);
        assert_eq!(line.spans.len(), 1);
        assert_eq!(line.spans[0].content.to_string(), "好世界");
    }

    #[test]
    fn a_long_menu_is_cut_between_chords_not_inside_one() {
        // `fit` cuts at a cell, which turns `n session new` into `n session n…`
        // and teaches nothing. A menu drops whole chords instead and says how
        // many are left; the rest are one `/help` away.
        let menu = "ctrl+x · q app exit · n session new · g workspace changes · m models";
        for width in [24usize, 34, 44] {
            let narrow = fit_chords(menu, width);
            assert!(
                UnicodeWidthStr::width(narrow.as_str()) <= width,
                "{width} columns overflow: {narrow}"
            );
            let whole = menu.split(" · ").collect::<Vec<_>>();
            for part in narrow.split(" · ") {
                if part == "ctrl+x" || part.starts_with('…') {
                    continue;
                }
                assert!(
                    whole.contains(&part),
                    "{part:?} is half a chord in {narrow:?}"
                );
            }
        }
        // A menu that fits is painted as it is.
        assert_eq!(fit_chords("ctrl+x · q app exit", 40), "ctrl+x · q app exit");
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

    fn home_theme() -> Theme {
        Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        }
    }

    /// A long CJK title and a long CJK todo each stay on one row. Counting
    /// characters instead of cells let both through at twice the column's
    /// width, and the wrapping widget then broke them one character per line.
    #[test]
    fn a_long_cjk_sidebar_stays_on_one_row_per_line() {
        let mut sidebar = SidebarPane {
            theme: home_theme(),
            session: None,
            usage: None,
            goal: None,
            todos: Vec::new(),
        };
        let mut summary = home_row("ses_s", &"很长的会话标题".repeat(8), None);
        summary.directory = Some("/very/long/path\n".repeat(4));
        sidebar.session = Some(summary);
        sidebar.todos = vec![crate::session::TodoView {
            content: "很长的待办事项".repeat(8),
            status: "in_progress".into(),
        }];
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(30, 24)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(30)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let header = rows
            .iter()
            .position(|row| row.contains("Todo"))
            .expect("todo header");
        // The column's left border survives trimming, so a padding row still
        // reads as "│    "; only a row with content counts.
        let below = rows[header + 1..]
            .iter()
            .filter(|row| {
                !row.trim_matches(|c: char| c == '│' || c.is_whitespace())
                    .is_empty()
            })
            .collect::<Vec<_>>();
        assert_eq!(below.len(), 1, "one row per todo: {rows:#?}");
        assert!(
            below[0].contains('…'),
            "the todo is truncated: {:?}",
            below[0]
        );
        let title = rows
            .iter()
            .position(|row| row.contains('很'))
            .expect("title row");
        assert!(
            rows[title].contains('…'),
            "the title is truncated: {:?}",
            rows[title]
        );
    }

    fn home_row(id: &str, title: &str, preview: Option<&str>) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            title: Some(title.to_string()),
            parent_id: None,
            // Eight hours back keeps every row inside "Today" however long the
            // test machine has been up.
            updated_at_ms: Some(now_ms().saturating_sub(8 * 3_600_000)),
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: None,
            model: None,
            credential_id: None,
            preview: preview.map(str::to_string),
        }
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

    /// A wide glyph leaves its next cell as a continuation. Copying that cell
    /// put a space after every Chinese character, so a copied sentence read
    /// "无 失 败" instead of "无失败".
    #[test]
    fn a_drag_over_wide_glyphs_copies_them_without_gaps() {
        let inner = Rect::new(0, 0, 6, 1);
        // What the buffer holds for "无失败": each glyph, then its continuation.
        let row = ["无", " ", "失", " ", "败", " "]
            .iter()
            .map(|cell| cell.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            selection_text(&[row], inner, Position::new(0, 0), Position::new(5, 0)),
            "无失败"
        );
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
