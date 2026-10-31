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

/// One selectable account, derived from the entries of `model_catalog` that
/// name a credential. The credential identity is opaque; the label never
/// reveals an endpoint or a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub credential_id: String,
    pub detail: String,
}

impl AccountInfo {
    pub fn catalog(value: &Value) -> Vec<Self> {
        let Some(entries) = value.as_array() else {
            return Vec::new();
        };
        // Catalog order decides the account order; each credential lists the
        // models it can serve without repeating one.
        let mut ids: Vec<String> = Vec::new();
        let mut models: Vec<Vec<String>> = Vec::new();
        for entry in entries {
            let Some(credential_id) = entry.get("credential_id").and_then(Value::as_str) else {
                continue;
            };
            let index = match ids.iter().position(|id| id == credential_id) {
                Some(index) => index,
                None => {
                    ids.push(credential_id.to_string());
                    models.push(Vec::new());
                    ids.len() - 1
                }
            };
            let model = entry.get("model").and_then(Value::as_str).unwrap_or("");
            if !model.is_empty() && !models[index].iter().any(|item| item == model) {
                models[index].push(model.to_string());
            }
        }
        ids.into_iter()
            .zip(models)
            .map(|(credential_id, models)| Self {
                credential_id,
                detail: models.join(", "),
            })
            .collect()
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
    pub kind: ListKind,
    pub hint: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    /// `Enter` returns the selected index.
    Plain,
    /// `Enter` opens the Session; `r`/`a`/`d` act on it.
    Sessions,
    /// `Enter` restores the prompt; `d` removes it.
    Stash,
    /// `Enter` returns the revert boundary sequence the row names.
    Timeline,
    /// No selection: `Enter` and `Esc` both close.
    ReadOnly,
}

impl ListDialog {
    pub fn new(title: &'static str, rows: Vec<Row>, kind: ListKind, hint: &'static str) -> Self {
        Self {
            title,
            rows,
            selected: 0,
            kind,
            hint,
        }
    }

    pub(crate) fn move_cursor(&mut self, delta: i32) {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmKind {
    RemoveSession(String),
    /// Rewind the transcript to a user message, with or without restoring the
    /// file set the Session recorded at that boundary.
    Revert {
        boundary_seq: u64,
        files: bool,
    },
}

pub struct ConfirmDialog {
    pub title: &'static str,
    pub message: String,
    /// False keeps the safe choice focused; a destructive action starts on
    /// "cancel" so a stray Enter cannot delete a Session.
    pub confirmed: bool,
    pub kind: ConfirmKind,
}

impl ConfirmDialog {
    /// The word on the confirming button. A revert is not a delete, and the
    /// button should not say so.
    pub fn action_label(&self) -> &'static str {
        match self.kind {
            ConfirmKind::RemoveSession(_) => "delete",
            ConfirmKind::Revert { .. } => "revert",
        }
    }
}

pub enum Dialog {
    SavedPermissions(crate::saved_permissions::Dialog),
    WorkspaceChanges(crate::workspace_changes::Dialog),
    Models(ListDialog),
    Theme(ListDialog),
    Sessions(ListDialog),
    Accounts(ListDialog),
    Stash(ListDialog),
    Timeline(ListDialog),
    Status(ListDialog),
    Debug(ListDialog),
    Help(ListDialog),
    Mcp(ListDialog),
    Providers(ListDialog),
    Skills(ListDialog),
    Workspaces(ListDialog),
    Message(TextDialog),
    Palette(PaletteDialog),
    Rename(RenameDialog),
    Confirm(ConfirmDialog),
}

/// A filterable list of commands. The filter owns the keyboard while the
/// palette is open; `Enter` hands the row's id back as the chosen command.
/// A scrollable plain-text view: message details, and anything else that is
/// read rather than chosen.
pub struct TextDialog {
    pub title: &'static str,
    pub lines: Vec<String>,
    pub scroll: usize,
}

pub struct PaletteDialog {
    pub input: Editor,
    pub rows: Vec<Row>,
    /// Indices into `rows` that match the filter, in display order.
    pub visible: Vec<usize>,
    pub selected: usize,
}

impl PaletteDialog {
    pub fn new(rows: Vec<Row>) -> Self {
        let visible = (0..rows.len()).collect();
        Self {
            input: Editor::new(),
            rows,
            visible,
            selected: 0,
        }
    }

