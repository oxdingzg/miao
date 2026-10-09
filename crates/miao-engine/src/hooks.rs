use crate::{process, tools::ToolError};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    ToolBefore,
    ToolAfter,
}

impl Event {
    pub fn name(self) -> &'static str {
        match self {
            Self::ToolBefore => "tool_before",
            Self::ToolAfter => "tool_after",
        }
    }
}

/// Host-configured lifecycle hooks. They run under the same workspace sandbox
/// as run_command; hooks are a guard/observation surface, not an escape hatch.
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Hook {
    pub event: Event,
    #[serde(default)]
    pub tool: String,
    pub argv: Vec<String>,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
}
fn timeout() -> u64 {
    10_000
}

impl Hook {
    pub(crate) fn matches(&self, name: &str) -> bool {
        self.tool == "*" || self.tool == name
    }
    pub(crate) fn input(&self) -> Result<process::Input, ToolError> {
        process::Input::parse(json!({
            "argv": self.argv,
            "cwd": ".",
            "timeout_ms": self.timeout_ms,
        }))
    }
}

pub fn validate(hooks: &[Hook]) -> Result<(), ToolError> {
    if hooks.len() > 16 {
        return Err(ToolError::InvalidInput);
    }
    let mut seen = std::collections::BTreeSet::new();
    for hook in hooks {
        if hook.tool.is_empty()
            || hook.tool.len() > 128
            || hook
                .tool
                .contains(|c: char| c.is_whitespace() || c.is_control())
        {
            return Err(ToolError::InvalidInput);
        }
        hook.input()?;
        let key = (
            hook.event,
            hook.tool.clone(),
            serde_json::to_string(&hook.argv).map_err(|_| ToolError::InvalidInput)?,
        );
        if !seen.insert(key) {
            return Err(ToolError::InvalidInput);
        }
    }
    Ok(())
}
