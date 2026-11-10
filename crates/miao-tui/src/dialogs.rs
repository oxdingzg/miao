//! Modal dialogs: model selection, theme selection, the Session list, rename
//! and delete confirmation.
//!
//! The dialogs own only their cursor and edit state. Every decision leaves as
//! an [`Action`] so the app can issue the engine request or apply a theme.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;

use crate::editor::Editor;
use crate::event::JobRow;
use crate::session::{ModelPin, SessionSummary};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub protocol: String,
    pub model: String,
    pub route_id: Option<String>,
    pub variant: Option<String>,
    /// The provider half of the catalog's model key (`volcengine/model`), so
    /// the picker groups the list the way the product's does.
    pub provider: Option<String>,
    /// The account this route spends, when the provider holds more than one.
    /// Two accounts answer through two routes, and the label is what tells
    /// them apart in the picker.
    pub account: Option<String>,
    /// The opaque credential identity behind the route. It stands in for the
    /// account label when the operator named none, which is the only thing
    /// telling two keys of one provider apart.
    pub credential_id: Option<String>,
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
                        let provider = entry
                            .get("model_key")
                            .and_then(Value::as_str)
                            .and_then(|key| key.split_once('/'))
                            .map(|(provider, _)| provider.to_string())
                            // The catalog does not always name the model_key;
                            // the route id still does, and grouping collapses
                            // without it.
                            .or_else(|| {
                                entry
                                    .get("route_id")
                                    .and_then(Value::as_str)
                                    .and_then(|id| id.split_once('/'))
                                    .map(|(provider, _)| provider.to_string())
                            });
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
                        let account = entry
                            .get("account")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let credential_id = entry
                            .get("credential_id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let single = Self {
                            protocol: protocol.to_string(),
                            model: model.to_string(),
                            route_id: route_id.clone(),
                            variant: None,
                            provider: provider.clone(),
                            account: account.clone(),
                            credential_id: credential_id.clone(),
                        };
                        if variants.is_empty() {
                            return vec![single];
                        }
                        variants
                            .into_iter()
                            .map(|variant| Self {
                                protocol: protocol.to_string(),
                                model: model.to_string(),
                                route_id: route_id.clone(),
                                variant: Some(variant),
                                provider: provider.clone(),
                                account: account.clone(),
                                credential_id: credential_id.clone(),
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

    /// The muted column of a picker row: the provider that serves the route
    /// and, when that provider holds more than one account (`shared`), the
    /// account the row spends. The TypeScript picker fills the same column
    /// with `provider.name` (`dialog-model.tsx`), which keeps a row readable
    /// once its provider header has scrolled away.
    pub fn origin(&self, shared: &[String]) -> String {
        let name_account = self
            .provider
            .as_ref()
            .is_some_and(|provider| shared.contains(provider));
        let account = self
            .account
            .as_deref()
            .or(self.credential_id.as_deref())
            .filter(|account| name_account && *account != "default");
        [self.provider.as_deref(), account]
            .into_iter()
            .flatten()
            .collect::<Vec<&str>>()
            .join(" · ")
    }

    /// What the status strip names: the model, the provider serving it, the
    /// wire protocol and the variant. The picker leaves the provider out
    /// because its rows already sit under a provider header; the strip has no
    /// header, and `deepseek-v4-1-flash-261017 · openai-chat` named the
    /// transport without ever saying which provider answered.
    pub fn identity(&self) -> String {
        let mut parts = vec![self.model.clone()];
        if let Some(provider) = &self.provider {
            parts.push(provider.clone());
        }
        if let Some(account) = self
            .account
            .as_deref()
            .filter(|account| *account != "default")
        {
            parts.push(account.to_string());
        }
        parts.push(self.protocol.clone());
        if let Some(variant) = &self.variant {
            parts.push(variant.clone());
        }
        parts.join(" · ")
    }

    /// Distinct providers the catalog names, in first-appearance order. The
    /// ctrl+o filter list and the picker's groups share it.
    pub fn providers(models: &[ModelInfo]) -> Vec<String> {
        let mut providers: Vec<String> = Vec::new();
        for model in models {
            if let Some(provider) = &model.provider {
                if !providers.iter().any(|named| named == provider) {
                    providers.push(provider.clone());
                }
            }
        }
        providers
    }

    /// The id a selection is remembered by: the route when the catalog names
    /// one, otherwise `provider/model`, which is what the engine keys a model
    /// by when a provider serves exactly one account.
    pub fn route(&self) -> String {
        self.route_id
            .clone()
            .unwrap_or_else(|| match &self.provider {
                // A catalog entry that names no provider has no route to key on,
                // so the model id is the whole identity: writing `/{model}` into
                // the remembered preference would name nothing.
                Some(provider) => format!("{provider}/{}", self.model),
                None => self.model.clone(),
            })
    }

    /// Whether a remembered pin or a starred route names this model.
    pub fn matches(&self, name: &str) -> bool {
        self.model == name || self.route() == name
    }

    /// The catalog entry a remembered selection names.
    ///
    /// The launcher reads the operator's last pick back from its own
    /// preferences, and that value can be a model id, a route id, or the
    /// display name the engine carried before a route suffix was appended to
    /// the id (`deepseek-v4.1-flash` against `deepseek-v4-1-flash-261017`).
    /// Missing that match is why the landing strip used to name a model with
    /// no provider: the label fell back to the remembered string.
    pub fn resolve<'a>(models: &'a [ModelInfo], remembered: &str) -> Option<&'a ModelInfo> {
        models
            .iter()
            .find(|info| info.matches(remembered))
            .or_else(|| {
                let wanted = comparable(remembered);
                models.iter().find(|info| {
                    let id = comparable(&info.model);
                    id == wanted || (id.starts_with(&wanted) && id[wanted.len()..].starts_with('-'))
                })
            })
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

/// The model a Session runs on, as a row names it: the pin, then the provider
/// and the account that serve it. The pin on its own read `Claude-Opus-4.5`,
/// which named no provider at all, and left two accounts of one provider
/// looking like the same choice.
pub fn session_model(models: &[ModelInfo], pin: &ModelPin) -> String {
    let known = models.iter().find(|info| {
        let named = match &pin.route_id {
            Some(route_id) => info.route_id.as_deref() == Some(route_id.as_str()),
            None => {
                info.route_id.is_none() && info.model == pin.model && info.protocol == pin.protocol
            }
        };
        named && info.variant == pin.variant
    });

    // A catalog entry answers with the model, its provider, its account, the
    // protocol and the variant — the same reading the status strip gives a
    // selection. Only a route the catalog no longer serves falls back to the
    // raw pin, which is better than naming nothing.
    match known {
        Some(known) => known.identity(),
        None => pin.label(),
    }
}

/// The providers whose catalog holds more than one account. Two keys of one
/// provider serve the same models, so only those rows need the account named;
/// a provider with a single key would just repeat its own id on every row.
fn providers_with_several_accounts(models: &[ModelInfo]) -> Vec<String> {
    let mut seen: Vec<(&str, Vec<&str>)> = Vec::new();
    for model in models {
        let Some(provider) = model.provider.as_deref() else {
            continue;
        };
        let Some(account) = model.account.as_deref().or(model.credential_id.as_deref()) else {
            continue;
        };
        match seen.iter_mut().find(|(named, _)| *named == provider) {
            Some((_, accounts)) if !accounts.contains(&account) => accounts.push(account),
            Some(_) => {}
            None => seen.push((provider, vec![account])),
        }
    }
    seen.into_iter()
        .filter(|(_, accounts)| accounts.len() > 1)
        .map(|(provider, _)| provider.to_string())
        .collect()
}

/// One selectable account, derived from the entries of `model_catalog` that
/// name a credential. The credential identity is opaque; the label never
/// reveals an endpoint or a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub credential_id: String,
    /// The provider the credential serves, when the catalog names one. The
    /// account list groups by it, the way `provider.accounts` does.
    pub provider: Option<String>,
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
        let mut providers: Vec<Option<String>> = Vec::new();
        for entry in entries {
            let Some(credential_id) = entry.get("credential_id").and_then(Value::as_str) else {
                continue;
            };
            let index = match ids.iter().position(|id| id == credential_id) {
                Some(index) => index,
                None => {
                    ids.push(credential_id.to_string());
                    models.push(Vec::new());
                    providers.push(None);
                    ids.len() - 1
                }
            };
            let model = entry.get("model").and_then(Value::as_str).unwrap_or("");
            if !model.is_empty() && !models[index].iter().any(|item| item == model) {
                models[index].push(model.to_string());
            }
            if providers[index].is_none() {
                providers[index] = provider_of(entry);
            }
        }
        ids.into_iter()
            .zip(models)
            .zip(providers)
            .map(|((credential_id, models), provider)| Self {
                credential_id,
                provider,
                detail: models.join(", "),
            })
            .collect()
    }
}

/// The provider a catalog entry belongs to. The model key names it outright;
/// the route id still does when the served catalog omits the key.
fn provider_of(entry: &Value) -> Option<String> {
    entry
        .get("model_key")
        .and_then(Value::as_str)
        .and_then(|key| key.split_once('/'))
        .map(|(provider, _)| provider.to_string())
        .or_else(|| {
            entry
                .get("route_id")
                .and_then(Value::as_str)
                .and_then(|id| id.split_once('/'))
                .map(|(provider, _)| provider.to_string())
        })
}

/// One provider the engine's catalog names, with the two facts a picker needs:
/// how many models it offers and whether this engine already serves one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    pub detail: String,
    /// Whether this engine already serves a model of the provider. The model
    /// picker marks the rest as needing auth instead of hiding them.
    pub configured: bool,
    /// How many unexpired credentials this install holds for the provider, so a
    /// row can tell "no account" from "an account but no route".
    pub accounts: u64,
}

