use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::Value;

/// Bounds for delegated work. A subagent is a full child Session, so its depth
/// and concurrency are capped and its prompt is bounded.
pub const DEPTH_LIMIT: u32 = 4;
pub const CONCURRENCY_LIMIT: usize = 4;
const PROMPT_LIMIT: usize = 65536;

/// The `task` tool input: a prompt delegated to a child Session.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub prompt: String,
    #[serde(default)]
    pub session_id: Option<String>,
}
impl Input {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let parsed: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if parsed.prompt.trim().is_empty()
            || parsed.prompt.len() > PROMPT_LIMIT
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
