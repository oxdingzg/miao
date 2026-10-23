use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selector {
    pub job_id: String,
}
impl Selector {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let selector: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if selector.job_id.is_empty()
            || selector.job_id.len() > 64
            || !selector
                .job_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(selector)
    }
}

/// A bounded wait on one Session-owned job. The cap matches the model-facing
/// contract so a tool call cannot block a turn indefinitely.
pub(crate) const MAX_WAIT_MS: u64 = 600_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Wait {
    pub job_id: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_timeout() -> u64 {
    MAX_WAIT_MS
}

impl Wait {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let wait: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        Selector::parse(serde_json::json!({"job_id": wait.job_id}))?;
        if wait.timeout_ms > MAX_WAIT_MS {
            return Err(ToolError::InvalidInput);
        }
        Ok(wait)
    }
}
