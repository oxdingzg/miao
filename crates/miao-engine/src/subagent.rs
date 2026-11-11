use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::Value;

/// Bounds for delegated work. A subagent is a full child Session, so its depth
/// and concurrency are capped and its prompt is bounded.
pub const DEPTH_LIMIT: u32 = 4;
pub const CONCURRENCY_LIMIT: usize = 4;
/// A Session's share of the fleet-wide subagent pool. A parent at its share
/// waits for one of its own children to come back instead of taking another
/// child while other Sessions of this engine process wait.
pub const PER_SESSION_LIMIT: usize = 2;
/// The host policy sets no provider-turn cutoff for the operator's own Session,
/// which is right: an operator can interrupt and can ask for more. A delegated
/// child has neither, so a prompt that never converges runs for hours with
/// nobody able to stop it — one `task` call spent 69 minutes this way. A child
/// the host left unbounded therefore gets this allowance, and a wall clock,
/// after which it closes itself and its report returns. The sizing follows
/// issue #2825: an implementation-shaped child (read, implement, test, iterate
/// on CI) routinely outgrows a short burst, so the default covers a working
/// session; an explicit `budget` remains the way to grant more or less.
pub const TURN_LIMIT: u32 = 96;
pub const TIME_LIMIT_SECS: u64 = 3600;
/// A parent may state a child's bounds explicitly, but a stated bound may not
/// exceed what the host could ever honour: `0` is not a bound, and a larger
/// value is refused rather than silently clamped.
pub const TURN_CEILING: u32 = 10_000;
pub const WALLCLOCK_CEILING_MS: u64 = 86_400_000;
/// How many tool names one delegation may deny, and how long one name may be.
pub const DENY_TOOL_LIMIT: usize = 32;
const MAX_TOOL_NAME: usize = 128;
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
    matches!(name, "task" | "task_list" | "task_result" | "task_cancel")
}

/// One archived tool output of the delegating Session, named by its handle.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub tool_use_id: String,
    #[serde(default)]
    pub offset: u64,
}

/// Bounds a parent states explicitly for one delegation, structurally like a
/// goal budget (AGT-04): provider turns and wall clock, at least one of the
/// two when present.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    pub max_turns: Option<u32>,
    pub wallclock_ms: Option<u64>,
}

impl Budget {
    fn validate(&self) -> Result<(), ToolError> {
        if self.max_turns.is_none() && self.wallclock_ms.is_none() {
            return Err(ToolError::InvalidArgs(
                "budget states no bound: set max_turns or wallclock_ms".into(),
            ));
        }
        if self
            .max_turns
            .is_some_and(|turns| turns == 0 || turns > TURN_CEILING)
        {
            return Err(ToolError::InvalidArgs(format!(
                "max_turns must be between 1 and {TURN_CEILING}"
            )));
        }
        if self
            .wallclock_ms
            .is_some_and(|ms| ms == 0 || ms > WALLCLOCK_CEILING_MS)
        {
            return Err(ToolError::InvalidArgs(format!(
                "wallclock_ms must be between 1 and {WALLCLOCK_CEILING_MS}"
            )));
        }
        Ok(())
    }
}

/// The boundary a delegated child runs under, read once per run from the
/// durable `delegation.boundary` event recorded at delegation time. Explicit
/// budget and narrowed tools ride the event, not the environment.
pub(crate) struct Boundary {
    pub max_turns: Option<u32>,
    pub wallclock_ms: Option<u64>,
    pub deny_tools: Vec<String>,
}

