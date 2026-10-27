//! Modal dialogs: model selection, theme selection, the Session list, rename
//! and delete confirmation.
//!
//! The dialogs own only their cursor and edit state. Every decision leaves as
//! an [`Action`] so the app can issue the engine request or apply a theme.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;

use crate::editor::Editor;
use crate::session::SessionSummary;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub protocol: String,
    pub model: String,
    pub route_id: Option<String>,
    pub variant: Option<String>,
}

impl ModelInfo {
    /// The engine lists variants inside one catalog entry; each variant is a
    /// separately selectable binding.
    pub fn catalog(value: &Value) -> Vec<Self> {
        value
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .flat_map(|entry| {
                        let protocol = entry.get("protocol").and_then(Value::as_str).unwrap_or("");
                        let model = entry.get("model").and_then(Value::as_str).unwrap_or("");
                        if protocol.is_empty() || model.is_empty() {
                            return Vec::new();
                        }
                        let route_id = entry
                            .get("route_id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let variants = entry
                            .get("variants")
                            .and_then(Value::as_array)
                            .map(|variants| {
                                variants
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        if variants.is_empty() {
                            return vec![Self {
                                protocol: protocol.to_string(),
                                model: model.to_string(),
                                route_id,
                                variant: None,
                            }];
                        }
                        variants
                            .into_iter()
                            .map(|variant| Self {
                                protocol: protocol.to_string(),
                                model: model.to_string(),
                                route_id: route_id.clone(),
                                variant: Some(variant),
                            })
                            .collect()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn label(&self) -> String {
        match &self.variant {
            Some(variant) => format!("{} · {} · {variant}", self.model, self.protocol),
            None => format!("{} · {}", self.model, self.protocol),
        }
    }

    pub fn binding(&self) -> Value {
        let mut binding = serde_json::json!({
            "protocol": self.protocol,
            "model": self.model,
        });
        if let Some(route_id) = &self.route_id {
            binding["route_id"] = Value::String(route_id.clone());
        }
        if let Some(variant) = &self.variant {
            binding["variant"] = Value::String(variant.clone());
        }
        binding
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub label: String,
    pub detail: String,
}

pub struct ListDialog {
    pub title: &'static str,
    pub rows: Vec<Row>,
    pub selected: usize,
    /// Session rows answer `a`, `r` and `d` in addition to `Enter`.
    pub sessions: bool,
    pub hint: &'static str,
}

impl ListDialog {
    pub fn new(title: &'static str, rows: Vec<Row>, sessions: bool, hint: &'static str) -> Self {
        Self {
            title,
            rows,
            selected: 0,
            sessions,
            hint,
        }
    }

    fn move_cursor(&mut self, delta: i32) {
        if self.rows.is_empty() {
            return;
        }
        let next = self.selected as i32 + delta;
        self.selected = next.clamp(0, self.rows.len() as i32 - 1) as usize;
    }

    fn current_id(&self) -> Option<String> {
        self.rows.get(self.selected).map(|row| row.id.clone())
    }
}

pub enum ConfirmKind {
    RemoveSession(String),
}

pub struct ConfirmDialog {
    pub title: &'static str,
    pub message: String,
    /// False keeps the safe choice focused; a destructive action starts on
    /// "cancel" so a stray Enter cannot delete a Session.
    pub confirmed: bool,
    pub kind: ConfirmKind,
}

pub enum Dialog {
    Models(ListDialog),
    Theme(ListDialog),
    Sessions(ListDialog),
    Rename { session_id: String, input: Editor },
    Confirm(ConfirmDialog),
}

impl Dialog {
    pub fn models(models: &[ModelInfo]) -> Self {
        Dialog::Models(ListDialog::new(
            "models",
            models
                .iter()
                .enumerate()
                .map(|(index, model)| Row {
                    id: index.to_string(),
                    label: model.label(),
                    detail: model.route_id.clone().unwrap_or_default(),
                })
                .collect(),
            false,
            "enter select · esc close",
        ))
    }

    pub fn theme(current: &str) -> Self {
        let names = crate::theme::names();
        let mut list = ListDialog::new(
            "theme",
            names
                .iter()
                .enumerate()
                .map(|(index, name)| Row {
                    id: index.to_string(),
                    label: name.to_string(),
                    detail: String::new(),
                })
                .collect(),
            false,
            "enter apply · esc close",
        );
        list.selected = names.iter().position(|name| *name == current).unwrap_or(0);
        Dialog::Theme(list)
    }

    pub fn sessions(rows: &[SessionSummary]) -> Self {
        Dialog::Sessions(ListDialog::new(
            "sessions",
            rows.iter()
                .map(|row| Row {
                    id: row.id.clone(),
                    label: if row.archived_at_ms.is_some() {
                        format!("{} (archived)", row.label())
                    } else {
                        row.label().to_string()
                    },
                    detail: row.directory.clone().unwrap_or_default(),
                })
                .collect(),
            true,
            "enter open · r rename · a archive · d delete · esc close",
        ))
    }

    pub fn rename(session_id: &str, title: &str) -> Self {
        let mut input = Editor::new();
        input.set_text(title);
        Dialog::Rename {
            session_id: session_id.to_string(),
            input,
        }
    }

    pub fn confirm_remove(session_id: &str, title: &str) -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "delete session",
            message: format!("Delete \"{title}\" and everything it owns? This cannot be undone."),
            confirmed: false,
            kind: ConfirmKind::RemoveSession(session_id.to_string()),
        })
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        match self {
            Dialog::Models(list) | Dialog::Theme(list) | Dialog::Sessions(list) => {
                handle_list_key(list, key)
            }
            Dialog::Rename { input, .. } => handle_rename_key(input, key),
            Dialog::Confirm(confirm) => handle_confirm_key(confirm, key),
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Dialog::Models(list) | Dialog::Theme(list) | Dialog::Sessions(list) => list.title,
            Dialog::Rename { .. } => "rename session",
            Dialog::Confirm(confirm) => confirm.title,
        }
    }

    pub fn list(&self) -> Option<&ListDialog> {
        match self {
            Dialog::Models(list) | Dialog::Theme(list) | Dialog::Sessions(list) => Some(list),
            _ => None,
        }
    }

    pub fn list_mut(&mut self) -> Option<&mut ListDialog> {
        match self {
            Dialog::Models(list) | Dialog::Theme(list) | Dialog::Sessions(list) => Some(list),
            _ => None,
        }
    }

    pub fn rename_input(&self) -> Option<&Editor> {
        match self {
            Dialog::Rename { input, .. } => Some(input),
            _ => None,
        }
    }

    pub fn confirm(&self) -> Option<&ConfirmDialog> {
        match self {
            Dialog::Confirm(confirm) => Some(confirm),
            _ => None,
        }
    }

    pub fn height(&self) -> u16 {
        if let Some(list) = self.list() {
            return (list.rows.len().min(14) + 3) as u16;
        }
        if self.rename_input().is_some() {
            return 5;
        }
        6
    }
}

pub enum Action {
    None,
    Close,
    Chosen(usize),
    OpenSession(String),
    Rename(String),
    ToggleArchive(String),
    Remove(String),
    Submit(String),
    Confirmed(ConfirmKind),
}

fn handle_list_key(list: &mut ListDialog, key: KeyEvent) -> Action {
    match key.code {
        KeyCode::Esc => return Action::Close,
        KeyCode::Up | KeyCode::Char('k') => list.move_cursor(-1),
        KeyCode::Down | KeyCode::Char('j') => list.move_cursor(1),
        KeyCode::Enter => {
            let Some(id) = list.current_id() else {
                return Action::None;
            };
            return match list.sessions {
                true => Action::OpenSession(id),
                false => Action::Chosen(list.selected),
            };
        }
        KeyCode::Char('r') if list.sessions => {
            if let Some(id) = list.current_id() {
                return Action::Rename(id);
            }
        }
        KeyCode::Char('a') if list.sessions => {
            if let Some(id) = list.current_id() {
                return Action::ToggleArchive(id);
            }
        }
        KeyCode::Char('d') if list.sessions => {
            if let Some(id) = list.current_id() {
                return Action::Remove(id);
            }
        }
        _ => {}
    }
    Action::None
}

fn handle_rename_key(input: &mut Editor, key: KeyEvent) -> Action {
    if key.code == KeyCode::Esc {
        return Action::Close;
    }
    if key.code == KeyCode::Enter {
        let title = input.text().trim().to_string();
        if title.is_empty() {
            return Action::None;
        }
        return Action::Submit(title);
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Backspace => {
            input.backspace();
        }
        KeyCode::Delete => {
            input.delete_forward();
        }
        KeyCode::Left => {
            input.move_left();
        }
        KeyCode::Right => {
            input.move_right();
        }
        KeyCode::Home => {
            input.move_line_start();
        }
        KeyCode::End => {
            input.move_line_end();
        }
        KeyCode::Char('a') if ctrl => {
            input.move_line_start();
        }
        KeyCode::Char('e') if ctrl => {
            input.move_line_end();
        }
        KeyCode::Char('u') if ctrl => {
            input.delete_to_line_start();
        }
        KeyCode::Char('w') if ctrl => {
            input.delete_word_backward();
        }
        KeyCode::Char(c) if !ctrl => input.insert_char(c),
        _ => {}
    }
    Action::None
}

fn handle_confirm_key(confirm: &mut ConfirmDialog, key: KeyEvent) -> Action {
    match key.code {
        KeyCode::Esc => return Action::Close,
        KeyCode::Left | KeyCode::Right | KeyCode::Tab => {
            confirm.confirmed = !confirm.confirmed;
        }
        KeyCode::Char('y') => {
            confirm.confirmed = true;
        }
        KeyCode::Char('n') => {
            confirm.confirmed = false;
        }
        KeyCode::Enter => {
            if !confirm.confirmed {
                return Action::Close;
            }
            let kind = match &confirm.kind {
                ConfirmKind::RemoveSession(id) => ConfirmKind::RemoveSession(id.clone()),
            };
            return Action::Confirmed(kind);
        }
        _ => {}
    }
    Action::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn models() -> Vec<ModelInfo> {
        ModelInfo::catalog(&serde_json::json!([
            {"route_id": "r1", "protocol": "chat", "model": "glm-5"},
            {"protocol": "responses", "model": "gpt-5", "variants": ["low", "high"]}
        ]))
    }

    #[test]
    fn the_catalog_flattens_variants_into_bindings() {
        let models = models();
        assert_eq!(models.len(), 3);
        assert_eq!(models[2].label(), "gpt-5 · responses · high");
        assert_eq!(models[0].binding()["route_id"], "r1");
        assert_eq!(models[2].binding()["variant"], "high");
    }

    #[test]
    fn list_navigation_clamps_and_enter_returns_the_row() {
        let mut dialog = Dialog::models(&models());
        dialog.handle_key(key(KeyCode::Down));
        dialog.handle_key(key(KeyCode::Down));
        dialog.handle_key(key(KeyCode::Down));
        let list = dialog.list().expect("list");
        assert_eq!(list.selected, 2);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Chosen(2)
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Esc)),
            Action::Close
        ));
    }

