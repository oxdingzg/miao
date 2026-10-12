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