impl Boundary {
    pub(crate) fn from_event(data: &Value) -> Self {
        Self {
            max_turns: data["max_turns"].as_u64().map(|turns| turns as u32),
            wallclock_ms: data["wallclock_ms"].as_u64(),
            deny_tools: data["deny_tools"]
                .as_array()
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|name| name.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
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
    /// The child's explicit bounds, stated by the parent.
    #[serde(default)]
    pub budget: Option<Budget>,
    /// Tools the parent withholds from this child's surface.
    #[serde(default)]
    pub deny_tools: Vec<String>,
    /// What the delegated work is for. Optional: a caller that only has a
    /// prompt still works, and this is what a report can be checked against
    /// when the caller does state it.
    #[serde(default)]
    pub goal: Option<String>,
    /// What the child has to be able to show for its work to count. Optional
    /// for the same reason; when present the package asks the report to answer
    /// each one with its evidence instead of pasting history.
    #[serde(default)]
    pub completion_criteria: Vec<String>,
}

/// Bounds for the optional part of a task package.
pub const GOAL_LIMIT: usize = 512;
pub const CRITERIA_LIMIT: usize = 16;
pub const CRITERION_LIMIT: usize = 256;

impl Input {
    /// The structured part of a delegated prompt. A child forks empty, so the
    /// goal and the acceptance conditions would otherwise exist only in the
    /// parent's head; this states them once, above the instructions, in the
    /// shape the child's final report is expected to answer. A package that
    /// states neither renders nothing, which keeps a bare prompt unchanged.
    pub fn package(&self) -> String {
        let criteria: Vec<&String> = self
            .completion_criteria
            .iter()
            .filter(|criterion| !criterion.trim().is_empty())
            .collect();
        if self.goal.is_none() && criteria.is_empty() {
            return String::new();
        }
        let mut block = String::from("<task-package>\n");
        if let Some(goal) = &self.goal {
            block.push_str(&format!("Goal: {}\n", goal.trim()));
        }
        if !criteria.is_empty() {
            block.push_str("Completion criteria:\n");
            for (index, criterion) in criteria.iter().enumerate() {
                block.push_str(&format!("{}. {}\n", index + 1, criterion.trim()));
            }
            block.push_str(
                "Answer each criterion in the final report with the evidence that proves it. Keep the report short: name the commands, paths and observations, and do not paste long history.\n",
            );
        }
        block.push_str("</task-package>\n");
        block
    }

    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let parsed: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        let reference_invalid = parsed.references.len() > REFERENCE_LIMIT
            || parsed.references.iter().any(|reference| {
                reference.tool_use_id.is_empty()
                    || reference.tool_use_id.len() > MAX_REFERENCE_ID
                    || reference.tool_use_id.contains('\0')
                    || reference.offset > 64 * 1024 * 1024
            });
        let deny_invalid = parsed.deny_tools.len() > DENY_TOOL_LIMIT
            || parsed.deny_tools.iter().any(|name| {
                name.is_empty() || name.len() > MAX_TOOL_NAME || name.chars().any(char::is_control)
            });
        let package_invalid = parsed.goal.as_ref().is_some_and(|goal| {
            goal.trim().is_empty() || goal.len() > GOAL_LIMIT || goal.chars().any(char::is_control)
        }) || parsed.completion_criteria.len() > CRITERIA_LIMIT
            || parsed.completion_criteria.iter().any(|criterion| {
                criterion.len() > CRITERION_LIMIT || criterion.chars().any(char::is_control)
            });
        if parsed.agent.as_ref().is_some_and(|name| {
            name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
        }) || parsed.prompt.trim().is_empty()
            || parsed.prompt.len() > PROMPT_LIMIT
            || reference_invalid
            || deny_invalid
            || package_invalid
            || parsed
                .session_id
                .as_deref()
                .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err(ToolError::InvalidInput);
        }
        if let Some(budget) = &parsed.budget {
            budget.validate()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(input: Value) -> String {
        Input::parse(input).expect("a valid package").package()
    }

    /// A caller that states its goal and its acceptance conditions gets them
    /// stated to the child once, above the instructions, in the shape the
    /// report is asked to answer — the child cannot see the parent's context.
    #[test]
    fn a_task_package_states_the_goal_and_the_criteria() {
        let block = package(json!({
            "prompt": "read the ledger and report",
            "goal": "  find the double-charge  ",
            "completion_criteria": ["cite the ledger rows", "  name the fix  "],
        }));
        assert!(block.starts_with("<task-package>\n"), "{block}");
        assert!(
            block.contains("Goal: find the double-charge\n"),
            "the goal is trimmed: {block}"
        );
        assert!(block.contains("1. cite the ledger rows\n"), "{block}");
        assert!(block.contains("2. name the fix\n"), "{block}");
        assert!(
            block.contains("Answer each criterion in the final report with the evidence"),
            "the report is asked to answer them: {block}"
        );
        assert!(
            block.contains("do not paste long history"),
            "and to stay short: {block}"
        );
        assert!(block.ends_with("</task-package>\n"), "{block}");
    }

    /// A bare prompt is the whole package: nothing is added, so an existing
    /// caller that passes only a prompt sends exactly what it sent before.
    #[test]
    fn a_bare_prompt_renders_no_package() {
        assert_eq!(package(json!({"prompt": "just do it"})), "");
        // Blank values are not a package either.
        assert_eq!(
            package(json!({"prompt": "just do it", "completion_criteria": ["  ", ""]})),
            ""
        );
    }

    #[test]
    fn an_oversized_package_is_refused_rather_than_truncated() {
        let long_goal = "x".repeat(GOAL_LIMIT + 1);
        assert!(Input::parse(json!({"prompt": "p", "goal": long_goal})).is_err());
        let long_criterion = "y".repeat(CRITERION_LIMIT + 1);
        assert!(
            Input::parse(json!({"prompt": "p", "completion_criteria": [long_criterion]})).is_err()
        );
        let many: Vec<String> = (0..=CRITERIA_LIMIT)
            .map(|n| format!("criterion {n}"))
            .collect();
        assert!(Input::parse(json!({"prompt": "p", "completion_criteria": many})).is_err());
        // The limit itself is allowed.
        let at_limit: Vec<String> = (0..CRITERIA_LIMIT)
            .map(|n| format!("criterion {n}"))
            .collect();
        assert!(Input::parse(json!({"prompt": "p", "completion_criteria": at_limit})).is_ok());
    }
}
