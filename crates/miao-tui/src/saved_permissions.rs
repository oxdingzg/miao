//! Native-owned standing rules. The engine owns authorization; this dialog
//! only displays its response and sends an explicit individual revocation.
use std::path::Path;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{Paragraph, Wrap},
    Frame,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{dialogs::Action, editor::Editor, theme::Theme};

#[derive(Debug, Clone, Deserialize)]
pub struct Pattern {
    pub action: String,
    pub resource: String,
    effect: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub id: String,
    pub workspace: String,
    pub rule: Pattern,
    source: String,
}

pub fn decode(value: Value) -> Result<Vec<Rule>, String> {
    let rules: Vec<Rule> = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if rules.iter().any(|rule| {
        let digest = rule.id.strip_prefix("prule_").unwrap_or_default();
        rule.source != "native"
            || rule.rule.effect != "allow"
            || rule.workspace.is_empty()
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err("Invalid native saved permission response".into());
    }
    Ok(rules)
}

pub struct Dialog {
    pub generation: u64,
    directory: String,
    rules: Vec<Rule>,
    filter: Editor,
    selected: usize,
    review: Option<String>,
    confirmed: bool,
    loading: bool,
    pending: bool,
    notice: Option<String>,
    scroll: u16,
}

impl Dialog {
    pub fn new(generation: u64, directory: &Path) -> Self {
        Self {
            generation,
            directory: directory
                .canonicalize()
                .unwrap_or_else(|_| directory.to_path_buf())
                .to_string_lossy()
                .into_owned(),
            rules: Vec::new(),
            filter: Editor::new(),
            selected: 0,
            review: None,
            confirmed: false,
            loading: true,
            pending: false,
            notice: None,
            scroll: 0,
        }
    }

    pub fn loaded(&mut self, result: Result<Vec<Rule>, String>) {
        self.loading = false;
        match result {
            Ok(rules) if rules.iter().all(|rule| rule.workspace == self.directory) => {
                self.rules = rules;
                self.selected = 0;
                self.notice = None;
            }
            Ok(_) => {
                self.notice = Some("Saved permission directory does not match this engine".into())
            }
            Err(error) => self.notice = Some(error),
        }
    }

    pub fn revoked(&mut self, id: &str, result: Result<(), String>) {
        if !self.pending || self.review.as_deref() != Some(id) {
            return;
        }
        self.pending = false;
        match result {
            Ok(()) => {
                self.rules.retain(|rule| rule.id != id);
                self.review = None;
                self.selected = 0;
                self.notice =
                    Some("Saved permission revoked. Configured rules still apply.".into());
            }
            Err(error) => self.notice = Some(error),
        }
    }

    pub fn paste(&mut self, text: &str) {
        if self.loading || self.pending || self.review.is_some() {
            return;
        }
        self.filter.insert_str(text);
        self.selected = 0;
    }

    fn visible(&self) -> Vec<&Rule> {
        let needle = self.filter.text().to_lowercase();
        self.rules
            .iter()
            .filter(|rule| {
                format!("{} {}", rule.rule.action, rule.rule.resource)
                    .to_lowercase()
                    .contains(&needle)
            })
            .collect()
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        if key.code == KeyCode::Esc {
            if self.review.is_some() && !self.pending {
                self.review = None;
                self.notice = None;
                return Action::None;
            }
            return Action::Close;
        }
        if self.loading || self.pending {
            return Action::None;
        }
        if key.code == KeyCode::Char('r') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.review = None;
            self.loading = true;
            self.notice = None;
            return Action::RefreshPermissions;
        }
        if let Some(id) = self.review.clone() {
            match key.code {
                KeyCode::Left | KeyCode::Right | KeyCode::Tab => self.confirmed = !self.confirmed,
                KeyCode::Up | KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(1),
                KeyCode::Down | KeyCode::PageDown => self.scroll = self.scroll.saturating_add(1),
                KeyCode::Enter if self.confirmed => {
                    self.pending = true;
                    self.notice = None;
                    return Action::RevokePermission(id);
                }
                KeyCode::Enter => {
                    self.review = None;
                    self.notice = None;
                }
                _ => {}
            }
            return Action::None;
        }
        match key.code {
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => {
                self.selected = (self.selected + 1).min(self.visible().len().saturating_sub(1))
            }
            KeyCode::Enter => {
                self.review = self
                    .visible()
                    .get(self.selected)
                    .map(|rule| rule.id.clone());
                self.confirmed = false;
                self.scroll = 0;
                self.notice = None;
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.filter.insert_char(ch);
                self.selected = 0;
            }
            KeyCode::Backspace => {
                self.filter.backspace();
                self.selected = 0;
            }
            _ => {}
        }
        Action::None
    }

    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let palette = theme.palette;
        let footer = Rect {
            y: area.y + area.height.saturating_sub(1),
            height: 1,
            ..area
        };
        let content = Rect {
            height: area.height.saturating_sub(1),
            ..area
        };
        let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
        if let Some(rule) = self
            .review
            .as_ref()
            .and_then(|id| self.rules.iter().find(|rule| &rule.id == id))
        {
            let message = format!("Directory: {}\n\nAction: {}\nTarget pattern: {}\n\nConfigured permission rules still apply.\n{}", quoted(&rule.workspace), quoted(&rule.rule.action), quoted(&rule.rule.resource), self.notice.as_deref().unwrap_or_default());
            frame.render_widget(
                Paragraph::new(message)
                    .wrap(Wrap { trim: false })
                    .scroll((self.scroll, 0))
                    .style(Style::new().fg(palette.text)),
                content,
            );
            let buttons = if self.pending {
                "Waiting for the engine…"
            } else if self.confirmed {
                "Keep     ▸ Revoke · enter confirm · ↑↓ scroll"
            } else {
                "▸ Keep     Revoke · ←→ select · ↑↓ scroll"
            };
            frame.render_widget(
                Paragraph::new(buttons).style(Style::new().fg(palette.primary)),
                footer,
            );
            return;
        }
        let mut lines = vec![Line::from(format!("Search: {}", self.filter.text()))];
        if let Some(notice) = &self.notice {
            lines.push(Line::styled(
                notice.clone(),
                Style::new().fg(palette.warning),
            ));
        }
        if self.loading {
            lines.push(Line::from("Loading saved permissions…"));
        }
        if !self.loading && self.visible().is_empty() && self.notice.is_none() {
            lines.push(Line::from("No saved permissions for this directory."));
        }
        let count = content.height.saturating_sub(lines.len() as u16) as usize;
        let start = self.selected.saturating_sub(count.saturating_sub(1));
        for (index, rule) in self.visible().iter().enumerate().skip(start).take(count) {
            lines.push(Line::styled(
                format!(
                    "{} {} {}",
                    if index == self.selected { "▸" } else { " " },
                    quoted(&rule.rule.action),
                    quoted(&rule.rule.resource)
                ),
                Style::new().fg(if index == self.selected {
                    palette.primary
                } else {
                    palette.text
                }),
            ));
        }
        frame.render_widget(Paragraph::new(lines), content);
        frame.render_widget(
            Paragraph::new("enter review · ctrl+r refresh · esc close")
                .style(Style::new().fg(palette.text_muted)),
            footer,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;
    use serde_json::json;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn rules(directory: &str) -> Vec<Rule> {
        decode(json!([{ "id": format!("prule_{}", "a".repeat(64)), "workspace": directory,
            "source": "native", "rule": { "action": "read", "resource": "public/**", "effect": "allow" } }])).unwrap()
    }
    fn loaded() -> Dialog {
        let mut dialog = Dialog::new(1, Path::new("/fixture/worktree"));
        dialog.loaded(Ok(rules("/fixture/worktree")));
        dialog
    }

    #[test]
    fn revoke_requires_explicit_confirmation_and_an_acknowledgement() {
        let mut dialog = loaded();
        dialog.handle_key(key(KeyCode::Enter));
        assert!(dialog.review.is_some());
        assert!(!dialog.confirmed);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::None
        ));
        assert!(dialog.review.is_none());
        assert_eq!(dialog.rules.len(), 1);
        dialog.handle_key(key(KeyCode::Enter));
        dialog.handle_key(key(KeyCode::Right));
        let Action::RevokePermission(id) = dialog.handle_key(key(KeyCode::Enter)) else {
            panic!("revoke");
        };
        assert!(dialog.pending);
        assert_eq!(dialog.rules.len(), 1);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::None
        ));
        dialog.revoked(&id, Err("engine unavailable".into()));
        assert!(!dialog.pending);
        assert_eq!(dialog.rules.len(), 1);
        assert!(dialog.review.is_some());
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::RevokePermission(_)
        ));
        dialog.revoked("other-rule", Ok(()));
        assert!(dialog.pending);
        dialog.revoked(&id, Ok(()));
        assert!(dialog.rules.is_empty());
        assert!(dialog.review.is_none());
    }

    #[test]
    fn invalid_or_foreign_rules_cannot_replace_the_verified_list() {
        let mut dialog = loaded();
        dialog.loaded(Ok(rules("/other/worktree")));
        assert!(dialog.notice.as_deref().unwrap().contains("does not match"));
        assert_eq!(dialog.rules[0].workspace, "/fixture/worktree");
        for value in [
            json!({}),
            json!([{ "id": "wrong", "workspace": "/fixture/worktree", "source": "native", "rule": { "action": "read", "resource": "*", "effect": "allow" }}]),
        ] {
            assert!(decode(value).is_err());
        }
        let mut value = serde_json::to_value(json!([{ "id": format!("prule_{}", "a".repeat(64)), "workspace": "/fixture/worktree", "source": "native", "rule": { "action": "read", "resource": "*", "effect": "deny" }}])).unwrap();
        assert!(decode(value.clone()).is_err());
        value[0]["rule"]["effect"] = json!("allow");
        value[0]["source"] = json!("projected");
        assert!(decode(value).is_err());
    }

    #[test]
    fn search_retry_and_failed_load_do_not_claim_an_empty_list() {
        let mut dialog = loaded();
        dialog.handle_key(key(KeyCode::Char('z')));
        assert!(dialog.visible().is_empty());
        dialog.handle_key(key(KeyCode::Backspace));
        assert_eq!(dialog.visible().len(), 1);
        assert!(matches!(
            dialog.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            Action::RefreshPermissions
        ));
        assert!(dialog.loading);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::None
        ));
        dialog.loaded(Err("offline".into()));
        assert_eq!(dialog.rules.len(), 1);
        assert_eq!(dialog.notice.as_deref(), Some("offline"));
    }

    #[test]
    fn a_small_terminal_keeps_explicit_confirmation_visible_with_long_targets() {
        let mut dialog = loaded();
        dialog.rules[0].rule.resource = "target\n\x1b[2J".repeat(200);
        dialog.handle_key(key(KeyCode::Enter));
        let backend = ratatui::backend::TestBackend::new(48, 12);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        let theme = Theme {
            name: crate::theme::DEFAULT_THEME.into(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).unwrap(),
        };
        terminal
            .draw(|frame| dialog.render(frame, frame.area(), &theme))
            .unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("Directory: "));
        assert!(text.contains("Keep"));
        assert!(text.contains("Revoke"));
        assert!(!text.contains('\x1b'));
        assert!(!dialog.confirmed);
    }
}
