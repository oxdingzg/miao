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
    pub directory: Option<String>,
}

impl SessionSummary {
    pub fn from_snapshot(snapshot: &Value) -> Option<Self> {
        let id = snapshot.get("session_id")?.as_str()?.to_string();
        Some(Self {
            id,
            title: text(snapshot.get("title")),
            parent_id: text(snapshot.get("parent_session_id")),
            updated_at_ms: snapshot.get("updated_at_ms").and_then(Value::as_u64),
            archived_at_ms: snapshot.get("archived_at_ms").and_then(Value::as_u64),
            // The engine snapshot carries the workspace root as a string.
            directory: snapshot
                .get("location")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// What the list shows for a Session with no title yet.
    pub fn label(&self) -> &str {
        self.title.as_deref().unwrap_or("untitled")
    }
}

/// Only root, unarchived Sessions, most recently updated first. The engine
/// answers `sessions` in id order, which is stable but not what a picker needs.
pub fn home_rows(mut rows: Vec<SessionSummary>) -> Vec<SessionSummary> {
    rows.retain(|row| row.parent_id.is_none() && row.archived_at_ms.is_none());
    rows.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    rows
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

/// What the Session is doing and what it is waiting on, re-read from every
/// snapshot. Action state (which option is highlighted) stays in the UI.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionState {
    pub active_run: Option<String>,
    pub pending: usize,
    pub approvals: Vec<ApprovalView>,
    pub questions: Vec<QuestionView>,
}

impl SessionState {
    pub fn from_snapshot(snapshot: &Value) -> Self {
        Self {
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
        }
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
    },
    Assistant {
        agent: Option<String>,
        model: Option<String>,
        parts: Vec<Part>,
    },
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
            self.entries.push(Entry::User { text });
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

    /// Fold one committed event into the view. Only the display diff is kept:
    /// message content is re-read from a snapshot, which is the engine's own
    /// projection and cannot drift from the journal.
    pub fn apply_event(&mut self, kind: &str, data: &Value) {
        if kind != "tool.completed" {
            return;
        }
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
                text: "hello".into()
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
        transcript.apply_event("tool.completed", &json!({ "call_id": "run-1/call_1" }));
        assert!(transcript.displays.is_empty());
    }
}
