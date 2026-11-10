//! Billed usage and latency for one Session, projected from the engine's
//! `usage` report. Only the fields the status dialog shows are read; a report
//! that grows stays readable.

use serde_json::Value;

/// Token counts as the TypeScript sidebar writes them: `1.4k`, `1.4m`. Raw
/// digits stop being readable at a glance once a Session passes a few thousand.
pub fn compact_tokens(tokens: u64) -> String {
    match tokens {
        0..=999 => tokens.to_string(),
        1_000..=999_999 => format!("{:.1}k", tokens as f64 / 1_000.0),
        _ => format!("{:.1}m", tokens as f64 / 1_000_000.0),
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HourlyBucket {
    pub start_ms: u64,
    pub tokens: u64,
    pub turns: u64,
    pub cost_usd: f64,
}

/// One model's share of the window: the row under the strip that says which
/// model the spend belonged to. Rows are grouped by the route that priced the
/// turns, so `provider` names that route; `None` means the events predate
/// attribution or a custom provider never reported one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HourlyModel {
    pub provider: Option<String>,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub turns: u64,
    pub cost_usd: f64,
}

impl HourlyModel {
    fn from_value(value: &Value) -> Self {
        let number = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        Self {
            provider: value
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: value
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            input: number("input"),
            output: number("output"),
            cache_read: number("cache_read"),
            turns: number("turns"),
            cost_usd: number("cost_micros") as f64 / 1_000_000.0,
        }
    }
    /// The cached share of this model's prompt tokens, as the engine reports
    /// the same ratio for the window's totals: prompt is the denominator.
    pub fn cache_hit(&self) -> Option<f64> {
        (self.input > 0).then(|| (self.cache_read.min(self.input) as f64) / self.input as f64)
    }
}

/// Billed usage per whole hour for the trailing window the engine answered.
///
/// `cost_turns` says how many turns carried a money figure — the gateway's own
/// charge when it billed the turn, otherwise our rate applied to the reported
/// tokens — so a strip cannot present a handful of priced turns as the price of
/// the whole day.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HourlyUsage {
    pub buckets: Vec<HourlyBucket>,
    /// Per-model rollup over the window, busiest first. Rows without a served
    /// name stay only in the totals: attributing them to a name would invent
    /// one.
    pub models: Vec<HourlyModel>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub turns: u64,
    pub tokens: u64,
    pub cost_usd: f64,
    pub cost_turns: u64,
    /// The busiest hour: when it started, and the tokens it carried.
    pub peak: Option<(u64, u64)>,
    /// Retention removed events inside the window, so the strip is a lower
    /// bound rather than the whole story.
    pub truncated: bool,
    /// The cached share of the day's prompt tokens, as the engine computed it
    /// from prompt totals that already include the cache axes. `None` means the
    /// engine published no figure, which is not the same as a cold cache.
    pub cache_hit_ratio: Option<f64>,
}

