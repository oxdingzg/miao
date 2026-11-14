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
use crate::editor::{CompletionKind, Composer, Editor, Mode};
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
    // The sidebar owns its rule, so its rectangle starts on the divider column
    // rather than one past it. Leaving that column to neither pane let it keep
    // the terminal's default background — a hairline of a different colour
    // running down the middle of the window, next to text on both sides.
    let split = area.width.saturating_sub(SIDEBAR_WIDTH);
    (
        Rect {
            x: area.x,
            width: split.saturating_sub(1),
            ..area
        },
        Some(Rect {
            x: area.x + split.saturating_sub(1),
            width: SIDEBAR_WIDTH + 1,
            ..area
        }),
    )
}

/// The sidebar's width, matching the TypeScript layout's `width={42}`.
///
/// One of those columns is the hairline this layout draws to separate the two
/// columns; the TypeScript sidebar has no rule and spends the column on
/// content instead, so the same number here gives one column less to read.
const SIDEBAR_WIDTH: u16 = 42;

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
    /// The chord that shows or hides `sidebar`, resolved from the same keymap.
    /// The column paints it as its own last row.
    sidebar_chord: Option<String>,
    /// Whether the operator hid the right column. The strip carries the chord
    /// while it is gone, so hiding it never strands the way back.
    sidebar_hidden: bool,
    /// Where the draft was painted last frame. A pointer inside these cells
    /// selects the composer's text instead of falling through to the transcript.
    composer_text: Option<ComposerText>,
    /// Which surface the pointer's drag belongs to, if one is in flight. The
    /// release copies that surface and no other.
    drag: Option<DragTarget>,
    /// The queued prompts as painted, so a drag can copy the row it covers.
    queued: PaintedCells,
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
                hover_rows: Vec::new(),
                changes: None,
                mode: None,
                theme,
                session: None,
                usage: None,
                usage_hourly: None,
                goal: None,
                plan: None,
                todos: Vec::new(),
                chord: None,
            }),
            last: None,
            toggle_chord: None,
            sidebar_chord: None,
            sidebar_hidden: false,
            composer_text: None,
            drag: None,
            queued: PaintedCells::default(),
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

    /// Name the chord that shows or hides the right column the way the
    /// operator's keymap spells it. The column paints it as its own last row,
    /// and the status strip takes it over while the column is hidden.
    pub fn set_sidebar_chord(&mut self, chord: Option<String>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.chord = chord.clone();
        }
        self.sidebar_chord = chord;
    }

    /// The chord the strip names while the column is hidden: `None` when the
    /// column is on screen, because then the column itself carries it.
    pub fn hidden_sidebar_chord(&self) -> Option<&str> {
        self.sidebar_hidden
            .then_some(self.sidebar_chord.as_deref())
            .flatten()
    }

    /// Whether the operator hid the right column.
    pub fn sidebar_hidden(&self) -> bool {
        self.sidebar_hidden
    }

    /// Show or hide the right column, returning whether it is now visible. The
    /// transcript takes the whole width while it is gone.
    pub fn toggle_sidebar(&mut self) -> bool {
        self.sidebar_hidden = !self.sidebar_hidden;
        !self.sidebar_hidden
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

    /// The operator cleared the Session's context: the painted rows go, one
    /// marker stays, and nothing stale re-enters until the next snapshot.
    pub fn clear_transcript(&mut self) {
        self.transcript.set_rows(vec![Row::plain(Line::from(
            "context cleared · the next prompt starts fresh",
        ))]);
        self.transcript.user_anchors = Vec::new();
        self.transcript.scroll = 0;
        self.transcript.follow = true;
        self.last = None;
    }

    /// Show what the model is streaming before its message commits. Empty
    /// strings clear it.
    pub fn set_draft(&mut self, parts: &[DraftPart]) {
        self.transcript.set_draft(parts);
    }

    /// Mirror the engine's un-promoted input queue into the transcript tail, so
    /// a submitted prompt is visible for exactly as long as it is queued.
    pub fn set_pending_prompts(&mut self, prompts: &[String]) {
        if self.transcript.pending_prompts == prompts {
            return;
        }
        self.transcript.pending_prompts = prompts.to_vec();
    }

    /// Whether a newer draft is waiting for its paint slot. The drive loop uses
    /// this to schedule the wake that `set_draft`'s throttle would otherwise
    /// leave unscheduled.
    pub fn draft_pending(&self) -> bool {
        self.transcript.draft_dirty
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

    /// A press inside the draft starts a text selection on it, the queued rows
    /// above it answer next, and anywhere else the press belongs to the
    /// transcript, so one gesture means one source.
    pub fn begin_selection(&mut self, position: Position) -> bool {
        if let Some(text) = self
            .composer_text
            .filter(|text| text.input.contains(position))
        {
            let offset = text.offset(&self.composer.editor, position);
            self.composer.editor.select_from(offset, offset);
            self.drag = Some(DragTarget::Composer);
            return true;
        }
        if self.queued.begin(position) {
            self.drag = Some(DragTarget::Queued);
            return true;
        }
        self.drag = self
            .transcript
            .begin_selection(position)
            .then_some(DragTarget::Transcript);
        self.drag.is_some()
    }

    /// Extend the drag on the surface the press named, so a drag that leaves
    /// the draft still covers the last line it crossed.
    pub fn update_selection(&mut self, position: Position) {
        match self.drag {
            Some(DragTarget::Composer) => {
                if let Some(text) = self.composer_text {
                    let offset = text.offset(&self.composer.editor, position);
                    self.composer.editor.select_to(offset);
                }
            }
            Some(DragTarget::Queued) => self.queued.update(position),
            Some(DragTarget::Transcript) => self.transcript.update_selection(position),
            None => {}
        }
    }

    /// Consume the selection, whichever surface owns it.
    pub fn take_selection(&mut self) -> Option<String> {
        match self.drag.take() {
            Some(DragTarget::Composer) => {
                let text = self.composer.editor.selected_text().map(str::to_string);
                self.composer.editor.clear_selection();
                text
            }
            Some(DragTarget::Queued) => self.queued.take(),
            Some(DragTarget::Transcript) => self.transcript.take_selection(),
            None => None,
        }
    }

    /// A double click: the word under the cell on the transcript. The draft
    /// keeps its drag-only selection, and a press outside the transcript stays
    /// the ordinary press it already was. The claimed surface owns the
    /// release, the way [`Self::begin_selection`] hands the drag over.
    pub fn select_word(&mut self, position: Position) -> bool {
        let selected = self.transcript.select_word_at(position);
        if selected {
            self.drag = Some(DragTarget::Transcript);
        }
        selected
    }

    /// The first transcript cell that starts a word, for a test aiming a
    /// double click at painted text.
    #[cfg(test)]
    pub fn transcript_word_cell(&self) -> Option<Position> {
        self.transcript.first_word_cell()
    }

    /// The painted transcript area, for a test aiming a press at the pane.
    #[cfg(test)]
    pub fn transcript_area(&self) -> Rect {
        self.transcript.area
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

    /// How far one page of transcript moves: the painted height less two rows
    /// of overlap, so the line read last stays on screen across the jump.
    pub fn transcript_page(&self) -> i32 {
        (self.transcript.area.height as i32 - 2).max(1)
    }

    /// Jump to the oldest row, the way `Home` reads. Going through
    /// `scroll_transcript` keeps the follow rule in one place: a transcript
    /// short enough to fit still counts as following.
    pub fn scroll_transcript_to_start(&mut self) {
        let scroll = self.transcript.scroll as i32;
        self.scroll_transcript(-scroll);
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

    /// The first cell of the draft as last painted, so a test can aim a drag at
    /// it instead of guessing where the box landed.
    #[cfg(test)]
    pub fn draft_cell(&self) -> Option<Position> {
        self.composer_text
            .map(|text| Position::new(text.input.x, text.input.y))
    }

    pub fn set_usage(&mut self, usage: Option<&crate::status::UsageSummary>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.usage = usage.cloned();
        }
    }

    pub fn set_usage_hourly(&mut self, usage: Option<&crate::status::HourlyUsage>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.usage_hourly = usage.cloned();
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

    /// Show the Session's pending plan in its own section: the Goal says why
    /// it exists, the plan says how it means to get there, and the checklist
    /// says what this turn is doing.
    pub fn set_plan(&mut self, plan: Option<&crate::session::PlanView>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.plan = plan.cloned();
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

    pub fn set_changes(&mut self, changes: Option<(usize, u64, u64)>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.changes = changes;
        }
    }

    pub fn set_mode(&mut self, mode: Option<&str>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.mode = mode.map(str::to_string);
        }
    }

    pub fn set_session(&mut self, session: Option<&SessionSummary>) {
        if let Some(sidebar) = self.sidebar.as_mut() {
            sidebar.session = session.cloned();
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let panel_height = self.panel.as_ref().map_or(0, Panel::height);
        // No air bands around the composer. The box draws its own rules above
        // and below, so a spare row on either side was a second gap for a
        // boundary the border already marks — three rows of dead space between
        // the transcript, the input, and the status strip on a short window.
        // The status strip is one row and sits straight under the box.
        // Prompts the engine still holds un-promoted sit straight above the
        // input: the queue depth in the title says how many, these rows say
        // what they are, where the operator typed them.
        let queued_height = queued_rows(&self.transcript.pending_prompts) as u16;
        let [body_area, panel_area, queued_area, composer_area, status_area] = Layout::vertical([
            Constraint::Min(1),
            Constraint::Length(panel_height),
            Constraint::Length(queued_height),
            Constraint::Length(composer_height(
                &self.composer,
                composer_column(frame.area().width),
                frame.area().height,
            )),
            Constraint::Length(1),
        ])
        .areas(frame.area());
        // A hidden column hands its width to the transcript instead of leaving
        // an empty band beside the text.
        let (transcript_area, sidebar_area) = match self.sidebar_hidden {
            true => (body_area, None),
            false => body_columns(body_area),
        };
        self.transcript.render(frame, transcript_area);
        if let (Some(sidebar), Some(sidebar_area)) = (self.sidebar.as_mut(), sidebar_area) {
            sidebar.render(frame, sidebar_area);
        }
        if let Some(panel) = self.panel.as_ref() {
            panel.render(frame, panel_area, &self.transcript.theme);
        }
        render_queued(
            frame,
            queued_area,
            &self.transcript.pending_prompts,
            &self.transcript.theme,
        );
        // The queued rows are read back so a drag copies the text it covered,
        // and the highlight lands on the same cells. Snapshotting refreshes the
        // cells only: the drag's anchor has to survive the frames drawn between
        // a press and its release. An empty queue keeps no cells, so a press on
        // the band falls through to the transcript.
        if self.transcript.pending_prompts.is_empty() {
            self.queued.clear();
        } else {
            self.queued.snapshot(frame, queued_area);
            self.queued.paint(frame);
        }
        // The input spans the whole window width, covering the sidebar's bottom
        // band the way the layout draws it: the sidebar's content ends high, and
        // a prose-width input left that band looking cut off.
        self.composer_text =
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
    draft_source: Option<Vec<DraftPart>>,
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
    /// What the operator typed that the engine still holds un-promoted, in
    /// admission order. The shell paints these as rows right above the input:
    /// while a busy turn holds an input in its queue the only signal used to be
    /// the "1 queued" count, which reads as a lost message.
    pending_prompts: Vec<String>,
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
pub(crate) const DRAFT_REFRESH: Duration = Duration::from_millis(50);

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
            pending_prompts: Vec::new(),
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
    fn set_draft(&mut self, parts: &[DraftPart]) {
        if parts.is_empty() {
            self.draft_source = None;
            self.draft.clear();
            self.draft_rows.clear();
            self.draft_dirty = false;
            self.draft_version += 1;
            return;
        }
        self.draft_source = Some(parts.to_vec());
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
        self.draft = draft_lines(
            self.draft_source.as_deref().unwrap_or(&[]),
            &self.theme,
            now_ms(),
        );
        self.draft_dirty = false;
        self.draft_built = Some(Instant::now());
        self.draft_version += 1;
    }
}

impl Pane for TranscriptPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        self.refresh_draft(false);
        // The transcript fills its column edge to edge: the composer below it
        // starts on the window's first column and the sidebar's rule sits on
        // this column's last one, so an inset here left the text floating
        // between two edges that the rows around it touch.
        let content = area;
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
        let draft_end = self.body.len() + self.draft_rows.len();
        let rows = draft_end;
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
            // This row never passes the wrapper that clips completed rows, so
            // it clips itself: a long in-flight call used to ride the tail
            // across the divider into the sidebar. "{frame} running " is ten
            // display cells.
            let label = fit(label, (content.width as usize).saturating_sub(10));
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
                    // A band pads in its own ink: a diff row's tint must stay
                    // the row's green or red all the way to the edge, not fade
                    // into the panel surface mid-block.
                    let ink = line.style.bg.unwrap_or(palette.surface);
                    line.spans
                        .push(Span::styled(" ".repeat(width - used), Style::new().bg(ink)));
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

/// One piece of the streaming answer, in the order the engine produced it.
///
/// A provider turn interleaves prose and tool calls; keeping them in separate
/// fields painted every call after every paragraph, which is not the order the
/// work happened in and is not the order the committed message will show.
#[derive(Debug, Clone)]
pub enum DraftPart {
    Reasoning(String),
    Text(String),
    Call { name: String, arguments: String },
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
fn tool_row_shape(line: &Line<'static>) -> (u16, u16) {
    // Every tool row is projected with a fixed prefix: `● ` for a header,
    // `  │ ` for a result body, `  ⎿ ` for a one-line summary. That prefix is
    // what continuations must stay inside — and the drawn part of it (`●`, `│`,
    // `⎿`) is structural, so it repeats instead of being blanked.
    //
    // Blanking it turned a wrapped command output into text starting at column
    // three with no gutter, which is the "all piled into one block" an operator
    // sees on a long line: the box edges vanished exactly on the rows that
    // needed them most.
    let Some(first) = line.spans.first() else {
        return (0, 0);
    };
    // Display cells, not chars: the gutter glyphs (`│`, `⎿`) are one cell each,
    // but counting them as chars is how a wide glyph shifted the prefix.
    let prefix = first.content.as_ref();
    let spaces = prefix.chars().take_while(|c| *c == ' ').count();
    if spaces == 0 {
        // `● ` — the two-cell marker column hangs, and the bullet repeats.
        return (2, 2);
    }
    // The whole prefix is drawn again on continuations: the leading blanks,
    // the gutter glyph, and the blank after it. Tool rows are projected as
    // `  │ <text>` / `  ⎿ <text>` (and `● <text>`), so the prefix is the
    // leading blank run plus exactly one glyph plus the blank following it.
    let leading = prefix.len() - prefix.trim_start().len();
    let rest = &prefix[leading..];
    let glyph = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(0);
    let after_glyph = &rest[glyph..];
    let separator = after_glyph.len() - after_glyph.trim_start().len();
    let hang = prefix[..leading + glyph + separator]
        .width()
        .min(u16::MAX as usize) as u16;
    (hang, hang)
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
        // `hang` is a display-cell width while `cells` holds one entry per
        // char, so a prefix measured across wide characters can ask for more
        // entries than the row carries; clamp so the slices below stay in
        // range instead of panicking on CJK-heavy rows.
        let hang = (row.hang as usize)
            .min(width.saturating_sub(1))
            .min(cells.len());
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
        if text.is_empty() {
            // The clamped prefix swallowed the whole row: keeping it beats
            // dropping it, which is what an empty chunk list would do.
            out.push(row_from(&cells, &row.line));
            continue;
        }
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

/// Split cells into chunks of at most `width` display cells, each ending where
/// [`row_end`] says the row may end.
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
        let end = row_end(cells, start, end, blank);
        chunks.push(&cells[start..end]);
        start = end;
    }
    chunks
}

/// Where a row filled to the width ends.
///
/// Filling the row is the ordinary break: CJK text has no word boundaries, so a
/// break between any two of its characters is normal typesetting. Ending every
/// row at its last blank instead measured Chinese prose against Latin word
/// wrapping, which stopped rows a tenth of their width short and left the tail
/// of a sentence (`自证。`) alone on a row of its own.
///
/// Two things still pull the row back: an ASCII run — an identifier, a path, a
/// flag — must never be cut in two, and closing punctuation must not open the
/// next row. Both fall back to the row's last blank, and when there is no blank
/// the punctuation moves down with the character it belongs to.
fn row_end(cells: &[(char, Style)], start: usize, end: usize, blank: Option<usize>) -> usize {
    if end >= cells.len() {
        return end;
    }
    let blank = blank.filter(|index| *index > start && *index < end);
    let splits = joins_word(cells[end - 1].0) && joins_word(cells[end].0);
    if splits || !opens_row(cells[end].0) {
        if let Some(index) = blank {
            return index;
        }
    }
    if splits {
        return end;
    }
    let pull_back = !opens_row(cells[end].0)
        && end > start + 1
        && cells[end - 1].0 != ' '
        && !joins_word(cells[end - 1].0);
    match pull_back {
        true => end - 1,
        false => end,
    }
}

/// The ASCII runs a break must keep whole: a word, a path, a flag, a number.
fn joins_word(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(
            character,
            '_' | '-' | '.' | '/' | '\\' | ':' | '@' | '+' | '=' | '~' | '%' | '#' | '&' | '?'
        )
}

/// Whether a row may open with this character. Closing punctuation never does:
/// Chinese typesetting keeps `。` and `）` with the character they belong to.
fn opens_row(character: char) -> bool {
    !matches!(
        character,
        '。' | '，'
            | '、'
            | '；'
            | '：'
            | '？'
            | '！'
            | '）'
            | '］'
            | '｝'
            | '」'
            | '』'
            | '】'
            | '》'
            | '〉'
            | '”'
            | '’'
            | '…'
            | '·'
            | '～'
    )
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
        // A click that never moved is not a selection. Press and release on the
        // same cell used to copy one character and announce "Copied 1
        // characters", which reads as the app grabbing whatever the pointer
        // happened to cover. Selecting a single cell deliberately is not a
        // gesture anyone performs; the click should do nothing.
        if a == b {
            return None;
        }
        if self.rendered.is_empty() {
            return None;
        }
        let text = selection_text(&self.rendered, self.area, a, b);
        (!text.is_empty()).then_some(text)
    }

    /// Select the word run under a cell, the double-click gesture. The run is
    /// what [`joins_word`] keeps whole, so `crates/tui` and `--flag` come out
    /// in one piece. A cell that starts no word — whitespace, most
    /// punctuation, a wide glyph — selects nothing and returns false, so the
    /// caller can treat the press as the ordinary click it is.
    pub fn select_word_at(&mut self, position: Position) -> bool {
        if !self.area.contains(position) || self.rendered.is_empty() {
            return false;
        }
        let Some(row) = self.rendered.get((position.y - self.area.y) as usize) else {
            return false;
        };
        let column = (position.x - self.area.x) as usize;
        let is_word = |index: usize| {
            row.get(index)
                .and_then(|symbol| symbol.chars().next())
                .is_some_and(joins_word)
        };
        if !is_word(column) {
            return false;
        }
        let start = (0..column).rev().find(|index| !is_word(*index));
        let end = (column..row.len()).find(|index| !is_word(*index));
        let start = start.map_or(0, |index| index + 1);
        let end = end.map_or(row.len() - 1, |index| index - 1);
        self.selection = Some((
            Position::new(self.area.x + start as u16, position.y),
            Position::new(self.area.x + end as u16, position.y),
        ));
        true
    }

    /// The first painted cell that starts a word, so a test can aim a double
    /// click at real text instead of guessing a coordinate.
    #[cfg(test)]
    pub fn first_word_cell(&self) -> Option<Position> {
        self.rendered.iter().enumerate().find_map(|(y, row)| {
            row.iter().enumerate().find_map(|(x, symbol)| {
                symbol
                    .chars()
                    .next()
                    .filter(|character| joins_word(*character))
                    .map(|_| Position::new(self.area.x + x as u16, self.area.y + y as u16))
            })
        })
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
    /// `prompt.max_width`: the TS home caps the landing prompt and leaves the
    /// Session's full width, so the cap lives here rather than on the composer.
    prompt_width: crate::config::PromptWidth,
    /// When the operator last typed, pasted or clicked. The idle light rests
    /// after a stretch of no input, the way the product's logo does, so a home
    /// screen left open stops repainting instead of running forever.
    last_input: Instant,
    /// Where the landing prompt painted its draft last frame, so a pointer
    /// inside it selects text the way the Session composer does.
    composer_text: Option<ComposerText>,
    /// A drag that began on the draft owns the selection until the button comes
    /// up, which is when its text is copied.
    composer_drag: bool,
    theme: Theme,
    /// Painted idle animation, like the landing banner's shimmer. Off leaves
    /// every surface static and the loop never wakes for a frame.
    animated: bool,
}

impl Home {
    pub fn new(theme: Theme) -> Self {
        Self {
            notice: None,
            warning: None,
            prompt_width: crate::config::PromptWidth::default(),
            last_input: Instant::now(),
            composer_text: None,
            composer_drag: false,
            theme,
            animated: true,
        }
    }

    /// Any keystroke, paste or click restarts the idle light.
    pub fn wake(&mut self) {
        self.last_input = Instant::now();
    }

    /// A press inside the landing prompt selects the draft's text. The composer
    /// belongs to the shell, so it is passed in rather than held here.
    pub fn begin_selection(&mut self, composer: &mut Composer, position: Position) -> bool {
        let Some(text) = self
            .composer_text
            .filter(|text| text.input.contains(position))
        else {
            return false;
        };
        let offset = text.offset(&composer.editor, position);
        composer.editor.select_from(offset, offset);
        self.composer_drag = true;
        true
    }

    pub fn update_selection(&mut self, composer: &mut Composer, position: Position) {
        if let (true, Some(text)) = (self.composer_drag, self.composer_text) {
            let offset = text.offset(&composer.editor, position);
            composer.editor.select_to(offset);
        }
    }

    /// Consume the drag's selection, which is what the release copies.
    pub fn take_selection(&mut self, composer: &mut Composer) -> Option<String> {
        if !self.composer_drag {
            return None;
        }
        self.composer_drag = false;
        let text = composer.editor.selected_text().map(str::to_string);
        composer.editor.clear_selection();
        text
    }

    /// Whether the banner still paints its sweep: on a colour terminal, and
    /// only while the screen has had input inside the product's rest window.
    pub fn shimmering(&self) -> bool {
        self.animated
            && matches!(self.theme.palette.primary, ratatui::style::Color::Rgb(..))
            && self.last_input.elapsed() < crate::banner::REST
    }

    pub fn set_animated(&mut self, animated: bool) {
        self.animated = animated;
    }

    pub fn set_prompt_width(&mut self, width: crate::config::PromptWidth) {
        self.prompt_width = width;
    }

    pub fn set_notice(&mut self, notice: Option<String>) {
        self.notice = notice;
    }

    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    /// The first cell of the draft as last painted, so a test can aim a drag at
    /// the landing prompt instead of guessing where it landed.
    #[cfg(test)]
    pub fn draft_cell(&self) -> Option<Position> {
        self.composer_text
            .map(|text| Position::new(text.input.x, text.input.y))
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
        // The page ground: every other row is painted by something, and the
        // cells around the banner would otherwise keep the terminal's own
        // background, a band that matches nothing beside it.
        frame.render_widget(
            Block::new().style(Style::new().bg(palette.background)),
            area,
        );
        let banner = crate::banner::Banner::new();
        let shimmer = self.shimmering();
        let now = now_ms();

        let version = match option_env!("MIAO_TUI_VERSION") {
            Some(version) => version,
            None => env!("CARGO_PKG_VERSION"),
        };

        let prompt_width = self.prompt_width.resolve(area.width);
        // The band wraps at the landing prompt's own width, so a long draft
        // grows it the same way it grows the Session composer; sizing it from
        // the whole window left it one row tall and clipped.
        let prompt_h = crate::pane::composer_height(composer, prompt_width, area.height).max(3);
        // The composer's own notice used to ride the box's border title. The
        // landing band has no title, so it is painted under the prompt the way
        // the product shows a notice there: one line, in the accent tone.
        let notices = composer
            .notice
            .iter()
            .map(|notice| (notice.clone(), palette.accent))
            .chain(
                self.warning
                    .iter()
                    .map(|warning| (warning.clone(), palette.warning)),
            )
            .chain(
                self.notice
                    .iter()
                    .map(|notice| (notice.clone(), palette.error)),
            )
            .collect::<Vec<_>>();

        // Vertical, following the TS home's flex stack
        // (`packages/tui/src/routes/home.tsx`):
        //
        //   flexGrow 1  ─┐
        //   height 4    ─┤ spacer above the banner
        //   logo + version, prompt          ← the used block
        //   height 1    ─┤ one blank row
        //   flexGrow 1  ─┘
        //
        // The two `flexGrow` children split the leftover evenly, so the group
        // sits centred and never higher than half a screen down. The previous
        // rule (`free * 2 / 5`) pushed it slightly below centre on every
        // height, which is why nothing could reproduce the TS layout.
        let used = banner.height() + 1 + 1 + 1 + prompt_h as usize + notices.len();
        let free = (area.height as usize).saturating_sub(used);
        let gap_top = free / 2;

        let y = area.y as usize + gap_top.min(free);
        // The banner centres as one block, its columns carrying their own ink;
        // the version rides under it, then one blank row, then the prompt.
        let banner_x = width.saturating_sub(banner.width()) / 2;
        for row in 0..banner.height() {
            frame.render_widget(
                Paragraph::new(banner.line(row, now, shimmer, &self.theme)),
                Rect {
                    x: area.x + banner_x as u16,
                    y: (y + row) as u16,
                    width: banner.width() as u16,
                    height: 1,
                },
            );
        }
        let version = format!("v{version}");
        let pad = width.saturating_sub(version.width()) / 2;
        frame.render_widget(
            Paragraph::new(Span::styled(version, Style::new().fg(palette.text_muted))),
            Rect {
                x: area.x + pad as u16,
                y: (y + banner.height()) as u16,
                height: 1,
                ..area
            },
        );
        let prompt_x = width.saturating_sub(prompt_width as usize) / 2;
        let prompt_area = Rect {
            x: area.x + prompt_x as u16,
            // The banner, the version and one blank row above the band, the
            // TypeScript prompt's `paddingTop`.
            y: (y + banner.height() + 1 + 1) as u16,
            width: prompt_width,
            // The height already carries the rules, so adding them again left
            // an empty row under a one-line prompt.
            height: prompt_h,
        };
        self.composer_text = render_home_composer(frame, prompt_area, composer, &self.theme);
        for (offset, (notice, ink)) in notices.iter().enumerate() {
            frame.render_widget(
                Paragraph::new(Span::styled(notice.clone(), Style::new().fg(*ink))),
                Rect {
                    x: prompt_area.x,
                    y: prompt_area.y + prompt_h + offset as u16,
                    width: prompt_area.width,
                    height: 1,
                },
            );
        }
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
            let line = Line::from(spans).style(line.style);
            // A fenced code block is drawn as `  ╭ … │ … ╰`. Its body rows are
            // the only markdown rows whose own content opens with a drawn
            // gutter, and a wrapped row that blanked that gutter looked like
            // the box edge vanished mid-block — the "output piled into one
            // column" an operator reports on a long line inside a code block.
            //
            // The span carries the indent with the glyph (`"  │ "`), so the
            // test trims before looking, and the hang is the bullet column
            // plus the whole markdown prefix.
            let gutter = line
                .spans
                .get(1)
                .map(|span| span.content.trim_start())
                .filter(|content| {
                    content.starts_with('╭') || content.starts_with('│') || content.starts_with('╰')
                });
            match gutter {
                Some(_) => {
                    let hang = 2 + line.spans[1].content.width() as u16;
                    Row::hung_with_edge(line, hang, hang)
                }
                None => Row::hung(line, 2),
            }
        })
        .collect()
}

/// The streamed answer, rendered like the assistant entry it will become: the
/// provisional block gains its header when the committed message arrives.
/// The answer being streamed, painted in the order the engine produced it.
///
/// A provider turn interleaves prose and tool calls. Rendering them as two
/// groups (all prose, then all calls) is neither the order the work happened in
/// nor the order the committed message will show, so the transcript rearranged
/// itself the moment the turn committed. Claude Code and codex both paint the
/// turn in arrival order; this does the same.
fn draft_lines(parts: &[DraftPart], theme: &Theme, now_ms: u64) -> Vec<Row> {
    let palette = theme.palette;
    let mut rows = Vec::new();
    let mut opened = false;
    for part in parts {
        match part {
            DraftPart::Reasoning(text) => {
                // One muted header line names where the thought is heading; the
                // run of text itself would tile the screen with everything the
                // model produced before it answered.
                if text.is_empty() {
                    continue;
                }
                let frame = SPINNER_FRAMES[(now_ms / 160) as usize % SPINNER_FRAMES.len()];
                let summary = fit(&reasoning_summary(text), COMPACT_CELLS);
                let label = if summary.is_empty() {
                    "Thinking".to_string()
                } else {
                    format!("Thinking · {summary}")
                };
                rows.push(Row::clipped(Line::from(Span::styled(
                    format!("{frame} {label}"),
                    Style::new().fg(palette.text_muted),
                ))));
                opened = true;
            }
            DraftPart::Text(text) => {
                if text.is_empty() {
                    continue;
                }
                if opened {
                    rows.push(Row::plain(Line::default()));
                }
                rows.extend(prose_lines(text, theme));
                opened = true;
            }
            DraftPart::Call { name, arguments } => {
                if opened {
                    rows.push(Row::plain(Line::default()));
                }
                let part = crate::session::ToolPart {
                    id: String::new(),
                    name: name.clone(),
                    input: serde_json::from_str(arguments).unwrap_or(serde_json::Value::Null),
                    output: Some(String::new()),
                    failed: false,
                    unreturned: false,
                };
                for line in crate::tool::lines(&part, None, theme, false, None) {
                    rows.push(Row::hung(line, 2));
                }
                opened = true;
            }
        }
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
    // The pair the previous step closed with. The footer names the agent and
    // the model only when this step's pair differs from it, so a session that
    // never switches does not print the same label under every turn.
    let mut previous_identity: Option<(Option<String>, Option<String>)> = None;
    for entry in &transcript.entries {
        match entry {
            Entry::User { text, .. } => {
                inline_run = false;
                // The operator's own words as one quiet line per row: an accent
                // `❯` and the text. No panel, no background band, no rules above
                // and below — the prompt is a line the person typed, not a box
                // something was put into, and framing it made a short question
                // take five rows of screen.
                anchors.push((
                    rows.len(),
                    text.lines().next().unwrap_or_default().to_string(),
                ));
                for line in text.lines() {
                    rows.push(Row::hung(
                        Line::from(vec![
                            Span::styled("❯ ", Style::new().fg(palette.primary)),
                            Span::styled(line.to_string(), Style::new().fg(palette.text)),
                        ]),
                        2,
                    ));
                }
                rows.push(Row::plain(Line::default()));
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
                                let (hang, keep) = tool_row_shape(&line);
                                Row::hung_with_edge(line, hang, keep)
                            }));
                        }
                    }
                }
                // The step footer the TS message ends with: the check marks the
                // settled step, and its blank row is the seam between
                // consecutive assistant messages. The agent and the model are
                // named only when they differ from the step before, because a
                // session that never switches printed the same label under
                // every turn while the status line already showed both.
                rows.push(Row::plain(Line::default()));
                let identity = (agent.clone(), model.clone());
                let mut spans = vec![
                    Span::styled("  ", Style::new()),
                    Span::styled("✓", Style::new().fg(palette.success)),
                ];
                if previous_identity.as_ref() != Some(&identity) {
                    let name = match (agent.as_deref(), model.as_deref()) {
                        (Some(agent), Some(model)) => format!("{} · {model}", titlecase(agent)),
                        (Some(agent), None) => titlecase(agent),
                        (None, Some(model)) => model.to_string(),
                        (None, None) => "assistant".to_string(),
                    };
                    spans.push(Span::styled(
                        format!(" {name}"),
                        Style::new().fg(palette.text_muted),
                    ));
                }
                rows.push(Row::hung(Line::from(spans), 2));
                previous_identity = Some(identity);
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
        // The model this window runs on is the row in effect for the whole
        // screen, so it carries the same accent the lists mark theirs with:
        // the strip used to paint it like any other text, which left "which
        // model am I on" to be read rather than seen.
        spans.push(Span::styled(
            model.clone(),
            Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
        ));
    }
    if let Some(usage) = &status.usage {
        if !spans.is_empty() {
            spans.push(Span::styled(" · ", muted));
        }
        spans.push(Span::styled(usage.clone(), muted));
    }
    // The strip carries the page background across its whole width, empty or
    // not: this row is the window's last, and a paragraph that paints only its
    // text — or returns early with no text at all — leaves the rest of the row
    // at the terminal's default colour, a band that matches nothing above it.
    frame.render_widget(
        Paragraph::new(Line::from(spans))
            .style(Style::new().bg(palette.background))
            .block(Block::new().padding(ratatui::widgets::Padding::left(2))),
        area,
    );
    // The running build sits at the row's right edge: an operator verifying an
    // upgrade reads it without leaving the TUI for `miao --version`.
    let version = format!("miao {}", crate::VERSION);
    let version_width = version.chars().count() as u16;
    if area.width > version_width {
        let cell = version_width + 2;
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(version, muted)))
                .style(Style::new().bg(palette.background)),
            Rect::new(area.x + area.width - cell, area.y, cell, 1),
        );
    }
}

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

