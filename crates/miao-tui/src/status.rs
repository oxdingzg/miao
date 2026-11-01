//! Billed usage and latency for one Session, projected from the engine's
//! `usage` report. Only the fields the status dialog shows are read; a report
//! that grows stays readable.

use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageSummary {
    pub turns: u64,
    pub partial_turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub tool_calls: u64,
    pub tool_failures: u64,
    /// Average time to first token in milliseconds; `None` when the engine has
    /// no timing rows yet.
    pub ttft_avg_ms: Option<u64>,
    /// `model · protocol ×turns` for each model that served a turn.
    pub lineage: Vec<String>,
    /// Every attempt the provider client made, including the retries.
    pub attempts: u64,
    /// Attempts that failed: a 4xx/5xx status, or no status at all because the
    /// transport died.
    pub failed_attempts: u64,
    /// Turns the runner replayed after a transport failure. Retried work is
    /// billed work, so it is reported rather than folded into the turn count.
    pub replayed_turns: u64,
    /// Child Sessions this Session delegated to. A subagent bills on its own
    /// Session, so without this line its cost is missing from the only screen
    /// that shows cost.
    pub subagent_sessions: u64,
    pub subagent_turns: u64,
    pub subagent_input_tokens: u64,
    pub subagent_cache_read_tokens: u64,
    /// Decisions a person had to make for this Session to keep going.
    pub approvals: u64,
    pub answers: u64,
    pub rejections: u64,
    pub cancels: u64,
    pub input_edits: u64,
    /// Work the model had to redo on its own: malformed tool arguments it was
    /// asked to correct.
    pub tool_input_errors: u64,
    /// Auxiliary role calls (compaction and the other small jobs). Their cost is
    /// real spend that no main-model line accounts for.
    pub auxiliary_calls: u64,
    pub auxiliary_input_tokens: u64,
    pub auxiliary_output_tokens: u64,
}

