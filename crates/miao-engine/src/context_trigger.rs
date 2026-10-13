//! Automatic context-management trigger decisions (roadmap §2.13 gate ①).
//!
//! The anchor is the engine's normalized per-turn usage: the last `usage`
//! event's `inputTokens` (inclusive of cache read/write) plus `outputTokens`
//! approximates what the next provider turn re-sends. Tokens are unknown until
//! a provider turn reports them, so an unknown window or missing usage means
//! no trigger; nothing is invented. Gate ②'s provider counting will replace
//! the char estimate for messages that have not been counted yet.

use crate::protocol::Error;
use crate::store::Store;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::future::Future;
use tokio::sync::mpsc;

/// Explicit trigger configuration from the product layer.
#[derive(Debug, Clone)]
pub struct Budget {
    /// Effective context window for the provider. Unknown keeps the trigger off.
    pub window: Option<u64>,
    /// Fraction of the window at which compaction triggers.
    pub ratio: f64,
    /// Explicit token headroom: trim protection + summary output + slack.
    pub headroom: u64,
}

impl Budget {
    /// The later of the explicit headroom and the configured window ratio. An
    /// unknown window degrades to the explicit headroom alone.
    pub fn threshold(&self) -> u64 {
        let ratio_bound = self
            .window
            .map(|window| (window as f64 * self.ratio) as u64);
        match ratio_bound {
            Some(bound) => bound.max(self.headroom),
            None => self.headroom,
        }
    }

    /// Whether the anchored context plus not-yet-counted messages crosses the
    /// threshold. An unknown window never triggers.
    pub fn should_compact(&self, context_tokens: Option<u64>, pending_tokens: u64) -> bool {
        match context_tokens {
            Some(context_tokens) if self.window.is_some() => {
                context_tokens.saturating_add(pending_tokens) >= self.threshold()
            }
            _ => false,
        }
    }
}

/// Conservative char-based estimate for messages a provider has not counted
/// yet. Deliberately coarse (≈3 chars/token, rounded up) so the trigger errs
/// toward compacting; gate ② replaces it with the provider's own count.
pub fn estimate_tokens(chars: usize) -> u64 {
    (chars as u64).div_ceil(3)
}

/// Runtime wiring for automatic compaction (gates 1-6). Call at a run-owned
/// checkpoint boundary: a settled provider turn with no unsettled tools.
/// Summarization is injected so tests can stub it and the runtime can bind
/// the session's provider later. Every rejection feeds the breaker (gate 5);
/// a tripped breaker or a below-threshold context (gate 1) leaves the session
/// untouched. Gate 6 progress flows on the run's progress channel between the
/// transactional pre_compact and post_compact events the store already emits.
/// Returns whether a checkpoint was committed.
/// One run's compaction knobs at the checkpoint boundary.
pub struct CompactRequest<'a> {
    pub session: &'a str,
    pub run: &'a str,
    /// The settled assistant boundary the checkpoint cuts through.
    pub boundary: u64,
    pub budget: &'a Budget,
    /// Summarizer passes carry at most this many selected messages.
    pub per_pass: usize,
    pub breaker: &'a mut Breaker,
    /// The run's progress channel; gate-6 notices flow here.
    pub progress: &'a mpsc::Sender<Value>,
}

pub async fn maybe_compact<S, F>(
    store: &Store,
    request: CompactRequest<'_>,
    mut summarize: S,
) -> Result<bool, Error>
where
    S: FnMut(String) -> F,
    F: Future<Output = Result<String, String>>,
{
    let CompactRequest {
        session,
        run,
        boundary,
        budget,
        per_pass,
        breaker,
        progress,
    } = request;
    let channel = |kind: &str| json!({"session_id": session, "run_id": run, "kind": kind});
    if !breaker.allows() {
        let _ = progress.send(channel("compaction.skipped")).await;
        return Ok(false);
    }
    let context = store.last_context_tokens(session).await?;
    let messages = store.selected_history(session).await?;
    let chars: usize = messages
        .iter()
        .map(|message| message.content.to_string().len())
        .sum();
    if !budget.should_compact(context, estimate_tokens(chars)) {
        return Ok(false);
    }
    let plan = plan_summary(messages.len(), per_pass);
    let _ = progress
        .send(json!({
            "session_id": session, "run_id": run,
            "kind": "compaction.started", "segments": plan.segments.len(),
        }))
        .await;
    let mut parts = Vec::new();
    for (nth, (start, end)) in plan.segments.iter().enumerate() {
        let body = messages[*start..*end]
            .iter()
            .map(|message| format!("- {}: {}", message.role, message.content))
            .collect::<Vec<_>>()
            .join("\n");
        match summarize(format!(
            "Summarize this portion of the conversation:\n{body}"
        ))
        .await
        {
            Ok(part) => {
                parts.push(part);
                let _ = progress
                    .send(json!({
                        "session_id": session, "run_id": run,
                        "kind": "compaction.progress", "segment": nth + 1, "total": plan.segments.len(),
                    }))
                    .await;
            }
            Err(reason) => {
                breaker.rejected();
                let _ = progress
                    .send(json!({
                        "session_id": session, "run_id": run,
                        "kind": "compaction.failed", "reason": reason,
                    }))
                    .await;
                return Ok(false);
            }
        }
    }
    let id = format!("cut_{run}");
    match store
        .compact_for_run(session, run, &id, boundary, parts.join("\n\n"))
        .await
    {
        Ok(_) => {
            let _ = progress.send(channel("compaction.finished")).await;
            Ok(true)
        }
        Err(error) => {
            breaker.rejected();
            let _ = progress
                .send(json!({
                    "session_id": session, "run_id": run,
                    "kind": "compaction.failed", "reason": error.to_string(),
                }))
                .await;
            Ok(false)
        }
    }
}