/// The tallest the input grows before it scrolls, the TypeScript prompt's
/// default `max_height` of `max(6, height / 3)`: on a tall window a long draft
/// stays readable instead of being squeezed into a fixed eight rows.
fn composer_input_cap(height: u16) -> usize {
    (height as usize / 3).max(6)
}

/// The composer's height in rows, widened to the draft: a prompt that wraps or
/// has several lines is shown whole up to [`composer_input_cap`], so an
/// operator can read what they are about to send instead of only the line the
/// cursor happens to sit on.
pub fn composer_height(composer: &Composer, width: u16, height: u16) -> u16 {
    // The box spends two columns on borders and one blank column on each side
    // of the text, so the draft wraps four cells narrower than the box.
    let usable = width.saturating_sub(4).max(1) as usize;
    let input = composer
        .editor
        .display_rows(usable)
        .clamp(1, composer_input_cap(height));
    let completion = composer
        .completion
        .items
        .len()
        .min(COMPOSER_COMPLETION_ROWS);
    (2 + input + completion) as u16
}

/// Waiting prompts the queue band shows before it collapses the older ones
/// into a count. Claude Code and Codex print each queued message above the
/// input; the operator needs the newest ones, and a queue deeper than this is
/// read from its count.
const QUEUED_ROWS: usize = 3;

/// Rows the queue band above the input needs: one per waiting prompt, and one
/// more when older prompts do not fit.
fn queued_rows(prompts: &[String]) -> usize {
    prompts.len().min(QUEUED_ROWS) + usize::from(prompts.len() > QUEUED_ROWS)
}

/// What the operator sent that the engine still holds un-promoted, drawn
/// straight above the input: the title says how deep the queue is, these rows
/// say what is in it, so a submitted prompt does not look lost.
fn render_queued(frame: &mut Frame, area: Rect, prompts: &[String], theme: &Theme) {
    if area.height == 0 || prompts.is_empty() {
        return;
    }
    let palette = theme.palette;
    let hidden = prompts.len().saturating_sub(QUEUED_ROWS);
    let mut lines = (hidden > 0)
        .then(|| {
            Line::from(Span::styled(
                match hidden {
                    1 => "1 older prompt still queued".to_string(),
                    hidden => format!("{hidden} older prompts still queued"),
                },
                Style::new().fg(palette.text_muted),
            ))
        })
        .into_iter()
        .collect::<Vec<_>>();
    let room = (area.width as usize).saturating_sub(4);
    lines.extend(prompts.iter().skip(hidden).map(|prompt| {
        Line::from(vec![
            Span::styled("❯ ", Style::new().fg(palette.primary)),
            Span::styled(fit(prompt, room), Style::new().fg(palette.text)),
            Span::styled(" · queued", Style::new().fg(palette.text_muted)),
        ])
    }));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::new().bg(palette.background))
            .block(Block::new().padding(ratatui::widgets::Padding::left(2))),
        area,
    );
}

/// The landing prompt, drawn the way the TypeScript home draws it: a rule above
/// and one below, no sides, the draft two cells in from either edge, and the
/// element background behind it.
///
/// The Session composer keeps its closed box and its border title because that
/// title is where a run's phase, queue depth and notice live. The landing
/// screen has no run, so it gets the open band the product shows there instead
/// of a box titled with nothing.
fn render_home_composer(
    frame: &mut Frame,
    area: Rect,
    composer: &Composer,
    theme: &Theme,
) -> Option<ComposerText> {
    let palette = theme.palette;
    if area.width < 5 || area.height < 2 {
        return None;
    }
    let shell = composer.mode() == Mode::Shell;
    let rule = Style::new().fg(match shell {
        true => palette.warning,
        false => palette.primary,
    });
    for y in [area.y, area.y + area.height - 1] {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "─".repeat(area.width as usize),
                rule,
            ))),
            Rect {
                y,
                height: 1,
                ..area
            },
        );
    }
    let body = Rect {
        y: area.y + 1,
        height: area.height - 2,
        ..area
    };
    frame.render_widget(Block::new().style(Style::new().bg(palette.element)), body);
    if body.width < 5 {
        return None;
    }
    Some(render_composer_body(
        frame,
        Rect {
            x: body.x + 2,
            width: body.width.saturating_sub(4),
            ..body
        },
        composer,
        theme,
        shell,
    ))
}

/// A painted band of rows a pointer can select from. Read-only text — the
/// queued prompts above the input — has no editing model, so the cells this
/// frame drew are both what the highlight covers and what a copy returns.
#[derive(Default)]
struct PaintedCells {
    area: Rect,
    cells: Vec<Vec<String>>,
    selection: Option<(Position, Position)>,
}

