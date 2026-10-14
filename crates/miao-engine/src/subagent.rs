use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::Value;

/// Bounds for delegated work. A subagent is a full child Session, so its depth
/// and concurrency are capped and its prompt is bounded.
pub const DEPTH_LIMIT: u32 = 4;
pub const CONCURRENCY_LIMIT: usize = 4;
/// At most this many archived outputs may be referenced by one delegation.
pub const REFERENCE_LIMIT: usize = 4;
/// The referenced text injected into the child is bounded to this many bytes.
pub const REFERENCE_BYTES: usize = 65536;
const PROMPT_LIMIT: usize = 65536;
const MAX_REFERENCE_ID: usize = 128;

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
    pub prompt: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub references: Vec<Reference>,
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
        if parsed.prompt.trim().is_empty()
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