impl ProviderEntry {
    pub fn catalog(value: &Value) -> Vec<Self> {
        let Some(entries) = value.get("providers").and_then(Value::as_array) else {
            return Vec::new();
        };
        entries
            .iter()
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?;
                let models = entry.get("models").and_then(Value::as_u64).unwrap_or(0);
                let configured = entry
                    .get("configured")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let accounts = entry.get("accounts").and_then(Value::as_u64).unwrap_or(0);
                Some(Self {
                    id: id.to_string(),
                    name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                    detail: format!(
                        "{models} models · {}",
                        // "needs auth" named the wrong thing: a provider can
                        // hold an account and still serve no route, which needs
                        // a models entry rather than a key.
                        match (configured, accounts) {
                            (true, 0) => "ready".to_string(),
                            (true, 1) => "ready · 1 account".to_string(),
                            (true, many) => format!("ready · {many} accounts"),
                            (false, 0) => "needs auth".to_string(),
                            (false, 1) => "1 account · no route".to_string(),
                            (false, many) => format!("{many} accounts · no route"),
                        }
                    ),
                    configured,
                    accounts,
                })
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

impl Row {
    /// A provider header names a group and never takes the cursor.
    pub fn is_header(&self) -> bool {
        self.id.starts_with("group:")
    }
}

pub struct ListDialog {
    pub title: &'static str,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub kind: ListKind,
    pub hint: &'static str,
    /// Type-ahead filter for plain lists; the empty filter shows everything.
    pub filter: Editor,
    /// Indices into `rows` that match the filter, in display order.
    pub visible: Vec<usize>,
    /// Sessions keep their letter commands, so `/` arms the same filter the
    /// plain lists always have instead of making every key a query character.
    /// While armed the query owns the keyboard and the filter line shows why
    /// rows disappeared.
    pub search: bool,
    /// Sessions only: the pinned Session ids in display order, one per `1`-`9`
    /// quick slot, so a digit reaches a pin without walking the list.
    pub slots: Vec<String>,
    /// Rows whose preview the app already asked the engine for, kept apart
    /// from the detail: a jobs row carries its command as the detail before
    /// any preview answer lands, so the detail cannot say whether the engine
    /// was asked.
    pub(crate) previewed: Vec<String>,
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
    /// `a` approves a pending candidate, `x` rejects it, `r` revokes a grant.
    Devices,
    /// `Enter` refreshes the list; `x` stops the selected background job.
    Jobs,
    /// `Enter` refreshes; `x` cancels the selected wakeup or cron.
    Schedule,
    /// `Enter` moves this Session into the tree; `n` adds one, `d` removes
    /// the one under the cursor.
    Worktrees,
}

impl ListDialog {
    pub fn new(title: &'static str, rows: Vec<Row>, kind: ListKind, hint: &'static str) -> Self {
        let visible = (0..rows.len()).collect();
        let mut this = Self {
            title,
            rows,
            selected: 0,
            kind,
            hint,
            filter: Editor::new(),
            visible,
            search: false,
            slots: Vec::new(),
            previewed: Vec::new(),
        };
        // A leading header names a group and never takes the cursor, so the
        // list opens on its first model.
        if this.header_at(0) {
            this.selected = this.skip_headers(0, 1);
        }
        this
    }

    /// Plain lists (models, accounts, themes) type-ahead filter, and so does a
    /// read-only list: `help` is long enough that scrolling for a name is worse
    /// than typing it. List kinds with their own letter commands keep their
    /// keyboard.
    fn filterable(&self) -> bool {
        matches!(self.kind, ListKind::Plain | ListKind::ReadOnly)
    }

    /// Whether the painted list carries a filter row: a filterable list always
    /// does, and a Sessions list does while `/` has armed its search.
    pub fn shows_filter(&self) -> bool {
        self.filterable() || self.search
    }

    /// Put back the query and whether the search was armed, then refilter.
    ///
    /// The dialog is rebuilt whenever the catalog refreshes; without this the
    /// rows came back but the query did not, and the list jumped to its full
    /// history under the operator's cursor.
    pub(crate) fn restore_search(&mut self, query: &str, armed: bool) {
        self.search = armed;
        self.filter.set_text(query);
        self.refilter();
        self.selected = self.selected.min(self.visible.len().saturating_sub(1));
    }

    pub(crate) fn refilter(&mut self) {
        let needle = self.filter.text().to_lowercase();
        // A provider header matches when any model under it matches, so a
        // narrowed list keeps its grouping instead of orphaning the models it
        // kept. Headers are held back until the first matching model of their
        // group arrives; a model that does not match closes its group.
        let matches_row = |row: &Row| {
            needle.is_empty()
                || row.label.to_lowercase().contains(&needle)
                || row.detail.to_lowercase().contains(&needle)
                || row.id.to_lowercase().contains(&needle)
        };
        let mut visible = Vec::new();
        let mut held_headers: Vec<usize> = Vec::new();
        for (index, row) in self.rows.iter().enumerate() {
            if Self::is_header(row) {
                if needle.is_empty() {
                    visible.push(index);
                } else {
                    held_headers.push(index);
                }
            } else if matches_row(row) {
                visible.append(&mut held_headers);
                visible.push(index);
            } else if !needle.is_empty() {
                held_headers.clear();
            }
        }
        self.visible = visible;
        self.selected = if self.visible.is_empty() {
            0
        } else {
            self.skip_headers(0, 1)
        };
    }

    /// A header row names a provider group and never takes the cursor.
    fn is_header(row: &Row) -> bool {
        row.is_header()
    }

    fn header_at(&self, index: usize) -> bool {
        self.visible
            .get(index)
            .and_then(|row_index| self.rows.get(*row_index))
            .is_some_and(Self::is_header)
    }

    /// The nearest selectable position from `index`, walking in `delta`'s
    /// direction when the row there is a header.
    fn skip_headers(&self, mut index: usize, delta: i32) -> usize {
        while self.header_at(index) {
            let last = index == 0 && delta < 0;
            let exhausted = index + 1 >= self.visible.len() && delta >= 0;
            if last || exhausted {
                break;
            }
            index = (index as i32 + delta.signum()) as usize;
        }
        index
    }

    pub(crate) fn move_cursor(&mut self, delta: i32) {
        if self.visible.is_empty() {
            return;
        }
        let next = (self.selected as i32 + delta).clamp(0, self.visible.len() as i32 - 1) as usize;
        self.selected = self.skip_headers(next, delta);
    }

    fn current_id(&self) -> Option<String> {
        self.visible
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
            .map(|row| row.id.clone())
    }

    /// The id of the row the cursor is on, for a dialog whose rows name
    /// something the engine can answer more about.
    pub(crate) fn selected_id(&self) -> Option<String> {
        self.current_id()
    }

    /// Fill in a detail once the engine answers. Only the row with that id
    /// changes, so an answer for a row the operator already left is ignored
    /// instead of landing under the wrong job.
    pub(crate) fn set_detail(&mut self, id: &str, detail: String) {
        if let Some(row) = self.rows.iter_mut().find(|row| row.id == id) {
            row.detail = detail;
        }
    }

    /// Whether the preview for `id` was already asked for, once per row
    /// instead of on every cursor move.
    pub(crate) fn preview_asked(&self, id: &str) -> bool {
        self.previewed.iter().any(|asked| asked == id)
    }

    pub(crate) fn mark_preview_asked(&mut self, id: &str) {
        if !self.preview_asked(id) {
            self.previewed.push(id.to_string());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmKind {
    RemoveSession(String),
    /// Remove one git worktree by name.
    RemoveWorktree(String),
    /// Rewind the transcript to a user message, with or without restoring the
    /// file set the Session recorded at that boundary.
    Revert {
        boundary_seq: u64,
        files: bool,
    },
    /// Forget every stored credential for one integration. The routes that
    /// named them go with them, which is why it is worth a confirmation.
    RemoveCredential(String),
    /// Stop every background job of the open Session at once. Every running
    /// job dies together, which is why it is worth a confirmation.
    StopAllJobs,
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
            ConfirmKind::RemoveWorktree(_) => "remove",
            ConfirmKind::Revert { .. } => "revert",
            ConfirmKind::RemoveCredential(_) => "delete",
            ConfirmKind::StopAllJobs => "stop",
        }
    }
}

pub enum Dialog {
    SavedPermissions(crate::saved_permissions::Dialog),
    WorkspaceChanges(crate::workspace_changes::Dialog),
    /// ctrl+o inside the model picker: one provider to narrow the list to.
    ModelProviders(ListDialog),
    Models(ListDialog),
    Theme(ListDialog),
    Sessions(ListDialog),
    /// ctrl+o: providers that hold an account, one step above `Accounts`.
    ProviderAccounts(ListDialog),
    Accounts(ListDialog),
    Stash(ListDialog),
    Timeline(ListDialog),
    Status(ListDialog),
    Debug(ListDialog),
    Help(ListDialog),
    Mcp(ListDialog),
    Providers(ListDialog),
    Devices(ListDialog),
    Jobs(ListDialog),
    Schedule(ListDialog),
    Skills(ListDialog),
    Workspaces(ListDialog),
    Worktrees(ListDialog),
    TurnTimings(ListDialog),
    Message(TextDialog),
    Palette(PaletteDialog),
    Rename(RenameDialog),
    Tag(TagDialog),
    SignIn(SignInDialog),
    WorktreeNew(WorktreeNewDialog),
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

/// The API key for one provider. The engine builds its route table when it
/// starts, so storing the key is only half the job: the app restarts the engine
/// afterwards, which is what makes the provider's models appear.
pub struct SignInDialog {
    pub provider: String,
    pub name: String,
    pub input: Editor,
    /// The account a second key is stored under. `None` edits the default
    /// account, which is what re-entering a key means; `Some` adds another key
    /// beside it, and the label is what the account list and a route id show.
    pub account: Option<Editor>,
    /// Which field the keyboard is in while `account` is present.
    pub field: SignInField,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInField {
    Account,
    Key,
}

/// A paste into a one-line field: the line breaks a clipboard often carries
/// would otherwise land inside a value that has to stay one line, like an API
/// key or a Session name.
fn insert_paste(input: &mut Editor, text: &str) {
    input.insert_str(&text.replace(['\r', '\n'], ""));
}

/// The operator's own label for a Session. Confirming an empty label clears it,
/// the same shape rename already has: the dialog is the edit.
pub struct TagDialog {
    pub session_id: String,
    pub input: Editor,
}

/// The name for a new worktree: one path component, which is what the engine
/// accepts and what the directory it creates is called.
pub struct WorktreeNewDialog {
    pub input: Editor,
}

impl Dialog {
    pub fn models(models: &[ModelInfo], current: Option<&str>) -> Self {
        Self::models_with_filter(models, current, None)
    }

    /// One provider only: ctrl+o inside the picker narrows the catalog the way
    /// the product's dialog does, so a provider with many models stays usable.
    pub fn models_with_filter(
        models: &[ModelInfo],
        current: Option<&str>,
        provider: Option<&str>,
    ) -> Self {
        Self::models_with_needs_auth(models, current, provider, &[], &[], &[])
    }

    /// The picker plus a tail section naming providers this engine does not
    /// serve yet, split by what stands in the way: a provider with no stored
    /// key needs one, while a provider whose key exists but whose route the
    /// manifest does not carry needs its model list looked at. One line of
    /// advice cannot serve both.
    pub fn models_with_needs_auth(
        models: &[ModelInfo],
        current: Option<&str>,
        provider: Option<&str>,
        unserved: &[(String, String, bool)],
        recents: &[String],
        favorites: &[String],
    ) -> Self {
        // The picker groups by provider the way the product's does: a muted
        // header row names each provider and the models beneath it belong to
        // it. Rows carry their position in `models` as their id, so the app
        // can turn a chosen row back into a binding without assuming the
        // dialog's indices match the catalog's.
        let mut rows: Vec<Row> = Vec::new();
        // A provider holding several accounts serves one model through
        // several keys, so only those rows need the account named; the
        // provider itself belongs on every row.
        let shared = providers_with_several_accounts(models);
        // Favorites then recents lead the list, the way the product's picker
        // opens above its provider groups: the answer an operator wants is
        // usually one they starred or already used, and neither should need
        // scrolling past providers they moved away from.
        if provider.is_none() {
            for (title, names) in [("favorites", favorites), ("recent", recents)] {
                let mut listed: Vec<usize> = Vec::new();
                for name in names {
                    if let Some(index) = models
                        .iter()
                        .position(|model| model.matches(name))
                        .filter(|index| !listed.contains(index))
                    {
                        listed.push(index);
                    }
                }
                if listed.is_empty() {
                    continue;
                }
                rows.push(Row {
                    id: format!("group:{title}"),
                    label: title.to_string(),
                    detail: String::new(),
                });
                for index in listed {
                    rows.push(Row {
                        id: index.to_string(),
                        label: models[index].label(),
                        detail: models[index].origin(&shared),
                    });
                }
            }
            // An install holding no route at all says so, instead of opening an
            // empty box: the tail below is the way out, and the first line has
            // to admit there is nothing else yet.
            if models.is_empty() {
                rows.push(Row {
                    id: "empty".into(),
                    label: "no models yet".to_string(),
                    detail: "store a provider key to start".to_string(),
                });
            }
        }
        // A provider's models are merged even when the catalog lists them in
        // separate runs, so a provider names itself once.
        let mut groups: Vec<(Option<String>, Vec<usize>)> = Vec::new();
        for (index, model) in models.iter().enumerate() {
            if provider.is_some_and(|named| model.provider.as_deref() != Some(named)) {
                continue;
            }
            match groups
                .iter_mut()
                .find(|(provider, _)| *provider == model.provider)
            {
                Some((_, indices)) => indices.push(index),
                None => groups.push((model.provider.clone(), vec![index])),
            }
        }
        for (provider, indices) in groups {
            if let Some(provider) = provider {
                rows.push(Row {
                    id: format!("group:{provider}"),
                    label: provider,
                    detail: String::new(),
                });
            }
            for index in indices {
                let model = &models[index];
                // The Session's own binding is marked so the list answers
                // "which one am I on" without opening the footer.
                let label = match current {
                    // A pin names either the route or the `model · protocol`
                    // pair, and the row's label now carries neither the route
                    // nor the account, so both spellings mark the row.
                    Some(current) if current == model.label() || current == model.route() => {
                        format!("● {}", model.label())
                    }
                    _ => model.label(),
                };
                rows.push(Row {
                    id: index.to_string(),
                    label,
                    detail: model.origin(&shared),
                });
            }
        }
        if provider.is_none() {
            for (title, holds_key) in [("needs a key", false), ("has a key · no route", true)] {
                let entries: Vec<&(String, String, bool)> = unserved
                    .iter()
                    .filter(|entry| entry.2 == holds_key)
                    .collect();
                if entries.is_empty() {
                    continue;
                }
                rows.push(Row {
                    id: format!(
                        "group:{}",
                        if holds_key { "no-route" } else { "needs-auth" }
                    ),
                    label: title.to_string(),
                    detail: String::new(),
                });
                for (id, name, _) in entries {
                    rows.push(Row {
                        id: format!("{}:{id}", if holds_key { "accounts" } else { "auth" }),
                        label: name.clone(),
                        detail: if holds_key {
                            "key stored · no route serves it".to_string()
                        } else {
                            "enter to store a key".to_string()
                        },
                    });
                }
            }
        }
        let hint = match provider {
            Some(_) => "one provider · ctrl+o widen · ctrl+f favorite · esc close",
            None => "type to filter · ctrl+f favorite · ctrl+o provider · esc close",
        };
        Dialog::Models(ListDialog::new("models", rows, ListKind::Plain, hint))
    }

    /// The ctrl+o list: every provider the catalog names, plus the "all"
    /// escape hatch that restores the unfiltered picker.
    pub fn model_provider_filter(providers: &[String]) -> Self {
        let mut rows = vec![Row {
            id: "all".into(),
            label: "all providers".into(),
            detail: String::new(),
        }];
        for provider in providers {
            rows.push(Row {
                id: provider.clone(),
                label: provider.clone(),
                detail: String::new(),
            });
        }
        Dialog::ModelProviders(ListDialog::new(
            "model providers",
            rows,
            ListKind::Plain,
            "enter narrow · esc back to all models",
        ))
    }

    /// The palette list leads with the mode rows: pinning dark or light picks
    /// which half of every `{dark, light}` pair resolves, so it sits above the
    /// palettes, and the lock row only appears while a pin exists.
    pub fn theme(
        current: &str,
        lock: Option<crate::theme::ThemeMode>,
        catalog: &crate::theme::Catalog,
    ) -> Self {
        let names = catalog.names();
        let mut rows = vec![
            Row {
                id: "mode:dark".into(),
                label: "pin dark".into(),
                detail: if lock == Some(crate::theme::ThemeMode::Dark) {
                    "pinned".into()
                } else {
                    String::new()
                },
            },
            Row {
                id: "mode:light".into(),
                label: "pin light".into(),
                detail: if lock == Some(crate::theme::ThemeMode::Light) {
                    "pinned".into()
                } else {
                    String::new()
                },
            },
        ];
        if lock.is_some() {
            rows.push(Row {
                id: "mode:unlock".into(),
                label: "unlock".into(),
                detail: "back to dark".into(),
            });
        }
        let offset = rows.len();
        rows.extend(names.iter().enumerate().map(|(index, name)| Row {
            id: index.to_string(),
            label: name.to_string(),
            detail: String::new(),
        }));
        let mut list = ListDialog::new("theme", rows, ListKind::Plain, "enter apply · esc close");
        list.selected = names
            .iter()
            .position(|name| *name == current)
            .map(|index| index + offset)
            .unwrap_or(0);
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
            ListKind::Plain,
            "enter move session · esc cancel",
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

    /// The Session's scheduled wakeups and cron jobs. Each row names what it is
    /// (`wakeup <id>` or `cron <id>`) so `x` can cancel the right kind, and the
    /// detail carries the timing the engine reported.
    pub fn schedule(rows: &[(String, String, String)]) -> Self {
        let rows = if rows.is_empty() {
            vec![Row {
                id: String::new(),
                label: "nothing scheduled".to_string(),
                detail: String::new(),
            }]
        } else {
            rows.iter()
                .map(|(id, label, detail)| Row {
                    id: id.clone(),
                    label: label.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Schedule(ListDialog::new(
            "scheduled",
            rows,
            ListKind::Schedule,
            "x cancel · esc close",
        ))
    }

    /// Background jobs of one Session, each row naming the Session that owns
    /// it, with the Session's subagent runs below the jobs as read-only rows.
    /// A subagent row carries an empty id, so `x` — which stops jobs — walks
    /// over it. A Session with none says so rather than opening an empty list.
    pub fn jobs(rows: &[JobRow]) -> Self {
        let rows = if rows.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no background jobs".to_string(),
                detail: String::new(),
            }]
        } else {
            rows.iter()
                .map(|row| Row {
                    id: if row.subagent {
                        String::new()
                    } else {
                        row.id.clone()
                    },
                    label: if row.subagent {
                        format!("◇ {} · {} · {}", row.id, row.owner, row.state)
                    } else {
                        format!("{} · {} · {}", row.id, row.owner, row.state)
                    },
                    detail: row.detail.clone(),
                })
                .collect()
        };
        Dialog::Jobs(ListDialog::new(
            "jobs",
            rows,
            ListKind::Jobs,
            "x stop · X stop all · esc close",
        ))
    }

    pub fn devices(devices: &[(String, String)]) -> Self {
        let rows = if devices.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no paired devices".to_string(),
                detail: String::new(),
            }]
        } else {
            devices
                .iter()
                .map(|(name, detail)| Row {
                    id: name.clone(),
                    label: name.clone(),
                    detail: detail.clone(),
                })
                .collect()
        };
        Dialog::Devices(ListDialog::new(
            "devices",
            rows,
            ListKind::ReadOnly,
            "esc close",
        ))
    }

    /// Every provider the engine's catalog names, ready ones first, with the
    /// ones that still need auth marked instead of hidden.
    pub fn providers(providers: &[ProviderEntry]) -> Self {
        let rows = if providers.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no providers in the catalog".to_string(),
                detail: String::new(),
            }]
        } else {
            providers
                .iter()
                .map(|provider| Row {
                    id: provider.id.clone(),
                    label: provider.name.clone(),
                    detail: provider.detail.clone(),
                })
                .collect()
        };
        Dialog::Providers(ListDialog::new(
            "providers",
            rows,
            ListKind::Plain,
            "enter pick provider · type to filter · esc close",
        ))
    }

