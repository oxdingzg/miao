//! Session workspace Git state. The engine answers `vcs_status` read-only;
//! this dialog only displays its response and never touches the index.
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
    Frame,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{dialogs::Action, theme::Theme};

#[derive(Debug, Clone, Deserialize)]
pub struct Change {
    pub path: String,
    #[serde(default)]
    pub original_path: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VcsState {
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub detached: bool,
    #[serde(default)]
    pub ahead: Option<u64>,
    #[serde(default)]
    pub behind: Option<u64>,
    #[serde(default)]
    pub files: Vec<Change>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub file_count: Option<u64>,
    #[serde(default)]
    pub repository: bool,
}

pub fn decode(value: Value) -> Result<VcsState, String> {
    let state: VcsState = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if !state.repository {
        return Err("This session's workspace is not inside a Git repository".into());
    }
    if state.files.len() > 5000 {
        return Err("Invalid vcs_status response".into());
    }
    Ok(state)
}

/// One file's patch against HEAD, decoded from the `vcs_diff` answer. A `null`
/// diff is a fact, not a failure: an untracked file has no committed version,
/// and a patch past the engine's limit names its own size instead of arriving.
#[derive(Debug, Clone, Deserialize)]
pub struct DiffView {
    pub path: String,
    #[serde(default)]
    pub diff: Option<String>,
    #[serde(default)]
    pub untracked: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub chars: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
}

pub fn decode_diff(value: Value) -> Result<DiffView, String> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// The per-file diff the operator opened from the list. The list stays loaded
/// underneath, so Esc returns to it with the selection intact.
pub struct DiffPanel {
    pub path: String,
    loading: bool,
    view: Option<DiffView>,
    notice: Option<String>,
    scroll: usize,
}

pub struct Dialog {
    pub generation: u64,
    pub session_id: String,
    state: Option<VcsState>,
    selected: usize,
    loading: bool,
    notice: Option<String>,
    diff: Option<DiffPanel>,
}

impl Dialog {
    pub fn new(generation: u64, session_id: &str) -> Self {
        Self {
            generation,
            session_id: session_id.into(),
            state: None,
            selected: 0,
            loading: true,
            notice: None,
            diff: None,
        }
    }

    pub fn loaded(&mut self, result: Result<VcsState, String>) {
        self.loading = false;
        match result {
            Ok(state) => {
                self.selected = 0;
                self.notice = None;
                self.state = Some(state);
            }
            Err(error) => self.notice = Some(error),
        }
    }

    /// Ask for the selected file's patch. The dialog switches to the diff view
    /// at once so the UI answers immediately; the patch arrives as an event.
    pub fn open_diff(&mut self, path: String) {
        self.diff = Some(DiffPanel {
            path,
            loading: true,
            view: None,
            notice: None,
            scroll: 0,
        });
    }

    pub fn diff_loaded(&mut self, path: &str, result: Result<DiffView, String>) {
        let Some(panel) = self.diff.as_mut() else {
            return;
        };
        if panel.path != path {
            return;
        }
        panel.loading = false;
        panel.scroll = 0;
        match result {
            Ok(view) => {
                panel.notice = None;
                panel.view = Some(view);
            }
            Err(error) => panel.notice = Some(error),
        }
    }

    pub fn diff_open(&self) -> bool {
        self.diff.is_some()
    }

    /// Rows the painted body needs: the branch header, a separator, and one row
    /// per change (or the line that says the tree is clean). The caller adds
    /// the two border rows.
    pub fn body_rows(&self) -> usize {
        match &self.state {
            Some(state) => state.files.len().clamp(1, 14) + 2,
            None => 1,
        }
    }