impl PaintedCells {
    /// Remember the symbols this frame drew inside `area`.
    fn snapshot(&mut self, frame: &mut Frame, area: Rect) {
        self.area = area;
        let buffer = frame.buffer_mut();
        self.cells = (area.y..area.bottom())
            .map(|y| {
                (area.x..area.right())
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

    /// Reverse the covered cells, the way a transcript drag does, so the band
    /// shows what a release would copy.
    fn paint(&self, frame: &mut Frame) {
        let Some((a, b)) = self.selection else {
            return;
        };
        let (start, end) = if (a.y, a.x) > (b.y, b.x) {
            (b, a)
        } else {
            (a, b)
        };
        let buffer = frame.buffer_mut();
        for y in start.y.max(self.area.y)..=end.y.min(self.area.bottom().saturating_sub(1)) {
            let from = if y == start.y { start.x } else { self.area.x };
            let to = if y == end.y {
                end.x
            } else {
                self.area.right().saturating_sub(1)
            };
            for x in from.max(self.area.x)..=to.min(self.area.right().saturating_sub(1)) {
                if let Some(cell) = buffer.cell_mut(Position::new(x, y)) {
                    cell.set_style(Style::new().add_modifier(Modifier::REVERSED));
                }
            }
        }
    }

    fn begin(&mut self, position: Position) -> bool {
        if self.cells.is_empty() || !self.area.contains(position) {
            return false;
        }
        self.selection = Some((position, position));
        true
    }

    fn update(&mut self, position: Position) {
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

    fn take(&mut self) -> Option<String> {
        let (a, b) = self.selection.take()?;
        if a == b {
            return None;
        }
        let text = selection_text(&self.cells, self.area, a, b);
        (!text.is_empty()).then_some(text)
    }

    /// Forget the band: with nothing queued there is nothing to select. The
    /// drag selection is only dropped here, never by a repaint, or a drag would
    /// lose its anchor on every frame the loop draws.
    fn clear(&mut self) {
        self.cells.clear();
        self.selection = None;
    }
}

/// Which painted surface a drag belongs to. One gesture selects from one
/// surface, so a drag that leaves it clamps instead of jumping to a neighbour.
#[derive(Clone, Copy)]
enum DragTarget {
    Composer,
    Queued,
    Transcript,
}

/// Where the draft was painted and how far a wrapped draft scrolled, recorded
/// by the frame that painted it. The renderer and the pointer share these
/// cells, so a drag selects the characters it covered instead of guessing at
/// the wrap.
#[derive(Clone, Copy)]
struct ComposerText {
    input: Rect,
    row_offset: usize,
}

impl ComposerText {
    /// The byte offset under `position`, clamped into the painted cells so a
    /// drag that leaves the box still selects the last line it crossed.
    fn offset(&self, editor: &Editor, position: Position) -> usize {
        let row = position
            .y
            .clamp(self.input.y, self.input.bottom().saturating_sub(1))
            .saturating_sub(self.input.y);
        let cell = position
            .x
            .clamp(self.input.x, self.input.right().saturating_sub(1))
            .saturating_sub(self.input.x);
        editor.offset_at(
            self.row_offset + row as usize,
            cell as usize,
            self.input.width as usize,
        )
    }
}

fn render_composer(
    frame: &mut Frame,
    area: Rect,
    composer: &Composer,
    theme: &Theme,
) -> Option<ComposerText> {
    render_composer_in(frame, area, composer, theme, composer_column(area.width))
}

fn render_composer_in(
    frame: &mut Frame,
    area: Rect,
    composer: &Composer,
    theme: &Theme,
    column: u16,
) -> Option<ComposerText> {
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
    // The box carries a title, and the title is where the run's state lives:
    // the phase, the queue depth, and any notice, joined with separators. That
    // keeps "is it working, queued, or waiting on me?" beside the input the
    // operator is typing into instead of only in the status strip at the foot
    // of the screen, and it gives the phase a colour of its own.
    let queued = (composer.queued > 0).then(|| {
        if composer.queued == 1 {
            "1 queued".to_string()
        } else {
            format!("{} queued", composer.queued)
        }
    });
    // The idle box carries no label: the word "composer" named the widget
    // rather than saying anything about the run, and the phase below is the
    // fact worth the space.
    let name = if shell {
        "shell · runs locally · output stays in this Session · esc exit"
    } else {
        ""
    };
    let mut parts = composer.phase.iter().cloned().collect::<Vec<_>>();
    // The elapsed time rides the phase it measures: "Waiting for model · 2.0s"
    // reads as one fact, and the title has room for it once the box carries the
    // state instead of a band above the box.
    if composer.phase.is_some() {
        parts.extend(composer.phase_elapsed.iter().cloned());
    }
    parts.extend(queued);
    parts.extend(composer.notice.iter().cloned());
    let title_style = match shell {
        true => Style::new().fg(palette.warning),
        false => Style::new().fg(palette.text_muted),
    };
    let mut title = Vec::new();
    if !name.is_empty() {
        title.push(Span::styled(format!(" {name} "), title_style));
    }
    if !parts.is_empty() {
        title.push(Span::styled("· ", Style::new().fg(palette.border)));
        // A run in flight gets the braille spinner beside its phase, so the box
        // reads as moving even while the phase name stays the same. Past half a
        // minute of waiting the tone turns warning, which is the one signal
        // that separates "thinking" from "wedged" without reading the words.
        let tone = match (shell, composer.phase_alert) {
            (true, _) => palette.warning,
            (false, true) => palette.warning,
            (false, false) => palette.accent,
        };
        if composer.phase.is_some() {
            let frame = SPINNER_FRAMES[(now_ms() / 160) as usize % SPINNER_FRAMES.len()];
            title.push(Span::styled(format!("{frame} "), Style::new().fg(tone)));
        }
        title.push(Span::styled(parts.join(" · "), Style::new().fg(tone)));
        title.push(Span::styled(" ", Style::new()));
    }
    // The box keeps one border colour in normal mode and the shell warning when
    // a `!` line is active: the composer is where typing latency lives, and a
    // border that changes with the draft makes every keystroke repaint the whole
    // band for decoration.
    let border = match shell {
        true => palette.warning,
        false => palette.border,
    };
    let block = Block::bordered()
        .title(Line::from(title))
        .border_style(Style::new().fg(border))
        .style(Style::new().bg(palette.background));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return None;
    }
    let padded = Rect {
        x: inner.x + 1,
        width: inner.width.saturating_sub(2),
        ..inner
    };
    Some(render_composer_body(frame, padded, composer, theme, shell))
}

/// The draft, its selection, the caret and the completion list, painted inside
/// whatever chrome the caller drew around it: a Session composer's box or the
/// landing prompt's two rules.
fn render_composer_body(
    frame: &mut Frame,
    padded: Rect,
    composer: &Composer,
    theme: &Theme,
    shell: bool,
) -> ComposerText {
    let palette = theme.palette;
    let accent = if shell {
        palette.warning
    } else {
        palette.primary
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
    // A roomy box reads top-hung: the input sits in the vertical middle of
    // the space it has, so a one-line prompt does not hug the top border
    // while an empty row sits under it. The Session composer is sized to its
    // content exactly, so this offset is zero there and only the roomier
    // launcher box moves.
    let content_rows = if composer.editor.is_empty() && composer.completion.items.is_empty() {
        1
    } else {
        composer
            .editor
            .display_rows(input_rows.width.saturating_sub(gutter) as usize)
            .clamp(1, input_rows.height as usize) as u16
    };
    let vertical_offset = input_rows.height.saturating_sub(content_rows) / 2;
    let input_area = Rect {
        x: input_rows.x.saturating_add(gutter),
        y: input_rows.y + vertical_offset,
        width: input_rows.width.saturating_sub(gutter),
        height: input_rows.height.saturating_sub(vertical_offset),
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
    let (cursor_row, cursor_cell) = composer.editor.display_cursor(input_area.width as usize);
    let row_offset = cursor_row.saturating_sub(input_area.height.saturating_sub(1) as usize);
    let text_color = if shell { accent } else { palette.text };
    // The selection is painted in the accent on the composer's own background,
    // so the text stays readable while the covered cells read as chosen.
    let selection_style = Style::new().fg(palette.background).bg(accent);
    let selection_cells = composer.editor.selection_cells();
    if composer.editor.is_empty() && composer.completion.items.is_empty() {
        // The work the finished turn left behind outranks the rotating example:
        // it is this Session's own next todo, dim until `Tab` promotes it. The
        // `!` line runs commands, so it keeps its own examples.
        let line = match composer.suggestion.as_deref().filter(|_| !shell) {
            Some(next) => Line::from(vec![
                Span::styled(format!("Next: {next}"), Style::new().fg(palette.text_muted)),
                Span::styled(" (tab)", Style::new().fg(palette.text_muted).dim()),
            ]),
            None => {
                // An empty composer offers the example the TS prompt cycles
                // through: one quiet sentence, `Run a command…` on a `!` line.
                // The pick is the stored per-mount roll, not a clock drift, so
                // the example stays put the way the TS one does between Session
                // changes.
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
                Line::from(Span::styled(
                    format!("{verb} \u{201c}{example}\u{201d}"),
                    Style::new().fg(palette.text_muted),
                ))
            }
        };
        frame.render_widget(Paragraph::new(line), input_area);
    } else {
        let lines = composer
            .editor
            .display_lines(input_area.width as usize)
            .into_iter()
            .skip(row_offset)
            .take(input_area.height as usize)
            .map(|(index, start, line)| {
                let selection = selection_cells
                    .iter()
                    .find(|(line_index, _, _)| *line_index == index)
                    .map(|(_, start, end)| (*start, *end));
                composer_line(
                    &line,
                    start,
                    selection,
                    Style::new().fg(text_color),
                    selection_style,
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), input_area);
    }

    let cursor_row = cursor_row - row_offset;
    if cursor_row < input_area.height as usize && cursor_cell < input_area.width as usize {
        frame.set_cursor_position(Position::new(
            input_area.x + cursor_cell as u16,
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
    ComposerText {
        input: input_area,
        row_offset,
    }
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

/// Push one sidebar row whose clipped text a hover tip can complete: the row
/// shows `fit(...)`'s cut, the tip carries the whole string. Sidebar rows never
/// wrap, so a row wider than the column is where information otherwise dies.
/// The plural suffix for a billed-usage count, so "1 attempt" and "2 attempts"
/// both read as English.
fn plural(count: u64) -> &'static str {
    match count {
        1 => "",
        _ => "s",
    }
}

fn hoverable_line(
    hover_rows: &mut Vec<HoverRow>,
    inner: ratatui::layout::Rect,
    lines: &mut Vec<Line<'static>>,
    text: String,
    style: ratatui::style::Style,
    width: usize,
) {
    hover_rows.push(HoverRow {
        row: inner.y + lines.len() as u16,
        span: (inner.x, inner.x + inner.width.saturating_sub(1)),
        text: text.clone(),
    });
    lines.push(Line::from(Span::styled(fit(&text, width), style)));
}

/// One wrapped display row of the draft as spans, with the selected cells
/// carrying the highlight. `start` is the cell of the logical line the row
/// begins at, so a selection over CJK text covers exactly the cells the
/// terminal shows for it.
fn composer_line(
    line: &str,
    start: usize,
    selection: Option<(usize, usize)>,
    text: ratatui::style::Style,
    highlighted: ratatui::style::Style,
) -> ratatui::text::Line<'static> {
    let mut spans: Vec<ratatui::text::Span<'static>> = Vec::new();
    let mut current = String::new();
    let mut current_highlighted = false;
    let mut cell = start;
    for c in line.chars() {
        let highlighted_cell = selection.is_some_and(|(from, to)| cell >= from && cell < to);
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
        cell += UnicodeWidthChar::width(c).unwrap_or(0);
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

/// The last 24 hours of billed usage, one glyph per hour.
///
/// Colour only ever underlines what the glyphs already say: bar height is the
/// volume against the day's 95th percentile (an hour above it fills the top
/// level), the trailing column is the current hour, `~` says a figure covers
/// fewer turns than the window counted, and `partial` says retention removed
/// rows inside it. A monochrome terminal loses none of those facts.
fn hourly_lines(
    usage: Option<&crate::status::HourlyUsage>,
    width: usize,
    palette: &crate::theme::Palette,
) -> (Vec<Line<'static>>, Vec<(usize, String)>) {
    const GLYPHS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let muted = Style::new().fg(palette.text_muted);
    // The window spans the workspace ledger rather than this Session: say so,
    // or every Session's sidebar reads the same figures and the block looks
    // like a stub instead of a total.
    let mut lines = vec![Line::from(Span::styled("▾ Last 24h · workspace", muted))];
    let mut hover: Vec<(usize, String)> = Vec::new();
    let Some(usage) = usage else {
        lines.push(Line::from(Span::styled("no usage recorded", muted)));
        return (lines, hover);
    };
    // A narrow column pairs hours instead of dropping them: the shape of the
    // day is the point, and twelve two-hour glyphs keep it.
    let pair = width < 26;
    let cells = usage
        .buckets
        .chunks(if pair { 2 } else { 1 })
        .map(|chunk| {
            chunk
                .iter()
                .fold(0u64, |total, bucket| total.saturating_add(bucket.tokens))
        })
        .collect::<Vec<_>>();
    if cells.is_empty() {
        lines.push(Line::from(Span::styled("no usage recorded", muted)));
        return (lines, hover);
    }
    let mut sorted = cells.clone();
    sorted.sort_unstable();
    let p95 = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)];
    let mut spans = Vec::with_capacity(cells.len());
    for (index, tokens) in cells.iter().enumerate() {
        let colour = match tokens {
            0 => palette.element,
            _ if index + 1 == cells.len() => palette.primary,
            _ if *tokens > p95 => palette.warning,
            _ => palette.accent,
        };
        // Bar height is the volume against the day's 95th percentile hour, so
        // one outlier cannot flatten the other twenty-three into the baseline;
        // an hour above that percentile fills the top level and keeps its
        // warning colour, which is how a monochrome reader still sees it.
        // Zero hours keep a baseline dot so the axis stays 24 cells wide: a gap
        // would read as "no data", which is a different fact from "no spend".
        let glyph = match *tokens {
            0 => '·',
            tokens => {
                let top = GLYPHS.len() as u64;
                let level = match tokens > p95 {
                    true => top,
                    false => (tokens * (top - 1) / p95.max(1)).clamp(1, top - 1),
                };
                GLYPHS[level as usize - 1]
            }
        };
        spans.push(Span::styled(glyph.to_string(), Style::new().fg(colour)));
    }
    lines.push(Line::from(spans));
    // The marker under the last column says "this hour is still filling".
    lines.push(Line::from(vec![
        Span::raw(" ".repeat(cells.len().saturating_sub(1))),
        Span::styled("▸", Style::new().fg(palette.primary)),
    ]));
    let compact = crate::status::compact_tokens;
    lines.push(Line::from(vec![
        Span::styled("in ", muted),
        Span::styled(compact(usage.input), Style::new().fg(palette.secondary)),
        Span::styled(" · out ", muted),
        Span::styled(compact(usage.output), Style::new().fg(palette.warning)),
        Span::styled(" · cache ", muted),
        Span::styled(
            usage
                .cache_hit()
                .map(|hit| format!("{:.0}%", hit * 100.0))
                .unwrap_or_else(|| "—".into()),
            Style::new().fg(palette.success),
        ),
    ]));
    // The totals never name the model that earned them. One row per served
    // model, busiest first as the engine ordered them, keeps "which model did
    // the day's spend belong to" a glance instead of a guess. Six model rows
    // are the window a tall sidebar shows without crowding the histogram's
    // meaning. Once the day spread across providers, each provider heads its
    // own group and its models indent under it — a flat wall of look-alike
    // rows hides which provider billed what.
    const MODEL_ROWS: usize = 6;
    let providers: std::collections::HashSet<Option<&str>> = usage
        .models
        .iter()
        .map(|model| model.provider.as_deref())
        .collect();
    let grouped = providers.len() > 1;
    let mut open_provider = None;
    for (index, model) in usage.models.iter().enumerate() {
        if index == MODEL_ROWS {
            let more = usage.models.len() - MODEL_ROWS;
            lines.push(Line::from(Span::styled(
                format!("  … {} more", more),
                muted,
            )));
            break;
        }
        let hit = model
            .cache_hit()
            .map(|hit| format!("{:.0}%", hit * 100.0))
            .unwrap_or_else(|| "—".into());
        let provider = model.provider.as_deref();
        if grouped && provider != open_provider {
            open_provider = provider;
            if let Some(name) = provider {
                lines.push(Line::from(Span::styled(name.to_string(), muted)));
            }
        }
        let mark = match grouped && provider == open_provider && provider.is_some() {
            true => "  - ",
            false => "  ",
        };
        let row = format!(
            "{mark}{} · in {} · out {} · {}",
            model.model,
            compact(model.input),
            compact(model.output),
            hit
        );
        hover.push((lines.len(), row.clone()));
        lines.push(Line::from(Span::styled(fit(&row, width), muted)));
    }
    let mut money = Vec::new();
    if usage.cost_turns > 0 {
        // `~` marks turns that carried no figure at all, so a partial answer
        // is never read as the day's whole price.
        let suffix = match usage.cost_turns >= usage.turns && !usage.truncated {
            true => String::new(),
            false => " ~".to_string(),
        };
        money.push(Span::styled(
            format!("${:.3}", usage.cost_usd),
            Style::new().fg(palette.text),
        ));
        if !suffix.is_empty() {
            money.push(Span::styled(suffix, muted));
        }
        money.push(Span::styled(" · ", muted));
    }
    money.push(Span::styled(
        format!(
            "{} turn{}",
            usage.turns,
            if usage.turns == 1 { "" } else { "s" }
        ),
        muted,
    ));
    if let Some((start_ms, tokens)) = usage.peak {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let hours_ago = now_ms.saturating_sub(start_ms) / 3_600_000;
        money.push(Span::styled(
            format!(
                " · peak {} · {}",
                match hours_ago {
                    0 => "now".to_string(),
                    hours => format!("-{hours}h"),
                },
                compact(tokens)
            ),
            muted,
        ));
    }
    // The histogram and the numbers are two different reads: a blank row
    // between them lets the eye take the shape first, then the figures.
    lines.push(Line::default());
    lines.push(Line::from(money));
    // An unhealthy cache state carries its own next step: billed input that
    // the cache barely recognised is the one shape compaction actually
    // fixes, so name the command instead of printing a bare percentage. It
    // sits in its own group below the figures.
    lines.push(Line::default());
    if usage.cache_hit().is_some_and(|hit| hit < 0.5) && usage.input >= 50_000 {
        lines.push(Line::from(vec![
            Span::styled("low cache hit: ", Style::new().fg(palette.warning)),
            Span::styled("/compact", Style::new().fg(palette.secondary)),
            Span::styled(" trims the input later turns resend", muted),
        ]));
    }
    if usage.truncated {
        lines.push(Line::from(Span::styled(
            "partial: retention removed older rows",
            Style::new().fg(palette.warning),
        )));
    }
    (lines, hover)
}

/// One sidebar row whose clipped title a hover tip can complete.
#[derive(Debug)]
pub struct HoverRow {
    /// The screen row the tip belongs to.
    pub row: u16,
    /// The columns that row occupies. The transcript shares these rows, so the
    /// column -- not the row alone -- decides whose tooltip opens.
    pub span: (u16, u16),
    /// The full text the row had to clip.
    pub text: String,
}

pub struct SidebarPane {
    /// Rows carrying a clipped title, each with the columns it spans, for the
    /// hover tip: the row itself shows `fit(...)`'s clipped title.
    pub hover_rows: Vec<HoverRow>,
    /// Files this Session's tools touched, with lines added and removed.
    pub changes: Option<(usize, u64, u64)>,
    /// The launch policy in force, when it is not the default one.
    pub mode: Option<String>,
    theme: Theme,
    session: Option<SessionSummary>,
    usage: Option<crate::status::UsageSummary>,
    usage_hourly: Option<crate::status::HourlyUsage>,
    /// The durable Goal, painted above the checklist and never mixed into it.
    goal: Option<crate::session::GoalView>,
    /// The pending plan: how the Session means to get there. Its own section,
    /// because the checklist is what changes every turn and a plan is not.
    plan: Option<crate::session::PlanView>,
    todos: Vec<crate::session::TodoView>,
    /// The chord that hides this column, resolved from the live keymap. Pinned
    /// to the column's last row so a long checklist cannot scroll it away.
    chord: Option<String>,
}

impl Pane for SidebarPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        // A single hairline, the way the TypeScript layout separates this column
        // from the transcript: no frame around it, but the edge is visible.
        let outer = area;
        // The whole column carries the page background, the rule included. A
        // `Block` only writes its border cells and a `Paragraph` only its own
        // area, so painting the rule on its own left the indent and the rows
        // past the last line at the terminal's default colour — a strip beside
        // the divider that did not match the page on either side of it.
        let edge = Block::new()
            .borders(Borders::LEFT)
            .border_style(Style::new().fg(palette.text_muted).bg(palette.background))
            .style(Style::new().bg(palette.background))
            .padding(ratatui::widgets::Padding::left(2));
        let inner = edge.inner(outer);
        // Fill the column first, then draw the rule over it: `Block` writes
        // only its border cells and `Paragraph` only its own area, so without
        // the fill the indent, the rows past the last line, and the rule's own
        // cell stay at the terminal's default colour — a strip beside the
        // divider that matched the page on neither side.
        frame.render_widget(
            Block::new().style(Style::new().bg(palette.background)),
            outer,
        );
        frame.render_widget(edge, outer);
        // `paddingLeft={2}` comes from the block above, so the text never
        // touches the rule and the indent carries the page colour with it.
        let area = inner;
        // Hover tips track this pass's rows only: a tip left over from the
        // previous frame must not answer for a row this render never painted.
        self.hover_rows.clear();
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
            // The workspace strip opens the billed-usage section: a "Context"
            // banner above it read as two stacked headers for one block of
            // numbers, and the strip already says what the rows below explain.
            lines.push(Line::default());
            let (hourly, hourly_hover) =
                hourly_lines(self.usage_hourly.as_ref(), text_width, &palette);
            let hourly_base = lines.len();
            lines.extend(hourly);
            for (offset, text) in hourly_hover {
                self.hover_rows.push(HoverRow {
                    row: inner.y + (hourly_base + offset) as u16,
                    span: (inner.x, inner.x + inner.width.saturating_sub(1)),
                    text,
                });
            }
            // The rows below are a different scope from the workspace strip
            // above: they are what this Session was billed, not what the
            // workspace spent, so they carry their own "WHAT · scope" header
            // instead of reading as the tail of the Last 24h group.
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                "▾ Usage · session",
                Style::new().fg(palette.text_muted),
            )));
            match &self.usage {
                None => lines.push(Line::from(Span::styled(
                    "no usage yet",
                    Style::new().fg(palette.text_muted),
                ))),
                Some(usage) => {
                    // Every model that served a turn gets its own row: a
                    // session that switched models must not keep painting only
                    // the first one.
                    for lineage in &usage.lineage {
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            lineage.clone(),
                            Style::new().fg(palette.text),
                            text_width,
                        );
                    }
                    // How full the live context is: the window the last turn
                    // planned against and the occupancy it planned for. This
                    // is a different read from the billed tokens below — those
                    // are what was paid for, this is what still fits — so it
                    // leads, and the rung where automatic compaction arms
                    // (~80%) paints the warning colour.
                    if let (Some(window), Some(tokens)) =
                        (usage.context_window, usage.context_tokens)
                    {
                        let percent = tokens.saturating_mul(100) / window.max(1);
                        // `ctx` asked the reader to know the word. Say what the
                        // figure is — the conversation the model can still see
                        // — and let the hover carry the rest, because the row
                        // itself has only the column's 42 cells.
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!(
                                "context {} of {} · {}%",
                                crate::status::compact_tokens(tokens),
                                crate::status::compact_tokens(window),
                                percent
                            ),
                            Style::new().fg(if percent >= 80 {
                                palette.warning
                            } else {
                                palette.text_muted
                            }),
                            text_width,
                        );
                        if let Some(row) = self.hover_rows.last_mut() {
                            row.text = format!(
                                "context {} of {} · {}% — the conversation the model can still read; compaction starts at 80%",
                                crate::status::compact_tokens(tokens),
                                crate::status::compact_tokens(window),
                                percent
                            );
                        }
                    }
                    hoverable_line(
                        &mut self.hover_rows,
                        inner,
                        &mut lines,
                        format!(
                            "in {} · out {}",
                            crate::status::compact_tokens(usage.input_tokens),
                            crate::status::compact_tokens(usage.output_tokens)
                        ),
                        Style::new().fg(palette.text_muted),
                        text_width,
                    );
                    hoverable_line(
                        &mut self.hover_rows,
                        inner,
                        &mut lines,
                        format!(
                            "cache {} · turns {}",
                            crate::status::compact_tokens(usage.cache_read_tokens),
                            usage.turns
                        ),
                        Style::new().fg(palette.text_muted),
                        text_width,
                    );
                    // A retry is billed work: saying "1 turn" while three
                    // attempts were made hides where the money went. A
                    // subagent bills on its own Session, so a parent screen
                    // that only shows its own tokens understates the cost.
                    let detailed = usage.subagent_sessions > 0
                        || usage.hook_calls > 0
                        || usage.approvals + usage.answers + usage.rejections + usage.cancels > 0
                        || usage.input_edits > 0
                        || usage.auxiliary_calls > 0
                        || usage.tool_input_errors > 0
                        || usage.replayed_turns > 0
                        || usage.failed_attempts > 0;
                    if detailed {
                        // Every other header in the column opens after a blank
                        // row; this one sat glued to the figures above and read
                        // as one more data line.
                        lines.push(Line::default());
                        lines.push(Line::from(Span::styled(
                            "▾ Activity",
                            Style::new().fg(palette.text_muted),
                        )));
                    }
                    // The rows read abnormal-first: what went wrong (retries,
                    // rework) before what it cost in supervision and spend,
                    // time last. Order carries that priority when colour
                    // cannot, so a monochrome terminal loses no hierarchy. A
                    // row lists only the parts that carry a count: a zero says
                    // nothing the absence of the part does not.
                    if usage.replayed_turns > 0 || usage.failed_attempts > 0 {
                        let mut parts = Vec::new();
                        if usage.replayed_turns > 0 {
                            parts.push(format!("retried {}", usage.replayed_turns));
                        }
                        if usage.failed_attempts > 0 {
                            parts.push(format!(
                                "{} failed attempt{}",
                                usage.failed_attempts,
                                plural(usage.failed_attempts)
                            ));
                        }
                        // The engine reports the attempt count beside the two
                        // counters above, and it can be zero while a replay or
                        // a failure is recorded: the row then read
                        // `retried 7 · 0 attempts`, a zero describing nothing
                        // (see the comment on the row). State it only when it
                        // carries a count of its own.
                        if usage.attempts > 0 {
                            parts.push(format!(
                                "{} attempt{}",
                                usage.attempts,
                                plural(usage.attempts)
                            ));
                        }
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            parts.join(" · "),
                            Style::new().fg(palette.warning),
                            text_width,
                        );
                    }
                    if usage.tool_input_errors > 0 {
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!(
                                "rework {} · tool-input error{}",
                                usage.tool_input_errors,
                                plural(usage.tool_input_errors)
                            ),
                            Style::new().fg(palette.warning),
                            text_width,
                        );
                    }
                    // What a person had to decide, including the drafts they
                    // rewrote: the headline count, then only the kinds that
                    // happened. The gate admits the row for edits alone, so an
                    // edits-only Session reads "needs you 2 edits" instead of a
                    // row of zeroes.
                    let decisions =
                        usage.approvals + usage.answers + usage.rejections + usage.cancels;
                    if decisions > 0 || usage.input_edits > 0 {
                        let mut parts = Vec::new();
                        if usage.approvals > 0 {
                            parts.push(usage.approvals.to_string());
                        }
                        if usage.answers > 0 {
                            parts.push(format!(
                                "{} answer{}",
                                usage.answers,
                                plural(usage.answers)
                            ));
                        }
                        if usage.rejections > 0 {
                            parts.push(format!(
                                "{} rejection{}",
                                usage.rejections,
                                plural(usage.rejections)
                            ));
                        }
                        if usage.cancels > 0 {
                            parts.push(format!(
                                "{} cancel{}",
                                usage.cancels,
                                plural(usage.cancels)
                            ));
                        }
                        if usage.input_edits > 0 {
                            parts.push(format!(
                                "{} edit{}",
                                usage.input_edits,
                                plural(usage.input_edits)
                            ));
                        }
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!("needs you {}", parts.join(" · ")),
                            Style::new().fg(palette.text_muted),
                            text_width,
                        );
                    }
                    if usage.subagent_sessions > 0 {
                        // A child's retries are its own billed attempts. When
                        // they outnumber its settled turns, say so rather than
                        // reporting the child at the price of one turn; when
                        // they match, the suffix would repeat the turn count in
                        // other words.
                        let retried = if usage.subagent_attempts > usage.subagent_turns {
                            format!(
                                " · {} attempt{}",
                                usage.subagent_attempts,
                                plural(usage.subagent_attempts)
                            )
                        } else {
                            String::new()
                        };
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!(
                                "subagents {} · {} turn{} · in {}{}",
                                usage.subagent_sessions,
                                usage.subagent_turns,
                                plural(usage.subagent_turns),
                                crate::status::compact_tokens(usage.subagent_input_tokens),
                                retried,
                            ),
                            Style::new().fg(palette.text_muted),
                            text_width,
                        );
                    }
                    // Compaction runs as an auxiliary role, so its spend is
                    // real and absent from every main-model line above.
                    if usage.auxiliary_calls > 0 {
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!(
                                "auxiliary {} call{} · in {} · out {}",
                                usage.auxiliary_calls,
                                plural(usage.auxiliary_calls),
                                crate::status::compact_tokens(usage.auxiliary_input_tokens),
                                crate::status::compact_tokens(usage.auxiliary_output_tokens),
                            ),
                            Style::new().fg(palette.text_muted),
                            text_width,
                        );
                    }
                    // A hook is a process the Session waited on before a tool
                    // could run: its time is cost too, and a failure is not a
                    // quiet detail.
                    if usage.hook_calls > 0 {
                        let failed = if usage.hook_failed > 0 {
                            format!(" · {} failed", usage.hook_failed)
                        } else {
                            String::new()
                        };
                        hoverable_line(
                            &mut self.hover_rows,
                            inner,
                            &mut lines,
                            format!(
                                "hooks {} · {} ms{}",
                                usage.hook_calls, usage.hook_ms, failed
                            ),
                            Style::new().fg(palette.text_muted),
                            text_width,
                        );
                    }
                }
            }
            lines.push(Line::default());
            if let Some(mode) = &self.mode {
                lines.push(Line::from(Span::styled(
                    format!("▾ Mode · {mode}"),
                    Style::new().fg(palette.warning),
                )));
            }
            if let Some((files, added, removed)) = self.changes {
                let noun = if files == 1 { "file" } else { "files" };
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(
                    format!("▾ Changes {files} {noun}  +{added} −{removed}"),
                    Style::new().fg(palette.text_muted),
                )));
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
            }
            if let Some(plan) = &self.plan {
                // A plan is a promise, not a result: the approved word is the
                // only one that earns colour, and the rows stay plain.
                let plan_style = match plan.status.as_str() {
                    "approved" => Style::new().fg(palette.success),
                    _ => Style::new().fg(palette.text_muted),
                };
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(
                    format!("▾ Plan · {}", plan.status),
                    plan_style,
                )));
                let width = area.width.saturating_sub(3);
                lines.push(Line::from(Span::styled(
                    clip_cells(&plan.summary, 0, width),
                    Style::new().fg(palette.text),
                )));
                if plan.steps > 0 {
                    lines.push(Line::from(Span::styled(
                        format!("{} step{}", plan.steps, plural(plan.steps as u64)),
                        Style::new().fg(palette.text_muted),
                    )));
                }
            }
            // Every ▾ section opens after one blank row; the Goal block no
            // longer carries its own trailing one.
            lines.push(Line::default());
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
                // The same bracket glyphs the transcript's todowrite row paints,
                // so a task reads identically in both columns.
                let glyph = match todo.status.as_str() {
                    "completed" => "✓",
                    "in_progress" => "•",
                    "cancelled" => "×",
                    "waiting" => "…",
                    "blocked" => "!",
                    _ => " ",
                };
                let color = if todo.status == "in_progress" {
                    palette.warning
                } else {
                    palette.text_muted
                };
                let text = fit(&todo.content, width.saturating_sub(4));
                // The row shows the clipped title; the hover tip has to carry
                // the text the clip removed.
                self.hover_rows.push(HoverRow {
                    row: inner.y + lines.len() as u16,
                    span: (inner.x, inner.x + inner.width.saturating_sub(1)),
                    text: todo.content.clone(),
                });
                lines.push(Line::from(Span::styled(
                    format!("[{glyph}] {text}"),
                    Style::new().fg(color),
                )));
            }
        }
        // No wrapping: a long title or todo would otherwise split into several
        // rows, pushing the rest of the column off the screen and reading as one
        // character per line for CJK.
        // One background for the whole window. A panel tone behind this column
        // read as a stripe against the transcript's page, and the hairline
        // already separates the two columns — a second, near-identical dark
        // shade drew attention to the boundary instead of the content.
        //
        // The paragraph paints over `outer`, not over the inset `area`: `Block`
        // writes only its border cells, so a paragraph confined to `area` would
        // leave the indent and every row past the last line in the terminal's
        // own default colour — a block of reset background hugging the rule on
        // one side while the transcript beside it was the page colour.
        let pad = area.x - inner.x;
        // The column names its own way out, on its last row rather than after
        // the checklist: a long todo list would otherwise push the one line
        // that explains how to hide the column off the screen, and a chord
        // nobody is shown is a chord nobody presses.
        let hint = self
            .chord
            .as_ref()
            .filter(|_| inner.height > 3)
            .map(|chord| {
                Line::from(vec![
                    Span::styled(chord.clone(), Style::new().fg(palette.text)),
                    Span::styled("  hide sidebar", Style::new().fg(palette.text_muted)),
                ])
            });
        let content = match hint {
            // One blank row keeps the data above the hint from touching it.
            Some(_) => Rect {
                height: inner.height - 2,
                ..inner
            },
            None => inner,
        };
        frame.render_widget(
            Paragraph::new(lines)
                .style(Style::new().bg(palette.background))
                .block(Block::new().padding(ratatui::widgets::Padding::left(pad))),
            content,
        );
        if let Some(hint) = hint {
            frame.render_widget(
                Paragraph::new(hint).style(Style::new().bg(palette.background)),
                Rect {
                    y: inner.y + inner.height - 1,
                    height: 1,
                    ..inner
                },
            );
        }
    }
}