    /// Providers that already hold a stored account, the list `provider.accounts`
    /// opens in the TypeScript UI. Selecting one narrows to its accounts; the
    /// `all` row keeps every credential reachable in a single flat list.
    pub fn provider_accounts(rows: Vec<Row>) -> Self {
        let rows = if rows.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no stored provider accounts".to_string(),
                detail: "run `miao auth login <provider> <key>`".to_string(),
            }]
        } else {
            rows
        };
        Dialog::ProviderAccounts(ListDialog::new(
            "provider accounts",
            rows,
            ListKind::Plain,
            "enter narrow · type to filter · esc close",
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
        let mut list = ListDialog::new(
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
                    // The preview answers "which conversation was this?"
                    // without opening it, and it rides the label so `/` finds a
                    // Session by what it last said as well as by its title.
                    if let Some(preview) = row.preview.as_deref().filter(|preview| !preview.is_empty())
                    {
                        label.push_str(" — ");
                        label.push_str(preview);
                    }
                    Row {
                        id: row.id.clone(),
                        label,
                        detail: row.directory.clone().unwrap_or_default(),
                    }
                })
                .collect(),
            ListKind::Sessions,
            "enter open · 1-9 pinned · / search · r rename · p pin · a archive · d delete · esc close",
        );
        // The caller hands the rows over pinned-first, so the same order is the
        // quick-slot order: `1` reaches the most recently pinned Session.
        list.slots = rows
            .iter()
            .filter(|row| row.pinned_at_ms.is_some())
            .map(|row| row.id.clone())
            .collect();
        Dialog::Sessions(list)
    }

    /// The git worktrees of this checkout, the checkout itself first.
    pub fn worktrees(trees: &[crate::worktrees::Worktree]) -> Self {
        let rows = if trees.is_empty() {
            vec![Row {
                id: String::new(),
                label: "no worktrees".to_string(),
                detail: String::new(),
            }]
        } else {
            trees
                .iter()
                .map(|tree| Row {
                    // The checkout itself is not removable, so its row carries
                    // no id and `d` skips it.
                    id: if tree.main {
                        String::new()
                    } else {
                        tree.name.clone()
                    },
                    label: tree.label(),
                    detail: tree.detail(),
                })
                .collect()
        };
        Dialog::Worktrees(ListDialog::new(
            "worktrees",
            rows,
            ListKind::Worktrees,
            "enter move this session here \u{b7} n new \u{b7} d remove \u{b7} esc close",
        ))
    }

    /// The name for a new worktree: one path component under the checkout's
    /// worktree directory.
    pub fn worktree_new() -> Self {
        Dialog::WorktreeNew(WorktreeNewDialog {
            input: Editor::new(),
        })
    }

    /// A worktree removal is destructive, so it asks first and opens on the safe
    /// choice like a Session deletion does.
    pub fn confirm_remove_worktree(name: &str) -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "remove worktree",
            message: format!(
                "Remove the worktree \"{name}\" and the branch it holds? Sessions still working there \nmove back to the checkout first."
            ),
            confirmed: false,
            kind: ConfirmKind::RemoveWorktree(name.to_string()),
        })
    }

    /// The global stop of the jobs dialog: one answer for every background
    /// job the Session owns.
    pub fn confirm_stop_all_jobs() -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "stop all jobs",
            message: "Stop every background job this Session owns?".to_string(),
            confirmed: false,
            kind: ConfirmKind::StopAllJobs,
        })
    }

    /// COST-04: one reviewable view of where the turn spent its time and what
    /// it waited for.
    pub fn turn_timings(rows: &[(String, String)]) -> Self {
        Dialog::TurnTimings(ListDialog::new(
            "turn timings",
            rows.iter()
                .enumerate()
                .map(|(index, (label, spent))| Row {
                    id: index.to_string(),
                    label: label.clone(),
                    detail: spent.clone(),
                })
                .collect(),
            ListKind::Plain,
            "phases close as the turn moves on · esc close",
        ))
    }

    pub fn accounts(accounts: &[AccountInfo]) -> Self {
        Dialog::accounts_with_actions(Vec::new(), accounts)
    }

    /// The same list with the provider's own actions ahead of its accounts, so
    /// updating or deleting the key lives where the key is shown rather than
    /// only in `miao auth`.
    pub fn accounts_with_actions(actions: Vec<Row>, accounts: &[AccountInfo]) -> Self {
        let hint = match actions.is_empty() {
            true => "type to filter · ↑↓ move · enter switch · esc close",
            false => "type to filter · ↑↓ move · enter select · esc close",
        };
        Dialog::Accounts(ListDialog::new(
            "accounts",
            actions
                .into_iter()
                .chain(accounts.iter().map(|account| Row {
                    id: account.credential_id.clone(),
                    label: account.credential_id.clone(),
                    detail: account.detail.clone(),
                }))
                .collect(),
            ListKind::Plain,
            hint,
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
            "type to filter · esc close",
        ))
    }

    pub fn command_palette(rows: Vec<Row>) -> Self {
        Dialog::Palette(PaletteDialog::new(rows))
    }

    pub fn tag(session_id: &str, tag: &str) -> Self {
        let mut input = Editor::new();
        input.set_text(tag);
        Dialog::Tag(TagDialog {
            session_id: session_id.to_string(),
            input,
        })
    }

    /// Store the key of one provider the engine does not serve yet.
    pub fn sign_in_prompt(provider: &str, name: &str) -> Self {
        Dialog::SignIn(SignInDialog {
            provider: provider.to_string(),
            name: name.to_string(),
            input: Editor::new(),
            account: None,
            field: SignInField::Key,
        })
    }

    /// Add a second key for a provider that already holds one. The account
    /// label is collected first because it is what tells the two apart in the
    /// account list and in a route id.
    pub fn add_account_prompt(provider: &str, name: &str) -> Self {
        Dialog::SignIn(SignInDialog {
            provider: provider.to_string(),
            name: name.to_string(),
            input: Editor::new(),
            account: Some(Editor::new()),
            field: SignInField::Account,
        })
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

    /// Ask before a stored key is forgotten. Updating a key replaces it, so
    /// only the removal needs this: nothing can put the secret back.
    pub fn confirm_remove_credential(integration: &str, name: &str) -> Self {
        Dialog::Confirm(ConfirmDialog {
            title: "delete key",
            message: format!(
                "Delete the key stored for {name}? Its models stop being served until a new key is stored."
            ),
            confirmed: false,
            kind: ConfirmKind::RemoveCredential(integration.to_string()),
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
            | Dialog::ModelProviders(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::ProviderAccounts(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list) => handle_list_key(list, key),
            Dialog::Mcp(list) => handle_list_key(list, key),
            Dialog::Providers(list) => handle_list_key(list, key),
            Dialog::Devices(list) => handle_list_key(list, key),
            Dialog::Jobs(list) => handle_list_key(list, key),
            Dialog::Schedule(list) => handle_list_key(list, key),
            Dialog::Skills(list) => handle_list_key(list, key),
            Dialog::Workspaces(list) => handle_list_key(list, key),
            Dialog::Worktrees(list) => handle_list_key(list, key),
            Dialog::TurnTimings(list) => handle_list_key(list, key),
            Dialog::Message(text) => handle_text_key(text, key),
            Dialog::Palette(palette) => handle_palette_key(palette, key),
            Dialog::Rename(rename) => handle_rename_key(&mut rename.input, key),
            Dialog::Tag(tag) => handle_rename_key(&mut tag.input, key),
            Dialog::SignIn(sign_in) => handle_sign_in_key(sign_in, key),
            Dialog::WorktreeNew(dialog) => handle_rename_key(&mut dialog.input, key),
            Dialog::Confirm(confirm) => handle_confirm_key(confirm, key),
        }
    }

    /// Move the open dialog by wheel notches: one row per notch, the way the
    /// arrow keys move. Dialogs with nothing to scroll — an editor or a
    /// choice — keep the notch.
    pub fn scroll(&mut self, rows: i32) {
        match self {
            Dialog::SavedPermissions(dialog) => dialog.scroll(rows),
            Dialog::WorkspaceChanges(dialog) => dialog.scroll(rows),
            Dialog::Models(list)
            | Dialog::ModelProviders(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::ProviderAccounts(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list)
            | Dialog::Mcp(list)
            | Dialog::Providers(list)
            | Dialog::Devices(list)
            | Dialog::Jobs(list)
            | Dialog::Schedule(list)
            | Dialog::Skills(list)
            | Dialog::Workspaces(list)
            | Dialog::Worktrees(list)
            | Dialog::TurnTimings(list) => list.move_cursor(rows),
            Dialog::Message(text) => {
                text.scroll = text.scroll.saturating_add_signed(rows as isize);
            }
            Dialog::Palette(palette) => {
                if palette.visible.is_empty() {
                    return;
                }
                palette.selected = (palette.selected as i32 + rows)
                    .clamp(0, palette.visible.len() as i32 - 1)
                    as usize;
            }
            Dialog::Rename(_)
            | Dialog::Tag(_)
            | Dialog::SignIn(_)
            | Dialog::WorktreeNew(_)
            | Dialog::Confirm(_) => {}
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Dialog::SavedPermissions(_) => "saved permissions",
            Dialog::WorkspaceChanges(_) => "workspace changes",
            Dialog::TurnTimings(_) => "turn timings",
            Dialog::Models(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::ProviderAccounts(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::ModelProviders(list)
            | Dialog::Help(list) => list.title,
            Dialog::Mcp(list) => list.title,
            Dialog::Providers(list) => list.title,
            Dialog::Devices(list) => list.title,
            Dialog::Jobs(list) => list.title,
            Dialog::Schedule(list) => list.title,
            Dialog::Skills(list) => list.title,
            Dialog::Workspaces(list) => list.title,
            Dialog::Worktrees(list) => list.title,
            Dialog::Message(text) => text.title,
            Dialog::Palette(_) => "commands",
            Dialog::Rename(_) => "rename session",
            Dialog::Tag(_) => "tag session",
            Dialog::SignIn(_) => "provider key",
            Dialog::WorktreeNew(_) => "new worktree",
            Dialog::Confirm(confirm) => confirm.title,
        }
    }

    pub fn list(&self) -> Option<&ListDialog> {
        match self {
            Dialog::Models(list)
            | Dialog::ModelProviders(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::ProviderAccounts(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list)
            | Dialog::Mcp(list)
            | Dialog::Providers(list)
            | Dialog::Skills(list)
            | Dialog::Workspaces(list)
            | Dialog::Worktrees(list)
            | Dialog::Jobs(list)
            | Dialog::Devices(list)
            | Dialog::Schedule(list) => Some(list),
            _ => None,
        }
    }

    pub fn list_mut(&mut self) -> Option<&mut ListDialog> {
        match self {
            Dialog::Models(list)
            | Dialog::ModelProviders(list)
            | Dialog::Theme(list)
            | Dialog::Sessions(list)
            | Dialog::ProviderAccounts(list)
            | Dialog::Accounts(list)
            | Dialog::Stash(list)
            | Dialog::Timeline(list)
            | Dialog::Status(list)
            | Dialog::Debug(list)
            | Dialog::Help(list)
            | Dialog::Mcp(list)
            | Dialog::Providers(list)
            | Dialog::Skills(list)
            | Dialog::Workspaces(list)
            | Dialog::Worktrees(list)
            | Dialog::Jobs(list)
            | Dialog::Devices(list)
            | Dialog::Schedule(list) => Some(list),
            _ => None,
        }
    }

    /// The key prompt for a provider this engine does not serve. It paints
    /// through its own renderer, so the provider name can stand beside the
    /// input instead of only in the border title.
    pub fn sign_in(&self) -> Option<&SignInDialog> {
        match self {
            Dialog::SignIn(sign_in) => Some(sign_in),
            _ => None,
        }
    }

    /// Take a paste when this dialog owns a text field, and say so.
    ///
    /// A dialog is modal for keystrokes, but a paste arrives on its own event:
    /// the provider prompt rendered, the operator pasted the key, and it went
    /// into the composer underneath while the prompt stayed empty. Whatever
    /// asked for the text gets it.
    pub fn paste(&mut self, text: &str) -> bool {
        match self {
            Dialog::SavedPermissions(dialog) => dialog.paste(text),
            // A paste lands in the field the keyboard is in: a key pasted while
            // the account label is being typed would otherwise fill the wrong
            // one and read as "the key was ignored".
            Dialog::SignIn(sign_in) => match (&mut sign_in.account, sign_in.field) {
                (Some(account), SignInField::Account) => insert_paste(account, text),
                _ => insert_paste(&mut sign_in.input, text),
            },
            Dialog::Rename(rename) => insert_paste(&mut rename.input, text),
            Dialog::Tag(tag) => insert_paste(&mut tag.input, text),
            Dialog::WorktreeNew(dialog) => insert_paste(&mut dialog.input, text),
            _ => return false,
        }
        true
    }

    pub fn rename_input(&self) -> Option<&Editor> {
        match self {
            Dialog::Rename(rename) => Some(&rename.input),
            Dialog::Tag(tag) => Some(&tag.input),
            Dialog::WorktreeNew(dialog) => Some(&dialog.input),
            _ => None,
        }
    }

    pub fn rename_session_id(&self) -> Option<&str> {
        match self {
            Dialog::Rename(rename) => Some(&rename.session_id),
            Dialog::Tag(tag) => Some(&tag.session_id),
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
        // The change set is the point of the panel, so the box grows with it
        // instead of the fixed six rows that left the body empty.
        if let Dialog::WorkspaceChanges(changes) = self {
            let rows = if changes.diff_open() {
                changes.view_rows()
            } else {
                changes.body_rows()
            };
            return (rows + 2).min(u16::MAX as usize) as u16;
        }
        if let Some(palette) = self.palette() {
            // Filter line, one row even when nothing matches, and the border.
            return (palette.visible.len().clamp(1, 12) + 3) as u16;
        }
        if let Some(list) = self.list() {
            // The box needs room for the rows plus the filter line, the hint
            // line and the border. A one-row list (`models` on a single-model
            // engine) used to lose its only row to those chrome rows and paint
            // an empty picker, and an empty list still shows "nothing to show".
            let rows = list.rows.len().clamp(1, 14) as u16;
            let filter = u16::from(list.shows_filter());
            return rows + 3 + filter;
        }
        // The key prompt grows a row for the account label it collects when a
        // second key is being added: two labelled inputs, a blank row between
        // them and the hint line.
        if let Some(sign_in) = self.sign_in() {
            return match sign_in.account.is_some() {
                true => 8,
                false => 5,
            };
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
    /// Open the selected file's patch inside the workspace-changes dialog.
    OpenWorkspaceDiff(String),
    None,
    Close,
    Chosen(usize),
    /// A device row action: 0 approve, 1 reject, 2 revoke.
    DeviceChosen(usize, u8),
    /// Stop the background job the row names.
    CancelJob(String),
    /// Stop every background job of the Session, after confirmation.
    StopAllJobs,
    /// Ask for the name of a worktree to add.
    WorktreeNew,
    /// Remove the worktree the row names, after confirmation.
    WorktreeRemove(String),
    /// Cancel the wakeup or cron the row names, written `kind:id`.
    CancelSchedule(String),
    OpenSession(String),
    Rename(String),
    ToggleArchive(String),
    TogglePin(String),
    Remove(String),
    Submit(String),
    /// A stored provider key, with the account label it belongs to: `None`
    /// replaces the default account, `Some` adds another key beside it.
    SubmitAccount {
        account: Option<String>,
        key: String,
    },
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
    // An armed Session search owns the keyboard, so a query may contain the
    // letters that otherwise rename, pin, archive, or delete. Esc leaves the
    // search and restores the full list rather than closing the dialog.
    if list.search {
        match key.code {
            KeyCode::Esc => {
                list.search = false;
                list.filter.clear();
                list.refilter();
                return Action::None;
            }
            KeyCode::Backspace => {
                list.filter.backspace();
                list.refilter();
                return Action::None;
            }
            KeyCode::Delete => {
                list.filter.delete_forward();
                list.refilter();
                return Action::None;
            }
            KeyCode::Up => {
                list.move_cursor(-1);
                return Action::None;
            }
            KeyCode::Down => {
                list.move_cursor(1);
                return Action::None;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                list.filter.insert_char(c);
                list.refilter();
                return Action::None;
            }
            _ => {}
        }
    }
    if list.filterable() {
        match key.code {
            KeyCode::Backspace => {
                list.filter.backspace();
                list.refilter();
                return Action::None;
            }
            KeyCode::Delete => {
                list.filter.delete_forward();
                list.refilter();
                return Action::None;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                list.filter.insert_char(c);
                list.refilter();
                return Action::None;
            }
            _ => {}
        }
    }
    match key.code {
        KeyCode::Esc => return Action::Close,
        KeyCode::Up | KeyCode::Char('k') if !list.filterable() => list.move_cursor(-1),
        KeyCode::Down | KeyCode::Char('j') if !list.filterable() => list.move_cursor(1),
        KeyCode::Up => list.move_cursor(-1),
        KeyCode::Down => list.move_cursor(1),
        KeyCode::Enter => {
            if list.kind == ListKind::ReadOnly {
                return Action::Close;
            }
            // A header cannot be chosen: walking past it keeps the decision
            // on a model even when the cursor was parked there.
            if list.header_at(list.selected) {
                list.move_cursor(1);
            }
            let Some(row_index) = list.visible.get(list.selected).copied() else {
                return Action::None;
            };
            let id = list.rows[row_index].id.clone();
            return match list.kind {
                ListKind::Sessions => Action::OpenSession(id),
                ListKind::Stash => Action::StashRestore(row_index),
                ListKind::Timeline => match id.parse::<u64>() {
                    Ok(seq) => Action::Revert(seq),
                    Err(_) => Action::None,
                },
                _ => Action::Chosen(row_index),
            };
        }
        KeyCode::Char('a') if list.kind == ListKind::Devices => {
            return Action::DeviceChosen(list.selected, 0)
        }
        KeyCode::Char('x') if list.kind == ListKind::Jobs => {
            if let Some(id) = list.current_id().filter(|id| !id.is_empty()) {
                return Action::CancelJob(id);
            }
        }
        // The global stop names no row, so it takes no selection; the action
        // opens the confirmation and only an answer stops anything.
        KeyCode::Char('X') if list.kind == ListKind::Jobs => return Action::StopAllJobs,
        KeyCode::Char('x') if list.kind == ListKind::Schedule => {
            if let Some(id) = list.current_id() {
                return Action::CancelSchedule(id);
            }
        }
        KeyCode::Char('n') if list.kind == ListKind::Worktrees => return Action::WorktreeNew,
        KeyCode::Char('d') if list.kind == ListKind::Worktrees => {
            if let Some(id) = list.current_id().filter(|id| !id.is_empty()) {
                return Action::WorktreeRemove(id);
            }
        }
        KeyCode::Char('x') if list.kind == ListKind::Devices => {
            return Action::DeviceChosen(list.selected, 1)
        }
        KeyCode::Char('r') if list.kind == ListKind::Devices => {
            return Action::DeviceChosen(list.selected, 2)
        }
        KeyCode::Char('/') if list.kind == ListKind::Sessions => {
            list.search = true;
            return Action::None;
        }
        KeyCode::Char(c @ '1'..='9') if list.kind == ListKind::Sessions => {
            // A digit reaches a pinned Session by slot, and does nothing when
            // that slot is empty so a typo cannot open an unrelated Session.
            if let Some(id) = list.slots.get(c as usize - '1' as usize) {
                return Action::OpenSession(id.clone());
            }
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

/// The key prompt, with an optional account label in front of the key itself.
///
/// `Tab` moves between the two fields, which is the only thing a two-field
/// dialog needs beyond typing. `Enter` in the label field moves on to the key
/// instead of submitting: a label alone stores nothing, and a key entered
/// first would otherwise have to be retyped after naming the account.
fn handle_sign_in_key(sign_in: &mut SignInDialog, key: KeyEvent) -> Action {
    let Some(account) = sign_in.account.as_mut() else {
        return match handle_rename_key(&mut sign_in.input, key) {
            Action::Submit(key) => Action::SubmitAccount { account: None, key },
            action => action,
        };
    };
    if key.code == KeyCode::Esc {
        return Action::Close;
    }
    if key.code == KeyCode::Tab {
        sign_in.field = match sign_in.field {
            SignInField::Account => SignInField::Key,
            SignInField::Key => SignInField::Account,
        };
        return Action::None;
    }
    if key.code == KeyCode::Enter {
        return match sign_in.field {
            SignInField::Account => {
                if account.text().trim().is_empty() {
                    return Action::None;
                }
                sign_in.field = SignInField::Key;
                Action::None
            }
            SignInField::Key => {
                let key = sign_in.input.text().trim().to_string();
                if key.is_empty() {
                    return Action::None;
                }
                Action::SubmitAccount {
                    account: Some(account.text().trim().to_string()),
                    key,
                }
            }
        };
    }
    match sign_in.field {
        SignInField::Account => {
            edit_one_line(account, key);
            Action::None
        }
        SignInField::Key => handle_rename_key(&mut sign_in.input, key),
    }
}

/// One-line editing for a field that has no submit of its own: the same keys a
/// rename accepts, minus `Enter` and `Esc`, which the dialog interprets.
fn edit_one_line(input: &mut Editor, key: KeyEvent) {
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
        KeyCode::Char(c) if !ctrl => input.insert_char(c),
        _ => {}
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
                ConfirmKind::RemoveWorktree(name) => ConfirmKind::RemoveWorktree(name.clone()),
                ConfirmKind::Revert {
                    boundary_seq,
                    files,
                } => ConfirmKind::Revert {
                    boundary_seq: *boundary_seq,
                    files: *files,
                },
                ConfirmKind::RemoveCredential(integration) => {
                    ConfirmKind::RemoveCredential(integration.clone())
                }
                ConfirmKind::StopAllJobs => ConfirmKind::StopAllJobs,
            };
            return Action::Confirmed(kind);
        }
        _ => {}
    }
    Action::None
}

/// A model id reduced to the characters the two spellings share: the engine's
/// ids are dashed, and a remembered display name may be the dotted form.
fn comparable(model: &str) -> String {
    model.to_lowercase().replace('.', "-")
}

#[cfg(test)]
mod tests {

    fn list_dialog(labels: &[&str]) -> ListDialog {
        let rows = labels
            .iter()
            .map(|label| Row {
                id: (*label).to_string(),
                label: (*label).to_string(),
                detail: String::new(),
            })
            .collect();
        ListDialog {
            title: "test",
            rows,
            selected: 0,
            kind: ListKind::Plain,
            hint: "",
            filter: Editor::new(),
            visible: (0..labels.len()).collect(),
            search: false,
            slots: Vec::new(),
            previewed: Vec::new(),
        }
    }

    /// UX-02: the wheel has to move the open dialog the notch is over, one row
    /// per notch, the way the arrow keys do — including at the ends.
    #[test]
    fn a_wheel_notch_moves_a_list_dialog_selection() {
        let mut dialog = Dialog::Models(list_dialog(&["a", "b", "c"]));
        let selected = |dialog: &Dialog| dialog.list().expect("a list dialog").selected;
        assert_eq!(selected(&dialog), 0);
        dialog.scroll(1);
        assert_eq!(selected(&dialog), 1);
        dialog.scroll(-1);
        assert_eq!(selected(&dialog), 0, "the notch came back");
        dialog.scroll(-5);
        assert_eq!(selected(&dialog), 0, "the top clamps");
        dialog.scroll(5);
        assert_eq!(selected(&dialog), 2, "the bottom clamps");
    }

    /// The wheel on a text dialog is the j/k keys, and scrolling up past the
    /// top must not underflow.
    #[test]
    fn a_wheel_notch_scrolls_a_text_dialog_without_underflow() {
        let mut dialog = Dialog::Message(TextDialog {
            title: "details",
            lines: (0..20).map(|index| format!("line {index}")).collect(),
            scroll: 2,
        });
        let scroll = |dialog: &Dialog| match dialog {
            Dialog::Message(text) => text.scroll,
            _ => unreachable!("a text dialog"),
        };
        dialog.scroll(5);
        assert_eq!(scroll(&dialog), 7);
        dialog.scroll(-20);
        assert_eq!(scroll(&dialog), 0, "the top clamps instead of panicking");
    }

    #[test]
    fn the_workspace_changes_panel_grows_with_its_change_set() {
        // The panel used to fall through to the default six-row box, which is
        // four body rows for a change set of any size: the branch header, a
        // separator, and then the first two files.
        let state = |files: usize| crate::workspace_changes::VcsState {
            branch: Some("main".into()),
            detached: false,
            ahead: None,
            behind: None,
            files: (0..files)
                .map(|index| crate::workspace_changes::Change {
                    path: format!("src/file{index}.rs"),
                    original_path: None,
                    kind: "modified".into(),
                })
                .collect(),
            truncated: false,
            file_count: Some(files as u64),
            repository: true,
        };
        let changes = crate::workspace_changes::Dialog::new(1, "ses_a");
        assert_eq!(
            Dialog::WorkspaceChanges(changes).height(),
            3,
            "one line while the engine is still answering"
        );
        let mut changes = crate::workspace_changes::Dialog::new(2, "ses_a");
        changes.loaded(Ok(state(3)));
        assert_eq!(
            Dialog::WorkspaceChanges(changes).height(),
            7,
            "header, separator, three files and the borders"
        );
        let mut changes = crate::workspace_changes::Dialog::new(3, "ses_a");
        changes.loaded(Ok(state(40)));
        assert_eq!(
            Dialog::WorkspaceChanges(changes).height(),
            18,
            "a long change set still stays bounded"
        );
    }

    #[test]
    fn typing_narrows_the_help_list_and_enter_still_closes() {
        // UX-05: help is the place discovery happens, and it is long. Typing the
        // name being looked for has to narrow it instead of scrolling.
        let rows = vec![
            Row {
                id: "session_new".into(),
                label: "session_new".into(),
                detail: "ctrl+x n".into(),
            },
            Row {
                id: "theme_list".into(),
                label: "theme_list".into(),
                detail: "ctrl+x t".into(),
            },
            Row {
                id: "job_list".into(),
                label: "job_list".into(),
                detail: "ctrl+x j".into(),
            },
        ];
        let mut dialog = Dialog::help(rows);
        let Some(Dialog::Help(list)) = Some(&mut dialog) else {
            panic!("help dialog");
        };
        assert_eq!(list.visible.len(), 3);
        assert!(list.shows_filter(), "help carries a filter row");
        for character in "them".chars() {
            handle_list_key(list, key(KeyCode::Char(character)));
        }
        assert_eq!(list.visible.len(), 1, "only the theme row is left");
        assert_eq!(
            list.visible
                .first()
                .and_then(|index| list.rows.get(*index))
                .map(|row| row.label.as_str()),
            Some("theme_list")
        );
        // Read-only means Enter closes and runs nothing, filtered or not.
        assert!(matches!(
            handle_list_key(list, key(KeyCode::Enter)),
            Action::Close
        ));
        // Backspacing back to empty shows the whole table again.
        for _ in 0..4 {
            handle_list_key(list, key(KeyCode::Backspace));
        }
        assert_eq!(list.visible.len(), 3);
    }

    #[test]
    fn the_tag_dialog_starts_empty_for_the_open_session() {
        let dialog = Dialog::tag("ses_a", "");
        match &dialog {
            Dialog::Tag(tag) => {
                assert_eq!(tag.session_id, "ses_a");
                assert!(tag.input.text().is_empty());
            }
            _ => panic!("Dialog::tag must build the tag dialog"),
        }
        assert_eq!(dialog.title(), "tag session");
        assert_eq!(dialog.rename_session_id(), Some("ses_a"));
        assert!(dialog.rename_input().is_some());
    }
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

    /// A remembered selection has to resolve through the catalog, because the
    /// catalog is the only place that knows its provider: the exact model id,
    /// the route id, and the dotted display name an older install stored all
    /// name the same entry.
    #[test]
    fn a_remembered_selection_resolves_to_its_catalog_entry() {
        let models = ModelInfo::catalog(&serde_json::json!([
            {"route_id": "xiaomi/glm-5.3-flash", "protocol": "openai-chat", "model": "glm-5.3-flash"},
            {"route_id": "deepseek/deepseek-v4-1-flash-261017", "protocol": "openai-chat", "model": "deepseek-v4-1-flash-261017"}
        ]));
        let identity =
            |remembered: &str| ModelInfo::resolve(&models, remembered).map(ModelInfo::identity);
        assert_eq!(
            identity("glm-5.3-flash").as_deref(),
            Some("glm-5.3-flash · xiaomi · openai-chat")
        );
        assert_eq!(
            identity("xiaomi/glm-5.3-flash").as_deref(),
            Some("glm-5.3-flash · xiaomi · openai-chat")
        );
        assert_eq!(
            identity("deepseek-v4.1-flash").as_deref(),
            Some("deepseek-v4-1-flash-261017 · deepseek · openai-chat"),
            "the dotted display name the install remembered still names a provider"
        );
        assert_eq!(identity("not-a-model"), None);
    }

    #[test]
    fn the_catalog_flattens_variants_into_bindings() {
        let models = models();
        assert_eq!(models.len(), 3);
        assert_eq!(models[2].label(), "gpt-5 · responses · high");
        assert_eq!(models[0].binding()["route_id"], "r1");
        assert_eq!(models[2].binding()["variant"], "high");
    }

    /// The picker used to leave the provider to the section header, so a row
    /// read `glm-5 · openai-chat` and named no provider once that header had
    /// scrolled away.
    #[test]
    fn every_picker_row_names_the_provider_that_serves_it() {
        let dialog = Dialog::models(&grouped(), None);
        let list = dialog.list().expect("list");
        let rows: Vec<(&str, &str)> = list
            .rows
            .iter()
            .map(|row| (row.label.as_str(), row.detail.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("zhipu", ""),
                ("glm-5 · openai-chat", "zhipu"),
                ("flash · openai-chat", "zhipu"),
                ("mtty", ""),
                ("haiku · openai-chat", "mtty"),
            ],
            "a header leaves the detail column empty; every model row names its provider"
        );
    }

    /// Two keys of one provider serve the same models, so the rows only read as
    /// different choices when each names its account. An account the operator
    /// never named falls back to the opaque credential identity.
    #[test]
    fn two_accounts_of_one_provider_are_told_apart() {
        let models = ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "glm-5", "model_key": "zhipu/glm-5",
             "route_id": "zhipu-work/glm-5", "account": "work", "credential_id": "cred_a"},
            {"protocol": "openai-chat", "model": "glm-5", "model_key": "zhipu/glm-5",
             "route_id": "zhipu-home/glm-5", "credential_id": "cred_b"}
        ]));
        let dialog = Dialog::models(&models, None);
        let list = dialog.list().expect("list");
        let details: Vec<&str> = list.rows.iter().map(|row| row.detail.as_str()).collect();
        assert_eq!(
            details,
            vec!["", "zhipu · work", "zhipu · cred_b"],
            "one provider, two keys: the account is what tells them apart"
        );
    }

    /// A Session's row names the provider and the account behind its pin, not
    /// only the route: `Claude-Opus-4.5` on its own said nothing about who
    /// answered.
    #[test]
    fn a_session_model_names_the_provider_and_the_account_behind_the_pin() {
        let models = ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "glm-5", "model_key": "zhipu/glm-5",
             "route_id": "zhipu-work/glm-5", "account": "work", "credential_id": "cred_a"}
        ]));
        let pin = ModelPin {
            protocol: "openai-chat".into(),
            model: "glm-5".into(),
            route_id: Some("zhipu-work/glm-5".into()),
            variant: None,
        };
        assert_eq!(
            session_model(&models, &pin),
            "glm-5 · zhipu · work · openai-chat",
            "the row names the model, its provider, its account and the protocol"
        );
        let dropped = ModelPin {
            route_id: Some("gone/glm-5".into()),
            ..pin
        };
        assert_eq!(
            session_model(&models, &dropped),
            "gone/glm-5",
            "a route the catalog no longer serves still prints instead of vanishing"
        );
    }

    #[test]
    fn a_single_row_list_asks_for_room_for_its_row() {
        // One model used to size the box to filter + hint + border alone, so
        // the only row a single-model engine serves had zero rows to paint in.
        let one = ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "deepseek-v4-1-flash-261017"}
        ]));
        let dialog = Dialog::models(&one, None);
        let list = dialog.list().expect("list");
        let filter = u16::from(list.shows_filter());
        assert_eq!(
            dialog.height(),
            1 + filter + 1 + 2,
            "row + hint + filter + border"
        );
    }

    #[test]
    fn an_empty_list_still_fits_its_placeholder() {
        let dialog = Dialog::models(&[], None);
        let list = dialog.list().expect("list");
        let filter = u16::from(list.shows_filter());
        assert_eq!(dialog.height(), 1 + filter + 1 + 2);
    }

    fn grouped() -> Vec<ModelInfo> {
        ModelInfo::catalog(&serde_json::json!([
            {"protocol": "openai-chat", "model": "glm-5", "model_key": "zhipu/glm-5"},
            {"protocol": "openai-chat", "model": "haiku", "model_key": "mtty/haiku"},
            {"protocol": "openai-chat", "model": "flash", "model_key": "zhipu/flash"}
        ]))
    }

    #[test]
    fn the_picker_groups_models_under_provider_headers() {
        let dialog = Dialog::models(&grouped(), None);
        let list = dialog.list().expect("list");
        let labels: Vec<&str> = list.rows.iter().map(|row| row.label.as_str()).collect();
        // The catalog order keeps each provider's models together, so the
        // headers interleave instead of one block of headers up front.
        assert_eq!(
            labels,
            vec![
                "zhipu",
                "glm-5 · openai-chat",
                "flash · openai-chat",
                "mtty",
                "haiku · openai-chat"
            ]
        );
        assert!(list.rows[0].is_header());
        assert!(!list.rows[1].is_header());
    }

    /// The operator's recent models lead the picker, the way the product's
    /// dialog opens with its recents above the provider groups: the answer an
    /// operator wants is usually one they already gave.
    #[test]
    fn recents_lead_the_picker_once_each() {
        let recents = vec![
            "haiku".to_string(),
            "glm-5".to_string(),
            "haiku".to_string(),
        ];
        let dialog = Dialog::models_with_needs_auth(&grouped(), None, None, &[], &recents, &[]);
        let list = dialog.list().expect("list");
        let labels: Vec<&str> = list.rows.iter().map(|row| row.label.as_str()).collect();
        assert_eq!(
            &labels[..3],
            &["recent", "haiku · openai-chat", "glm-5 · openai-chat"],
            "recents come first, in the order they were used, once each"
        );
        assert!(list.rows[0].is_header());
        // The provider groups still follow, unchanged.
        assert_eq!(labels[3], "zhipu");
        // A provider-narrowed picker has no recents section: everything in it
        // is already that provider.
        let narrowed =
            Dialog::models_with_needs_auth(&grouped(), None, Some("zhipu"), &[], &recents, &[]);
        let narrowed = narrowed.list().expect("list");
        assert!(
            narrowed
                .rows
                .iter()
                .all(|row| row.label.as_str() != "recent"),
            "the narrowed picker stays a single provider"
        );
    }

    /// Starred models lead even the recents: an operator who starred a route
    /// asked for it by name, which outranks "used last".
    #[test]
    fn favorites_lead_the_picker_before_recents() {
        let favorites = vec!["glm-5".to_string()];
        let recents = vec!["haiku".to_string()];
        let dialog =
            Dialog::models_with_needs_auth(&grouped(), None, None, &[], &recents, &favorites);
        let list = dialog.list().expect("list");
        let labels: Vec<&str> = list.rows.iter().map(|row| row.label.as_str()).collect();
        assert_eq!(
            &labels[..3],
            &["favorites", "glm-5 · openai-chat", "recent"]
        );
        // A favorite row still names its position in the catalog, so starring
        // one and choosing it bind the same model.
        let position: usize = list.rows[1].id.parse().expect("catalog position");
        assert_eq!(
            grouped()[position].model,
            "glm-5",
            "the starred row binds the model it names"
        );
        assert!(list.rows[2].is_header());
    }

    /// An install holding no route at all says so, instead of opening an empty
    /// box with a tail of providers whose keys are the only way forward.
    #[test]
    fn an_empty_catalog_names_itself_and_the_way_out() {
        let unserved = vec![("anthropic".to_string(), "Anthropic".to_string(), false)];
        let dialog = Dialog::models_with_needs_auth(&[], None, None, &unserved, &[], &[]);
        let list = dialog.list().expect("list");
        let labels: Vec<&str> = list.rows.iter().map(|row| row.label.as_str()).collect();
        assert_eq!(
            labels,
            ["no models yet", "needs a key", "Anthropic"],
            "the empty state sits above the one action that fills it"
        );
        assert_eq!(list.rows[0].detail, "store a provider key to start");
    }

    /// A stored key with no route behind it is a different problem from a
    /// missing key, and the picker says which one the operator has.
    #[test]
    fn a_provider_holding_a_key_without_a_route_says_that() {
        let unserved = vec![
            ("anthropic".to_string(), "Anthropic".to_string(), false),
            ("mistral".to_string(), "Mistral".to_string(), true),
        ];
        let dialog = Dialog::models_with_needs_auth(&grouped(), None, None, &unserved, &[], &[]);
        let list = dialog.list().expect("list");
        let rows: Vec<(&str, &str)> = list
            .rows
            .iter()
            .map(|row| (row.label.as_str(), row.detail.as_str()))
            .collect();
        assert!(
            rows.contains(&("needs a key", "")),
            "a provider with no credential leads its own group"
        );
        assert!(
            rows.contains(&("Mistral", "key stored · no route serves it")),
            "a stored key with no route says so instead of asking for the key again"
        );
        let mistral = list
            .rows
            .iter()
            .find(|row| row.label == "Mistral")
            .expect("mistral row");
        assert_eq!(mistral.id, "accounts:mistral");
    }

    fn worktrees() -> Vec<crate::worktrees::Worktree> {
        crate::worktrees::decode(&serde_json::json!([
            {"name": "miao", "path": "/repo", "branch": "main", "main": true},
            {"name": "work", "path": "/repo/.miao-worktrees/work", "branch": "work"}
        ]))
    }

    /// The checkout row is listed first and carries no id, so `d` cannot ask to
    /// remove the tree the operator is standing in.
    #[test]
    fn the_worktree_dialog_lists_the_checkout_as_unremovable() {
        let dialog = Dialog::worktrees(&worktrees());
        let list = dialog.list().expect("list");
        let rows: Vec<(&str, &str)> = list
            .rows
            .iter()
            .map(|row| (row.label.as_str(), row.detail.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("checkout", "/repo"),
                ("work", "/repo/.miao-worktrees/work"),
            ]
        );
        assert!(list.rows[0].id.is_empty(), "the checkout is not removable");
        assert_eq!(list.rows[1].id, "work");
    }

    #[test]
    fn a_worktree_row_asks_to_be_added_or_removed() {
        let mut dialog = Dialog::worktrees(&worktrees());
        assert!(
            matches!(
                dialog.handle_key(key(KeyCode::Char('n'))),
                Action::WorktreeNew
            ),
            "n asks for a new worktree"
        );
        assert!(
            matches!(dialog.handle_key(key(KeyCode::Char('d'))), Action::None),
            "the checkout row is never removed"
        );
        dialog.handle_key(key(KeyCode::Down));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('d'))),
            Action::WorktreeRemove(name) if name == "work"
        ));
    }

    #[test]
    fn the_new_worktree_prompt_submits_one_path_component() {
        let mut dialog = Dialog::worktree_new();
        assert_eq!(dialog.title(), "new worktree");
        assert!(
            matches!(dialog.handle_key(key(KeyCode::Enter)), Action::None),
            "an empty name is not a worktree"
        );
        for c in "wt".chars() {
            dialog.handle_key(key(KeyCode::Char(c)));
        }
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::Submit(name) if name == "wt"
        ));
    }

    #[test]
    fn the_cursor_and_enter_never_rest_on_a_header() {
        let mut dialog = Dialog::models(&grouped(), None);
        // The list opens on the first model, past the zhipu header.
        let list = dialog.list().expect("list");
        assert_eq!(list.selected, 1);
        // Down crosses the mtty header between flash and haiku.
        dialog.handle_key(key(KeyCode::Down));
        dialog.handle_key(key(KeyCode::Down));
        let list = dialog.list().expect("list");
        assert_eq!(list.selected, 4, "the header is skipped");
        // Walking back crosses it the same way.
        dialog.handle_key(key(KeyCode::Up));
        let list = dialog.list().expect("list");
        assert_eq!(list.selected, 2, "walking back skips the header too");
        // Enter on the header's own position (its cursor neighbour) still
        // decides a model, never the section label.
        assert!(
            matches!(dialog.handle_key(key(KeyCode::Enter)), Action::Chosen(index) if index == 2)
        );
    }

    #[test]
    fn a_filter_keeps_the_headers_of_the_models_it_keeps() {
        let mut dialog = Dialog::models(&grouped(), None);
        for c in "haiku".chars() {
            dialog.handle_key(key(KeyCode::Char(c)));
        }
        let list = dialog.list().expect("list");
        let visible: Vec<&str> = list
            .visible
            .iter()
            .map(|index| list.rows[*index].label.as_str())
            .collect();
        assert_eq!(visible, vec!["mtty", "haiku · openai-chat"]);
        assert_eq!(list.selected, 1, "the cursor sits on the model");
    }

    #[test]
    fn list_navigation_clamps_and_enter_returns_the_row() {
        let mut dialog = Dialog::models(&models(), None);
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
            preview: None,
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
            {"protocol": "chat", "model": "glm-5", "model_key": "zhipu/glm-5", "credential_id": "cred_a"},
            {"protocol": "chat", "model": "glm-5", "model_key": "zhipu/glm-5", "variant": "high", "credential_id": "cred_a"},
            {"protocol": "responses", "model": "gpt-5", "route_id": "openai/gpt-5", "credential_id": "cred_b"},
            {"protocol": "responses", "model": "gpt-5"}
        ]));
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].credential_id, "cred_a");
        assert_eq!(accounts[0].detail, "glm-5");
        assert_eq!(accounts[0].provider.as_deref(), Some("zhipu"));
        assert_eq!(accounts[1].credential_id, "cred_b");
        // The route id still names the provider when the catalog omits the key.
        assert_eq!(accounts[1].provider.as_deref(), Some("openai"));
    }

    #[test]
    fn the_provider_catalog_names_ready_and_unconfigured_providers() {
        let providers = ProviderEntry::catalog(&serde_json::json!({
            "providers": [
                {"id": "openai", "name": "OpenAI", "models": 12, "configured": true},
                {"id": "zhipu", "models": 4, "configured": false},
                {"models": 1}
            ]
        }));
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "openai");
        assert_eq!(providers[0].name, "OpenAI");
        assert_eq!(providers[0].detail, "12 models · ready");
        // An entry without a name falls back to its id, never to a blank row.
        assert_eq!(providers[1].name, "zhipu");
        assert_eq!(providers[1].detail, "4 models · needs auth");
        assert!(!providers[1].configured);
    }

    #[test]
    fn the_provider_accounts_list_keeps_the_flat_list_reachable() {
        let dialog = Dialog::provider_accounts(vec![
            Row {
                id: "all".into(),
                label: "all accounts".into(),
                detail: "3 accounts".into(),
            },
            Row {
                id: "openai".into(),
                label: "OpenAI".into(),
                detail: "2 accounts".into(),
            },
        ]);
        assert_eq!(dialog.title(), "provider accounts");
        let list = dialog.list().expect("list");
        assert_eq!(list.rows.len(), 2);
        assert_eq!(list.rows[0].id, "all");
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
    fn a_confirmation_states_the_blast_radius_it_asks_about() {
        // UX-05: a destructive prompt has to say what it destroys and whether
        // the operator can walk it back, so "yes" is an informed answer.
        let remove = Dialog::confirm_remove("ses_a", "login fix");
        let Dialog::Confirm(confirm) = &remove else {
            panic!("removing a Session asks first");
        };
        assert!(confirm.message.contains("login fix"), "{}", confirm.message);
        assert!(
            confirm.message.contains("cannot be undone"),
            "the prompt says the deletion is permanent: {}",
            confirm.message
        );
        assert!(!confirm.confirmed, "the safe answer starts focused");

        let plan = crate::session::RevertPlan::default();
        let revert = Dialog::confirm_revert(4, &plan);
        let Dialog::Confirm(confirm) = &revert else {
            panic!("a revert asks first");
        };
        assert_eq!(
            confirm.message,
            plan.summary(),
            "the prompt is the engine's own plan, not a generic warning"
        );
        assert!(!confirm.confirmed);
    }

    #[test]
    fn the_revert_confirmation_names_the_side_effects_it_leaves_alone() {
        // HIS-03: the undo prompt is where the operator learns shell side
        // effects are outside what a revert undoes, on a history-only
        // boundary just like on a file plan.
        let plan = crate::session::RevertPlan::from_value(&serde_json::json!({
            "available": false,
            "reason": "no-file-snapshot"
        }));
        let revert = Dialog::confirm_revert(4, &plan);
        let Dialog::Confirm(confirm) = &revert else {
            panic!("a revert asks first");
        };
        assert!(
            confirm
                .message
                .contains("Shell commands and other side effects cannot be undone."),
            "{}",
            confirm.message
        );
        assert!(!confirm.confirmed);
    }

    #[test]
    fn a_jobs_row_names_the_job_and_x_stops_it() {
        // A Session with no jobs says so, and `x` on a row names that job so the
        // caller stops the one the operator is looking at. A subagent row owns
        // no job, so `x` on it stops nothing.
        let empty = Dialog::jobs(&[]);
        let rows = empty.list().expect("list");
        assert_eq!(rows.rows[0].label, "no background jobs");

        let mut dialog = Dialog::jobs(&[
            JobRow {
                id: "job_1".into(),
                owner: "ses_a".into(),
                state: "running".into(),
                detail: "bun test".into(),
                subagent: false,
            },
            JobRow {
                id: "sub_survey".into(),
                owner: "ses_a".into(),
                state: "running".into(),
                detail: "survey the flaky tests".into(),
                subagent: true,
            },
            JobRow {
                id: "job_2".into(),
                owner: "ses_c".into(),
                state: "finished".into(),
                detail: "bun run deploy".into(),
                subagent: false,
            },
        ]);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('x'))),
            Action::CancelJob(id) if id == "job_1"
        ));
        let rows = dialog.list().expect("list");
        assert_eq!(rows.rows[0].label, "job_1 · ses_a · running");
        assert_eq!(
            rows.rows[1].label, "◇ sub_survey · ses_a · running",
            "a subagent row marks itself and names its owner"
        );
        assert_eq!(rows.rows[2].label, "job_2 · ses_c · finished");
        dialog.handle_key(key(KeyCode::Down));
        assert!(
            !matches!(
                dialog.handle_key(key(KeyCode::Char('x'))),
                Action::CancelJob(_)
            ),
            "x on a subagent row stops nothing"
        );
    }

    #[test]
    fn x_names_the_global_stop_and_the_confirmation_gates_it() {
        // `X` does not name a row: it opens the confirmation, whatever the
        // cursor is on.
        let mut dialog = Dialog::jobs(&[JobRow {
            id: "job_1".into(),
            owner: "ses_a".into(),
            state: "running".into(),
            detail: "bun test".into(),
            subagent: false,
        }]);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('X'))),
            Action::StopAllJobs
        ));

        // The confirmation starts on the safe choice, so a bare Enter closes
        // it without stopping anything; `y` arms it and Enter fires it.
        let mut confirm = Dialog::confirm_stop_all_jobs();
        assert!(matches!(
            confirm.handle_key(key(KeyCode::Enter)),
            Action::Close
        ));
        confirm.handle_key(key(KeyCode::Char('y')));
        assert!(matches!(
            confirm.handle_key(key(KeyCode::Enter)),
            Action::Confirmed(ConfirmKind::StopAllJobs)
        ));
    }

    #[test]
    fn a_job_detail_fills_only_the_row_that_asked_for_it() {
        // A row shows the job's command as its detail before any preview answer
        // lands, and the answer for the selected row replaces it. An answer for
        // a job the operator already left must not land under the new one.
        let mut dialog = Dialog::jobs(&[
            JobRow {
                id: "job_1".into(),
                owner: "ses_a".into(),
                state: "running".into(),
                detail: "bun test".into(),
                subagent: false,
            },
            JobRow {
                id: "job_2".into(),
                owner: "ses_c".into(),
                state: "running".into(),
                detail: "bun run deploy".into(),
                subagent: false,
            },
        ]);
        let list = dialog.list_mut().expect("list");
        assert_eq!(list.selected_id().as_deref(), Some("job_1"));
        assert_eq!(
            list.rows
                .iter()
                .find(|row| row.id == "job_1")
                .map(|row| row.detail.as_str()),
            Some("bun test"),
            "the command is known before any preview answer lands"
        );

        list.set_detail("job_2", "running · no result yet".into());
        let list = dialog.list().expect("list");
        assert_eq!(
            list.rows
                .iter()
                .find(|row| row.id == "job_1")
                .map(|row| row.detail.as_str()),
            Some("bun test")
        );
        assert_eq!(
            list.rows
                .iter()
                .find(|row| row.id == "job_2")
                .map(|row| row.detail.as_str()),
            Some("running · no result yet"),
            "the answer names its job, so it fills that row only"
        );
        assert_eq!(list.rows[1].detail, "running · no result yet");
    }

    #[test]
    fn a_schedule_row_names_its_kind_so_x_cancels_the_right_thing() {
        let empty = Dialog::schedule(&[]);
        assert_eq!(
            empty.list().expect("list").rows[0].label,
            "nothing scheduled"
        );

        let mut dialog = Dialog::schedule(&[
            (
                "wakeup:t1".into(),
                "wakeup t1 · pending".into(),
                "in 5m".into(),
            ),
            (
                "cron:c1".into(),
                "cron c1 · scheduled".into(),
                "*/5 * * * * · 2 fired · 0 skipped".into(),
            ),
        ]);
        let rows = dialog.list().expect("list");
        assert_eq!(rows.rows[0].detail, "in 5m");
        assert_eq!(rows.rows[1].detail, "*/5 * * * * · 2 fired · 0 skipped");
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('x'))),
            Action::CancelSchedule(entry) if entry == "wakeup:t1"
        ));
        dialog.handle_key(key(KeyCode::Down));
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('x'))),
            Action::CancelSchedule(entry) if entry == "cron:c1"
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

    fn summary(id: &str, pinned: Option<u64>, directory: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: Some(id.into()),
            parent_id: None,
            updated_at_ms: Some(100),
            archived_at_ms: None,
            pinned_at_ms: pinned,
            directory: Some(directory.into()),
            model: None,
            credential_id: None,
            preview: None,
        }
    }

    #[test]
    fn a_session_row_shows_what_the_conversation_last_said() {
        let mut row = summary("ses_a", None, "/repo");
        row.preview = Some("we moved the parser into the engine".into());
        let dialog = Dialog::sessions(&[row]);
        let list = dialog.list().expect("list");
        assert_eq!(
            list.rows[0].label,
            "ses_a — we moved the parser into the engine"
        );
        // The directory keeps its own column so a long preview cannot hide
        // where the Session lives.
        assert_eq!(list.rows[0].detail, "/repo");
    }

    #[test]
    fn a_digit_reaches_the_pinned_session_in_that_slot() {
        let rows = [
            summary("ses_pinned_new", Some(20), "/repo/new"),
            summary("ses_pinned_old", Some(10), "/repo/old"),
            summary("ses_plain", None, "/repo/plain"),
        ];
        let mut dialog = Dialog::sessions(&rows);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('2'))),
            Action::OpenSession(id) if id == "ses_pinned_old"
        ));
        // Slot 3 is unpinned, so the digit does nothing rather than opening the
        // third row of the list.
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('3'))),
            Action::None
        ));
    }

    /// The catalog refreshes above an open dialog (a rename, a title model,
    /// a pin). Rebuilding the rows must not throw away what the operator
    /// typed, or the list jumps back to its full history under the cursor.
    #[test]
    fn a_rebuilt_dialog_keeps_the_search_and_its_row() {
        let rows = [
            summary("ses_a", None, "/repo/a"),
            summary("ses_plain", None, "/repo/plain"),
            summary("ses_checked", None, "/repo/checked"),
        ];
        let mut dialog = Dialog::sessions(&rows);
        dialog.handle_key(key(KeyCode::Char('/')));
        for c in "check".chars() {
            dialog.handle_key(key(KeyCode::Char(c)));
        }
        let list = dialog.list().expect("list");
        assert_eq!(list.filter.text(), "check");
        assert_eq!(list.visible.len(), 1);

        let mut rebuilt = Dialog::sessions(&rows);
        let previous = dialog.list().expect("list");
        rebuilt
            .list_mut()
            .expect("list")
            .restore_search(previous.filter.text(), previous.search);
        let list = rebuilt.list().expect("list");
        assert_eq!(
            list.filter.text(),
            "check",
            "the query survives the rebuild"
        );
        assert!(list.search, "the search stays armed");
        assert_eq!(list.visible.len(), 1);
        assert!(matches!(
            rebuilt.handle_key(key(KeyCode::Enter)),
            Action::OpenSession(id) if id == "ses_checked"
        ));
    }

    #[test]
    fn a_slash_arms_the_search_and_esc_restores_the_full_list() {
        let rows = [
            summary("ses_pinned", Some(20), "/repo/checked"),
            summary("ses_plain", None, "/other/plain"),
        ];
        let mut dialog = Dialog::sessions(&rows);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Char('/'))),
            Action::None
        ));
        // Inside the search, an `r` is a query character rather than rename.
        for c in "check".chars() {
            assert!(matches!(
                dialog.handle_key(key(KeyCode::Char(c))),
                Action::None
            ));
        }
        let list = dialog.list().expect("list");
        assert_eq!(list.visible.len(), 1);
        assert!(matches!(
            dialog.handle_key(key(KeyCode::Enter)),
            Action::OpenSession(id) if id == "ses_pinned"
        ));
        // Esc leaves the search instead of closing the dialog.
        let mut dialog = Dialog::sessions(&rows);
        dialog.handle_key(key(KeyCode::Char('/')));
        dialog.handle_key(key(KeyCode::Char('c')));
        assert!(matches!(dialog.handle_key(key(KeyCode::Esc)), Action::None));
        let list = dialog.list().expect("list");
        assert!(!list.search);
        assert_eq!(list.visible.len(), 2);
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

    /// The paint path reaches a list's rows only through `list()`, so a list
    /// variant that skips it draws its border and title over an empty body.
    /// `ModelProviders` was in `title()` but not in `list()`: ctrl+o inside the
    /// model picker opened a blank "model providers" box.
    #[test]
    fn every_list_variant_answers_the_body_accessors() {
        let theme = crate::theme::Catalog::builtin();
        let dialogs = vec![
            Dialog::model_provider_filter(&[]),
            Dialog::models(&[], None),
            Dialog::theme("miao", None, &theme),
            Dialog::sessions(&[]),
            Dialog::provider_accounts(Vec::new()),
            Dialog::accounts(&[]),
            Dialog::stash(Vec::new()),
            Dialog::timeline(Vec::new()),
            Dialog::status(Vec::new()),
            Dialog::debug(Vec::new()),
            Dialog::help(Vec::new()),
            Dialog::mcp(&[]),
            Dialog::providers(&[]),
            Dialog::devices(&[]),
            Dialog::jobs(&[]),
            Dialog::schedule(&[]),
            Dialog::skills(&[]),
            Dialog::workspaces(&[]),
        ];
        for mut dialog in dialogs {
            let title = dialog.title();
            assert!(dialog.list().is_some(), "{title} paints an empty body");
            assert!(dialog.list_mut().is_some(), "{title} cannot take a cursor");
            // One row, the hint line and the border; a list that falls through
            // to the default six-row box loses rows it has.
            assert!(dialog.height() >= 4, "{title} is too short for its rows");
        }
    }
}