    /// Body height while the diff view is up: the patch itself (capped), the
    /// header line naming the file, and the fact lines untracked or truncation
    /// contribute.
    pub fn view_rows(&self) -> usize {
        let Some(panel) = &self.diff else {
            return self.body_rows();
        };
        let patch = panel
            .view
            .as_ref()
            .and_then(|view| view.diff.as_ref())
            .map(|text| text.lines().count())
            .unwrap_or(0);
        (patch + 2).clamp(6, 32)
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        if key.code == KeyCode::Esc {
            // Esc in the diff view returns to the list; Esc on the list closes.
            if self.diff.take().is_some() {
                return Action::None;
            }
            return Action::Close;
        }
        if let Some(panel) = &mut self.diff {
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => panel.scroll = panel.scroll.saturating_sub(1),
                KeyCode::Down | KeyCode::Char('j') => panel.scroll += 1,
                KeyCode::PageUp => panel.scroll = panel.scroll.saturating_sub(10),
                KeyCode::PageDown => panel.scroll += 10,
                KeyCode::Home => panel.scroll = 0,
                KeyCode::Char('r') => {
                    panel.loading = true;
                    panel.notice = None;
                    return Action::OpenWorkspaceDiff(panel.path.clone());
                }
                _ => {}
            }
            return Action::None;
        }
        if self.loading {
            return Action::None;
        }
        if key.code == KeyCode::Char('r') {
            self.loading = true;
            self.notice = None;
            return Action::RefreshWorkspaceChanges(self.session_id.clone());
        }
        if let Some(state) = &self.state {
            match key.code {
                KeyCode::Up => self.selected = self.selected.saturating_sub(1),
                KeyCode::Down => {
                    self.selected = (self.selected + 1).min(state.files.len().saturating_sub(1))
                }
                KeyCode::Enter => {
                    if let Some(change) = state.files.get(self.selected) {
                        let path = change.path.clone();
                        self.open_diff(path.clone());
                        return Action::OpenWorkspaceDiff(path);
                    }
                }
                _ => {}
            }
        }
        Action::None
    }

    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if let Some(panel) = &self.diff {
            self.render_diff(panel, frame, area, theme);
            return;
        }
        let mut lines: Vec<Line> = Vec::new();
        match (&self.state, &self.notice) {
            (None, Some(notice)) => lines
                .push(Line::from(notice.as_str()).style(Style::default().fg(theme.palette.error))),
            (None, _) if self.loading => lines.push(Line::from("reading workspace state…")),
            (Some(state), notice) => {
                let branch = match (&state.branch, state.detached) {
                    (_, true) => "HEAD (detached)".to_string(),
                    (Some(name), false) => name.clone(),
                    (None, false) => "no branch".to_string(),
                };
                let mut header = branch.to_string();
                if let Some(ahead) = state.ahead {
                    header.push_str(&format!("  ↑{ahead}"));
                }
                if let Some(behind) = state.behind {
                    header.push_str(&format!("  ↓{behind}"));
                }
                let shown = if state.truncated {
                    format!(
                        "  {} of {} files (truncated)",
                        state.files.len(),
                        state.file_count.unwrap_or_default()
                    )
                } else {
                    format!("  {} files", state.files.len())
                };
                header.push_str(&shown);
                lines.push(Line::from(header).style(Style::default().fg(theme.palette.accent)));
                if let Some(notice) = notice {
                    lines.push(
                        Line::from(notice.as_str()).style(Style::default().fg(theme.palette.error)),
                    );
                }
                lines.push(Line::from(""));
                if state.files.is_empty() {
                    lines.push(Line::from("No uncommitted changes."));
                }
                for (index, change) in state.files.iter().enumerate() {
                    let marker = if index == self.selected { "❯ " } else { "  " };
                    let renamed = match &change.original_path {
                        Some(from) => format!(" {from} ->"),
                        None => String::new(),
                    };
                    lines.push(Line::from(format!(
                        "{marker}{:>10} {}{renamed}",
                        change.kind, change.path
                    )));
                }
            }
            (None, None) => lines.push(Line::from("reading workspace state…")),
        }
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        frame.render_widget(paragraph, area);
    }

    fn render_diff(&self, panel: &DiffPanel, frame: &mut Frame, area: Rect, theme: &Theme) {
        let mut lines: Vec<Line> = Vec::new();
        match (&panel.view, &panel.notice) {
            (None, Some(notice)) => lines
                .push(Line::from(notice.as_str()).style(Style::default().fg(theme.palette.error))),
            (None, _) if panel.loading => {
                lines.push(Line::from(format!("reading diff of {}…", panel.path)))
            }
            (Some(view), notice) => {
                lines.push(
                    Line::from(view.path.clone()).style(Style::default().fg(theme.palette.accent)),
                );
                if let Some(notice) = notice {
                    lines.push(
                        Line::from(notice.as_str()).style(Style::default().fg(theme.palette.error)),
                    );
                }
                if view.untracked {
                    lines.push(Line::from(
                        "untracked — no committed version to diff against",
                    ));
                } else if view.truncated {
                    lines.push(
                        Line::from(format!(
                            "patch too large: {} chars against the {} limit; the engine refused to stream it",
                            view.chars.unwrap_or_default(),
                            view.limit.unwrap_or_default()
                        ))
                        .style(Style::default().fg(theme.palette.warning)),
                    );
                } else if let Some(text) = &view.diff {
                    for line in text.lines() {
                        // The +/-/@@ prefixes colour themselves; everything else
                        // stays plain so context lines read as context.
                        let style = match line.chars().next() {
                            Some('+') if !line.starts_with("+++") => {
                                Style::default().fg(theme.palette.success)
                            }
                            Some('-') if !line.starts_with("---") => {
                                Style::default().fg(theme.palette.error)
                            }
                            Some('@') => Style::default().fg(theme.palette.accent),
                            _ => Style::default(),
                        };
                        lines.push(Line::from(Span::styled(line.to_string(), style)));
                    }
                    if text.lines().count() == 0 {
                        lines.push(Line::from("no difference against HEAD"));
                    }
                } else {
                    lines.push(Line::from("no difference against HEAD"));
                }
                lines.push(Line::from(""));
                lines.push(
                    Line::from("esc back · j/k or arrows scroll · r re-read")
                        .style(Style::default().fg(theme.palette.text_muted)),
                );
            }
            (None, None) => lines.push(Line::from(format!("reading diff of {}…", panel.path))),
        }
        let paragraph = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((panel.scroll.min(u16::MAX as usize) as u16, 0));
        frame.render_widget(paragraph, area);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_parses_branch_and_files() {
        let value = serde_json::json!({
            "repository": true,
            "branch": "main",
            "detached": false,
            "ahead": 2,
            "files": [
                {"path": "src/lib.rs", "kind": "modified"},
                {"path": "src/new.rs", "original_path": "src/old.rs", "kind": "renamed"}
            ],
            "truncated": false,
            "file_count": 2
        });
        let state = decode(value).unwrap();
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.files.len(), 2);
        assert_eq!(state.files[1].original_path.as_deref(), Some("src/old.rs"));
    }

    #[test]
    fn the_diff_view_stays_readable_at_forty_columns() {
        // UX-03: the changes view is where a diff is inspected, and 40 columns
        // is the narrowest layout the item names. The branch, the kind and the
        // path all have to survive there.
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let value = serde_json::json!({
            "repository": true,
            "branch": "fix/ux03-diff",
            "detached": false,
            "ahead": 1,
            "files": [
                {"path": "crates/miao-tui/src/workspace_changes.rs", "kind": "modified"},
                {"path": "src/new.rs", "original_path": "src/old.rs", "kind": "renamed"}
            ],
            "truncated": false,
            "file_count": 2
        });
        for width in [40u16, 80, 120] {
            let mut dialog = Dialog::new(1, "ses_a");
            dialog.loaded(Ok(decode(value.clone()).expect("state")));
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 12))
                    .expect("terminal");
            terminal
                .draw(|frame| dialog.render(frame, frame.area(), &theme))
                .expect("draw");
            let text = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(
                text.contains("fix/ux03-diff"),
                "the branch survives {width} columns: {text}"
            );
            assert!(
                text.contains("modified") && text.contains("renamed"),
                "the kinds survive {width} columns: {text}"
            );
            assert!(
                text.contains("workspace_changes.rs") || text.contains("workspace_changes"),
                "the path survives {width} columns: {text}"
            );
        }
    }

    #[test]
    fn decode_reports_a_non_repository_workspace() {
        let value = serde_json::json!({"repository": false, "root": "/tmp"});
        let error = decode(value).unwrap_err();
        assert!(error.contains("not inside a Git repository"));
    }

    #[test]
    fn decode_rejects_an_oversized_listing() {
        let files: Vec<Value> = (0..5001)
            .map(|index| serde_json::json!({"path": format!("f/{index}"), "kind": "modified"}))
            .collect();
        let value = serde_json::json!({"repository": true, "files": files});
        assert!(decode(value).is_err());
    }

    #[test]
    fn decode_diff_reads_the_three_engine_answers() {
        let patch = decode_diff(serde_json::json!({
            "path": "src/lib.rs",
            "diff": "@@ -1 +1,2 @@\n-one\n+one\n+two\n",
            "untracked": false
        }))
        .expect("patch answer");
        assert_eq!(patch.diff.as_deref().map(str::len), Some(29));
        assert!(!patch.untracked);

        let untracked = decode_diff(serde_json::json!({
            "path": "fresh.txt", "diff": Value::Null, "untracked": true
        }))
        .expect("untracked answer");
        assert!(untracked.untracked && untracked.diff.is_none());

        let truncated = decode_diff(serde_json::json!({
            "path": "big.rs", "diff": Value::Null,
            "truncated": true, "chars": 900_000, "limit": 256_000
        }))
        .expect("truncated answer");
        assert!(truncated.truncated);
        assert_eq!(truncated.chars, Some(900_000));
    }

    fn loaded_dialog() -> Dialog {
        let mut dialog = Dialog::new(1, "ses_a");
        dialog.loaded(Ok(decode(serde_json::json!({
            "repository": true,
            "branch": "main",
            "detached": false,
            "files": [
                {"path": "src/lib.rs", "kind": "modified"},
                {"path": "src/new.rs", "original_path": "src/old.rs", "kind": "renamed"},
                {"path": "src/fresh.rs", "kind": "untracked"}
            ],
            "truncated": false,
            "file_count": 3
        }))
        .expect("state")));
        dialog
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn enter_opens_the_selected_files_diff_and_esc_returns_to_the_list() {
        let mut dialog = loaded_dialog();
        let action = dialog.handle_key(key(KeyCode::Down)); // select src/new.rs
        assert!(matches!(action, Action::None));
        let action = dialog.handle_key(key(KeyCode::Enter));
        assert!(dialog.diff_open());
        assert!(matches!(
            action,
            Action::OpenWorkspaceDiff(path) if path == "src/new.rs"
        ));
        // The reply fills the panel; Esc steps back to the list, not out.
        dialog.diff_loaded(
            "src/new.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/new.rs", "diff": "+new content\n", "untracked": false
            }))
            .expect("view")),
        );
        assert!(matches!(dialog.handle_key(key(KeyCode::Esc)), Action::None));
        assert!(!dialog.diff_open());
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Esc)),
            Action::Close
        ));
    }

    #[test]
    fn the_diff_view_paints_the_patch_the_facts_and_the_hints() {
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        };
        let paint = |dialog: &Dialog| {
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 16)).expect("term");
            terminal
                .draw(|frame| dialog.render(frame, frame.area(), &theme))
                .expect("draw");
            terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
        };

        let mut dialog = loaded_dialog();
        dialog.open_diff("src/lib.rs".into());
        assert!(paint(&dialog).contains("reading diff"), "loading state");
        dialog.diff_loaded(
            "src/lib.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/lib.rs",
                "diff": "@@ -1 +1,2 @@\n-one\n+one\n+two\n",
                "untracked": false
            }))
            .expect("view")),
        );
        let text = paint(&dialog);
        assert!(text.contains("src/lib.rs"), "{text}");
        assert!(text.contains("+two"), "{text}");
        assert!(text.contains("esc back"), "{text}");

        let mut untracked = loaded_dialog();
        untracked.open_diff("src/fresh.rs".into());
        untracked.diff_loaded(
            "src/fresh.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/fresh.rs", "diff": Value::Null, "untracked": true
            }))
            .expect("view")),
        );
        assert!(
            paint(&untracked).contains("no committed version"),
            "the untracked fact is the answer"
        );

        let mut truncated = loaded_dialog();
        truncated.open_diff("big.rs".into());
        truncated.diff_loaded(
            "big.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "big.rs", "diff": Value::Null,
                "truncated": true, "chars": 900_000, "limit": 256_000
            }))
            .expect("view")),
        );
        assert!(
            paint(&truncated).contains("patch too large"),
            "the truncation fact is shown, not hidden"
        );
    }

    #[test]
    fn a_late_answer_for_a_closed_view_does_not_revive_it() {
        let mut dialog = loaded_dialog();
        dialog.open_diff("src/lib.rs".into());
        dialog.handle_key(key(KeyCode::Esc)); // operator backed out early
        dialog.diff_loaded(
            "src/lib.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/lib.rs", "diff": "+late\n", "untracked": false
            }))
            .expect("view")),
        );
        assert!(!dialog.diff_open());
    }

    #[test]
    fn the_diff_box_grows_with_its_patch_up_to_the_cap() {
        let mut dialog = loaded_dialog();
        assert_eq!(
            dialog.view_rows(),
            dialog.body_rows(),
            "list mode unchanged"
        );
        dialog.open_diff("src/lib.rs".into());
        assert_eq!(dialog.view_rows(), 6, "no patch yet: the minimum");
        dialog.diff_loaded(
            "src/lib.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/lib.rs",
                "diff": "a\nb\nc\nd\ne\nf\ng\n",
                "untracked": false
            }))
            .expect("view")),
        );
        assert_eq!(dialog.view_rows(), 9, "seven patch lines + two");
        dialog.diff_loaded(
            "src/lib.rs",
            Ok(decode_diff(serde_json::json!({
                "path": "src/lib.rs", "diff": "x\n".repeat(100).trim_end(), "untracked": false
            }))
            .expect("view")),
        );
        assert_eq!(dialog.view_rows(), 32, "capped at 32");
    }
}