/// Gate 5: the compaction circuit breaker. After `threshold` consecutive
/// rejected attempts the breaker trips and the trigger stays off until an
/// explicit `compact` resets it, so a persistently failing summarizer cannot
/// spin the engine. An operator's explicit compact is also the reset.
#[derive(Debug, Clone)]
pub struct Breaker {
    threshold: u8,
    failures: u8,
}

impl Breaker {
    pub fn new(threshold: u8) -> Self {
        Self {
            threshold,
            failures: 0,
        }
    }

    /// A rejected compaction attempt. Reaching the threshold trips the breaker.
    pub fn rejected(&mut self) {
        if self.failures < u8::MAX {
            self.failures = self.failures.saturating_add(1);
        }
    }

    /// An explicit operator compact clears the failure streak and closes the
    /// breaker.
    pub fn reset(&mut self) {
        self.failures = 0;
    }

    /// Whether compaction may be attempted.
    pub fn allows(&self) -> bool {
        self.failures < self.threshold
    }
}

/// Gate 4: one tool output's pruning decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prune {
    /// The output stays whole.
    Keep,
    /// The output is replaced by a bounded head and tail with an elision mark.
    Elide { keep_head: usize, keep_tail: usize },
}

/// Gate ④: prune oversized tool outputs from the context selection. Outputs
/// within `budget` chars stay whole; anything larger keeps a head/tail
/// reserve plus an explicit elision mark, so a model can still see the
/// shape of what it received. Recent outputs (the newest `protect` tool
/// messages, which the turn is most likely acting on) are never pruned
/// regardless of size.
pub fn prune_tool_output(output_len: usize, budget: usize, is_recent: bool) -> Prune {
    if is_recent || output_len <= budget {
        return Prune::Keep;
    }
    // Half of the budget for the head, a quarter for the tail, and the rest
    // for the elision mark and framing, bounded so tiny budgets still keep
    // something recognizable on both ends.
    let keep_head = (budget / 2).max(64);
    let keep_tail = (budget / 4).max(32);
    Prune::Elide {
        keep_head,
        keep_tail,
    }
}

/// Gate ③: how a hot prefix is summarized. One pass while the prefix fits
/// the summarizer's budget; consecutive segments only when it cannot. Ranges
/// are half-open `[start, end)` message offsets, so a caller replays them
/// directly against the selected history and the checkpoint contract stays
/// the single-shot one: every segment lands in the same checkpoint summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryPlan {
    /// `single` never splits; `segmented` only when the prefix cannot fit.
    pub mode: &'static str,
    /// Consecutive half-open message ranges, in order.
    pub segments: Vec<(usize, usize)>,
}

/// Partition `prefix` messages into summarizer passes of at most `per_pass`
/// messages. A non-positive budget means "cannot summarize"; the plan stays
/// empty rather than guessing.
pub fn plan_summary(prefix: usize, per_pass: usize) -> SummaryPlan {
    if per_pass == 0 {
        return SummaryPlan {
            mode: "segmented",
            segments: Vec::new(),
        };
    }
    if prefix <= per_pass {
        return SummaryPlan {
            mode: "single",
            segments: vec![(0, prefix)],
        };
    }
    let mut segments = Vec::new();
    let mut start = 0;
    while start < prefix {
        let end = (start + per_pass).min(prefix);
        segments.push((start, end));
        start = end;
    }
    SummaryPlan {
        mode: "segmented",
        segments,
    }
}

/// Gate ②: the provider's own count wins; absence or refusal falls back to
/// the estimate. A counting failure never fails the turn — this function
/// cannot fail by construction.
pub fn resolve_pending_tokens(counted: crate::provider::CountTokens, chars: usize) -> u64 {
    match counted {
        crate::provider::CountTokens::Counted(tokens) => tokens,
        _ => estimate_tokens(chars),
    }
}