impl HourlyUsage {
    pub fn from_value(value: &Value) -> Self {
        let number = |value: Option<&Value>| value.and_then(Value::as_u64).unwrap_or(0);
        let totals = value.get("totals");
        Self {
            buckets: value
                .get("buckets")
                .and_then(Value::as_array)
                .map(|buckets| {
                    buckets
                        .iter()
                        .map(|bucket| HourlyBucket {
                            start_ms: number(bucket.get("start_ms")),
                            tokens: number(bucket.get("tokens")),
                            turns: number(bucket.get("turns")),
                            cost_usd: number(bucket.get("cost_micros")) as f64 / 1_000_000.0,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            models: value
                .get("models")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().map(HourlyModel::from_value).collect())
                .unwrap_or_default(),
            input: number(totals.and_then(|totals| totals.get("input"))),
            output: number(totals.and_then(|totals| totals.get("output"))),
            cache_read: number(totals.and_then(|totals| totals.get("cache_read"))),
            turns: number(totals.and_then(|totals| totals.get("turns"))),
            tokens: number(totals.and_then(|totals| totals.get("tokens"))),
            cost_usd: number(totals.and_then(|totals| totals.get("cost_micros"))) as f64
                / 1_000_000.0,
            cost_turns: number(totals.and_then(|totals| totals.get("cost_turns"))),
            cache_hit_ratio: totals
                .and_then(|totals| totals.get("cache_hit_ratio"))
                .and_then(Value::as_f64),
            peak: value
                .get("peak")
                .map(|peak| (number(peak.get("start_ms")), number(peak.get("tokens")))),
            truncated: value
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }

    /// The share of billed input that came from cache. The one number a
    /// reader can act on: it is what makes the same work cheap or expensive.
    /// The engine owns the arithmetic — `input` already counts the cache axes,
    /// so a second formula here is how the strip came to report a 97% hit as
    /// 49% and nag every Session to compact.
    pub fn cache_hit(&self) -> Option<f64> {
        self.cache_hit_ratio
    }
}

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
    /// The most recent turns with their own timings. COST-04 asks for the phase
    /// timings of each turn in one reviewable place; an average hides the turn
    /// that was slow.
    pub turn_timings: Vec<TurnTiming>,
    /// Child Sessions this Session delegated to. A subagent bills on its own
    /// Session, so without this line its cost is missing from the only screen
    /// that shows cost.
    pub subagent_sessions: u64,
    pub subagent_turns: u64,
    pub subagent_input_tokens: u64,
    pub subagent_cache_read_tokens: u64,
    /// Attempts the child Sessions made, retries included: a child that spent
    /// three attempts where the parent spent one was billed for three.
    pub subagent_attempts: u64,
    pub subagent_replayed_turns: u64,
    /// Hooks are shell processes the Session waited on: their wall time is part
    /// of what the task cost, and a hook that failed is a fact worth seeing.
    pub hook_calls: u64,
    pub hook_failed: u64,
    pub hook_ms: u64,
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
    /// The context window the last provider turn planned against, and the
    /// occupancy it planned for. `None` means the engine never reported a
    /// window (no turn yet, or a model with no known capacity), which reads
    /// differently from an empty context.
    pub context_window: Option<u64>,
    pub context_tokens: Option<u64>,
}

/// One settled turn's timing, as the engine recorded it beside the receipt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnTiming {
    pub step: u64,
    pub model: Option<String>,
    pub turn_ms: Option<u64>,
    pub ttft_ms: Option<u64>,
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
            turn_timings: value
                .get("providerDetail")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| {
                            let turn_ms = row.get("turnMs").and_then(Value::as_u64);
                            let ttft_ms = row.get("ttftMs").and_then(Value::as_u64);
                            // A turn the engine never timed teaches nothing.
                            if turn_ms.is_none() && ttft_ms.is_none() {
                                return None;
                            }
                            Some(TurnTiming {
                                step: row.get("step").and_then(Value::as_u64).unwrap_or(0),
                                model: row.get("model").and_then(Value::as_str).map(str::to_string),
                                turn_ms,
                                ttft_ms,
                            })
                        })
                        // The report lists oldest first; the view wants the most
                        // recent turns, and a long Session must not cost a frame.
                        .rev()
                        .take(5)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect()
                })
                .unwrap_or_default(),
            subagent_sessions: u64_at(value, &["subagents", "sessions"]).unwrap_or(0),
            subagent_turns: u64_at(value, &["subagents", "turns"]).unwrap_or(0),
            subagent_input_tokens: u64_at(value, &["subagents", "tokens", "input"]).unwrap_or(0),
            subagent_cache_read_tokens: u64_at(value, &["subagents", "tokens", "cacheRead"])
                .unwrap_or(0),
            subagent_attempts: u64_at(value, &["subagents", "attempts"]).unwrap_or(0),
            subagent_replayed_turns: u64_at(value, &["subagents", "replayedTurns"]).unwrap_or(0),
            hook_calls: u64_at(value, &["hooks", "calls"]).unwrap_or(0),
            hook_failed: u64_at(value, &["hooks", "failed"]).unwrap_or(0),
            hook_ms: u64_at(value, &["hooks", "timeMs"]).unwrap_or(0),
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
            context_window: value
                .get("context")
                .and_then(|context| context.get("window"))
                .and_then(Value::as_u64),
            context_tokens: value
                .get("context")
                .and_then(|context| context.get("tokens"))
                .and_then(Value::as_u64),
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

    /// The strip formats the engine's figure and never derives its own: the
    /// prompt total already counts the cache axes, so dividing by `input` plus
    /// the cache read read a fully cached day as 50% and nagged every Session.
    #[test]
    fn the_hourly_hit_share_is_the_engine_figure_not_a_local_guess() {
        let usage = HourlyUsage::from_value(&json!({
            "totals": {
                "input": 284_900_000,
                "output": 269_900,
                "cache_read": 276_500_000,
                "cache_hit_ratio": 0.97
            }
        }));
        assert_eq!(usage.cache_hit(), Some(0.97));
        // An engine that published no figure leaves the strip unknown: a cold
        // cache and an unreported one must not render the same.
        assert_eq!(
            HourlyUsage::from_value(&json!({"totals": {}})).cache_hit(),
            None
        );
    }

    /// The window rollup keeps the served names and their shares, busiest
    /// first as the engine ordered them, each under the route that priced it;
    /// a report without the array reads as an older engine whose strip still
    /// renders from the totals.
    #[test]
    fn the_hourly_report_carries_per_model_rows() {
        let usage = HourlyUsage::from_value(&json!({
            "buckets": [],
            "models": [
                {"provider": "zhipuai-coding-plan", "model": "glm-5", "input": 1200, "output": 300, "cache_read": 900, "turns": 3, "cost_micros": 2025},
                {"model": "claude-opus", "input": 500, "output": 100, "cache_read": 0, "turns": 1},
            ],
            "totals": {"input": 1700, "output": 400}
        }));
        assert_eq!(usage.models.len(), 2);
        assert_eq!(
            usage.models[0].provider.as_deref(),
            Some("zhipuai-coding-plan")
        );
        assert_eq!(usage.models[0].model, "glm-5");
        assert_eq!(usage.models[0].input, 1200);
        assert_eq!(usage.models[0].cost_usd, 0.002_025);
        // Per-model cache share divides the model's own prompt, the way the
        // engine computes the window's total ratio.
        assert_eq!(usage.models[0].cache_hit(), Some(0.75));
        assert_eq!(usage.models[1].cache_hit(), Some(0.0));
        // A row the engine never attributed to a route stays provider-less.
        assert_eq!(usage.models[1].provider, None);
        assert!(HourlyUsage::from_value(&json!({"totals": {}}))
            .models
            .is_empty());
    }

    /// The last provider turn's window and occupancy ride the report so the
    /// sidebar can show how full the Session's context is. A report without
    /// them stays `None`: no known capacity is not a full one.
    #[test]
    fn the_report_carries_the_last_turns_context_window() {
        let usage = UsageSummary::from_value(&json!({
            "turns": 1,
            "context": {"window": 1_048_576, "tokens": 630_000}
        }));
        assert_eq!(usage.context_window, Some(1_048_576));
        assert_eq!(usage.context_tokens, Some(630_000));
        let bare = UsageSummary::from_value(&json!({"turns": 1}));
        assert_eq!(bare.context_window, None);
        assert_eq!(bare.context_tokens, None);
    }

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
            "subagents": {
                "sessions": 2,
                "turns": 4,
                "attempts": 6,
                "failedAttempts": 1,
                "replayedTurns": 2,
                "tokens": {"input": 900, "cacheRead": 700}
            },
            "hooks": {"calls": 3, "failed": 1, "timeMs": 1550},
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
        // A child's retried attempts are billed work of its own.
        assert_eq!(usage.subagent_attempts, 6);
        assert_eq!(usage.subagent_replayed_turns, 2);
        // A hook the Session waited on costs it time, and a failed one is kept.
        assert_eq!(usage.hook_calls, 3);
        assert_eq!(usage.hook_failed, 1);
        assert_eq!(usage.hook_ms, 1550);
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
    fn each_recent_turn_keeps_its_own_timings() {
        // An average cannot say which turn was slow, so the view needs the
        // turns themselves: newest five, timing-less rows dropped.
        let rows = (1..=8)
            .map(|step| {
                json!({"step": step, "model": "glm-5", "turnMs": step * 1000, "ttftMs": step * 100})
            })
            .chain(std::iter::once(json!({"step": 9, "model": "glm-5"})))
            .collect::<Vec<_>>();
        let usage = UsageSummary::from_value(&json!({"turns": 8, "providerDetail": rows}));
        assert_eq!(usage.turn_timings.len(), 5, "{:?}", usage.turn_timings);
        // The newest five, still oldest-first so the list reads as a timeline.
        assert_eq!(
            usage
                .turn_timings
                .iter()
                .map(|timing| timing.step)
                .collect::<Vec<_>>(),
            vec![4, 5, 6, 7, 8]
        );
        assert_eq!(usage.turn_timings[4].turn_ms, Some(8000));
        assert_eq!(usage.turn_timings[4].ttft_ms, Some(800));
        assert_eq!(usage.turn_timings[4].model.as_deref(), Some("glm-5"));
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