    fn refilter(&mut self) {
        let needle = self.input.text().to_lowercase();
        self.visible = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.label.to_lowercase().contains(&needle)
                    || row.id.to_lowercase().contains(&needle)
            })
            .map(|(index, _)| index)
            .collect();
        self.selected = 0;
    }

    fn move_cursor(&mut self, delta: i32) {
        if self.visible.is_empty() {
            return;
        }
        let next = self.selected as i32 + delta;
        self.selected = next.clamp(0, self.visible.len() as i32 - 1) as usize;
    }

    fn current(&self) -> Option<&Row> {
        self.visible
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
    }
}

/// The rename dialog keeps its target beside the editor so a submit needs no
/// lookup of the row it came from.
pub struct RenameDialog {
    pub session_id: String,
    pub input: Editor,
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
            ListKind::Plain,
            "enter select · esc close",
        ))
    }

    pub fn theme(current: &str, catalog: &crate::theme::Catalog) -> Self {
        let names = catalog.names();
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
            ListKind::Plain,
            "enter apply · esc close",
        );
        list.selected = names.iter().position(|name| *name == current).unwrap_or(0);
        Dialog::Theme(list)
    }

    /// The MCP servers the host resolved for this workspace. Names and
    /// transports only: the host never exports headers or environment.
    /// The integrations the host has a stored credential for. Values never
    /// cross the process boundary; only the name and the operator's label.
    /// The skills the host discovered for this workspace.
    /// The workspaces the host reported for this project.
    pub fn workspaces(workspaces: &[(String, String)]) -> Self {
        let rows = if workspaces.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no workspaces".to_string(),
                detail: String::new(),
            }]
        } else {
            workspaces
                .iter()
                .map(|(name, detail)| Row {
                    id: name.clone(),
                    label: name.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Workspaces(ListDialog::new(
            "workspaces",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn skills(skills: &[(String, String)]) -> Self {
        let rows = if skills.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no skills discovered".to_string(),
                detail: String::new(),
            }]
        } else {
            skills
                .iter()
                .map(|(name, detail)| Row {
                    id: name.clone(),
                    label: name.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Skills(ListDialog::new(
            "skills",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn providers(providers: &[(String, String)]) -> Self {
        let rows = if providers.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no providers configured".to_string(),
                detail: String::new(),
            }]
        } else {
            providers
                .iter()
                .map(|(name, detail)| Row {
                    id: name.clone(),
                    label: name.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Providers(ListDialog::new(
            "providers",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn mcp(servers: &[(String, String)]) -> Self {
        let rows = if servers.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no MCP servers configured".to_string(),
                detail: String::new(),
            }]
        } else {
            servers
                .iter()
                .map(|(name, detail)| Row {
                    id: name.clone(),
                    label: name.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Mcp(ListDialog::new(
            "mcp",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))

    }

    pub fn message(lines: Vec<String>) -> Self {
        Dialog::Message(TextDialog {
            title: "message",
            lines,
            scroll: 0,
        })
    }

    pub fn sessions(rows: &[SessionSummary]) -> Self {
        Dialog::Sessions(ListDialog::new(
            "sessions",
            rows.iter()
                .map(|row| {
                    // Both marks are suffixes so a row can honestly show that it
                    // is pinned and archived at once; neither affects the order,
                    // which the caller already handed over pinned-first.
                    let mut label = row.label().to_string();
                    if row.pinned_at_ms.is_some() {
                        label.push_str(" (pinned)");
                    }
                    if row.archived_at_ms.is_some() {
                        label.push_str(" (archived)");
                    }
                    Row {
                        id: row.id.clone(),
                        label,
                        detail: row.directory.clone().unwrap_or_default(),
                    }
                })
                .collect(),
            ListKind::Sessions,
            "enter open · r rename · p pin · a archive · d delete · esc close",
        ))
    }

    pub fn accounts(accounts: &[AccountInfo]) -> Self {
        Dialog::Accounts(ListDialog::new(
            "accounts",
            accounts
                .iter()
                .map(|account| Row {
                    id: account.credential_id.clone(),
                    label: account.credential_id.clone(),
                    detail: account.detail.clone(),
                })
                .collect(),
            ListKind::Plain,
            "enter switch · esc close",
        ))
    }

    pub fn stash(rows: Vec<Row>) -> Self {
        Dialog::Stash(ListDialog::new(
            "stash",
            rows,
            ListKind::Stash,
            "enter restore · d delete · esc close",
        ))
    }

    pub fn timeline(rows: Vec<Row>) -> Self {
        Dialog::Timeline(ListDialog::new(
            "timeline",
            rows,
            ListKind::Timeline,
            "enter revert to here · esc close",
        ))
    }

    pub fn status(rows: Vec<Row>) -> Self {
        Dialog::Status(ListDialog::new(
            "status",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn debug(rows: Vec<Row>) -> Self {
        Dialog::Debug(ListDialog::new(
            "debug",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn help(rows: Vec<Row>) -> Self {
        Dialog::Help(ListDialog::new(
            "help",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    pub fn command_palette(rows: Vec<Row>) -> Self {
        Dialog::Palette(PaletteDialog::new(rows))
    }

    pub fn rename(session_id: &str, title: &str) -> Self {
        let mut input = Editor::new();
        input.set_text(title);
        Dialog::Rename(RenameDialog {
            session_id: session_id.to_string(),
            input,
        })
    }

    pub fn confirm_remove(session_id: &str, title: &str) -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "delete session",
            message: format!("Delete \"{title}\" and everything it owns? This cannot be undone."),
            confirmed: false,
            kind: ConfirmKind::RemoveSession(session_id.to_string()),
        })
    }

    /// Ask before a revert lands. The plan comes from the engine, so the
    /// dialog states what will actually change, including paths this Session
    /// did not edit itself.
    pub fn confirm_revert(boundary_seq: u64, plan: &crate::session::RevertPlan) -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "revert",
            message: plan.summary(),
            confirmed: false,
            kind: ConfirmKind::Revert {
                boundary_seq,
                files: plan.files(),
            },
        })
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        match self {
            Dialog::SavedPermissions(dialog) => dialog.handle_key(key),
            Dialog::WorkspaceChanges(dialog) => dialog.handle_key(key),
            Dialog::Models(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list) => handle_list_key(list, key),
            Dialog::Mcp(list) => handle_list_key(list, key),
            Dialog::Providers(list) => handle_list_key(list, key),
            Dialog::Skills(list) => handle_list_key(list, key),
            Dialog::Workspaces(list) => handle_list_key(list, key),
            Dialog::Message(text) => handle_text_key(text, key),
            Dialog::Palette(palette) => handle_palette_key(palette, key),
            Dialog::Rename(rename) => handle_rename_key(&mut rename.input, key),
            Dialog::Confirm(confirm) => handle_confirm_key(confirm, key),
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Dialog::SavedPermissions(_) => "saved permissions",
            Dialog::WorkspaceChanges(_) => "workspace changes",
            Dialog::Models(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list) => list.title,
            Dialog::Mcp(list) => list.title,
            Dialog::Providers(list) => list.title,
            Dialog::Skills(list) => list.title,
            Dialog::Workspaces(list) => list.title,
            Dialog::Message(text) => text.title,
            Dialog::Palette(_) => "commands",
            Dialog::Rename(_) => "rename session",
            Dialog::Confirm(confirm) => confirm.title,
        }
    }

    pub fn list(&self) -> Option<&ListDialog> {
        match self {
            Dialog::Models(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list)
            | Dialog::Mcp(list)
            | Dialog::Providers(list)
            | Dialog::Skills(list)
            | Dialog::Workspaces(list) => Some(list),
            _ => None,
        }
    }

    pub fn list_mut(&mut self) -> Option<&mut ListDialog> {
        match self {
            Dialog::Models(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list)
            | Dialog::Mcp(list)
            | Dialog::Providers(list)
            | Dialog::Skills(list)
            | Dialog::Workspaces(list) => Some(list),
            _ => None,
        }
    }

    pub fn rename_input(&self) -> Option<&Editor> {
        match self {
            Dialog::Rename(rename) => Some(&rename.input),
            _ => None,
        }
    }

    pub fn rename_session_id(&self) -> Option<&str> {
        match self {
            Dialog::Rename(rename) => Some(&rename.session_id),
            _ => None,
        }
    }

    pub fn confirm(&self) -> Option<&ConfirmDialog> {
        match self {
            Dialog::Confirm(confirm) => Some(confirm),
            _ => None,
        }
    }

    pub fn palette(&self) -> Option<&PaletteDialog> {
        match self {
            Dialog::Palette(palette) => Some(palette),
            _ => None,
        }
    }

    pub fn height(&self) -> u16 {
        if matches!(self, Dialog::Message(_)) {
            return 22;
        }
        if matches!(self, Dialog::SavedPermissions(_)) {
            return 18;
        }
        if let Some(palette) = self.palette() {
            // Filter line, one row even when nothing matches, and the border.
            return (palette.visible.len().clamp(1, 12) + 3) as u16;
        }
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
    RefreshPermissions,
    RevokePermission(String),
    RefreshWorkspaceChanges(String),
    None,
    Close,
    Chosen(usize),
    OpenSession(String),
    Rename(String),
    ToggleArchive(String),
    TogglePin(String),
    Remove(String),
    Submit(String),
    Confirmed(ConfirmKind),
    /// Take one stashed prompt back into the composer.
    StashRestore(usize),
    StashRemove(usize),
    /// Rewind this Session to the user message with this sequence.
    Revert(u64),
    /// Run the command the palette selected, by its id.
    Command(String),
}

fn handle_text_key(text: &mut TextDialog, key: KeyEvent) -> Action {
    match key.code {
        KeyCode::Esc | KeyCode::Enter => return Action::Close,
        KeyCode::Up | KeyCode::Char('k') => text.scroll = text.scroll.saturating_sub(1),
        KeyCode::Down | KeyCode::Char('j') => text.scroll += 1,
        KeyCode::PageUp => text.scroll = text.scroll.saturating_sub(10),
        KeyCode::PageDown => text.scroll += 10,
        KeyCode::Home => text.scroll = 0,
        _ => {}
    }
    Action::None
}

fn handle_list_key(list: &mut ListDialog, key: KeyEvent) -> Action {
    match key.code {
        KeyCode::Esc => return Action::Close,
        KeyCode::Up | KeyCode::Char('k') => list.move_cursor(-1),
        KeyCode::Down | KeyCode::Char('j') => list.move_cursor(1),
        KeyCode::Enter => {
            if list.kind == ListKind::ReadOnly {
                return Action::Close;
            }
            let Some(id) = list.current_id() else {
                return Action::None;
            };
            return match list.kind {
                ListKind::Sessions => Action::OpenSession(id),
                ListKind::Stash => Action::StashRestore(list.selected),
                ListKind::Timeline => match id.parse::<u64>() {
                    Ok(seq) => Action::Revert(seq),
                    Err(_) => Action::None,
                },
                _ => Action::Chosen(list.selected),
            };
        }
        KeyCode::Char('r') if list.kind == ListKind::Sessions => {
            if let Some(id) = list.current_id() {
                return Action::Rename(id);
            }
        }
        KeyCode::Char('p') if list.kind == ListKind::Sessions => {
            if let Some(id) = list.current_id() {
                return Action::TogglePin(id);
            }
        }
        KeyCode::Char('a') if list.kind == ListKind::Sessions => {
            if let Some(id) = list.current_id() {
                return Action::ToggleArchive(id);
            }
        }
        KeyCode::Char('d') if list.kind == ListKind::Sessions => {
            if let Some(id) = list.current_id() {
                return Action::Remove(id);
            }
        }
        KeyCode::Char('d') if list.kind == ListKind::Stash => {
            return Action::StashRemove(list.selected);
        }
        _ => {}
    }
    Action::None
}

fn handle_palette_key(palette: &mut PaletteDialog, key: KeyEvent) -> Action {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    match key.code {
        KeyCode::Esc => Action::Close,
        KeyCode::Up => {
            palette.move_cursor(-1);
            Action::None
        }
        KeyCode::Down => {
            palette.move_cursor(1);
            Action::None
        }
        KeyCode::Char('n') if ctrl => {
            palette.move_cursor(1);
            Action::None
        }
        KeyCode::Char('p') if ctrl => {
            palette.move_cursor(-1);
            Action::None
        }
        KeyCode::Enter => match palette.current() {
            Some(row) => Action::Command(row.id.clone()),
            None => Action::None,
        },
        KeyCode::Backspace if ctrl || alt => {
            palette.input.delete_word_backward();
            palette.refilter();
            Action::None
        }
        KeyCode::Backspace => {
            palette.input.backspace();
            palette.refilter();
            Action::None
        }
        KeyCode::Delete => {
            palette.input.delete_forward();
            palette.refilter();
            Action::None
        }
        KeyCode::Left => {
            palette.input.move_left();
            Action::None
        }
        KeyCode::Right => {
            palette.input.move_right();
            Action::None
        }
        KeyCode::Home => {
            palette.input.move_line_start();
            Action::None
        }
        KeyCode::End => {
            palette.input.move_line_end();
            Action::None
        }
        KeyCode::Char('a') if ctrl => {
            palette.input.move_line_start();
            Action::None
        }
        KeyCode::Char('e') if ctrl => {
            palette.input.move_line_end();
            Action::None
        }
        KeyCode::Char('u') if ctrl => {
            palette.input.delete_to_line_start();
            palette.refilter();
            Action::None
        }
        KeyCode::Char('w') if ctrl => {
            palette.input.delete_word_backward();
            palette.refilter();
            Action::None
        }
        KeyCode::Char(c) if !ctrl && !alt => {
            palette.input.insert_char(c);
            palette.refilter();
            Action::None
        }
        _ => Action::None,
    }
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
                ConfirmKind::Revert {
                    boundary_seq,
                    files,
                } => ConfirmKind::Revert {
                    boundary_seq: *boundary_seq,
                    files: *files,
                },
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
    fn session_rows_answer_rename_pin_archive_and_delete() {
        let row = SessionSummary {
            id: "ses_a".into(),
            title: Some("A".into()),
            parent_id: None,
            updated_at_ms: None,
            archived_at_ms: None,
            pinned_at_ms: None,
            directory: None,
            model: None,
            credential_id: None,
        };
        let mut dialog = Dialog::sessions(&[row]);
        assert_eq!(dialog.list().expect("list").rows[0].label, "A");
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('r'))),
            Action::Rename(id) if id == "ses_a"
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('p'))),
            Action::TogglePin(id) if id == "ses_a"
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
    fn the_account_catalog_names_each_credential_once() {
        let accounts = AccountInfo::catalog(&serde_json::json!([
            {"protocol": "chat", "model": "glm-5", "credential_id": "cred_a"},
            {"protocol": "chat", "model": "glm-5", "variant": "high", "credential_id": "cred_a"},
            {"protocol": "responses", "model": "gpt-5", "credential_id": "cred_b"},
            {"protocol": "responses", "model": "gpt-5"}
        ]));
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].credential_id, "cred_a");
        assert_eq!(accounts[0].detail, "glm-5");
        assert_eq!(accounts[1].credential_id, "cred_b");
    }

    #[test]
    fn a_stash_row_restores_on_enter_and_deletes_on_d() {
        let rows = vec![
            Row {
                id: "0".into(),
                label: "first".into(),
                detail: String::new(),
            },
            Row {
                id: "1".into(),
                label: "second".into(),
                detail: String::new(),
            },
        ];
        let mut dialog = Dialog::stash(rows);
        dialog.handle_key(key(KeyCode::Down));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::StashRestore(1)
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('d'))),
            Action::StashRemove(1)
        ));
    }

    #[test]
    fn a_read_only_list_closes_on_enter() {
        let rows = vec![Row {
            id: "turns".into(),
            label: "turns".into(),
            detail: "3".into(),
        }];
        let mut dialog = Dialog::status(rows);
        assert_eq!(dialog.title(), "status");
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Close
        ));
    }

    #[test]
    fn the_palette_filters_as_you_type_and_returns_the_chosen_id() {
        let mut dialog = Dialog::command_palette(vec![
            Row {
                id: "model".into(),
                label: "Select a model".into(),
                detail: "<leader>m".into(),
            },
            Row {
                id: "theme".into(),
                label: "Select a theme".into(),
                detail: "<leader>t".into(),
            },
        ]);
        for c in "theme".chars() {
            dialog.handle_key(key(KeyCode::Char(c)));
        }
        let list = dialog.palette().expect("palette");
        assert_eq!(list.visible.len(), 1);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Command(id) if id == "theme"
        ));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Esc)),
            Action::Close
        ));
    }

    #[test]
    fn backspace_widens_the_palette_filter_again() {
        let mut dialog = Dialog::command_palette(vec![Row {
            id: "model".into(),
            label: "Select a model".into(),
            detail: String::new(),
        }]);
        dialog.handle_key(key(KeyCode::Char('z')));
        assert!(dialog.palette().expect("palette").visible.is_empty());
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::None
        ));
        dialog.handle_key(key(KeyCode::Backspace));
        assert_eq!(dialog.palette().expect("palette").visible.len(), 1);
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
