//! Session workspace Git state. The engine answers `vcs_status` read-only;
//! this dialog only displays its response and never touches the index.
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::{
    layout::Rect,
    style::Style,
    text::Line,
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

pub struct Dialog {
    pub generation: u64,
    pub session_id: String,
    state: Option<VcsState>,
    selected: usize,
    loading: bool,
    notice: Option<String>,
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

    /// Rows the painted body needs: the branch header, a separator, and one row
    /// per change (or the line that says the tree is clean). The caller adds
    /// the two border rows.
    pub fn body_rows(&self) -> usize {
        match &self.state {
            Some(state) => state.files.len().clamp(1, 14) + 2,
            None => 1,
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        if key.code == KeyCode::Esc {
            return Action::Close;
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
                KeyCode::Down | KeyCode::Enter => {
                    self.selected = (self.selected + 1).min(state.files.len().saturating_sub(1))
                }
                _ => {}
            }
        }
        Action::None
    }

    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
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
}
