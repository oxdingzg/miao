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
        }));
        assert_eq!(usage.turns, 3);
        assert_eq!(usage.partial_turns, 1);
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.cache_read_tokens, 900);
        assert_eq!(usage.tool_calls, 5);
        assert_eq!(usage.ttft_avg_ms, Some(812));
        assert_eq!(usage.lineage, vec!["glm-5 · chat ×3"]);
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
