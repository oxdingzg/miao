//! Read-only projection of what the engine already owns.
//!
//! The home list and the transcript are views over two engine answers:
//! `snapshot` (metadata-only for list rows, full for one Session) and the
//! committed event stream (`tool.completed` carries the display diff). Nothing
//! here decides Session state; an unknown field is ignored so a protocol that
//! only grew stays readable.

use std::collections::HashMap;

use serde_json::Value;

/// One home-list row, projected from a `metadata_only` snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub parent_id: Option<String>,
    pub updated_at_ms: Option<u64>,
    pub archived_at_ms: Option<u64>,
    /// When the operator pinned this Session. The engine owns the timestamp so
    /// every client sorts the same shared catalog the same way.
    pub pinned_at_ms: Option<u64>,
    pub directory: Option<String>,
    /// The Session's explicit model pin, as `model · protocol[ · variant]`.
    /// `None` means the engine's default.
    pub model: Option<String>,
    /// The account every turn of this Session runs on, when one is pinned.
    pub credential_id: Option<String>,
    /// The engine's bounded "what this conversation last said", for the list
    /// preview. `None` when the Session has no readable text yet.
    pub preview: Option<String>,
}

impl SessionSummary {
    pub fn from_snapshot(snapshot: &Value) -> Option<Self> {
        let id = snapshot.get("session_id")?.as_str()?.to_string();
        let selection = snapshot.get("model_selection");
        let model = selection.and_then(|selection| {
            let protocol = selection.get("protocol")?.as_str()?;
            let model = selection.get("model")?.as_str()?;
            let variant = selection.get("variant").and_then(Value::as_str);
            Some(match variant {
                Some(variant) => format!("{model} · {protocol} · {variant}"),
                None => format!("{model} · {protocol}"),
            })
        });
        Some(Self {
            id,
            title: text(snapshot.get("title")),
            parent_id: text(snapshot.get("parent_session_id")),
            updated_at_ms: snapshot.get("updated_at_ms").and_then(Value::as_u64),
            archived_at_ms: snapshot.get("archived_at_ms").and_then(Value::as_u64),
            pinned_at_ms: snapshot.get("pinned_at_ms").and_then(Value::as_u64),
            // The engine snapshot carries the workspace root as a string.
            directory: snapshot
                .get("location")
                .and_then(Value::as_str)
                .map(str::to_string),
            model,
            credential_id: snapshot
                .get("account_selection")
                .and_then(|selection| selection.get("credential_id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            preview: snapshot
                .get("preview")
                .and_then(|preview| preview.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// What the list shows for a Session with no title yet.
    pub fn label(&self) -> &str {
        self.title.as_deref().unwrap_or("untitled")
    }
}

/// Only root, unarchived Sessions, pinned first and then most recently updated.
/// The engine answers `sessions` in id order, which is stable but not what a
/// picker needs.
pub fn home_rows(mut rows: Vec<SessionSummary>) -> Vec<SessionSummary> {
    rows.retain(|row| row.parent_id.is_none() && row.archived_at_ms.is_none());
    sort_rows(&mut rows);
    rows
}

/// Root Sessions including archived ones, for the Session dialog. Archived
/// Sessions stay reachable so they can be opened again or un-archived.
pub fn catalog_rows(mut rows: Vec<SessionSummary>) -> Vec<SessionSummary> {
    rows.retain(|row| row.parent_id.is_none());
    sort_rows(&mut rows);
    rows
}

fn sort_rows(rows: &mut [SessionSummary]) {
    // A pin is an explicit list preference, so it outranks recency even for a
    // Session that has not been touched in days; within each group the most
    // recently updated Session comes first.
    rows.sort_by(|a, b| {
        a.pinned_at_ms
            .is_none()
            .cmp(&b.pinned_at_ms.is_none())
            .then_with(|| b.updated_at_ms.cmp(&a.updated_at_ms))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// One blocking approval the engine is waiting on.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalView {
    pub request_id: String,
    pub tool: String,
    pub resource: String,
    pub input: Value,
    pub input_hash: String,
    pub policy_revision: String,
    pub matcher: Option<Value>,
    pub expires_at_ms: Option<u64>,
}

impl ApprovalView {
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            request_id: value.get("request_id")?.as_str()?.to_string(),
            tool: value.get("tool")?.as_str()?.to_string(),
            resource: value
                .get("resource")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            input: value.get("input").cloned().unwrap_or(Value::Null),
            input_hash: value.get("input_hash")?.as_str()?.to_string(),
            policy_revision: value.get("policy_revision")?.as_str()?.to_string(),
            matcher: value.get("matcher").cloned(),
            expires_at_ms: value.get("expires_at_ms").and_then(Value::as_u64),
        })
    }

    /// The exact response the engine binds to this request.
    pub fn response(&self, decision: &str) -> Value {
        let mut response = serde_json::json!({
            "request_id": self.request_id,
            "input_hash": self.input_hash,
            "policy_revision": self.policy_revision,
            "decision": decision,
        });
        if let Some(matcher) = &self.matcher {
            response["matcher"] = matcher.clone();
        }
        response
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<Choice>,
    pub multi_select: bool,
    /// The tool allows a typed answer (default true, as the question tool
    /// documents). The Rust panel offers it as one extra row on single-select
    /// questions.
    pub custom: bool,
}

/// One pending `question` tool call, projected from `snapshot.questions`.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionView {
    pub question_id: String,
    pub input_hash: String,
    pub questions: Vec<QuestionItem>,
}

impl QuestionView {
    pub fn from_value(value: &Value) -> Option<Self> {
        let input = value.get("input")?;
        let questions = input
            .get("questions")?
            .as_array()?
            .iter()
            .filter_map(|item| {
                Some(QuestionItem {
                    question: item.get("question")?.as_str()?.to_string(),
                    header: item
                        .get("header")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    options: item
                        .get("options")?
                        .as_array()?
                        .iter()
                        .filter_map(|option| {
                            Some(Choice {
                                label: option.get("label")?.as_str()?.to_string(),
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            })
                        })
                        .collect(),
                    custom: item.get("custom").and_then(Value::as_bool).unwrap_or(true),
                    multi_select: item
                        .get("multiSelect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect::<Vec<_>>();
        if questions.is_empty() {
            return None;
        }
        Some(Self {
            question_id: value.get("question_id")?.as_str()?.to_string(),
            input_hash: value.get("input_hash")?.as_str()?.to_string(),
            questions,
        })
    }

    pub fn answer(&self, answers: Vec<Vec<String>>) -> Value {
        serde_json::json!({
            "question_id": self.question_id,
            "input_hash": self.input_hash,
            "answers": answers,
        })
    }

    pub fn rejection(&self) -> Value {
        serde_json::json!({
            "question_id": self.question_id,
            "input_hash": self.input_hash,
        })
    }
}

/// One todo row projected from the engine's Session state: the sidebar shows
/// the same list the model owns, never a TUI-side copy.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TodoView {
    pub content: String,
    pub status: String,
}

/// The Session's persistent Goal, which the engine keeps apart from the todo
/// list: the checklist says what this turn is doing, the Goal says why the
/// Session exists and what would prove it finished. The engine refuses `done`
/// and `blocked` without evidence, so this view never invents one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalView {
    pub objective: String,
    pub status: String,
    pub budget: Option<String>,
    pub evidence: Option<String>,
}

impl GoalView {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            objective: value.get("objective")?.as_str()?.to_string(),
            status: value.get("status")?.as_str()?.to_string(),
            budget: value
                .get("budget")
                .and_then(Value::as_str)
                .map(str::to_string),
            evidence: value
                .get("evidence")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

/// What the Session is doing and what it is waiting on, re-read from every
/// snapshot. Action state (which option is highlighted) stays in the UI.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionState {
    pub todos: Vec<TodoView>,
    /// The durable Goal, separate from the checklist. `None` when the Session
    /// never recorded one.
    pub goal: Option<GoalView>,
    pub active_run: Option<String>,
    pub pending: usize,
    pub approvals: Vec<ApprovalView>,
    pub questions: Vec<QuestionView>,
    /// Messages a redo would restore. The engine keeps reverted rows in its
    /// ledger, so this count is the durable answer to "can I redo?".
    pub reverted: usize,
}

impl SessionState {
    pub fn from_snapshot(snapshot: &Value) -> Self {
        let todos = snapshot
            .get("state")
            .and_then(|state| state.get("todos"))
            .and_then(|todos| todos.get("value"))
            .and_then(|value| value.get("todos"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(TodoView {
                            content: item.get("content")?.as_str()?.to_string(),
                            status: item.get("status")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            todos,
            goal: snapshot
                .get("state")
                .and_then(|state| state.get("goal"))
                .and_then(|goal| goal.get("value"))
                .filter(|value| !value.is_null())
                .and_then(GoalView::from_value),
            active_run: snapshot
                .get("active_run")
                .and_then(Value::as_str)
                .map(str::to_string),
            pending: snapshot
                .get("pending")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            approvals: snapshot
                .get("approvals")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(ApprovalView::from_value).collect())
                .unwrap_or_default(),
            questions: snapshot
                .get("questions")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(QuestionView::from_value).collect())
                .unwrap_or_default(),
            reverted: snapshot
                .get("reverted_count")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        }
    }
}

/// What a revert at one boundary would change, projected from the engine's
/// `revert_preview`. The engine decides every path; the TUI only says what it
/// was told and asks before touching the workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RevertPlan {
    /// False when the boundary has no recorded file state. The revert is then
    /// history-only, which the engine still performs.
    pub available: bool,
    /// Why a file plan is missing, as the engine names it.
    pub reason: String,
    pub restore: Vec<String>,
    pub remove: Vec<String>,
    /// Paths whose disk content differs from what the Session last recorded.
    /// Restoring them overwrites an edit this Session did not make.
    pub conflicts: Vec<String>,
}

impl RevertPlan {
    pub fn from_value(value: &Value) -> Self {
        let available = value
            .get("available")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let paths = |field: &str| {
            value
                .get(field)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            available,
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            restore: paths("restore"),
            remove: paths("remove"),
            conflicts: value
                .get("conflicts")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let path = item.get("path")?.as_str()?;
                            let disk = item
                                .get("disk")
                                .and_then(Value::as_str)
                                .unwrap_or("modified");
                            Some(format!("{path} ({disk})"))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// One sentence for the confirm dialog. The dialog renders a single
    /// wrapped line, so this stays a paragraph rather than a list.
    pub fn summary(&self) -> String {
        let head = "Revert to this message: it and everything after it leave the transcript.";
        if !self.available {
            return format!(
                "{head} The Session recorded no file changes at this boundary, so the workspace stays as it is. Shell commands and other side effects cannot be undone."
            );
        }
        let mut text = format!(
            "{head} Restore {} file(s), remove {}.",
            self.restore.len(),
            self.remove.len()
        );
        if !self.conflicts.is_empty() {
            text.push_str(&format!(
                " {} path(s) changed outside this Session will be overwritten: {}.",
                self.conflicts.len(),
                listed(&self.conflicts)
            ));
        }
        text.push_str(" Shell commands and other side effects cannot be undone.");
        text
    }

    /// Whether the staged revert should restore files. The engine refuses a
    /// file revert at a boundary that has no file record.
    pub fn files(&self) -> bool {
        self.available
    }
}

/// At most three names, so one outside edit does not push the rest of the
/// message out of the dialog.
fn listed(paths: &[String]) -> String {
    let shown = paths.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
    match paths.len() {
        0..=3 => shown,
        _ => format!("{shown}, and {} more", paths.len() - 3),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolPart {
    pub id: String,
    pub name: String,
    pub input: Value,
    /// The tool result arrives as a separate `role:"user"` message and is
    /// joined here by `tool_use_id`.
    pub output: Option<String>,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Reasoning(String),
    Tool(ToolPart),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    User {
        text: String,
        /// The message's sequence, which is the revert boundary that removes it
        /// and everything after it.
        seq: u64,
    },
    Assistant {
        agent: Option<String>,
        model: Option<String>,
        parts: Vec<Part>,
    },
    /// A drain that ended in failure. A failed turn commits no assistant
    /// message, so the snapshot cannot project this: it comes from the
    /// `stop_failure` event and is carried across refreshes like `displays`.
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayFile {
    pub path: String,
    pub action: String,
    pub patch: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    /// Display diffs by tool-call id. They live on the committed event, not in
    /// the message content the snapshot projects.
    pub displays: HashMap<String, Vec<DisplayFile>>,
    /// Terminal failure of the newest run, with the event's sequence. Also
    /// event-only: `push_failure` turns it into an entry.
    pub failure: Option<(u64, String)>,
    /// Sequence of the newest projected message. Messages and events share one
    /// sequence, so it says whether a failure still trails the conversation.
    pub tail_seq: u64,
}

impl Transcript {
    pub fn from_snapshot(snapshot: &Value) -> Self {
        let mut transcript = Transcript::default();
        let Some(messages) = snapshot.get("messages").and_then(Value::as_array) else {
            return transcript;
        };
        for message in messages {
            transcript.push_message(message);
        }
        transcript
    }

    fn push_message(&mut self, message: &Value) {
        self.tail_seq = self
            .tail_seq
            .max(message.get("seq").and_then(Value::as_u64).unwrap_or(0));
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        match role {
            "user" => self.push_user(message, blocks),
            "assistant" => self.push_assistant(message, blocks),
            _ => {}
        }
    }

    fn push_user(&mut self, message: &Value, blocks: &[Value]) {
        let content = message.get("content");
        let text = content
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                let joined = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                (!joined.is_empty()).then_some(joined)
            });
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            let seq = message.get("seq").and_then(Value::as_u64).unwrap_or(0);
            self.entries.push(Entry::User { text, seq });
        }
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let output = match block.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            let failed = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            self.attach_result(id, output, failed);
        }
    }

    fn attach_result(&mut self, id: &str, output: String, failed: bool) {
        for entry in self.entries.iter_mut().rev() {
            let Entry::Assistant { parts, .. } = entry else {
                continue;
            };
            for part in parts.iter_mut().rev() {
                let Part::Tool(tool) = part else { continue };
                if tool.id != id {
                    continue;
                }
                tool.output = Some(output);
                tool.failed = failed;
                return;
            }
        }
    }

    fn push_assistant(&mut self, message: &Value, blocks: &[Value]) {
        let identity = message.get("identity");
        let agent = identity
            .and_then(|identity| identity.get("agent"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let model = identity
            .and_then(|identity| identity.get("provider"))
            .and_then(|provider| provider.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut parts = Vec::new();
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            parts.push(Part::Text(text.to_string()));
        }
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        parts.push(Part::Text(text.to_string()));
                    }
                }
                Some("reasoning") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        parts.push(Part::Reasoning(text.to_string()));
                    }
                }
                Some("tool_use") => {
                    let Some(name) = block.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    parts.push(Part::Tool(ToolPart {
                        id: block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: name.to_string(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                        output: None,
                        failed: false,
                    }));
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            self.entries.push(Entry::Assistant {
                agent,
                model,
                parts,
            });
        }
    }

    /// Fold one committed event into the view. Message content is re-read from
    /// a snapshot, which is the engine's own projection and cannot drift from
    /// the journal; only the display diff and the terminal failure live on
    /// events alone, so both are carried here.
    pub fn apply_event(&mut self, seq: u64, kind: &str, data: &Value) {
        match kind {
            "stop_failure" => self.failure = failure_of(seq, data),
            // A later drain that ended any other way supersedes the failure.
            "stop" => self.failure = None,
            "tool.completed" => self.push_display(data),
            _ => {}
        }
    }

    /// The user turns this transcript can rewind to, oldest first. Reverting at
    /// a boundary removes that message and everything after it, so the newest
    /// boundary is "undo the last turn".
    pub fn boundaries(&self) -> Vec<(u64, String)> {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                // A projected user message without a sequence cannot be named
                // as a boundary, so it is not offered as one.
                Entry::User { text, seq } if *seq > 0 => Some((*seq, text.clone())),
                _ => None,
            })
            .collect()
    }

    /// Append the failure once the snapshot and the replayed events are folded
    /// in. It belongs to the transcript only while it is the tail: a message
    /// committed after it means the user has already moved past that turn.
    pub fn push_failure(&mut self) {
        let Some((seq, message)) = self.failure.clone() else {
            return;
        };
        if seq <= self.tail_seq {
            return;
        }
        self.entries.push(Entry::Error { message });
    }

    fn push_display(&mut self, data: &Value) {
        let Some(call_id) = data.get("call_id").and_then(Value::as_str) else {
            return;
        };
        let files = data
            .pointer("/display/files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(|file| {
                        Some(DisplayFile {
                            path: file.get("path")?.as_str()?.to_string(),
                            action: file
                                .get("action")
                                .and_then(Value::as_str)
                                .unwrap_or("update")
                                .to_string(),
                            patch: file
                                .get("patch")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            additions: file.get("additions").and_then(Value::as_u64).unwrap_or(0),
                            deletions: file.get("deletions").and_then(Value::as_u64).unwrap_or(0),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if files.is_empty() {
            return;
        }
        // The engine prefixes the run id: "<run_id>/<call_id>".
        let id = call_id.rsplit('/').next().unwrap_or(call_id);
        self.displays.insert(id.to_string(), files);
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// The drain's own error text, which `stop_failure` carries. A payload without
/// one must not render an empty block.
fn failure_of(seq: u64, data: &Value) -> Option<(u64, String)> {
    Some((seq, text(data.get("message"))?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(
        id: &str,
        title: &str,
        updated: u64,
        parent: Option<&str>,
        archived: Option<u64>,
    ) -> Value {
        json!({
            "session_id": id,
            "title": title,
            "updated_at_ms": updated,
            "parent_session_id": parent,
            "archived_at_ms": archived,
            "location": "/work/miao",
        })
    }

    #[test]
    fn home_rows_keep_roots_and_sort_by_recency() {
        let rows = home_rows(vec![
            SessionSummary::from_snapshot(&snapshot("ses_a", "older", 10, None, None))
                .expect("row"),
            SessionSummary::from_snapshot(&snapshot("ses_child", "child", 99, Some("ses_a"), None))
                .expect("row"),
            SessionSummary::from_snapshot(&snapshot("ses_archived", "archived", 50, None, Some(5)))
                .expect("row"),
            SessionSummary::from_snapshot(&snapshot("ses_b", "newer", 30, None, None))
                .expect("row"),
        ]);
        let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, ["ses_b", "ses_a"]);
        assert_eq!(rows[0].label(), "newer");
        assert_eq!(rows[0].directory.as_deref(), Some("/work/miao"));
    }

    #[test]
    fn the_goal_is_decoded_apart_from_the_todo_list() {
        // The engine keeps the Goal and the checklist in separate state rows;
        // the view must not fold one into the other.
        let state = SessionState::from_snapshot(&json!({
            "state": {
                "todos": {
                    "revision": 4,
                    "value": { "todos": [{ "content": "wire the parser", "status": "completed" }] }
                },
                "goal": {
                    "revision": 7,
                    "value": {
                        "objective": "ship the offset reporting",
                        "status": "active",
                        "budget": "two hours",
                        "evidence": null
                    }
                }
            }
        }));
        assert_eq!(state.todos.len(), 1);
        let goal = state.goal.expect("goal");
        assert_eq!(goal.objective, "ship the offset reporting");
        assert_eq!(goal.status, "active");
        assert_eq!(goal.budget.as_deref(), Some("two hours"));
        assert_eq!(goal.evidence, None);
    }

    #[test]
    fn a_session_without_a_goal_has_none() {
        let state = SessionState::from_snapshot(&json!({
            "state": { "todos": null, "goal": null }
        }));
        assert!(state.goal.is_none());
        assert!(state.todos.is_empty());
    }

    #[test]
    fn a_pin_outranks_recency_in_both_lists() {
        let pinned = |id: &str, updated: u64, pinned: Option<u64>| {
            SessionSummary::from_snapshot(&json!({
                "session_id": id,
                "title": id,
                "updated_at_ms": updated,
                "pinned_at_ms": pinned,
            }))
            .expect("row")
        };
        let rows = home_rows(vec![
            pinned("ses_newer", 900, None),
            pinned("ses_pinned_old", 10, Some(1)),
            pinned("ses_pinned_new", 20, Some(2)),
        ]);
        let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
        // The pin groups come first, newest pin first; an unpinned, fresher
        // Session stays below them.
        assert_eq!(ids, ["ses_pinned_new", "ses_pinned_old", "ses_newer"]);
        let catalog = catalog_rows(vec![
            pinned("ses_newer", 900, None),
            pinned("ses_pinned_old", 10, Some(1)),
        ]);
        assert_eq!(
            catalog
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["ses_pinned_old", "ses_newer"]
        );
    }

    #[test]
    fn catalog_rows_keep_archived_roots_and_drop_children() {
        let rows = catalog_rows(vec![
            SessionSummary::from_snapshot(&snapshot("ses_a", "older", 10, None, None))
                .expect("row"),
            SessionSummary::from_snapshot(&snapshot("ses_child", "child", 99, Some("ses_a"), None))
                .expect("row"),
            SessionSummary::from_snapshot(&snapshot("ses_archived", "archived", 50, None, Some(5)))
                .expect("row"),
        ]);
        let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, ["ses_archived", "ses_a"]);
    }

    #[test]
    fn a_summary_carries_the_model_and_account_pins() {
        let value = json!({
            "session_id": "ses_a",
            "model_selection": {"protocol": "chat", "model": "glm-5", "variant": "high"},
            "account_selection": {"credential_id": "cred_1"},
        });
        let row = SessionSummary::from_snapshot(&value).expect("row");
        assert_eq!(row.model.as_deref(), Some("glm-5 · chat · high"));
        assert_eq!(row.credential_id.as_deref(), Some("cred_1"));
        let bare = SessionSummary::from_snapshot(&json!({"session_id": "ses_b"})).expect("row");
        assert_eq!(bare.model, None);
        assert_eq!(bare.credential_id, None);
    }

    #[test]
    fn a_snapshot_preview_becomes_the_list_preview() {
        let value = json!({
            "session_id": "ses_p",
            "preview": { "text": "it was the stub config", "truncated": true },
        });
        let row = SessionSummary::from_snapshot(&value).expect("row");
        assert_eq!(row.preview.as_deref(), Some("it was the stub config"));

        let bare = SessionSummary::from_snapshot(&json!({"session_id": "ses_b"})).expect("row");
        assert_eq!(bare.preview, None);
    }

    #[test]
    fn transcript_joins_tool_results_by_call_id() {
        let snapshot = json!({
            "session_id": "ses_a",
            "messages": [
                { "role": "user", "content": "hello" },
                {
                    "role": "assistant",
                    "identity": { "agent": "build", "provider": { "model": "glm-5.3-flash" } },
                    "content": [
                        { "type": "reasoning", "text": "thinking about it" },
                        { "type": "text", "text": "running the tool" },
                        { "type": "tool_use", "id": "call_1", "name": "bash", "input": { "command": "ls" } }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "tool_use_id": "call_1", "content": "a.txt", "is_error": false }
                    ]
                }
            ]
        });
        let transcript = Transcript::from_snapshot(&snapshot);
        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(
            transcript.entries[0],
            Entry::User {
                text: "hello".into(),
                seq: 0
            }
        );
        let Entry::Assistant {
            agent,
            model,
            parts,
        } = &transcript.entries[1]
        else {
            panic!("expected assistant entry");
        };
        assert_eq!(agent.as_deref(), Some("build"));
        assert_eq!(model.as_deref(), Some("glm-5.3-flash"));
        assert_eq!(parts[0], Part::Reasoning("thinking about it".into()));
        assert_eq!(parts[1], Part::Text("running the tool".into()));
        let Part::Tool(tool) = &parts[2] else {
            panic!("expected tool part");
        };
        assert_eq!(tool.name, "bash");
        assert_eq!(tool.output.as_deref(), Some("a.txt"));
        assert!(!tool.failed);
    }

    #[test]
    fn a_failed_tool_result_is_marked() {
        let snapshot = json!({
            "session_id": "ses_a",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{ "type": "tool_use", "id": "call_1", "name": "bash", "input": {} }]
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "tool_use_id": "call_1", "content": "boom", "is_error": true }
                    ]
                }
            ]
        });
        let transcript = Transcript::from_snapshot(&snapshot);
        let Entry::Assistant { parts, .. } = &transcript.entries[0] else {
            panic!("expected assistant entry");
        };
        let Part::Tool(tool) = &parts[0] else {
            panic!("expected tool part");
        };
        assert!(tool.failed);
        assert_eq!(tool.output.as_deref(), Some("boom"));
    }

    #[test]
    fn a_display_event_attaches_its_files_to_the_call() {
        let mut transcript = Transcript::default();
        transcript.apply_event(
            12,
            "tool.completed",
            &json!({
                "call_id": "run-1/call_1",
                "display": { "files": [{ "path": "src/lib.rs", "action": "update", "patch": "@@ -1 +1 @@\n-a\n+b\n", "additions": 1, "deletions": 1 }] }
            }),
        );
        let files = transcript.displays.get("call_1").expect("display files");
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].additions, 1);
    }

    #[test]
    fn session_state_projects_run_status_and_blocked_requests() {
        let snapshot = json!({
            "session_id": "ses_a",
            "active_run": "run-1",
            "pending": [{"input_id": "in_1", "delivery": "steer"}],
            "approvals": [{
                "request_id": "run-1/call_1",
                "tool": "bash",
                "resource": "rm -rf build",
                "input": {"command": "rm -rf build"},
                "input_hash": "a".repeat(64),
                "policy_revision": "rev-1",
                "matcher": {"kind": "builtin"},
                "expires_at_ms": 123
            }, { "tool": "broken" }],
            "questions": [{
                "question_id": "run-1/call_2",
                "input_hash": "b".repeat(64),
                "input": {"questions": [{
                    "question": "Proceed?",
                    "header": "Confirm",
                    "options": [{"label": "yes"}, {"label": "no", "description": "stop"}],
                    "multiSelect": false
                }], "timeout_ms": 60000}
            }]
        });
        let state = SessionState::from_snapshot(&snapshot);
        assert_eq!(state.active_run.as_deref(), Some("run-1"));
        assert_eq!(state.pending, 1);
        assert_eq!(state.approvals.len(), 1, "malformed approvals are skipped");
        assert_eq!(state.approvals[0].tool, "bash");
        assert_eq!(state.questions[0].questions[0].header, "Confirm");
        assert_eq!(state.questions[0].questions[0].options[1].label, "no");
        assert_eq!(
            state.approvals[0].response("deny")["decision"],
            "deny",
            "the response carries the decision"
        );
        assert_eq!(
            state.questions[0].answer(vec![vec!["yes".into()]])["answers"],
            json!([["yes"]])
        );
        assert_eq!(state.questions[0].rejection()["input_hash"], "b".repeat(64));
    }

    #[test]
    fn a_snapshot_without_blocking_state_is_idle() {
        let state = SessionState::from_snapshot(&json!({"session_id": "ses_a"}));
        assert_eq!(state, SessionState::default());
    }

    #[test]
    fn an_event_without_a_display_is_ignored() {
        let mut transcript = Transcript::default();
        transcript.apply_event(9, "tool.completed", &json!({ "call_id": "run-1/call_1" }));
        assert!(transcript.displays.is_empty());
    }

    #[test]
    fn a_failed_run_reaches_the_transcript_as_an_error_entry() {
        let mut transcript = Transcript::from_snapshot(&json!({
            "session_id": "ses_a",
            "messages": [{ "seq": 4, "role": "user", "content": "hello" }]
        }));
        transcript.apply_event(
            9,
            "stop_failure",
            &json!({ "run_id": "run-1", "reason": "failed", "message": "provider unavailable" }),
        );
        transcript.push_failure();
        assert_eq!(
            transcript.entries.last(),
            Some(&Entry::Error {
                message: "provider unavailable".into()
            })
        );
    }

    #[test]
    fn a_failure_before_the_newest_message_is_history() {
        let mut transcript = Transcript::from_snapshot(&json!({
            "session_id": "ses_a",
            "messages": [{ "seq": 12, "role": "user", "content": "try again" }]
        }));
        transcript.apply_event(
            9,
            "stop_failure",
            &json!({ "run_id": "run-1", "reason": "failed", "message": "provider unavailable" }),
        );
        transcript.push_failure();
        assert_eq!(
            transcript.entries,
            vec![Entry::User {
                text: "try again".into(),
                seq: 12
            }],
            "the retry has already moved past the old failure"
        );
    }

    #[test]
    fn boundaries_are_the_user_turns_the_session_can_rewind_to() {
        let transcript = Transcript::from_snapshot(&json!({
            "session_id": "ses_a",
            "messages": [
                { "seq": 2, "role": "user", "content": "first" },
                { "seq": 3, "role": "assistant", "content": [{ "type": "text", "text": "answer" }] },
                // A projected message without a sequence cannot name a
                // boundary, so it is not offered as one.
                { "role": "user", "content": "unanchored" },
                { "seq": 8, "role": "user", "content": "second" }
            ]
        }));
        assert_eq!(
            transcript.boundaries(),
            vec![(2, "first".to_string()), (8, "second".to_string())]
        );
        assert_eq!(transcript.boundaries().last().map(|(seq, _)| *seq), Some(8));
    }

    #[test]
    fn a_revert_plan_names_the_paths_an_outside_edit_loses() {
        let plan = RevertPlan::from_value(&json!({
            "available": true,
            "boundary_seq": 8,
            "restore": ["a.txt", "b.txt"],
            "remove": ["c.txt"],
            "conflicts": [{ "path": "a.txt", "action": "restore", "disk": "modified" }]
        }));
        assert!(plan.files());
        let summary = plan.summary();
        assert!(summary.contains("Restore 2 file(s), remove 1"));
        assert!(summary.contains("a.txt (modified)"), "got {summary}");
        assert!(summary.contains("cannot be undone"), "got {summary}");
    }

    #[test]
    fn a_boundary_without_a_file_record_reverts_history_only() {
        let plan = RevertPlan::from_value(&json!({
            "available": false,
            "reason": "no-file-snapshot"
        }));
        assert!(!plan.files(), "the engine would refuse a file revert");
        assert!(plan.summary().contains("workspace stays as it is"));
    }

    #[test]
    fn the_snapshot_reverted_count_says_whether_a_redo_is_possible() {
        assert_eq!(
            SessionState::from_snapshot(&json!({ "reverted_count": 3 })).reverted,
            3
        );
        assert_eq!(SessionState::from_snapshot(&json!({})).reverted, 0);
    }

    #[test]
    fn a_stop_that_did_not_fail_clears_the_failure() {
        let mut transcript = Transcript::default();
        transcript.apply_event(
            9,
            "stop_failure",
            &json!({ "run_id": "run-1", "reason": "failed", "message": "boom" }),
        );
        transcript.apply_event(
            11,
            "stop",
            &json!({ "run_id": "run-2", "reason": "completed" }),
        );
        assert_eq!(transcript.failure, None);
    }
}