impl Store {
    /// Normalized context anchor from the newest `usage` event, or `None`
    /// before the first provider turn.
    pub async fn last_context_tokens(&self, session: &str) -> Result<Option<u64>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let data: Option<String> = conn
                .query_row(
                    "SELECT data FROM engine_event WHERE session_id=?1 AND kind='usage' ORDER BY seq DESC LIMIT 1",
                    [&session],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(data) = data else { return Ok(None) };
            let usage = serde_json::from_str::<serde_json::Value>(&data)?;
            let usage = &usage["usage"];
            let input = usage["inputTokens"].as_u64().unwrap_or(0);
            let output = usage["outputTokens"].as_u64().unwrap_or(0);
            Ok(Some(input.saturating_add(output)))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn threshold_prefers_the_later_bound() {
        let budget = Budget {
            window: Some(100_000),
            ratio: 0.8,
            headroom: 90_000,
        };
        assert_eq!(budget.threshold(), 90_000);
        let budget = Budget {
            window: Some(100_000),
            ratio: 0.8,
            headroom: 50_000,
        };
        assert_eq!(budget.threshold(), 80_000);
        let budget = Budget {
            window: None,
            ratio: 0.8,
            headroom: 50_000,
        };
        assert_eq!(budget.threshold(), 50_000);
    }

    #[test]
    fn unknown_window_or_usage_never_triggers() {
        let budget = Budget {
            window: None,
            ratio: 0.8,
            headroom: 1,
        };
        assert!(!budget.should_compact(Some(1_000_000), 0));
        assert!(!budget.should_compact(None, 0));
        let budget = Budget {
            window: Some(1_000),
            ratio: 0.8,
            headroom: 100,
        };
        assert!(!budget.should_compact(Some(700), 50));
        assert!(budget.should_compact(Some(700), 100));
    }

    #[test]
    fn summary_plans_stay_single_until_the_prefix_cannot_fit() {
        assert_eq!(
            plan_summary(4, 8),
            SummaryPlan {
                mode: "single",
                segments: vec![(0, 4)]
            }
        );
        assert_eq!(
            plan_summary(8, 8),
            SummaryPlan {
                mode: "single",
                segments: vec![(0, 8)]
            }
        );
        assert_eq!(
            plan_summary(9, 4),
            SummaryPlan {
                mode: "segmented",
                segments: vec![(0, 4), (4, 8), (8, 9)]
            }
        );
        assert_eq!(
            plan_summary(0, 4),
            SummaryPlan {
                mode: "single",
                segments: vec![(0, 0)]
            }
        );
        assert_eq!(
            plan_summary(9, 0),
            SummaryPlan {
                mode: "segmented",
                segments: vec![]
            }
        );
    }

    #[test]
    fn breaker_trips_after_the_threshold_and_resets_explicitly() {
        let mut breaker = Breaker::new(3);
        assert!(breaker.allows());
        breaker.rejected();
        breaker.rejected();
        assert!(breaker.allows());
        breaker.rejected();
        assert!(!breaker.allows());
        breaker.rejected();
        assert!(!breaker.allows());
        breaker.reset();
        assert!(breaker.allows());
    }

    #[test]
    fn tool_output_pruning_protects_recent_and_bounds_old() {
        assert_eq!(prune_tool_output(100, 200, true), Prune::Keep);
        assert_eq!(prune_tool_output(100, 200, false), Prune::Keep);
        assert_eq!(
            prune_tool_output(100_000, 4_000, false),
            Prune::Elide {
                keep_head: 2_000,
                keep_tail: 1_000
            }
        );
        // Tiny budgets keep the recognizable minimum on both ends.
        assert_eq!(
            prune_tool_output(1_000, 10, false),
            Prune::Elide {
                keep_head: 64,
                keep_tail: 32
            }
        );
    }

    #[test]
    fn provider_count_wins_and_every_other_outcome_falls_back() {
        use crate::provider::CountTokens;
        assert_eq!(
            resolve_pending_tokens(CountTokens::Counted(4321), 9_000),
            4321
        );
        assert_eq!(
            resolve_pending_tokens(CountTokens::Unsupported, 9_000),
            estimate_tokens(9_000)
        );
        assert_eq!(
            resolve_pending_tokens(
                CountTokens::Failed("count refused: 429 Too Many Requests".into()),
                3
            ),
            1
        );
    }

    #[test]
    fn char_estimate_rounds_up() {
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(1), 1);
        assert_eq!(estimate_tokens(6), 2);
    }

    #[tokio::test]
    async fn anchor_reads_the_newest_usage_event() {
        use crate::protocol::{Delivery, Input};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        assert_eq!(store.last_context_tokens("s").await.unwrap(), None);
        store
            .admit(Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "old task".into(),
                delivery: Delivery::Steer,
            })
            .await
            .unwrap();
        store.promote("s", true).await.unwrap();
        store
            .record(
                "s",
                "usage",
                json!({"run_id":"run","step":0,"usage":{"inputTokens":900,"outputTokens":100}}),
            )
            .await
            .unwrap();
        store
            .record(
                "s",
                "usage",
                json!({"run_id":"run","step":1,"usage":{"inputTokens":1_500,"outputTokens":50}}),
            )
            .await
            .unwrap();
        store
            .record("s", "run.started", json!({"run_id":"run"}))
            .await
            .unwrap();
        assert_eq!(store.last_context_tokens("s").await.unwrap(), Some(1_550));
        let budget = Budget {
            window: Some(2_000),
            ratio: 0.8,
            headroom: 0,
        };
        assert!(budget.should_compact(
            store.last_context_tokens("s").await.unwrap(),
            estimate_tokens(1_000)
        ));
    }
}
