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
