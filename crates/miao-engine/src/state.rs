use crate::{
    protocol::Error,
    store::{append, Store},
    tools::ToolError,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
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
    pub objective: String,
    pub status: GoalStatus,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub budget: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

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
                Self {
                    kind: "goal",
                    expected: goal.expected_revision,
                    value: json!({"objective":goal.objective,"status":goal.status,"evidence":goal.evidence,"budget":goal.budget}),
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
            let tx=conn.transaction()?;
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