/// The tooltip a hovered sidebar row draws: the full text the row clipped,
/// cleared against the page so it reads over the transcript beside it.
impl SidebarPane {
    /// The tip for the row under the pointer, or `None` when the pointer is on
    /// that line but in another column: the transcript paints the same rows, and
    /// hovering it must not open the sidebar's tooltip.
    pub fn hover_tip(&self, column: u16, row: u16) -> Option<&str> {
        self.hover_rows
            .iter()
            .find(|tip| tip.row == row && (tip.span.0..=tip.span.1).contains(&column))
            .map(|tip| tip.text.as_str())
    }
}

pub fn render_hover_tip(frame: &mut Frame, at: (u16, u16), text: &str, theme: &Theme) {
    let area = frame.area();
    let width = (text.chars().count() as u16 + 4).clamp(12, area.width.saturating_sub(2).max(12));
    let height = 3;
    let x = at.0.min(area.width.saturating_sub(width));
    let y =
        at.1.saturating_sub(1)
            .min(area.height.saturating_sub(height));
    let rect = Rect {
        x,
        y,
        width,
        height,
    };
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            clip_cells(text, 0, width.saturating_sub(2)),
            Style::new().fg(theme.palette.text),
        )))
        .style(Style::new().bg(theme.palette.background))
        .block(Block::bordered().border_style(Style::new().fg(theme.palette.text_muted))),
        rect,
    );
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
    if let Some(sign_in) = dialog.sign_in() {
        render_sign_in(frame, inner, sign_in, theme);
        return;
    }
    if let Some((input, label)) = dialog.rename_input() {
        render_rename(frame, inner, input, label, theme);
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
                // The row already in effect — the open Session, the model the
                // Session runs on — is not the cursor and must not look like it:
                // it carries its own bullet and the theme's accent, so "what am
                // I on" is answered by colour before the cursor moves.
                let current =
                    !read_only && !selected && list.current.as_deref() == Some(row.id.as_str());
                let marker = if selected {
                    "▸ "
                } else if current {
                    "● "
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
                } else if current {
                    Style::new().fg(palette.accent).add_modifier(Modifier::BOLD)
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

fn render_rename(
    frame: &mut Frame,
    area: Rect,
    input: &crate::editor::Editor,
    label: &str,
    theme: &Theme,
) {
    let palette = theme.palette;
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            label,
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

/// The key prompt for a provider the engine does not serve yet. The border
/// title cannot carry the provider (it is a static string), so the name stands
/// on the label row beside the input instead.
fn render_sign_in(
    frame: &mut Frame,
    area: Rect,
    sign_in: &crate::dialogs::SignInDialog,
    theme: &Theme,
) {
    use crate::dialogs::SignInField;
    let palette = theme.palette;
    // Two fields when a second key is being added: the label is what tells the
    // accounts apart, so it is asked for first and the key follows it.
    let account = sign_in.account.as_ref();
    let mut row = area.y;
    let mut draw = |frame: &mut Frame, label: &str, text: &str, focused: bool| {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                label.to_string(),
                Style::new().fg(palette.text_muted),
            ))),
            Rect {
                y: row,
                height: 1,
                ..area
            },
        );
        row += 1;
        let input_area = Rect {
            y: row,
            height: 1,
            ..area
        };
        if input_area.width > 0 {
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    clip_cells(text, 0, input_area.width),
                    Style::new().fg(match focused {
                        true => palette.text,
                        false => palette.text_muted,
                    }),
                ))),
                input_area,
            );
        }
        row += 2;
        input_area
    };
    let account_area = account.map(|account| {
        let focused = sign_in.field == SignInField::Account;
        draw(
            frame,
            &format!("{}  account", sign_in.name),
            account.text(),
            focused,
        )
    });
    let key_area = draw(
        frame,
        &format!("{}  API key", sign_in.name),
        sign_in.input.text(),
        account.is_none() || sign_in.field == SignInField::Key,
    );
    let hint = match account.is_some() {
        true => "tab switches · enter stores · esc cancels",
        false => "enter stores · esc cancels",
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            hint,
            Style::new().fg(palette.text_muted),
        ))),
        Rect {
            y: row.saturating_sub(1),
            height: 1,
            ..area
        },
    );
    let (focused, input_area) = match (account, sign_in.field) {
        (Some(_), SignInField::Account) => (
            account
                .map(|account| account.cursor_position().1)
                .unwrap_or(0),
            account_area.unwrap_or(key_area),
        ),
        _ => (sign_in.input.cursor_position().1, key_area),
    };
    if input_area.width == 0 {
        return;
    }
    let column = focused.min(input_area.width as usize - 1) as u16;
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
    fn animations_off_keep_the_landing_screen_still() {
        let theme = crate::theme::Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
        };
        let mut home = Home::new(theme);
        assert!(
            home.shimmering(),
            "a colour terminal with fresh input shimmers"
        );
        home.set_animated(false);
        assert!(!home.shimmering(), "animations off holds the banner still");
    }

    #[test]
    fn wide_characters_never_overflow_the_width_and_keep_every_character() {
        // A CJK paragraph mixes full-width text with a narrow phrase, so a naive
        // split overflows the viewport or drops cells where the boundary lands
        // inside a wide character.
        let line =
            "两项属于 P1，等 P0 合并后我单独开 PR。另外这轮真实账本验证有两个发现已记进后续待办";
        let cells = line
            .chars()
            .map(|character| (character, ratatui::style::Style::new()))
            .collect::<Vec<_>>();
        for width in 2..=40 {
            let chunks = super::chunk_cells(&cells, width);
            for chunk in &chunks {
                assert!(
                    super::cells_width(chunk) <= width,
                    "width {width} overflowed the viewport"
                );
            }
            let joined = chunks
                .iter()
                .flat_map(|chunk| chunk.iter().map(|(character, _)| *character))
                .collect::<String>();
            assert_eq!(
                joined, line,
                "width {width} lost, duplicated or reordered cells"
            );
        }
    }

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
        shell.scroll_transcript(-5);
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
    use std::collections::HashMap;

    /// TUI-04's reading surfaces in one narrow frame: the markdown block
    /// stays structured, an image result names the media instead of its
    /// bytes, and long tool output folds behind the chord that reopens it.
    /// A row lost here is a result the operator cannot read, on exactly the
    /// widths a transcript actually runs at.
    #[test]
    fn a_narrow_transcript_keeps_markdown_media_and_folded_output_readable() {
        let mut shell = Shell::new(Path::new("/tmp/pane-test"), home_theme());
        shell.set_toggle_chord(Some("ctrl+x u".into()));
        let transcript = Transcript {
            entries: vec![
                Entry::User {
                    text: "check the render".into(),
                    seq: 1,
                },
                Entry::Assistant {
                    agent: None,
                    model: None,
                    parts: vec![
                        Part::Text(
                            [
                                "## Findings",
                                "",
                                "| name | count |",
                                "| --- | --- |",
                                "| rows | 3 |",
                                "",
                                "- one",
                                "see [the guide](https://example.com/x) now",
                                "",
                                "```",
                                "let x = 1;",
                                "```",
                            ]
                            .join("\n"),
                        ),
                        Part::Tool(crate::session::ToolPart {
                            id: "call_img".into(),
                            name: "read_image".into(),
                            input: serde_json::json!({"filePath": "assets/logo.png"}),
                            output: Some(
                                serde_json::json!({"text": "iVBORw0KGgoAAAANSUhEUg=="}).to_string(),
                            ),
                            failed: false,
                            unreturned: false,
                        }),
                        Part::Tool(crate::session::ToolPart {
                            id: "call_seq".into(),
                            name: "run_command".into(),
                            input: serde_json::json!({"argv": ["seq", "12"]}),
                            output: Some(
                                serde_json::json!({
                                    "stdout": (1..=12)
                                        .map(|n| format!("line {n}"))
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    "exit_code": 0
                                })
                                .to_string(),
                            ),
                            failed: false,
                            unreturned: false,
                        }),
                    ],
                },
            ],
            ..Transcript::default()
        };
        shell.set_transcript(&transcript);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        let paint =
            |shell: &mut Shell, terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>| {
                terminal
                    .draw(|frame| shell.transcript.render(frame, frame.area()))
                    .expect("draw");
                (0..40)
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
        let painted = paint(&mut shell, &mut terminal).join("\n");
        // The markdown structure survives the narrow frame, and a link keeps
        // its label while the URL it points at stays out of the transcript.
        for needle in [
            "Findings",
            "name",
            "rows",
            "• one",
            "the guide",
            "│ let x = 1;",
        ] {
            assert!(painted.contains(needle), "missing {needle:?}: {painted}");
        }
        assert!(!painted.contains("example.com"), "{painted}");
        // The image result is a placeholder naming the media; its bytes never
        // reach the buffer.
        assert!(painted.contains("Read image"), "{painted}");
        assert!(!painted.contains("iVBOR"), "{painted}");
        // Long output folds to its budget and names the chord that reopens it.
        assert!(painted.contains("line 1"), "{painted}");
        assert!(
            painted.contains("more lines") && painted.contains("ctrl+x u expand"),
            "{painted}"
        );
        assert!(
            !painted.contains("line 12"),
            "folded output stays hidden: {painted}"
        );
        shell.toggle_tool_expansion();
        let painted = paint(&mut shell, &mut terminal).join("\n");
        assert!(
            painted.contains("line 12"),
            "expansion shows the tail: {painted}"
        );
        assert!(!painted.contains("more lines"), "{painted}");
    }

    #[test]
    fn the_goal_has_its_own_section_above_the_todo_list() {
        // AGT-04: a displayed plan is not an implemented one, and a checklist is
        // not a Goal. Both are painted, and the Goal comes first with its own
        // header so the operator cannot read the todo list as the objective.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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

    /// #1969: the third durable row gets its own section, between the Goal
    /// (why) and the checklist (what this turn is doing).
    #[test]
    fn the_pending_plan_sits_between_the_goal_and_the_checklist() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_session(Some(&SessionSummary {
            id: "ses_p".into(),
            title: Some("plan".into()),
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
            budget: None,
            evidence: None,
        }));
        shell.set_plan(Some(&crate::session::PlanView {
            summary: "read the ledger, then replay it".into(),
            status: "approved".into(),
            steps: 2,
        }));
        shell.set_todos(&[crate::session::TodoView {
            content: "wire the parser".into(),
            status: "pending".into(),
        }]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 24)).expect("terminal");
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
        let plan = text.find("▾ Plan · approved").expect("plan header");
        let summary = text
            .find("read the ledger, then replay it")
            .expect("plan summary");
        let steps = text.find("2 steps").expect("step count");
        let todos = text.find("▾ Todo 0/1").expect("todo header");
        assert!(
            goal < plan && plan < summary && summary < steps && steps < todos,
            "the plan reads between the goal and the checklist: {text}"
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
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
        };
        let mut composer = Composer::new(Path::new("."));
        composer.paste("fix the parser at forty columns");
        for width in [40u16, 80, 120] {
            let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 8))
                .expect("terminal");
            terminal
                .draw(|frame| {
                    let _ = render_composer(frame, frame.area(), &composer, &theme);
                })
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
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
            text.contains('•'),
            "the running item still reads as running: {text}"
        );
        assert!(text.contains("wire the parser") && text.contains("measure the window"));
    }

    #[test]
    fn an_alerting_status_is_painted_in_the_warning_color() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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

    /// The list marks the row already in effect apart from the cursor: a bullet
    /// of its own and the theme's accent, so "which one am I on" is seen rather
    /// than read while the cursor keeps its own band where it is.
    #[test]
    fn the_row_in_effect_is_painted_apart_from_the_cursor() {
        let theme = home_theme();
        let models = crate::dialogs::ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "glm-5.3-flash"},
            {"protocol": "openai-chat", "model": "deepseek-v4"}
        ]));
        let dialog = crate::dialogs::Dialog::models(&models, Some(&models[1].label()));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).expect("terminal");
        terminal
            .draw(|frame| super::render_dialog(frame, frame.area(), &dialog, &theme))
            .expect("draw");
        let buffer = terminal.backend().buffer();
        let rows = buffer
            .content
            .chunks(buffer.area.width as usize)
            .map(|cells| {
                let text: String = cells.iter().map(|cell| cell.symbol()).collect();
                (text, cells.to_vec())
            })
            .collect::<Vec<_>>();
        let current = rows
            .iter()
            .find(|(text, _)| text.contains("deepseek-v4"))
            .expect("the model the window runs on");
        assert!(
            current.0.contains('●'),
            "the row in effect carries its own bullet: {}",
            current.0
        );
        assert!(
            current
                .1
                .iter()
                .any(|cell| cell.style().fg == Some(theme.palette.accent)),
            "the row in effect takes the accent colour"
        );
        // The cursor stays where it was, on the first row, in the selection's
        // own style: the marker must not move the keyboard.
        let cursor = rows
            .iter()
            .find(|(text, _)| text.contains("glm-5.3-flash"))
            .expect("the first model");
        assert!(
            cursor.0.contains("▸ "),
            "the cursor keeps its marker: {}",
            cursor.0
        );
        assert!(
            cursor
                .1
                .iter()
                .any(|cell| cell.style().fg == Some(theme.palette.primary)),
            "the cursor keeps the selection colour"
        );
    }

    /// ctrl+o inside the model picker narrows to one provider. The box used to
    /// paint its title and an empty body because the variant never answered
    /// `list()`, so no row reached the frame.
    #[test]
    fn the_provider_filter_paints_its_rows() {
        let theme = home_theme();
        let dialog =
            crate::dialogs::Dialog::model_provider_filter(&["deepseek".into(), "zhipu".into()]);
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
        assert!(painted.contains("all providers"), "{painted}");
        assert!(painted.contains("deepseek"), "{painted}");
        assert!(painted.contains("zhipu"), "{painted}");
    }

    /// The strip states the model the window runs on, so it carries the accent
    /// the lists mark their row in effect with instead of plain body text.
    #[test]
    fn the_status_strip_marks_the_model_the_window_runs_on() {
        let theme = home_theme();
        let status = super::StatusStrip {
            model: Some("glm-5.3-flash".into()),
            ..Default::default()
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 3)).expect("terminal");
        terminal
            .draw(|frame| super::render_status(frame, Rect::new(0, 0, 60, 1), &status, &theme))
            .expect("draw");
        let buffer = terminal.backend().buffer();
        let painted: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
        assert!(painted.contains("glm-5.3-flash"), "{painted}");
        let started = buffer
            .content
            .iter()
            .position(|cell| cell.symbol() == "g")
            .expect("the model's first glyph");
        assert_eq!(
            buffer.content[started].style().fg,
            Some(theme.palette.accent),
            "the model rides the accent"
        );
    }

    /// The offer a settled turn leaves reads where the rotating example would,
    /// and never claims the `!` line, which runs commands instead.
    #[test]
    fn an_offered_task_replaces_the_example_hint() {
        let theme = home_theme();
        let mut composer = crate::editor::Composer::new(Path::new("."));
        composer.set_suggestion(Some("cover the parser with tests".into()));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 6)).expect("terminal");
        let painted = |terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>| {
            terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol().to_string())
                .collect::<String>()
        };
        terminal
            .draw(|frame| {
                let _ = super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                );
            })
            .expect("draw");
        let text = painted(&mut terminal);
        assert!(text.contains("Next: cover the parser with tests"), "{text}");
        assert!(text.contains("(tab)"), "{text}");
        assert!(!text.contains("Ask anything"), "{text}");

        // A draft hides the offer: what the operator wrote is the composer.
        composer.editor.insert_str("hello");
        terminal
            .draw(|frame| {
                let _ = super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                );
            })
            .expect("draw");
        let text = painted(&mut terminal);
        assert!(text.contains("hello"), "{text}");
        assert!(!text.contains("Next: cover"), "{text}");
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
                let _ = super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                );
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
                let _ = super::render_composer(
                    frame,
                    ratatui::layout::Rect::new(0, 0, 80, 6),
                    &composer,
                    &theme,
                );
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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

    /// A command's output is projected as `  │ <line>`. When that line is
    /// longer than the pane it wraps, and the wrapped rows have to keep the
    /// gutter: blanking the prefix turned real output into text starting at
    /// column three with no box edge, which is what an operator reads as "the
    /// whole thing piled into one block".
    /// A fenced code block is drawn as `  ╭ … │ … ╰`. A body row longer than
    /// the pane wraps, and every wrapped row has to keep the `│` gutter —
    /// blanking it makes a long line look like the box fell apart, which is
    /// what an operator reports as "the output is all piled into one column".
    #[test]
    fn a_wrapped_code_block_keeps_its_box_edges() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
        };
        let document = "```\nuname -a 输出是 Darwin host.local 25.5.0 Darwin Kernel Version 25.5.0 RELEASE_ARM64_T8112 arm64\n```";
        let rows = prose_lines(document, &theme);
        let wrapped = wrap_rows(&rows, 50);
        let painted = line_texts(&wrapped);
        let body = painted
            .iter()
            .filter(|row| {
                row.contains("Darwin") || row.contains("Version") || row.contains("arm64")
            })
            .collect::<Vec<_>>();
        assert!(body.len() > 1, "the body wrapped: {painted:?}");
        for row in &body {
            assert!(
                row.contains("│"),
                "a wrapped code-block row lost its box edge: {row:?}\n{painted:?}"
            );
        }
    }

    /// `hang` is a display-cell width while a row's cells are one entry per
    /// char: 20 CJK entries span 40 cells, so a prefix measured across them
    /// used to slice past the end of the row and panic the transcript.
    #[test]
    fn a_hang_wider_than_the_row_entries_wraps_instead_of_panicking() {
        let rows = vec![Row::hung(Line::from("界".repeat(20)), 100)];
        let wrapped = wrap_rows(&rows, 30);
        let painted = line_texts(&wrapped);
        assert!(
            painted.iter().any(|row| row.contains("界")),
            "the row survived intact: {painted:?}"
        );
    }

    #[test]
    fn a_wrapped_tool_output_keeps_its_gutter() {
        let tool = crate::session::ToolPart {
            id: "call_1".into(),
            name: "bash".into(),
            input: serde_json::json!({"command": "uname -a"}),
            output: Some(
                serde_json::json!({
                    "stdout": "Darwin host.local 25.5.0 Darwin Kernel Version 25.5.0: RELEASE_ARM64_T8112 arm64",
                    "exit_code": 0
                })
                .to_string(),
            ),
            failed: false,
            unreturned: false,
        };
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
        };
        let lines = crate::tool::lines(&tool, None, &theme, false, None);
        assert!(lines.len() > 1, "the fixture has a header and a body row");

        // 40 columns forces the body to wrap.
        let rows = lines
            .into_iter()
            .map(|line| {
                let (hang, keep) = tool_row_shape(&line);
                Row::hung_with_edge(line, hang, keep)
            })
            .collect::<Vec<_>>();
        let wrapped = wrap_rows(&rows, 40);
        let painted = line_texts(&wrapped);
        let body_rows = painted
            .iter()
            .filter(|row| row.contains("Darwin") || row.contains("Kernel") || row.contains("arm64"))
            .collect::<Vec<_>>();
        assert!(body_rows.len() > 1, "the body wrapped: {painted:?}");
        for row in &body_rows {
            assert!(
                row.starts_with("  │ "),
                "a wrapped command-output row lost its gutter: {row:?}\n{painted:?}"
            );
        }
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
    fn a_cjk_row_fills_its_width_instead_of_stopping_at_a_blank() {
        // Chinese breaks between characters, so only a word that would be cut
        // apart pulls the row back to a blank. Ending every row at the last
        // blank left the tail of a sentence alone on a row: the operator sees
        // `自证。` on a line of its own.
        let rows = wrap_lines(&[Line::from("中文 ab 中文文")], 10);
        assert_eq!(line_texts(&rows), vec!["中文 ab 中", "文文"]);
    }

    #[test]
    fn closing_punctuation_never_opens_a_row() {
        let rows = wrap_lines(&[Line::from("中文中文。")], 4);
        assert_eq!(line_texts(&rows), vec!["中文", "中", "文。"]);
        // A word keeps the punctuation company instead of being cut for it.
        let rows = wrap_lines(&[Line::from("ab cd，ef")], 6);
        assert_eq!(line_texts(&rows), vec!["ab ", "cd，ef"]);
    }

    #[test]
    fn a_chinese_sentence_keeps_its_tail_off_a_row_of_its_own() {
        // The reported symptom, in the sentence that showed it: backing off to
        // the last blank produced `[58, 60, 49, 9]` here, so `success。` sat
        // alone. Only a paragraph's own remainder may be short.
        let sentence = "验证：builder 上 fmt、clippy、三个测试全通过；合并后 main 推送的 tui / tui (macos-14)、engine (macos-arm64)、engine / cli (macos-arm64) 全部 success，整个 ci run 结论 success。";
        let rows = wrap_lines(&[Line::from(sentence)], 60);
        let texts = line_texts(&rows);
        assert!(texts.len() > 1, "the sentence wrapped: {texts:?}");
        for row in &texts[..texts.len() - 1] {
            let width = UnicodeWidthStr::width(row.as_str());
            assert!(
                width > 52,
                "a row of the sentence stopped early at {width} cells: {row:?} in {texts:?}"
            );
        }
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft(&[DraftPart::Text("streamed words".into())]);
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft(&[
            DraftPart::Text("streamed words".into()),
            DraftPart::Reasoning("considering".into()),
        ]);
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
        shell.set_draft(&[]);
        assert!(shell.draft().is_empty());
    }

    #[test]
    fn the_draft_names_the_thinking_in_one_muted_header() {
        // The TS transcript shows thinking as one header line while it streams
        // and keeps that line once the answer starts; the reasoning text itself
        // never tiles the screen.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let mut shell = Shell::new(
            Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_draft(&[DraftPart::Reasoning(
            "reading the diff\nthen the tests".into(),
        )]);
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
        shell.set_draft(&[
            DraftPart::Text("partial".into()),
            DraftPart::Reasoning("reading the diff\nthen the tests".into()),
        ]);
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
    fn the_prompt_renders_as_one_marked_line() {
        // The operator's own words are a line, not a panel: an accent `❯`, the
        // text, and nothing framing it. The panel it used to be drew a rule
        // above and below plus a background band, so a one-line question took
        // five rows of screen and read as a box something had been put into.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        assert_eq!(text(&lines[1]), "❯ question", "the prompt is one line");
        assert_eq!(
            lines[1].line.style.bg, None,
            "and carries no background band"
        );
        // Prose opens below the prompt's trailing blank row, under a muted
        // bullet, and the step closes with the check footer naming the agent
        // and the model.
        assert_eq!(text(&lines[2]), "");
        assert_eq!(text(&lines[3]), "");
        assert!(
            text(&lines[4]).starts_with("● answer"),
            "{:?}",
            text(&lines[4])
        );
        assert_eq!(text(&lines[5]), "");
        assert_eq!(text(&lines[6]), "  ✓ General · glm-5");
    }

    /// The footer names the agent and the model only when the step differs from
    /// the one before it. Repeating the same label under every turn said
    /// nothing the status line did not already show, which is why a transcript
    /// read `✓ Miao · deepseek-v4-1-flash-261017` down the whole pane.
    #[test]
    fn the_step_footer_names_the_identity_only_when_it_changes() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let step = |model: &str, text: &str| Entry::Assistant {
            agent: Some("miao".into()),
            model: Some(model.into()),
            parts: vec![Part::Text(text.into())],
        };
        let transcript = Transcript {
            entries: vec![
                step("deepseek-v4", "first"),
                step("deepseek-v4", "second"),
                step("glm-5", "third"),
                step("glm-5", "fourth"),
            ],
            ..Transcript::default()
        };
        let lines = transcript_lines(&transcript, &theme, false, None).rows;
        let footers = lines
            .iter()
            .map(row_text)
            .filter(|text| text.contains('✓'))
            .collect::<Vec<_>>();
        assert_eq!(
            footers,
            ["  ✓ Miao · deepseek-v4", "  ✓", "  ✓ Miao · glm-5", "  ✓"]
        );
    }

    #[test]
    fn consecutive_inline_tools_butt_together_like_the_typescript_rows() {
        // Two single-row tools read as one list; prose reopens the gap the way
        // the TS sibling margin does.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
            unreturned: false,
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
            "· WebSearch  q",
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
    fn a_changed_diff_row_paints_to_the_pane_edge() {
        // The changed rows of one block are not padded to the block's longest
        // line: a row keeps its own text and the pane fills the rest in the
        // row's colour, so a short change and a long one are bands of the same
        // width and the block's right edge is straight.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut displays = HashMap::new();
        displays.insert(
            "call_diff".to_string(),
            vec![crate::session::DisplayFile {
                path: "src/lib.rs".into(),
                action: "update".into(),
                patch: "@@ -1,2 +1,2 @@\n-short\n+short changed but longer\n kept\n".into(),
                additions: 1,
                deletions: 1,
            }],
        );
        let transcript = Transcript {
            entries: vec![Entry::Assistant {
                agent: None,
                model: None,
                parts: vec![Part::Tool(crate::session::ToolPart {
                    id: "call_diff".into(),
                    name: "edit".into(),
                    input: serde_json::json!({"path": "src/lib.rs"}),
                    output: Some(serde_json::json!({"applied": true}).to_string()),
                    failed: false,
                    unreturned: false,
                })],
            }],
            displays,
            ..Transcript::default()
        };
        let mut shell = Shell::new(Path::new("."), theme);
        shell.set_transcript(&transcript);
        let width = 60u16;
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 16))
            .expect("terminal");
        terminal
            .draw(|frame| shell.transcript.render(frame, frame.area()))
            .expect("draw");
        let buffer = terminal.backend().buffer();
        let rows = buffer.content.chunks(width as usize).collect::<Vec<_>>();
        let find = |needle: &str| {
            rows.iter()
                .position(|row| {
                    row.iter()
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains(needle)
                })
                .unwrap_or_else(|| panic!("no row holds {needle}"))
        };
        let last = width as usize - 1;
        for (needle, tint) in [
            ("+short changed but longer", palette.diff_block(true)),
            ("-short", palette.diff_block(false)),
        ] {
            let row = rows[find(needle)];
            for column in [0, last] {
                assert_eq!(
                    row[column].bg, tint,
                    "{needle:?} paints column {column} as its own band"
                );
            }
        }
    }

    #[test]
    fn the_composer_title_names_the_run_the_queue_and_notices() {
        // The box's title is where the run's state lives: what the run is
        // doing, what is waiting, and anything the operator must know. An idle
        // Session says only the box's own name.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut composer = crate::editor::Composer::new(Path::new("."));
        // An idle box carries no widget label: the word "composer" named the
        // widget rather than saying anything about the run.
        assert_eq!(
            draw_composer(&mut composer, &theme),
            "┌──────────────────────────────────────┐",
            "an idle session names nothing"
        );

        composer.phase = Some("Running bash".into());
        composer.queued = 2;
        let titled = draw_composer(&mut composer, &theme);
        assert!(titled.contains("Running bash"), "{titled}");
        assert!(titled.contains("2 queued"), "{titled}");
    }

    #[test]
    fn a_waiting_run_in_the_composer_title_turns_warning_colored() {
        // The tone is the only signal that separates a model still thinking
        // from one that has gone quiet; a monochrome title left the operator to
        // read the words every frame.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut composer = crate::editor::Composer::new(Path::new("."));
        composer.phase = Some("Waiting for model".into());
        composer.phase_alert = true;
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 3)).expect("terminal");
        terminal
            .draw(|frame| {
                let _ = render_composer(frame, frame.area(), &composer, &theme);
            })
            .expect("draw");
        let warning = theme.palette.warning;
        let painted = (0..40).any(|x| terminal.backend().buffer()[(x, 0)].fg == warning);
        assert!(painted, "the alerting title uses the warning tone");
    }

    /// A draft wider than the box wraps onto the next input row instead of
    /// sliding its head out of view, so the operator can read what they typed
    /// rather than only its tail.
    #[test]
    fn a_long_draft_wraps_inside_the_box() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut composer = crate::editor::Composer::new(Path::new("."));
        composer.editor.set_text(&"abcdefghij".repeat(8));
        let rows = paint_composer(&composer, &theme, 40, 8);
        assert!(rows[2].contains("abcdefghij"), "the head stays visible");
        assert!(
            rows[3].trim_end().chars().count() > 2,
            "the draft continues on the next row: {:?}",
            rows
        );
    }

    /// The landing prompt grows with its draft the way the Session composer
    /// does, up to the TypeScript prompt's `max_height` of `max(6, height/3)`.
    #[test]
    fn the_landing_prompt_grows_with_its_draft() {
        let mut composer = crate::editor::Composer::new(Path::new("."));
        assert_eq!(composer_height(&composer, 75, 40), 3, "one row and borders");
        composer.editor.set_text(&"x".repeat(200));
        // 200 cells wrap at the 71 columns the box leaves for text.
        assert_eq!(composer_height(&composer, 75, 40), 2 + 3);
        // A tall draft stops at the cap the TS prompt uses, not a fixed eight.
        composer.editor.set_text(&"x".repeat(2000));
        assert_eq!(composer_height(&composer, 75, 12), 2 + 6);
    }

    /// The landing prompt is the product's open band: 75 columns, a rule above
    /// and one below, no sides, and the draft two cells in from either edge on
    /// the element ground. The closed box it used to be read as a small,
    /// separate widget rather than the home's own input.
    #[test]
    fn the_landing_prompt_is_the_products_open_band() {
        let theme = home_theme();
        let mut home = Home::new(theme.clone());
        // The band's shape is what this test is about, so the width is pinned
        // to the product's fixed cap; the default is `"auto"`, and its own
        // arithmetic is asserted below.
        home.set_prompt_width(crate::config::PromptWidth::Fixed(75));
        let mut composer = crate::editor::Composer::new(Path::new("."));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 30)).expect("terminal");
        terminal
            .draw(|frame| home.render(frame, frame.area(), &mut composer))
            .expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let row = |y: u16| {
            (0..120)
                .map(|x| buffer[(x, y)].symbol().to_string())
                .collect::<String>()
        };
        let rule = "─".repeat(75);
        let rules = (0..30)
            .filter(|y| row(*y).contains(&rule))
            .collect::<Vec<_>>();
        assert_eq!(rules.len(), 2, "one rule above the draft and one below");
        let (top, bottom) = (rules[0], rules[1]);
        assert_eq!(bottom - top, 2, "the band is a rule, the draft, a rule");
        // The band is capped at the TypeScript default and centred on the
        // window, so a wide terminal does not stretch the input.
        assert_eq!(row(top).find('─'), Some(22), "{:?}", row(top));
        assert_eq!(row(top).trim_end().chars().count(), 97);
        // No vertical borders: the cells beside the band stay blank.
        assert_eq!(buffer[(21, top)].symbol(), " ");
        assert_eq!(buffer[(97, top)].symbol(), " ");
        // The draft starts two cells in from the edge, on the element ground.
        assert_eq!(buffer[(24, top + 1)].symbol(), "A");
        assert_eq!(buffer[(24, top + 1)].bg, theme.palette.element);
        assert!(row(top + 1).contains("Ask anything"), "{:?}", row(top + 1));
        // The banner sits above it, centred as one block.
        let banner_row = row(top - 6);
        assert!(banner_row.contains("/\\/\\"), "{banner_row:?}");
        assert_eq!(banner_row.find('/'), Some(46), "{banner_row:?}");
        assert!(banner_row.contains('█'), "{banner_row:?}");
        // The default scales with the window instead of sitting at the
        // product's fixed 75 columns.
        assert_eq!(
            crate::config::PromptWidth::default().resolve(120),
            84,
            "the default band is 70% of a 120-column window"
        );
    }

    /// The landing prompt is not a one-row field: a draft with newlines in it
    /// grows the band and shows every line, which is what makes `shift+enter`
    /// (or a pasted multi-line prompt) usable before a Session exists.
    #[test]
    fn the_landing_band_shows_every_line_of_its_draft() {
        let theme = home_theme();
        let mut home = Home::new(theme.clone());
        home.set_prompt_width(crate::config::PromptWidth::Fixed(75));
        let mut composer = crate::editor::Composer::new(Path::new("."));
        composer
            .editor
            .set_text("first line\nsecond line\nthird line");
        // Two rules and one row per draft line.
        assert_eq!(composer_height(&composer, 75, 30), 2 + 3);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 30)).expect("terminal");
        terminal
            .draw(|frame| home.render(frame, frame.area(), &mut composer))
            .expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let row = |y: u16| {
            (0..120)
                .map(|x| buffer[(x, y)].symbol().to_string())
                .collect::<String>()
        };
        let rule = "─".repeat(75);
        let rules = (0..30)
            .filter(|y| row(*y).contains(&rule))
            .collect::<Vec<_>>();
        assert_eq!(rules.len(), 2, "one rule above the draft and one below");
        let (top, bottom) = (rules[0], rules[1]);
        // Two rules plus three draft rows: a five-row band, so the rules sit
        // four rows apart.
        assert_eq!(
            bottom - top,
            2 + 3 - 1,
            "three draft rows between the rules"
        );
        for (offset, line) in ["first line", "second line", "third line"]
            .iter()
            .enumerate()
        {
            let painted = row(top + 1 + offset as u16);
            assert!(
                painted.contains(line),
                "line {offset} of the draft is missing: {painted:?}"
            );
        }
    }

    /// A queued prompt names itself above the input: the title only carried a
    /// count, which read as a lost message.
    #[test]
    fn a_queued_prompt_is_named_above_the_input() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let mut shell = Shell::new(Path::new("."), theme);
        shell.set_pending_prompts(&["finish every issue".to_string()]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 24)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(120)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let queued = rows
            .iter()
            .position(|row| row.contains("finish every issue"))
            .expect("the queued prompt is painted");
        assert!(rows[queued].contains("· queued"), "{}", rows[queued]);
        // The idle box carries no label, so the box's own rule is what locates
        // it now.
        let input = rows
            .iter()
            .position(|row| row.trim_start().starts_with('┌'))
            .expect("the input is painted");
        assert!(queued < input, "the queue sits above the input");
    }

    /// Paint the composer into a fixed frame and read its rows back as strings.
    fn paint_composer(
        composer: &crate::editor::Composer,
        theme: &Theme,
        width: u16,
        height: u16,
    ) -> Vec<String> {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height))
                .expect("terminal");
        terminal
            .draw(|frame| {
                let _ = render_composer(frame, frame.area(), composer, theme);
            })
            .expect("draw");
        terminal
            .backend()
            .buffer()
            .content
            .chunks(width as usize)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect()
    }

    /// Paint the composer at a fixed width and return its top border row,
    /// trimmed, so a test can read the title the box carries.
    fn draw_composer(composer: &mut crate::editor::Composer, theme: &Theme) -> String {
        let width = 40u16;
        let height = 3u16;
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height))
                .expect("terminal");
        terminal
            .draw(|frame| {
                let _ = render_composer(frame, frame.area(), composer, theme);
            })
            .expect("draw");
        (0..width)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn the_status_strip_carries_the_queued_count_like_the_typescript_hints() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
    fn the_status_strip_pins_the_running_build_at_its_right_edge() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let status = StatusStrip {
            model: Some("glm-5".into()),
            ..StatusStrip::default()
        };
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
        let version = format!("miao {}", crate::VERSION);
        assert!(text.contains(&version), "the strip names the build: {text}");
        assert!(
            text.trim_end().ends_with(&version),
            "the build sits at the right edge: {text}"
        );
    }

    #[test]
    fn a_running_tool_rides_the_tail_as_one_spinner_row() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
                    parts: vec![Part::Text("answer. ".repeat(90).trim_end().into())],
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

    /// The in-flight call's row never passes the wrapper that clips completed
    /// rows, so a long label used to ride the tail across the divider into the
    /// sidebar column. The painted row ends inside the transcript column, at
    /// the ellipsis `fit` writes for a clip, and the sidebar's rule keeps its
    /// own cell.
    #[test]
    fn a_long_running_tool_label_clips_to_the_transcript_column() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
                    parts: vec![Part::Text("answer. ".repeat(90).trim_end().into())],
                },
            ],
            ..Transcript::default()
        };
        shell.set_transcript(&transcript);
        let label = "巡检 4 个从零子会话(TOOL-01 · 分支 · worktrees)".repeat(6);
        shell.set_running_tool(Some(label));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 24)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let rows = (0..24)
            .map(|y| {
                (0..120)
                    .map(|x| {
                        terminal
                            .backend()
                            .buffer()
                            .cell(ratatui::prelude::Position::new(x, y))
                            .map(|cell| cell.symbol().to_string())
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        // On a 120-column window the transcript ends on column 76 and the
        // sidebar's rule sits on 77: exactly the boundary the row crossed.
        let (y, row) = rows
            .iter()
            .enumerate()
            .find(|(_, row)| row[..77].concat().contains("running"))
            .expect("the spinner row is painted");
        let left = row[..77].concat();
        assert!(
            left.trim_end().ends_with('…'),
            "the label clips at the column edge: {left:?}"
        );
        assert_eq!(row[77], "│", "the sidebar's rule keeps its cell: row {y}");
    }

    #[test]
    fn thinking_folds_away_once_the_step_has_prose() {
        // The TS default ("hide") drops reasoning that produced prose; a step
        // with no text keeps one duration header so a model that narrates
        // between tools still reads as having thought.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
        assert_eq!(sidebar.width, SIDEBAR_WIDTH + 1);
        assert_eq!(
            sidebar.x,
            prose.right(),
            "the sidebar starts on the divider column"
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
        // The sidebar starts on the divider column and owns it: a column
        // belonging to neither pane kept the terminal's default background.
        assert_eq!(sidebar.x, prose.right());
        // The divider column is the sidebar's, so its rectangle is one wider
        // than the content column it holds.
        assert_eq!(sidebar.width, SIDEBAR_WIDTH + 1);
        assert_eq!(prose.width, 120 - SIDEBAR_WIDTH - 1);
        // A body narrower than the threshold has no sidebar at all.
        let (prose, sidebar) = body_columns(Rect::new(0, 0, 99, 20));
        assert!(sidebar.is_none());
        assert_eq!(prose.width, 99);
    }

    #[test]
    fn a_wide_frame_paints_the_input_across_the_whole_window() {
        // The composer is a named box spanning the window, so its top edge
        // starts at the first column and ends at the last: the sidebar's bottom
        // band is covered rather than left looking cut off beside a
        // prose-width input.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
        // The top border spans the whole window, corner to corner.
        let top = &rows[placeholder - 1];
        assert_eq!(top[0].symbol(), "┌", "the box opens on the window's edge");
        assert_eq!(top[199].symbol(), "┐", "and closes on the other edge");
    }

    /// The composer must start on the same column as the text it answers. It
    /// used to be centred over the window, so on any frame wide enough for the
    /// sidebar the input sat ~20 columns to the right of the transcript.
    #[test]
    fn the_input_starts_on_the_transcripts_column() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
        // The transcript and the composer share their left edge: the box opens
        // on the window's first column and so does the transcript's `❯`, so the
        // text an operator typed sits directly above the box they type into.
        let input = column_of("┌");
        let marker = column_of("❯");
        assert_eq!(input, 0, "the composer box opens on the window edge");
        assert_eq!(marker, 0, "and the transcript starts on that same column");
    }

    #[test]
    fn a_wide_frame_keeps_the_transcript_at_a_readable_measure() {
        // A 200-column terminal should give the prose margins rather than
        // 200-column lines: the same rule the session list follows.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
                row.starts_with("  "),
                "a continuation hangs under the marker column: {row:?}"
            );
        }
    }

    #[test]
    fn the_thought_header_clips_instead_of_folding() {
        // TS ReasoningHeader is `wrapMode="none"`: a long summary is cut at the
        // row, never folded into a second line.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        // The elapsed time rides the phase it measures, inside the composer's
        // title: one fact on one line, in the box the operator is typing into.
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
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
        let phase_row = (0..12)
            .map(row_at)
            .find(|row| row.contains("Waiting for model"))
            .expect("the phase row is painted");
        assert!(
            phase_row.contains("2.0s"),
            "the elapsed time rides the phase: {phase_row:?}"
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

    /// The renderer marks exactly the selected cells, and a row that starts
    /// partway into the logical line highlights by the logical cell rather than
    /// by its position on the row.
    #[test]
    fn the_composer_line_highlights_only_the_selected_cells() {
        let text = Style::new().fg(ratatui::style::Color::Reset);
        let highlighted = Style::new().bg(ratatui::style::Color::Indexed(4));
        let line = composer_line("ab cd", 0, Some((1, 3)), text, highlighted);
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

        // Two CJK characters are four cells, so the selection covers both.
        let line = composer_line("你好世界", 0, Some((0, 4)), text, highlighted);
        assert_eq!(line.spans.len(), 2);
        assert_eq!(line.spans[0].content.to_string(), "你好");
        // A wrapped row carries the cells it starts at, so the highlight still
        // lands on the character the operator selected.
        let line = composer_line("好世界", 2, Some((2, 4)), text, highlighted);
        let spans = line
            .spans
            .iter()
            .map(|span| (span.content.to_string(), span.style))
            .collect::<Vec<_>>();
        assert_eq!(
            spans,
            vec![("好".to_string(), highlighted), ("世界".to_string(), text)]
        );
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
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
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
            .draw(|frame| {
                let _ = render_composer(frame, frame.area(), &composer, &theme);
            })
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

    /// The composer already knew how to select with the keyboard; the pointer
    /// had nowhere to land, so a draft could not be copied at all.
    #[test]
    fn a_drag_over_the_session_draft_copies_what_it_covered() {
        let mut shell = Shell::new(Path::new("."), home_theme());
        shell.composer.editor.set_text("hello world");
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let draft = shell.composer_text.expect("the composer painted its draft");
        assert!(
            shell.begin_selection(Position::new(draft.input.x, draft.input.y)),
            "a press on the draft belongs to the composer"
        );
        shell.update_selection(Position::new(draft.input.x + 4, draft.input.y));
        assert_eq!(
            shell.take_selection().as_deref(),
            Some("hell"),
            "the drag covered the first four cells"
        );
    }

    /// Queued prompts are painted text with no editing model, and they could not
    /// be selected either: the band above the input takes a drag the way the
    /// transcript does, and the release copies the row it covered.
    #[test]
    fn a_drag_over_the_queued_rows_copies_them() {
        let mut shell = Shell::new(Path::new("."), home_theme());
        shell.set_pending_prompts(&["queued prompt".to_string()]);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 14)).expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let area = shell.queued.area;
        assert!(area.height > 0, "the queue band painted: {area:?}");
        assert!(
            shell.begin_selection(Position::new(area.x, area.y)),
            "the press belongs to the queued rows"
        );
        // The loop draws between the press and the drag; a repaint must keep
        // the anchor instead of starting a fresh band each frame.
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        shell.update_selection(Position::new(area.right().saturating_sub(1), area.y));
        let copied = shell.take_selection().expect("the drag copies the row");
        assert!(
            copied.contains("queued prompt"),
            "the copy is what was painted: {copied:?}"
        );
    }

    /// The landing prompt is the same composer, so the same drag works there.
    #[test]
    fn a_drag_over_the_landing_draft_copies_what_it_covered() {
        let mut home = Home::new(home_theme());
        let mut composer = Composer::new(Path::new("."));
        composer.editor.set_text("draft text");
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(70, 16)).expect("terminal");
        terminal
            .draw(|frame| home.render(frame, frame.area(), &mut composer))
            .expect("draw");
        let draft = home.composer_text.expect("the prompt painted its draft");
        assert!(home.begin_selection(
            &mut composer,
            Position::new(draft.input.x + 6, draft.input.y)
        ));
        home.update_selection(
            &mut composer,
            Position::new(draft.input.x + 10, draft.input.y),
        );
        assert_eq!(home.take_selection(&mut composer).as_deref(), Some("text"));
    }

    fn home_theme() -> Theme {
        Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(
                crate::theme::DEFAULT_THEME,
                crate::theme::ThemeMode::Dark,
            )
            .expect("theme"),
        }
    }

    fn pane_with_text() -> TranscriptPane {
        let mut pane = TranscriptPane::new(home_theme());
        pane.rendered = vec![vec!["a".to_string(), "b".to_string(), "c".to_string()]];
        pane.area = Rect::new(0, 0, 3, 1);
        pane
    }

    /// Press and release on one cell is a click, not a selection. It used to
    /// copy a single character and announce "Copied 1 characters", which reads
    /// as the app grabbing whatever the pointer covered.
    #[test]
    fn a_click_that_never_moved_selects_nothing() {
        let mut pane = pane_with_text();
        pane.begin_selection(Position { x: 1, y: 0 });
        assert_eq!(pane.take_selection(), None);
    }

    /// A real drag still copies exactly the cells it covered.
    #[test]
    fn a_drag_still_returns_the_cells_it_covered() {
        let mut pane = pane_with_text();
        pane.begin_selection(Position { x: 0, y: 0 });
        pane.update_selection(Position { x: 2, y: 0 });
        assert_eq!(pane.take_selection().as_deref(), Some("abc"));
    }

    /// A double click selects the run `joins_word` keeps whole: the letters,
    /// and the punctuation inside paths and flags.
    #[test]
    fn a_double_click_selects_the_word_under_the_cell() {
        let mut pane = TranscriptPane::new(home_theme());
        let row = "run crates/tui next"
            .chars()
            .map(|character| character.to_string())
            .collect::<Vec<_>>();
        pane.rendered = vec![row];
        pane.area = Rect::new(0, 0, 19, 1);
        assert!(pane.select_word_at(Position { x: 5, y: 0 }));
        assert_eq!(pane.take_selection().as_deref(), Some("crates/tui"));
    }

    /// A cell that starts no word stays a click: a double click on a gap must
    /// not copy whatever happens to sit next to it.
    #[test]
    fn a_double_click_on_a_gap_selects_nothing() {
        let mut pane = TranscriptPane::new(home_theme());
        let row = "a b"
            .chars()
            .map(|character| character.to_string())
            .collect::<Vec<_>>();
        pane.rendered = vec![row];
        pane.area = Rect::new(0, 0, 3, 1);
        assert!(!pane.select_word_at(Position { x: 1, y: 0 }));
        assert_eq!(pane.take_selection(), None);
    }

    /// A double click outside the painted pane is no gesture at all.
    #[test]
    fn a_double_click_outside_the_pane_selects_nothing() {
        let mut pane = pane_with_text();
        assert!(!pane.select_word_at(Position { x: 0, y: 5 }));
    }

    /// The selection is consumed either way, so a click followed by a drag
    /// starts clean rather than extending a stale anchor.
    /// The transcript shares the sidebar's rows, so a pointer at the same
    /// height in the main column must not open the sidebar's tooltip. The
    /// tooltip used to key on the row alone and appeared across the whole line.
    #[test]
    fn a_hover_tip_answers_only_inside_the_sidebar_column() {
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_t", "todos", None)),
            usage: None,
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: vec![crate::session::TodoView {
                content: "a todo long enough that the column has to clip it".to_string(),
                status: "in_progress".to_string(),
            }],
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 20)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");

        let tip = sidebar
            .hover_rows
            .first()
            .expect("the todo row is hoverable");
        let (row, span) = (tip.row, tip.span);
        assert_eq!(
            sidebar.hover_tip(span.0, row),
            Some("a todo long enough that the column has to clip it"),
            "the sidebar's own column answers"
        );
        assert_eq!(
            sidebar.hover_tip(0, row),
            None,
            "the same row in the transcript's column answers nothing"
        );
        assert_eq!(sidebar.hover_tip(span.0, row + 100), None);
    }

    #[test]
    fn a_click_clears_its_anchor() {
        let mut pane = pane_with_text();
        pane.begin_selection(Position { x: 1, y: 0 });
        assert_eq!(pane.take_selection(), None);
        pane.begin_selection(Position { x: 0, y: 0 });
        pane.update_selection(Position { x: 2, y: 0 });
        assert_eq!(pane.take_selection().as_deref(), Some("abc"));
    }

    /// The strip keeps one cell per hour and marks the hour that is still
    /// filling: a reader counting glyphs must see the window it was promised,
    /// and a monochrome terminal must still see where "now" is.
    #[test]
    fn the_hourly_strip_keeps_one_cell_per_hour() {
        let buckets = (0..24)
            .map(|index| crate::status::HourlyBucket {
                start_ms: 1_760_000_000_000 + index * 3_600_000,
                tokens: match index % 3 {
                    0 => 0,
                    1 => 1_000 * (index + 1),
                    _ => 40_000,
                },
                turns: 1,
                cost_usd: 0.001,
            })
            .collect::<Vec<_>>();
        let usage = crate::status::HourlyUsage {
            buckets,
            models: Vec::new(),
            input: 300_000,
            output: 9_000,
            cache_read: 120_000,
            turns: 24,
            tokens: 309_000,
            cost_usd: 0.024,
            cost_turns: 24,
            peak: Some((1_760_000_000_000 + 12 * 3_600_000, 40_000)),
            truncated: false,
            cache_hit_ratio: Some(0.4),
        };
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_u", "usage", None)),
            usage: None,
            usage_hourly: Some(usage.clone()),
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 30)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let header = rows
            .iter()
            .position(|row| row.contains("Last 24h"))
            .expect("hourly header");
        assert!(
            rows[header].contains("workspace"),
            "the strip says what it totals: {:?}",
            rows[header]
        );
        let strip = &rows[header + 1];
        let cells = strip
            .chars()
            .filter(|glyph| "▁▂▃▄▅▆▇█·".contains(*glyph))
            .count();
        assert_eq!(cells, 24, "one cell per hour: {strip:?}");
        assert!(
            rows[header + 2].contains('▸'),
            "the filling hour is marked: {:?}",
            rows[header + 2]
        );
        let money = rows[header + 3..]
            .iter()
            .find(|row| row.contains('$'))
            .expect("reported cost row");
        assert!(money.contains("0.02"), "reported cost is shown: {money:?}");

        // A column too narrow for 24 glyphs pairs the hours instead of
        // dropping them: the shape of the day is the point, not the count.
        let palette = home_theme().palette;
        let (narrow, narrow_hover) = hourly_lines(sidebar.usage_hourly.as_ref(), 20, &palette);
        assert_eq!(narrow[1].spans.len(), 12, "narrow columns pair hours");
        assert!(
            narrow_hover.is_empty(),
            "no model rows, no hover candidates"
        );

        sidebar.usage_hourly = Some(crate::status::HourlyUsage {
            cost_turns: 3,
            truncated: true,
            ..usage
        });
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let rendered = rows.join("\n");
        assert!(
            rendered.contains("partial"),
            "retention is stated: {rendered}"
        );
        assert!(rendered.contains('~'), "partial cost coverage is marked");
    }

    /// A day spread across providers reads as groups: the provider heads its
    /// own block and its models indent under it, while a single-provider day
    /// keeps the flat rows it always had and an unattributed model stays flat.
    /// Each model row is hoverable with its full text, because the column
    /// clips what it cannot fit.
    #[test]
    fn provider_groups_head_the_hourly_model_rows_and_rows_are_hoverable() {
        let buckets = (0..24)
            .map(|index| crate::status::HourlyBucket {
                start_ms: 1_760_000_000_000 + index * 3_600_000,
                tokens: if index == 5 { 50_000 } else { 0 },
                turns: 1,
                cost_usd: 0.001,
            })
            .collect::<Vec<_>>();
        let model = |provider: Option<&str>, name: &str, input: u64| crate::status::HourlyModel {
            provider: provider.map(str::to_string),
            model: name.to_string(),
            input,
            output: input / 10,
            cache_read: 0,
            turns: 1,
            cost_usd: 0.001,
        };
        let usage = crate::status::HourlyUsage {
            buckets,
            models: vec![
                model(Some("zhipuai-coding-plan"), "glm-5.3-flash", 900_000),
                model(Some("opencode-go"), "deepseek-v4.1-flash", 400_000),
                model(None, "claude-opus", 100_000),
            ],
            input: 1_400_000,
            output: 140_000,
            cache_read: 0,
            turns: 3,
            tokens: 1_540_000,
            cost_usd: 0.003,
            cost_turns: 3,
            peak: None,
            truncated: false,
            cache_hit_ratio: None,
        };
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_p", "providers", None)),
            usage: None,
            usage_hourly: Some(usage),
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 30)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let joined = rows.join("\n");
        assert!(
            joined.contains("zhipuai-coding-plan"),
            "the provider heads its group: {joined:?}"
        );
        assert!(
            joined.contains("  - glm-5.3-flash"),
            "models indent under the provider: {joined:?}"
        );
        // The unattributed model stays a flat row: no route, no group to head.
        assert!(
            joined.contains("  claude-opus"),
            "no route keeps the flat row: {joined:?}"
        );
        assert_eq!(
            joined.matches("zhipuai-coding-plan").count(),
            1,
            "one header per contiguous group, never one per model: {joined:?}"
        );
        let tip = sidebar
            .hover_rows
            .iter()
            .find(|tip| tip.text.contains("glm-5.3-flash"))
            .expect("clipped model rows are hoverable");
        assert!(
            tip.text.contains("· in "),
            "the hover carries the full row: {tip:?}"
        );
    }

    /// The column names the chord that hides it on its own last row. A
    /// checklist long enough to fill the column must not push the one key that
    /// makes the column disappear off the screen, and an unbound action must
    /// not promise a key that does nothing.
    #[test]
    fn the_sidebar_pins_the_chord_that_hides_it_to_its_last_row() {
        fn rows(terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>) -> Vec<String> {
            terminal
                .backend()
                .buffer()
                .content
                .chunks(60)
                .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect()
        }

        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_k", "keys", None)),
            usage: None,
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: (0..40)
                .map(|index| crate::session::TodoView {
                    content: format!("todo {index}"),
                    status: "pending".to_string(),
                })
                .collect(),
            chord: Some("ctrl+x b".to_string()),
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let painted = rows(&mut terminal);
        let last = painted.last().expect("a last row");
        assert!(
            last.contains("ctrl+x b") && last.contains("hide sidebar"),
            "the chord that hides the column is its last row: {last:?}"
        );
        assert!(
            !painted.iter().any(|row| row.contains("todo 39")),
            "the hint takes its room from the list rather than covering it: {painted:?}"
        );

        sidebar.chord = None;
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        assert!(
            !rows(&mut terminal)
                .iter()
                .any(|row| row.contains("hide sidebar")),
            "an unbound action promises no chord"
        );
    }

    /// A day with one expensive hour must still show the shape of the other
    /// twenty-three. Scaling bar height to the busiest hour flattened them all
    /// onto the baseline, so the strip said "one spike" and nothing else.
    #[test]
    fn one_outlier_hour_does_not_flatten_the_rest_of_the_strip() {
        let buckets = (0..24)
            .map(|index| crate::status::HourlyBucket {
                start_ms: 1_760_000_000_000 + index * 3_600_000,
                tokens: match index {
                    15 => 100_000,
                    _ => 1_000,
                },
                turns: 1,
                cost_usd: 0.001,
            })
            .collect::<Vec<_>>();
        let usage = crate::status::HourlyUsage {
            buckets,
            models: Vec::new(),
            input: 123_000,
            output: 1_000,
            cache_read: 0,
            turns: 24,
            tokens: 123_000,
            cost_usd: 0.024,
            cost_turns: 24,
            peak: Some((1_760_000_000_000 + 15 * 3_600_000, 100_000)),
            truncated: false,
            cache_hit_ratio: Some(0.0),
        };
        let theme = home_theme();
        let (strip, _) = hourly_lines(Some(&usage), 40, &theme.palette);
        let glyphs = strip[1]
            .spans
            .iter()
            .map(|span| span.content.to_string())
            .collect::<Vec<_>>();
        assert_eq!(glyphs.len(), 24);
        assert_eq!(
            glyphs[0], "▇",
            "a typical hour keeps nearly the whole height: {glyphs:?}"
        );
        assert_eq!(
            glyphs[15], "█",
            "the outlier fills the top level: {glyphs:?}"
        );
        assert_eq!(
            strip[1].spans[15].style.fg,
            Some(theme.palette.warning),
            "the outlier keeps its warning colour"
        );
    }

    #[test]
    fn an_unhealthy_cache_hit_carries_its_recommendation_and_a_healthy_one_does_not() {
        let theme = home_theme();
        // `input` is the whole prompt, cache reads included: the engine reports
        // the ratio, and a cached turn can never read more than it sent.
        let build = |input: u64, cache_read: u64| {
            let bucket = |index: u64| crate::status::HourlyBucket {
                start_ms: 1_760_000_000_000 + index * 3_600_000,
                tokens: (input + 1_000) / 6,
                turns: 1,
                cost_usd: 0.001,
            };
            crate::status::HourlyUsage {
                buckets: (0..6).map(bucket).collect(),
                models: Vec::new(),
                input,
                output: 1_000,
                cache_read,
                turns: 6,
                tokens: input + 1_000,
                cost_usd: 0.01,
                cost_turns: 6,
                peak: None,
                truncated: false,
                cache_hit_ratio: Some(cache_read as f64 / input as f64),
            }
        };
        let (unhealthy, _) = hourly_lines(Some(&build(120_000, 10_000)), 40, &theme.palette);
        let joined = unhealthy
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(
            joined.contains("/compact"),
            "a low hit with heavy billed input names the fix: {joined:?}"
        );
        let (healthy, _) = hourly_lines(Some(&build(120_000, 110_000)), 40, &theme.palette);
        let joined = healthy
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(
            !joined.contains("/compact"),
            "a healthy hit stays quiet: {joined:?}"
        );
        let (small, _) = hourly_lines(Some(&build(3_000, 1_000)), 40, &theme.palette);
        let joined = small
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(
            !joined.contains("/compact"),
            "a small session is not worth a recommendation: {joined:?}"
        );
    }

    /// The totals never name the model that earned them, so the strip repeats
    /// them per served model, busiest first; a report without the array (an
    /// older engine) renders no rows rather than an empty shell.
    #[test]
    fn the_strip_names_the_models_that_earned_the_totals() {
        let theme = home_theme();
        let model =
            |name: &str, input: u64, output: u64, cache_read: u64| crate::status::HourlyModel {
                provider: None,
                model: name.to_string(),
                input,
                output,
                cache_read,
                turns: 1,
                cost_usd: 0.0,
            };
        let usage = crate::status::HourlyUsage {
            buckets: (0..24)
                .map(|index| crate::status::HourlyBucket {
                    start_ms: 1_760_000_000_000 + index * 3_600_000,
                    tokens: if index == 23 { 2_100 } else { 0 },
                    turns: 0,
                    cost_usd: 0.0,
                })
                .collect::<Vec<_>>(),
            models: vec![
                model("glm-5", 1_200, 300, 900),
                model("claude-opus", 500, 100, 0),
            ],
            input: 1_700,
            output: 400,
            cache_read: 900,
            turns: 2,
            tokens: 2_100,
            cost_usd: 0.0,
            cost_turns: 0,
            peak: None,
            truncated: false,
            cache_hit_ratio: None,
        };
        let (strip, _) = hourly_lines(Some(&usage), 40, &theme.palette);
        let joined = strip
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(
            joined.contains("glm-5 · in 1.2k · out 300 · 75%"),
            "the busiest model leads with its own share: {joined:?}"
        );
        assert!(
            joined.contains("claude-opus · in 500 · out 100 · 0%"),
            "the second model keeps its cold-cache row: {joined:?}"
        );
        let (bare, _) = hourly_lines(
            Some(&crate::status::HourlyUsage {
                models: Vec::new(),
                ..usage
            }),
            40,
            &theme.palette,
        );
        let joined = bare
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(
            !joined.contains("glm-5"),
            "no served names, no invented rows: {joined:?}"
        );
    }

    /// A long tail of models must not crowd the histogram's meaning: six rows
    /// render and the rest fold into one line that says how many.
    #[test]
    fn a_long_model_tail_folds_into_one_line() {
        let theme = home_theme();
        let models = (0..8)
            .map(|index| crate::status::HourlyModel {
                provider: None,
                model: format!("model-{index}"),
                input: 1_000 - index,
                output: 0,
                cache_read: 0,
                turns: 1,
                cost_usd: 0.0,
            })
            .collect::<Vec<_>>();
        let usage = crate::status::HourlyUsage {
            buckets: (0..24)
                .map(|index| crate::status::HourlyBucket {
                    start_ms: 1_760_000_000_000 + index * 3_600_000,
                    tokens: if index == 23 { 8_000 } else { 0 },
                    turns: 0,
                    cost_usd: 0.0,
                })
                .collect::<Vec<_>>(),
            models,
            input: 8_000,
            output: 0,
            cache_read: 0,
            turns: 8,
            tokens: 8_000,
            cost_usd: 0.0,
            cost_turns: 0,
            peak: None,
            truncated: false,
            cache_hit_ratio: None,
        };
        let (strip, _) = hourly_lines(Some(&usage), 40, &theme.palette);
        let joined = strip
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert!(joined.contains("model-5"), "{joined:?}");
        assert!(
            !joined.contains("model-6"),
            "rows past six fold away: {joined:?}"
        );
        assert!(joined.contains("… 2 more"), "{joined:?}");
    }

    /// How full the live context is reads differently from what was billed, so
    /// the usage section carries it beside the billed rows: window and
    /// occupancy at the last turn's granularity, warning-coloured once
    /// automatic compaction arms, and absent when the engine never reported a
    /// window.
    #[test]
    fn the_context_section_shows_window_occupancy_and_warns_when_it_is_high() {
        fn rows(terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>) -> Vec<String> {
            terminal
                .backend()
                .buffer()
                .content
                .chunks(60)
                .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect()
        }
        fn sidebar(usage: crate::status::UsageSummary) -> SidebarPane {
            SidebarPane {
                hover_rows: Vec::new(),
                changes: None,
                mode: None,
                theme: home_theme(),
                session: Some(home_row("ses_c", "occupancy", None)),
                usage: Some(usage),
                usage_hourly: None,
                goal: None,
                plan: None,
                todos: Vec::new(),
                chord: None,
            }
        }
        let summary = |window: Option<u64>, tokens: Option<u64>| {
            let context = window
                .map(|window| serde_json::json!({"window": window, "tokens": tokens.unwrap_or(0)}));
            crate::status::UsageSummary::from_value(&serde_json::json!({
                "turns": 1,
                "context": context,
            }))
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        let mut pane = sidebar(summary(Some(1_048_576), Some(630_000)));
        terminal
            .draw(|frame| pane.render(frame, frame.area()))
            .expect("draw");
        let painted = rows(&mut terminal);
        let line = painted
            .iter()
            .find(|row| row.contains("context "))
            .expect("the occupancy line leads the Context section");
        assert!(
            line.contains("context 630.0k of 1.0m · 60%"),
            "window and occupancy at the last turn: {line:?}"
        );
        let row = painted
            .iter()
            .position(|row| row.contains("context "))
            .expect("row")
            * 60;
        let warned = terminal.backend().buffer().content[row..row + 60]
            .iter()
            .any(|cell| cell.style().fg == Some(home_theme().palette.warning));
        assert!(
            !warned,
            "sixty percent is not the compaction rung: {line:?}"
        );

        let mut pane = sidebar(summary(Some(1_000_000), Some(900_000)));
        terminal
            .draw(|frame| pane.render(frame, frame.area()))
            .expect("draw");
        let painted = rows(&mut terminal);
        let line = painted
            .iter()
            .find(|row| row.contains("context "))
            .expect("line");
        assert!(line.contains("context 900.0k of 1.0m · 90%"), "{line:?}");
        let row = painted
            .iter()
            .position(|row| row.contains("context "))
            .expect("row")
            * 60;
        let warned = terminal.backend().buffer().content[row..row + 60]
            .iter()
            .any(|cell| cell.style().fg == Some(home_theme().palette.warning));
        assert!(
            warned,
            "the rung where compaction arms paints the warning: {line:?}"
        );

        let mut pane = sidebar(summary(None, None));
        terminal
            .draw(|frame| pane.render(frame, frame.area()))
            .expect("draw");
        assert!(
            !rows(&mut terminal)
                .iter()
                .any(|row| row.contains("context ")),
            "no reported window is not an empty one"
        );
    }

    /// The engine reports `attempts` beside `replayedTurns` and
    /// `failedAttempts`, and it can be zero while either fires: the row then
    /// read `retried 7 · 0 attempts`, a zero that describes nothing. Only a
    /// count of its own earns the part.
    #[test]
    fn a_zero_attempt_count_is_not_painted_beside_a_replay() {
        fn rows(terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>) -> Vec<String> {
            terminal
                .backend()
                .buffer()
                .content
                .chunks(60)
                .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect()
        }
        let usage = crate::status::UsageSummary::from_value(&serde_json::json!({
            "turns": 7,
            "retries": {"attempts": 0, "failedAttempts": 0, "replayedTurns": 7},
        }));
        let mut pane = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_z", "zero", None)),
            usage: Some(usage),
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        terminal
            .draw(|frame| pane.render(frame, frame.area()))
            .expect("draw");
        let painted = rows(&mut terminal);
        let rework = painted
            .iter()
            .find(|row| row.contains("retried"))
            .expect("the replay keeps its row");
        assert!(rework.contains("retried 7"), "{rework:?}");
        assert!(!rework.contains("0 attempt"), "{rework:?}");
    }

    /// #2737: the billed-usage column is two scopes, and the rows inside the
    /// session scope read abnormal-first. Both facts have to survive at the
    /// sidebar's own width without colour, so the test reads the painted rows
    /// rather than the model behind them.
    #[test]
    fn the_usage_scopes_are_ordered_and_abnormal_rows_come_first() {
        fn rows(terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>) -> Vec<String> {
            terminal
                .backend()
                .buffer()
                .content
                .chunks(60)
                .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect()
        }
        let usage = crate::status::UsageSummary::from_value(&serde_json::json!({
            "turns": 4,
            "retries": {"attempts": 5, "failedAttempts": 1, "replayedTurns": 2},
            "interventions": {"approvals": 1},
            "rework": {"toolInputErrors": 3},
            "subagents": {"sessions": 2, "turns": 3, "attempts": 3, "tokens": {"input": 1200}},
        }));
        let mut pane = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_u", "usage", None)),
            usage: Some(usage),
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        terminal
            .draw(|frame| pane.render(frame, frame.area()))
            .expect("draw");
        let painted = rows(&mut terminal);
        let at = |needle: &str| {
            painted
                .iter()
                .position(|row| row.contains(needle))
                .unwrap_or_else(|| panic!("{needle} missing: {painted:#?}"))
        };
        // The workspace strip answers a different question from the rows below
        // it, so it opens first and the session block gets its own header.
        assert!(at("Last 24h") < at("▾ Usage · session"), "{painted:#?}");
        // What went wrong leads; supervision and delegation follow, because a
        // monochrome terminal can only carry priority through order.
        assert!(at("retried") < at("needs you"), "{painted:#?}");
        assert!(at("needs you") < at("subagents"), "{painted:#?}");
        // Only the parts that happened: an approval and no answers must not
        // paint "0 answers".
        let needs_you = &painted[at("needs you")];
        assert!(needs_you.contains("needs you 1"), "{needs_you:?}");
        assert!(!needs_you.contains("0 answer"), "{needs_you:?}");
        assert!(!needs_you.contains("0 reject"), "{needs_you:?}");
        // Two retries and one failed attempt inside five attempts stay on the
        // one rework row that already says how many attempts were billed.
        let rework = &painted[at("retried")];
        assert!(rework.contains("retried 2"), "{rework:?}");
        assert!(rework.contains("1 failed attempt"), "{rework:?}");
        assert!(rework.contains("5 attempts"), "{rework:?}");
        // A child whose attempts match its settled turns needs no suffix.
        let subagents = &painted[at("subagents")];
        assert!(subagents.contains("2 · 3 turns"), "{subagents:?}");
        assert!(!subagents.contains("attempt"), "{subagents:?}");
    }

    /// #2737: lineage stays one row per served model under the session
    /// scope's header — switching models must not fold the rows into the Last
    /// 24h group above or into one another, whatever order the engine reports.
    #[test]
    fn a_multi_model_lineage_reads_as_one_group_under_the_usage_header() {
        let usage = crate::status::UsageSummary::from_value(&serde_json::json!({
            "turns": 4,
            "lineage": [
                {"protocol": "chat", "model": "glm-5", "turns": 3},
                {"protocol": "responses", "model": "claude-x", "turns": 1},
            ],
        }));
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: Some(home_row("ses_l", "lineage", None)),
            usage: Some(usage),
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let at = |needle: &str| {
            rows.iter()
                .position(|row| row.contains(needle))
                .unwrap_or_else(|| panic!("{needle} missing: {rows:?}"))
        };
        // The rows open the section: the header, then one row per model.
        let header = at("▾ Usage · session");
        assert_eq!(at("glm-5 · chat ×3"), header + 1, "{rows:?}");
        assert_eq!(at("claude-x · responses ×1"), header + 2, "{rows:?}");
    }

    /// A long CJK title and a long CJK todo each stay on one row. Counting
    /// characters instead of cells let both through at twice the column's
    /// width, and the wrapping widget then broke them one character per line.
    #[test]
    fn a_long_cjk_sidebar_stays_on_one_row_per_line() {
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: None,
            mode: None,
            theme: home_theme(),
            session: None,
            usage: None,
            usage_hourly: None,
            goal: None,
            plan: None,
            todos: Vec::new(),
            chord: None,
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
        // The checklist is bounded by the column itself now that the 24-hour
        // strip opens the usage section above it: everything between its
        // header and the first blank row is the todo's own rows. The column's
        // left border survives trimming, so a padding row still reads as
        // "│    "; only a row with content counts.
        let below = rows[header + 1..]
            .iter()
            .take_while(|row| {
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
    /// Every ▾ section opens after one blank row, wherever it sits in the
    /// column: a section header glued to the rows above reads as part of them.
    #[test]
    fn every_section_header_opens_after_a_blank_row() {
        let mut sidebar = SidebarPane {
            hover_rows: Vec::new(),
            changes: Some((2, 10, 4)),
            mode: Some("build".into()),
            theme: home_theme(),
            session: Some(home_row("ses_u", "usage", None)),
            usage: Some(crate::status::UsageSummary::from_value(
                &serde_json::json!({
                    "turns": 2,
                    "interventions": {"approvals": 1},
                }),
            )),
            usage_hourly: None,
            goal: Some(crate::session::GoalView {
                status: "active".into(),
                objective: "ship the release".into(),
                budget: None,
                evidence: None,
            }),
            plan: Some(crate::session::PlanView {
                summary: "draft, then transcribe".into(),
                status: "pending".into(),
                steps: 2,
            }),
            todos: vec![crate::session::TodoView {
                content: "write tests".into(),
                status: "in_progress".into(),
            }],
            chord: None,
        };
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 40)).expect("terminal");
        terminal
            .draw(|frame| sidebar.render(frame, frame.area()))
            .expect("draw");
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let blank = |row: &String| {
            row.trim_matches(|c: char| c == '│' || c.is_whitespace())
                .is_empty()
        };
        for header in [
            "▾ Last 24h",
            "▾ Usage · session",
            "▾ Activity",
            "▾ Mode",
            "▾ Changes",
            "▾ Goal",
            "▾ Plan",
            "▾ Todo",
        ] {
            let at = rows
                .iter()
                .position(|row| row.contains(header))
                .unwrap_or_else(|| panic!("{header} header missing: {rows:?}"));
            assert!(
                at > 0 && blank(&rows[at - 1]),
                "{header} must open after a blank row: {rows:?}"
            );
        }
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

#[cfg(test)]
mod draft_gap_tests {
    use super::*;

    /// The header naming what is being thought and the answer that follows are
    /// two different things, so a blank row has to separate them. Without it a
    /// reasoning model's stream read as one wall of prose: the summary line and
    /// the first line of the answer sat on adjacent rows.
    #[test]
    fn the_thinking_header_is_separated_from_the_answer() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: "t".into(),
            palette,
        };
        let rows = draft_lines(
            &[
                DraftPart::Reasoning("a thought".into()),
                DraftPart::Text("the answer".into()),
            ],
            &theme,
            0,
        );
        let text: Vec<String> = rows
            .iter()
            .map(|row| row.line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(text[0].contains("Thinking"), "{text:?}");
        assert_eq!(
            text[1], "",
            "a blank row separates header from answer: {text:?}"
        );
        assert!(text[2].starts_with("● the answer"), "{text:?}");
    }

    /// An answer with no reasoning keeps its first row: the separator belongs
    /// between two things, not above the only one.
    #[test]
    fn an_answer_without_thinking_starts_on_the_first_row() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: "t".into(),
            palette,
        };
        let rows = draft_lines(&[DraftPart::Text("the answer".into())], &theme, 0);
        let text: Vec<String> = rows
            .iter()
            .map(|row| row.line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(text[0].starts_with("● the answer"), "{text:?}");
    }
}

#[cfg(test)]
mod layout_alignment_tests {
    use super::*;

    /// The three columns have to agree on their edges: the transcript's text,
    /// the composer's box, and the sidebar's rule. An inset on the transcript
    /// alone left its text floating a cell inside the box below it, which is
    /// what the operator sees as "the left column does not line up".
    #[test]
    fn the_transcript_the_composer_and_the_sidebar_share_their_edges() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let mut shell = Shell::new(
            std::path::Path::new("."),
            Theme {
                name: crate::theme::DEFAULT_THEME.to_string(),
                palette,
            },
        );
        shell.set_transcript(&Transcript {
            entries: vec![Entry::User {
                text: "hello".into(),
                seq: 1,
            }],
            ..Transcript::default()
        });
        let width = 200u16;
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 24))
            .expect("terminal");
        terminal.draw(|frame| shell.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let rows: Vec<String> = (0..24)
            .map(|y| {
                (0..width)
                    .map(|x| {
                        buffer
                            .cell(ratatui::prelude::Position::new(x, y))
                            .map(|cell| cell.symbol().to_string())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect();
        let first_painted = |needle: &str| {
            rows.iter()
                .find(|row| row.contains(needle))
                .and_then(|row| row.find(needle))
                .unwrap_or_else(|| panic!("{needle} is painted: {rows:?}"))
        };
        let marker = first_painted("❯");
        let input = first_painted("┌");
        assert_eq!(
            marker, input,
            "the transcript starts on the composer's column"
        );
        assert_eq!(marker, 0, "and that column is the window's first");

        // The sidebar's rule divides the body. The transcript's text must not
        // run past it, and the sidebar's content must start after it.
        let rule = rows
            .iter()
            .find_map(|row| row.find('│').or_else(|| row.find('┃')))
            .expect("the sidebar rule is painted");
        assert!(rule > 0, "the rule sits between the two columns: {rule}");
        // The transcript's column ends where the rule begins, so no transcript
        // glyph is painted on or past it.
        for row in &rows {
            if let Some(index) = row.find("hello") {
                let end = row[..index].len() + "hello".len();
                assert!(
                    end <= rule,
                    "transcript text ends before the rule: {row:?} rule={rule}"
                );
            }
        }
    }
}

#[cfg(test)]
mod draft_tool_tests {
    use super::*;

    /// A tool call that runs mid-stream is work the turn did, so the draft
    /// paints it as a `✓ bash …` row instead of waiting for the commit. Without
    /// this the operator saw the answer's paragraphs with no sign of the calls
    /// between them.
    #[test]
    fn a_streamed_tool_call_paints_a_tool_row() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let tools = [(
            "run_command".to_string(),
            r#"{"argv":["echo","hi"]}"#.to_string(),
        )];
        let rows = draft_lines(
            &[
                DraftPart::Text("done".into()),
                DraftPart::Call {
                    name: tools[0].0.clone(),
                    arguments: tools[0].1.clone(),
                },
            ],
            &theme,
            0,
        );
        let text: Vec<String> = rows
            .iter()
            .map(|row| row.line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        let joined = text.join("\n");
        assert!(
            joined.contains("bash"),
            "the tool row names the tool: {joined}"
        );
        assert!(
            joined.contains("echo hi"),
            "and the command it ran: {joined}"
        );
    }
}

#[cfg(test)]
mod interleave_tests {
    use super::*;

    /// A provider turn is prose, a call, more prose, another call. The draft
    /// must paint that arrival order: grouping the text and then the calls put
    /// every `bash` row after the whole answer, which is neither what happened
    /// nor what the committed message shows — the transcript rearranged itself
    /// when the turn committed.
    #[test]
    fn a_streamed_turn_keeps_its_arrival_order() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette,
        };
        let parts = vec![
            DraftPart::Text("first paragraph".into()),
            DraftPart::Call {
                name: "run_command".into(),
                arguments: r#"{"argv":["echo","one"]}"#.into(),
            },
            DraftPart::Text("second paragraph".into()),
            DraftPart::Call {
                name: "run_command".into(),
                arguments: r#"{"argv":["echo","two"]}"#.into(),
            },
        ];
        let rows = draft_lines(&parts, &theme, 0);
        let text: Vec<String> = rows
            .iter()
            .map(|row| row.line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        let joined = text.join("\n");
        let first = joined.find("first paragraph").expect("first paragraph");
        let one = joined.find("echo one").expect("first call");
        let second = joined.find("second paragraph").expect("second paragraph");
        let two = joined.find("echo two").expect("second call");
        assert!(
            first < one && one < second && second < two,
            "the turn keeps its arrival order:\n{joined}"
        );
    }
}

#[cfg(test)]
mod final_layout_check {
    use super::*;
    /// Assert every cell in the window carries a page background. A cell left
    /// at the terminal default is a band of the terminal's own colour showing
    /// through the layout.
    #[test]
    fn no_cell_falls_back_to_the_terminal_default() {
        let palette =
            crate::theme::builtin(crate::theme::DEFAULT_THEME, crate::theme::ThemeMode::Dark)
                .expect("theme");
        let theme = Theme {
            name: "t".into(),
            palette,
        };
        for (w, h) in [(120u16, 20u16), (200, 40), (100, 12), (80, 10)] {
            let mut shell = Shell::new(std::path::Path::new("."), theme.clone());
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).expect("terminal");
            terminal.draw(|f| shell.render(f)).expect("draw");
            let buf = terminal.backend().buffer();
            let holes: Vec<(u16, u16)> = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x, y)))
                .filter(|(x, y)| {
                    buf.cell(ratatui::prelude::Position::new(*x, *y))
                        .is_some_and(|c| c.bg == ratatui::style::Color::Reset)
                })
                .collect();
            assert!(
                holes.is_empty(),
                "{w}x{h}: {} cell(s) kept the terminal's default background: {:?}",
                holes.len(),
                &holes[..holes.len().min(10)]
            );
        }
    }
}
