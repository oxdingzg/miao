use crate::{process, tools::ToolError};
use serde::Deserialize;
use serde_json::json;

/// Hooks are configured against the frozen lifecycle vocabulary.
pub use crate::events::Lifecycle as Event;

/// Host-configured lifecycle hooks. They run under the same workspace sandbox
/// as run_command; hooks are a guard/observation surface, not an escape hatch.
#[derive(Deserialize, Clone, PartialEq)]
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
        return Err(ToolError::InvalidArgs(format!(
            "at most 16 hooks are allowed; got {}",
            hooks.len()
        )));
    }
    let mut seen = std::collections::BTreeSet::new();
    for hook in hooks {
        if hook.tool.is_empty() {
            return Err(ToolError::InvalidArgs(
                "every hook needs a tool name, or \"*\" for all tools".into(),
            ));
        }
        if hook.tool.len() > 128 {
            return Err(ToolError::InvalidArgs(format!(
                "tool name is {} bytes; at most 128 are allowed",
                hook.tool.len()
            )));
        }
        if hook
            .tool
            .contains(|c: char| c.is_whitespace() || c.is_control())
        {
            return Err(ToolError::InvalidArgs(format!(
                "tool name {:?} must not contain whitespace or control characters",
                hook.tool
            )));
        }
        hook.input()?;
        let key = (
            hook.event,
            hook.tool.clone(),
            serde_json::to_string(&hook.argv).map_err(|_| ToolError::InvalidInput)?,
        );
        if !seen.insert(key) {
            return Err(ToolError::InvalidArgs(format!(
                "duplicate hook for {:?}; it would run twice",
                hook.tool
            )));
        }
    }
    Ok(())
}
