use crate::{
    protocol::Error,
    store::{append, write_tx, Store},
    tools::ToolError,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Waiting,
    Blocked,
    Completed,
    Cancelled,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    High,
    Medium,
    Low,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Todo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    pub content: String,
    pub status: TodoStatus,
    pub priority: Priority,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Todos {
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Done,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Goal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomous: Option<bool>,
    pub objective: String,
    pub status: GoalStatus,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub budget: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

// Task numbers/order are not prerequisites. Validate the declared graph before admission.
fn valid_dependencies(todos: &[Todo]) -> bool {
    let mut by_id = HashMap::new();
    for (index, todo) in todos.iter().enumerate() {
        if let Some(id) = &todo.id {
            if id.trim().is_empty() || by_id.insert(id.as_str(), index).is_some() {
                return false;
            }
        }
        let dependencies = todo.depends_on.as_deref().unwrap_or_default();
        if !dependencies.is_empty() && todo.id.is_none() {
            return false;
        }
        if dependencies.iter().collect::<HashSet<_>>().len() != dependencies.len() {
            return false;
        }
    }
    let mut degree = vec![0; todos.len()];
    let mut children = vec![Vec::new(); todos.len()];
    for (index, todo) in todos.iter().enumerate() {
        for id in todo.depends_on.as_deref().unwrap_or_default() {
            let Some(&parent) = by_id.get(id.as_str()) else {
                return false;
            };
            if matches!(&todo.status, TodoStatus::InProgress | TodoStatus::Completed)
                && !matches!(&todos[parent].status, TodoStatus::Completed)
            {
                return false;
            }
            degree[index] += 1;
            children[parent].push(index);
        }
    }
    let mut ready: VecDeque<_> = degree
        .iter()
        .enumerate()
        .filter_map(|(index, count)| (*count == 0).then_some(index))
        .collect();
    let mut visited = 0;
    while let Some(index) = ready.pop_front() {
        visited += 1;
        for child in &children[index] {
            degree[*child] -= 1;
            if degree[*child] == 0 {
                ready.push_back(*child);
            }
        }
    }
    visited == todos.len()
}

/// Readiness is derived from durable state. Cancelled prerequisites do not unlock dependents.
pub fn runnable(todos: &[Todo]) -> Vec<&Todo> {
    let by_id: HashMap<_, _> = todos
        .iter()
        .filter_map(|todo| todo.id.as_deref().map(|id| (id, todo)))
        .collect();
    todos
        .iter()
        .filter(|todo| {
            matches!(&todo.status, TodoStatus::Pending | TodoStatus::InProgress)
                && todo
                    .depends_on
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .all(|id| {
                        by_id
                            .get(id.as_str())
                            .is_some_and(|parent| matches!(&parent.status, TodoStatus::Completed))
                    })
        })
        .collect()
}

pub fn runnable_state(state: &Value) -> Result<Vec<String>, Error> {
    if state["todos"].is_null() {
        return Ok(Vec::new());
    }
    let todos: Vec<Todo> = serde_json::from_value(state["todos"]["value"]["todos"].clone())
        .map_err(|_| Error::Invalid("invalid durable todo state".into()))?;
    Ok(runnable(&todos)
        .iter()
        .map(|todo| todo.id.clone().unwrap_or_else(|| todo.content.clone()))
        .collect())
}

/// The task-list protocol the system prompt carries, mirroring the
/// instructions in the TypeScript `SessionTodo.context` block
/// (`packages/core/src/session/todo.ts`).
///
/// It is constant text, so it costs the Session one context epoch no matter how
/// many turns run: only Anthropic personas name `todowrite`, and a model loaded
/// with any other persona asset never learned the tool exists, so nothing wrote
/// the first checklist and the sidebar stayed empty. The recorded list itself
/// keeps travelling in the per-turn `<session-state>` note.
pub const TASK_LIST_PROTOCOL: &str = "\n\n<session-task-list>\n# Current session task list\nThe persisted todo list is shown to the user beside the transcript, and `<session-state>` carries its current contents. It supersedes older todo lists in the conversation.\nUse todowrite to track multi-step work. Keep the list synchronized with actual progress: mark work in_progress when starting, completed immediately after finishing and verifying it, and cancelled when it is no longer required. Update it before a final response or handoff; do not leave finished work pending or mark unfinished work completed. If blocked, leave the task open and explain the blocker. Do not infer completion merely from an idle session or a successful tool call.\nA background wait blocks only its dependent task. Give related tasks stable ids and depends_on links; keep not-started dependent tasks pending, and mark external job waits waiting. Continue pending or in_progress tasks only when every depends_on task is completed. Mark tasks needing a human decision blocked. End the Session only when no runnable task remains or its execution budget is exhausted.\n</session-task-list>";

pub struct Mutation {
    pub(crate) kind: &'static str,
    pub(crate) value: Value,
    pub(crate) expected: Option<u64>,
}
impl Mutation {
    pub fn parse(name: &str, value: Value) -> Result<Self, ToolError> {
        let mutation = match name {
            "todowrite" => {
                let todos: Todos =
                    serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
                if todos.todos.len() > 128
                    || !valid_dependencies(&todos.todos)
                    || todos
                        .todos
                        .iter()
                        .any(|todo| todo.content.trim().is_empty() || todo.content.len() > 2048)
                {
                    return Err(ToolError::InvalidInput);
                }
                Self {
                    kind: "todos",
                    expected: todos.expected_revision,
                    value: json!({"todos":todos.todos}),
                }
            }
            "goal" => {
                let goal: Goal =
                    serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
                if goal.objective.trim().is_empty()
                    || goal.objective.len() > 8192
                    || goal.evidence.as_ref().is_some_and(|text| text.len() > 8192)
                    || goal.budget.as_ref().is_some_and(|text| text.len() > 2048)
                    || matches!(goal.status, GoalStatus::Done | GoalStatus::Blocked)
                        && goal
                            .evidence
                            .as_ref()
                            .is_none_or(|text| text.trim().is_empty())
                {
                    return Err(ToolError::InvalidInput);
                }
                let mut value = json!({"objective":goal.objective,"status":goal.status,"evidence":goal.evidence,"budget":goal.budget});
                if let Some(autonomous) = goal.autonomous {
                    value["autonomous"] = json!(autonomous);
                }
                Self {
                    kind: "goal",
                    expected: goal.expected_revision,
                    value,
                }
            }
            _ => return Err(ToolError::Unsupported),
        };
        if serde_json::to_vec(&mutation.value)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > 32768
            || mutation
                .expected
                .is_some_and(|revision| revision > i64::MAX as u64)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(mutation)
    }
}
impl Store {
    pub async fn state(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| projection(conn, &session, i64::MAX as u64))
            .await
    }
    /// The event ledger is the sole state authority. One transaction checks the
    /// optimistic revision, records the operation and commits the new value.
    pub async fn update_state(
        &self,
        session: &str,
        operation_id: &str,
        mutation: Mutation,
    ) -> Result<Value, Error> {
        if operation_id.is_empty() || operation_id.len() > 512 {
            return Err(Error::Invalid("invalid state operation id".into()));
        }
        let (session, operation_id) = (session.to_owned(), operation_id.to_owned());
        self.call(move|conn|{
            let tx=write_tx(conn)?;
            let previous:Option<(u64,String)>=tx.query_row("SELECT seq,data FROM engine_event WHERE session_id=?1 AND kind='session.state.updated' AND json_extract(data,'$.operation_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,operation_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
            if let Some((revision,data))=previous {
                let data:Value=serde_json::from_str(&data)?;
                if data["kind"]!=mutation.kind||data["value"]!=mutation.value||data["expected_revision"]!=json!(mutation.expected){return Err(Error::Conflict);}
                return Ok(json!({"kind":mutation.kind,"revision":revision,"value":mutation.value,"duplicate":true}));
            }
            let state=projection(&tx,&session,i64::MAX as u64)?;
            let revision=state[mutation.kind]["revision"].as_u64().unwrap_or(0);
            if mutation.expected.is_some_and(|expected|expected!=revision){return Err(Error::Conflict);}
            let event=append(&tx,&session,"session.state.updated",json!({"operation_id":operation_id,"kind":mutation.kind,"value":mutation.value,"expected_revision":mutation.expected}))?;
            tx.commit()?;
            Ok(json!({"kind":mutation.kind,"revision":event.seq,"value":mutation.value,"duplicate":false}))
        }).await
    }
}
pub(crate) fn projection(conn: &Connection, session: &str, through: u64) -> Result<Value, Error> {
    let mut state = json!({"todos":null,"goal":null});
    for kind in ["todos", "goal"] {
        let row:Option<(u64,String)>=conn.query_row("SELECT seq,data FROM engine_event WHERE session_id=?1 AND seq<=?2 AND kind='session.state.updated' AND json_extract(data,'$.kind')=?3 ORDER BY seq DESC LIMIT 1",params![session,through,kind],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((revision, data)) = row {
            let data: Value = serde_json::from_str(&data)?;
            state[kind] = json!({"revision":revision,"value":data["value"]});
        }
    }
    Ok(state)
}

/// A list that stopped tracking real progress is worse than no list: the model
/// keeps reading finished work as open and open work as finished.
/// `packages/core/src/session/todo.ts` nudges a stale ledger through
/// `turnsBehind`; the Rust Session had no counterpart, so a long turn could run
/// dozens of tool calls without ever being asked to reconcile.
pub fn ledger_nudge(turns_since_write: u64) -> Option<&'static str> {
    const STALE_AFTER: u64 = 3;
    if turns_since_write < STALE_AFTER {
        return None;
    }
    Some(
        "The persisted task list has not been reconciled for several turns. Update it with \
         todowrite before continuing: mark started work in_progress, finished and verified \
         work completed, and work whose prerequisites are still open pending.",
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_ledger_untouched_for_several_turns_gets_a_nudge() {
        assert_eq!(super::ledger_nudge(0), None);
        assert_eq!(super::ledger_nudge(2), None);
        let nudge = super::ledger_nudge(3).expect("three turns without a write");
        assert!(nudge.contains("todowrite"), "{nudge}");
        assert!(nudge.contains("in_progress"), "{nudge}");
    }

    /// Only Anthropic personas name `todowrite`, so every other model learns
    /// the tool exists only from the protocol the system prompt carries.
    #[test]
    fn the_task_list_protocol_teaches_todowrite_and_its_rules() {
        let protocol = super::TASK_LIST_PROTOCOL;
        assert!(
            protocol.starts_with("\n\n<session-task-list>"),
            "{protocol}"
        );
        assert!(protocol.ends_with("\n</session-task-list>"), "{protocol}");
        assert!(
            protocol.contains("Use todowrite to track multi-step work"),
            "{protocol}"
        );
        // The rules that keep a long list honest: status timing, prerequisites,
        // and what a blocker means.
        assert!(protocol.contains("in_progress when starting"), "{protocol}");
        assert!(protocol.contains("completed immediately"), "{protocol}");
        assert!(protocol.contains("depends_on"), "{protocol}");
        assert!(protocol.contains("no runnable task remains"), "{protocol}");
        // Nothing session-specific rides it: a list that changed every turn
        // would churn the context epoch the system prompt is keyed by.
        assert!(!protocol.contains("Runnable tasks"), "{protocol}");
    }
}
