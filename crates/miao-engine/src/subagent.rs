use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::Value;

/// Bounds for delegated work. A subagent is a full child Session, so its depth
/// and concurrency are capped and its prompt is bounded.
pub const DEPTH_LIMIT: u32 = 4;
pub const CONCURRENCY_LIMIT: usize = 4;
/// The host policy sets no provider-turn cutoff for the operator's own Session,
/// which is right: an operator can interrupt and can ask for more. A delegated
/// child has neither, so a prompt that never converges runs for hours with
/// nobody able to stop it — one `task` call spent 69 minutes this way. A child
/// the host left unbounded therefore gets this allowance, and a wall clock,
/// after which it closes itself and its report returns.
pub const TURN_LIMIT: u32 = 32;
pub const TIME_LIMIT_SECS: u64 = 1800;
pub const TURN_BOUND_NOTE: &str = "Reached the delegated turn allowance for this task. The delegating Session receives the work completed so far.";
pub const TIME_BOUND_NOTE: &str = "Reached the delegated time limit for this task. The delegating Session receives the work completed so far.";

pub fn turn_limit() -> Option<u32> {
    match std::env::var("MIAO_SUBAGENT_MAX_TURNS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
    {
        Some(0) => None,
        Some(limit) => Some(limit.min(10_000)),
        None => Some(TURN_LIMIT),
    }
}

pub fn time_limit() -> Option<std::time::Duration> {
    match std::env::var("MIAO_SUBAGENT_MAX_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(0) => None,
        Some(seconds) => Some(std::time::Duration::from_secs(seconds.min(86_400))),
        None => Some(std::time::Duration::from_secs(TIME_LIMIT_SECS)),
    }
}
/// At most this many archived outputs may be referenced by one delegation.
pub const REFERENCE_LIMIT: usize = 4;
/// The referenced text injected into the child is bounded to this many bytes.
pub const REFERENCE_BYTES: usize = 65536;
const PROMPT_LIMIT: usize = 65536;
const MAX_REFERENCE_ID: usize = 128;

/// Tools that reach another Session. A delegated child runs as a leaf, so it
/// never sees them: recursion multiplies one prompt's cost, and a nested
/// foreground wait holds its parent's subagent permit until the whole subtree
/// finishes, which serializes the shared budget into what looks like a hang.
pub(crate) fn is_delegation_tool(name: &str) -> bool {
    matches!(name, "task" | "task_list" | "task_result" | "task_cancel" | "workflow")
}

/// One archived tool output of the delegating Session, named by its handle.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub tool_use_id: String,
    #[serde(default)]
    pub offset: u64,
}

/// The `task` tool input: a prompt delegated to a child Session, optionally with
/// references to material of the delegating Session that a child cannot see
/// because it forks empty.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    #[serde(default)]
    pub agent: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub references: Vec<Reference>,
    /// Return as soon as the child is scheduled instead of waiting for its
    /// final message. Background children survive the parent turn.
    #[serde(default)]
    pub background: bool,
}
impl Input {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let parsed: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        let reference_invalid = parsed.references.len() > REFERENCE_LIMIT
            || parsed.references.iter().any(|reference| {
                reference.tool_use_id.is_empty()
                    || reference.tool_use_id.len() > MAX_REFERENCE_ID
                    || reference.tool_use_id.contains('\0')
                    || reference.offset > 64 * 1024 * 1024
            });
        if parsed.agent.as_ref().is_some_and(|name| {
            name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
        }) || parsed.prompt.trim().is_empty()
            || parsed.prompt.len() > PROMPT_LIMIT
            || reference_invalid
            || parsed
                .session_id
                .as_deref()
                .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(parsed)
    }
}

/// Identifies one background child Session owned by the calling Session.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub id: String,
}

impl Selector {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let selector: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if selector.id.is_empty()
            || selector.id.len() > 256
            || selector.id.chars().any(char::is_control)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(selector)
    }
}