impl UsageSummary {
    pub fn from_value(value: &Value) -> Self {
        Self {
            turns: u64_at(value, &["turns"]).unwrap_or(0),
            partial_turns: u64_at(value, &["partialTurns"]).unwrap_or(0),
            input_tokens: u64_at(value, &["tokens", "input"]).unwrap_or(0),
            output_tokens: u64_at(value, &["tokens", "output"]).unwrap_or(0),
            cache_read_tokens: u64_at(value, &["tokens", "cacheRead"]).unwrap_or(0),
            tool_calls: u64_at(value, &["tools", "calls"]).unwrap_or(0),
            tool_failures: u64_at(value, &["tools", "failures"]).unwrap_or(0),
            ttft_avg_ms: u64_at(value, &["ttftMs", "avg"]),
            lineage: value
                .get("lineage")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| {
                            let protocol = row.get("protocol")?.as_str()?;
                            let model = row.get("model")?.as_str()?;
                            let turns = row.get("turns").and_then(Value::as_u64).unwrap_or(0);
                            Some(format!("{model} · {protocol} ×{turns}"))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            attempts: u64_at(value, &["retries", "attempts"]).unwrap_or(0),
            failed_attempts: u64_at(value, &["retries", "failedAttempts"]).unwrap_or(0),
            replayed_turns: u64_at(value, &["retries", "replayedTurns"]).unwrap_or(0),
            subagent_sessions: u64_at(value, &["subagents", "sessions"]).unwrap_or(0),
            subagent_turns: u64_at(value, &["subagents", "turns"]).unwrap_or(0),
            subagent_input_tokens: u64_at(value, &["subagents", "tokens", "input"]).unwrap_or(0),
            subagent_cache_read_tokens: u64_at(value, &["subagents", "tokens", "cacheRead"])
                .unwrap_or(0),
            approvals: u64_at(value, &["interventions", "approvals"]).unwrap_or(0),
            answers: u64_at(value, &["interventions", "answers"]).unwrap_or(0),
            rejections: u64_at(value, &["interventions", "rejections"]).unwrap_or(0),
            cancels: u64_at(value, &["interventions", "cancels"]).unwrap_or(0),
            input_edits: u64_at(value, &["interventions", "inputEdits"]).unwrap_or(0),
            tool_input_errors: u64_at(value, &["rework", "toolInputErrors"]).unwrap_or(0),
            auxiliary_calls: u64_at(value, &["auxiliary", "usage", "observations"]).unwrap_or(0),
            auxiliary_input_tokens: u64_at(value, &["auxiliary", "usage", "tokens", "input"])
                .unwrap_or(0),
            auxiliary_output_tokens: u64_at(value, &["auxiliary", "usage", "tokens", "output"])
                .unwrap_or(0),
        }
    }
}

fn u64_at(value: &Value, path: &[&str]) -> Option<u64> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_report_projects_the_fields_the_dialog_shows() {
        let usage = UsageSummary::from_value(&json!({
            "turns": 3,
            "partialTurns": 1,
            "tokens": {"input": 1200, "output": 300, "cacheRead": 900},
            "tools": {"calls": 5, "failures": 1},
            "ttftMs": {"count": 3, "avg": 812, "min": 400, "max": 1200},
            "lineage": [{"protocol": "chat", "model": "glm-5", "turns": 3}],
            "retries": {"attempts": 5, "failedAttempts": 2, "replayedTurns": 1, "details": []},
            "subagents": {"sessions": 2, "turns": 4, "tokens": {"input": 900, "cacheRead": 700}},
            "interventions": {"approvals": 2, "answers": 1, "rejections": 1, "cancels": 0, "inputEdits": 3},
            "rework": {"toolInputErrors": 4},
            "auxiliary": {"usage": {"observations": 9, "tokens": {"input": 1524, "output": 3433}}},
        }));
        assert_eq!(usage.turns, 3);
        assert_eq!(usage.partial_turns, 1);
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.cache_read_tokens, 900);
        assert_eq!(usage.tool_calls, 5);
        assert_eq!(usage.ttft_avg_ms, Some(812));
        assert_eq!(usage.lineage, vec!["glm-5 · chat ×3"]);
        // Retried work is billed work, so the report surfaces it beside tokens.
        assert_eq!(usage.attempts, 5);
        assert_eq!(usage.failed_attempts, 2);
        assert_eq!(usage.replayed_turns, 1);
        // Delegated work bills on its own Session; the parent screen has to say
        // so or the number it shows is not the Session's cost.
        assert_eq!(usage.subagent_sessions, 2);
        assert_eq!(usage.subagent_turns, 4);
        assert_eq!(usage.subagent_input_tokens, 900);
        assert_eq!(usage.subagent_cache_read_tokens, 700);
        // Supervision cost: what a person had to decide, and what the model had
        // to redo without asking.
        assert_eq!(usage.approvals, 2);
        assert_eq!(usage.answers, 1);
        assert_eq!(usage.rejections, 1);
        assert_eq!(usage.input_edits, 3);
        assert_eq!(usage.tool_input_errors, 4);
        // Compaction is an auxiliary role call: real spend the main-model lines
        // do not account for.
        assert_eq!(usage.auxiliary_calls, 9);
        assert_eq!(usage.auxiliary_input_tokens, 1524);
        assert_eq!(usage.auxiliary_output_tokens, 3433);
    }

    #[test]
    fn a_report_without_retries_reads_as_no_retries() {
        let usage = UsageSummary::from_value(&json!({"turns": 1, "retries": null}));
        assert_eq!(usage.attempts, 0);
        assert_eq!(usage.failed_attempts, 0);
        assert_eq!(usage.replayed_turns, 0);
    }

    #[test]
    fn a_session_without_timing_reports_no_ttft_and_zeros() {
        let usage = UsageSummary::from_value(&json!({"turns": 0, "ttftMs": null}));
        assert_eq!(usage.turns, 0);
        assert_eq!(usage.ttft_avg_ms, None);
        assert_eq!(usage.input_tokens, 0);
        assert!(usage.lineage.is_empty());
    }
}
