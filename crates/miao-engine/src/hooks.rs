use crate::{process, tools::ToolError};
use serde::Deserialize;
use serde_json::json;

/// Hooks are configured against the frozen lifecycle vocabulary.
pub use crate::events::Lifecycle as Event;

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
    /// Tool events select by tool name; other lifecycle events only match `*`.
    pub(crate) fn matches(&self, event: Event, subject: &str) -> bool {
        if self.event != event {
            return false;
        }
        if event.tool_scoped() {
            self.tool == "*" || self.tool == subject
        } else {
            self.tool == "*"
        }
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