    #[test]
    fn session_rows_answer_rename_archive_and_delete() {
        let row = SessionSummary {
            id: "ses_a".into(),
            title: Some("A".into()),
            parent_id: None,
            updated_at_ms: None,
            archived_at_ms: None,
            directory: None,
        };
        let mut dialog = Dialog::sessions(&[row]);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('r'))),
            Action::Rename(id) if id == "ses_a"
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('a'))),
            Action::ToggleArchive(id) if id == "ses_a"
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('d'))),
            Action::Remove(id) if id == "ses_a"
        ));
    }

    #[test]
    fn rename_submits_the_trimmed_title() {
        let mut dialog = Dialog::rename("ses_a", "Old");
        for _ in 0..3 {
            dialog.handle_key(key(KeyCode::Backspace));
        }
        for c in "New".chars() {
            dialog.handle_key(key(KeyCode::Char(c)));
        }
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Submit(title) if title == "New"
        ));
    }

    #[test]
    fn delete_confirmation_starts_on_cancel() {
        let mut dialog = Dialog::confirm_remove("ses_a", "A");
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Close
        ));
        let mut dialog = Dialog::confirm_remove("ses_a", "A");
        dialog.handle_key(key(KeyCode::Char('y')));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Confirmed(ConfirmKind::RemoveSession(id)) if id == "ses_a"
        ));
    }
}
