//! Automatic context-management trigger decisions (roadmap §2.13 gate ①).
//!
//! The anchor is the engine's normalized per-turn usage: the last `usage`
//! event's `inputTokens` (inclusive of cache read/write) plus `outputTokens`
//! approximates what the next provider turn re-sends. Tokens are unknown until
//! a provider turn reports them, so an unknown window or missing usage means
//! no trigger; nothing is invented. Gate ②'s provider counting will replace
//! the char estimate for messages that have not been counted yet.

use crate::protocol::{Error, Message};
use crate::store::Store;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::future::Future;

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
/// Effective context limits from the product configuration. `None` keeps
/// automatic compaction off entirely.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLimits {
    /// Effective context window for the provider.
    pub window: u64,
    /// Fraction of the window at which compaction triggers.
    pub ratio: f64,
    /// Explicit token headroom: trim protection + summary output + slack.
    pub headroom: u64,
    /// Summarizer passes carry at most this many selected messages.
    pub per_pass: usize,
    /// Serialized chars one tool-result payload may keep in the outgoing request
    /// before it is elided. Absent leaves tool output whole (pruning off).
    #[serde(default)]
    pub prune_chars: Option<usize>,
    /// Newest user-role messages whose tool output is never elided.
    #[serde(default = "default_protect_turns")]
    pub protect_turns: usize,
}

fn default_protect_turns() -> usize {
    2
}

impl ContextLimits {
    /// Parse the wire form the product spawner passes as
    /// `--context-limits <json>` (camelCase fields).
    pub fn from_wire(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|error| format!("invalid --context-limits: {error}"))
    }

    pub fn budget(&self) -> Budget {
        Budget {
            window: Some(self.window),
            ratio: self.ratio,
            headroom: self.headroom,
        }
    }
}

/// One run's compaction knobs at the checkpoint boundary.
pub struct CompactRequest<'a, P: FnMut(Value)> {
    pub session: &'a str,
    pub run: &'a str,
    /// The settled assistant boundary the checkpoint cuts through.
    pub boundary: u64,
    pub budget: &'a Budget,
    /// Summarizer passes carry at most this many selected messages.
    pub per_pass: usize,
    pub breaker: &'a mut Breaker,
    /// Gate-6 notices flow through this sink.
    pub notify: &'a mut P,
    /// Counts the messages appended since the anchor through the provider's own
    /// endpoint where it has one (gate ②); the runtime binds the session
    /// provider. A refused or unsupported count is not an error.
    pub count: &'a mut (dyn FnMut(
        Vec<Message>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::provider::CountTokens> + Send>,
    > + Send),
}

pub async fn maybe_compact<S, F, P>(
    store: &Store,
    request: CompactRequest<'_, P>,
    mut summarize: S,
) -> Result<bool, Error>
where
    S: FnMut(String) -> F,
    F: Future<Output = Result<String, String>>,
    P: FnMut(Value),
{
    let CompactRequest {
        session,
        run,
        boundary,
        budget,
        per_pass,
        breaker,
        notify,
        count,
    } = request;
    let channel = |kind: &str| json!({"session_id": session, "run_id": run, "kind": kind});
    if !breaker.allows() {
        notify(channel("compaction.skipped"));
        return Ok(false);
    }
    // Gate ①: the anchor is the newest usage report's normalized context plus
    // the message it counted. Only the messages appended after that report are
    // still uncounted, and for those gate ② prefers the provider's own count
    // over the char estimate. No marker means the report predates the anchor,
    // so nothing is invented and the trigger stays off.
    let Some((context, counted_through)) = store.context_anchor(session).await? else {
        return Ok(false);
    };
    let (pending, pending_chars) = store.pending_context(session, counted_through).await?;
    if pending.is_empty() {
        return Ok(false);
    }
    let counted = count(pending).await;
    if !budget.should_compact(
        Some(context),
        resolve_pending_tokens(counted, pending_chars as usize),
    ) {
        return Ok(false);
    }
    // The summary covers the warm prefix the next turn would re-send, which is
    // the selected history rather than the uncounted delta.
    let messages = store.selected_history(session).await?;
    if messages.is_empty() {
        return Ok(false);
    }
    let plan = plan_summary(messages.len(), per_pass);
    notify(json!({
        "session_id": session, "run_id": run,
        "kind": "compaction.started", "segments": plan.segments.len(),
    }));
    let mut parts = Vec::new();
    for (nth, (start, end)) in plan.segments.iter().enumerate() {
        let body = summarizer_body(&messages[*start..*end], SUMMARIZER_MESSAGE_CHARS);
        match summarize(format!(
            "Summarize this portion of the conversation:\n{body}"
        ))
        .await
        {
            Ok(part) => {
                parts.push(part);
                notify(json!({
                    "session_id": session, "run_id": run,
                    "kind": "compaction.progress", "segment": nth + 1, "total": plan.segments.len(),
                }));
            }
            Err(reason) => {
                breaker.rejected();
                notify(json!({
                    "session_id": session, "run_id": run,
                    "kind": "compaction.failed", "reason": reason,
                }));
                return Ok(false);
            }
        }
    }
    let id = format!("cut_{run}");
    match store
        .compact_for_run(
            session,
            run,
            &id,
            boundary,
            checkpoint_summary(store, &parts, session).await,
        )
        .await
    {
        Ok(_) => {
            notify(channel("compaction.finished"));
            Ok(true)
        }
        Err(error) => {
            breaker.rejected();
            notify(json!({
                "session_id": session, "run_id": run,
                "kind": "compaction.failed", "reason": error.to_string(),
            }));
            Ok(false)
        }
    }
}

/// Per-message cap on what one summarizer pass reads from a stored message.
/// Oversized tool outputs are named by their recall handle instead of being
/// paid for twice (the summary pass would re-read what pruning already
/// elided from the outgoing request).
pub const SUMMARIZER_MESSAGE_CHARS: usize = 2_000;

/// `commit_compaction` rejects checkpoints above this size, so the assembly
/// truncates the summarized part rather than failing the whole compaction.
pub const MAX_CHECKPOINT_CHARS: usize = 32_768;

/// The serialized text of one message, bounded for a summarizer pass. Text
/// blocks are capped at a char boundary; oversized tool results are replaced
/// by their recall handle, so nothing is lost that pruning has not already
/// archived.
fn message_excerpt(message: &Message, budget: usize) -> String {
    let blocks = message.content.as_array().into_iter().flatten();
    let mut parts = Vec::new();
    for block in blocks {
        match block["type"].as_str() {
            Some("text") => {
                let text = block["text"].as_str().unwrap_or_default();
                parts.push(bounded(text, budget));
            }
            Some("tool_result") => {
                let content = block["content"].as_str().unwrap_or_default();
                if content.len() <= budget {
                    parts.push(content.to_owned());
                } else {
                    let handle = match block["tool_use_id"].as_str() {
                        Some(id) if id.len() <= 128 && !id.is_empty() => {
                            format!(
                                r#"[tool output archived — recall {{"tool_use_id":"{id}"}} to restore]"#
                            )
                        }
                        _ => "[oversized tool output omitted]".to_owned(),
                    };
                    parts.push(handle);
                }
            }
            _ => {}
        }
    }
    format!("- {}: {}", message.role, parts.join(" "))
}

/// The largest char boundary at or below `budget`, with an explicit marker
/// when anything was cut.
fn bounded(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_owned();
    }
    let mut cut = budget.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…[truncated]", &text[..cut])
}

/// One summarizer pass's input: one bounded line per message.
pub fn summarizer_body(messages: &[Message], per_message_chars: usize) -> String {
    messages
        .iter()
        .map(|message| message_excerpt(message, per_message_chars))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Durable state carried verbatim into every checkpoint, independent of
/// summarizer quality: the active objective and the open tasks. Completed or
/// cancelled tasks are history, not state, and stay out.
pub fn durable_state_block(state: &serde_json::Value) -> String {
    let mut lines = Vec::new();
    let goal = &state["goal"]["value"];
    if goal["objective"].as_str().is_some_and(|o| !o.is_empty()) {
        lines.push(format!(
            "Objective: {} (status: {})",
            goal["objective"].as_str().unwrap_or_default(),
            goal["status"].as_str().unwrap_or("unknown")
        ));
    }
    let todos = state["todos"]["value"]["todos"].as_array();
    let open = todos
        .into_iter()
        .flatten()
        .filter(|todo| {
            todo["status"].as_str() != Some("completed")
                && todo["status"].as_str() != Some("cancelled")
        })
        .filter_map(|todo| todo["content"].as_str())
        .collect::<Vec<_>>();
    if !open.is_empty() {
        lines.push("Open tasks:".to_owned());
        lines.extend(open.iter().map(|task| format!("- [ ] {task}")));
    }
    if lines.is_empty() {
        return String::new();
    }
    format!("## Durable state (carried verbatim)\n{}", lines.join("\n"))
}

/// The checkpoint text: summarized parts plus the durable-state block, within
/// the size `commit_compaction` accepts. The durable block is the part that
/// must never be lost, so overflow truncates the summarized part instead.
pub async fn checkpoint_summary(store: &Store, parts: &[String], session: &str) -> String {
    let mut summary = parts.join("\n\n");
    let durable = store
        .state(session)
        .await
        .map(|state| durable_state_block(&state))
        .unwrap_or_default();
    if durable.is_empty() {
        return bounded_to(&summary, MAX_CHECKPOINT_CHARS);
    }
    let combined = format!("{summary}\n\n{durable}");
    if combined.len() <= MAX_CHECKPOINT_CHARS {
        return combined;
    }
    let keep = MAX_CHECKPOINT_CHARS.saturating_sub(durable.len() + 2);
    summary = bounded_to(&summary, keep);
    format!("{summary}\n\n{durable}")
}

/// The largest char-boundary prefix within `max` chars.
fn bounded_to(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].to_owned()
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

/// The elision mark's text. A model that reads an opaque placeholder as a
/// low-context signal invents a stop reason (observed on the TypeScript path),
/// so the mark states the facts instead of looking like a truncation.
pub const PRUNE_MARK: &str = "\n…[older tool output elided by context management — routine pruning, not a low-context signal; the harness compacts automatically near the window limit, so keep working]…\n";

/// Gate ④: elide oversized tool results from the outgoing request only, never
/// from stored history. The newest `protect_turns` user-role messages (prompts
/// or tool results) keep their output whatever it costs, so the work in flight
/// keeps its data. Returns the elided payload count and the characters dropped.
pub fn prune_history(
    messages: &mut [Message],
    budget: usize,
    protect_turns: usize,
) -> (usize, usize) {
    let mut elided = 0;
    let mut dropped = 0;
    let mut turns = 0;
    for message in messages.iter_mut().rev() {
        if message.role == "user" {
            turns += 1;
        }
        if turns <= protect_turns {
            continue;
        }
        for block in message.content.as_array_mut().into_iter().flatten() {
            if block["type"] != "tool_result" {
                continue;
            }
            let Some(content) = block["content"].as_str() else {
                continue;
            };
            let Prune::Elide {
                keep_head,
                keep_tail,
            } = prune_tool_output(content.len(), budget, false)
            else {
                continue;
            };
            let head = floor_boundary(content, keep_head);
            let tail = content.len() - ceil_boundary_from_end(content, keep_tail);
            // Pruning stays recoverable: the marker names the handle that
            // restores the elided middle, so nothing is silently lost.
            let note = match block["tool_use_id"].as_str() {
                Some(id) if id.len() <= 128 => format!(
                    "[the elided middle is recoverable on demand: recall {{\"tool_use_id\":\"{id}\"}}]\n"
                ),
                _ => String::new(),
            };
            let pruned = format!(
                "{}{}{}{}",
                &content[..head],
                PRUNE_MARK,
                note,
                &content[tail..]
            );
            dropped += content.len() - pruned.len();
            block["content"] = json!(pruned);
            elided += 1;
        }
    }
    (elided, dropped)
}

/// The largest char boundary at or below `index`.
fn floor_boundary(text: &str, index: usize) -> usize {
    let mut cut = index.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// The smallest char boundary at or above `len - index`.
fn ceil_boundary_from_end(text: &str, index: usize) -> usize {
    let mut cut = index.min(text.len());
    while !text.is_char_boundary(text.len() - cut) {
        cut -= 1;
    }
    cut
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
    /// The highest committed message seq, recorded inside each usage event so a
    /// later turn knows exactly which messages that report already counted.
    pub async fn max_message_seq(&self, session: &str) -> Result<u64, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            Ok(conn.query_row(
                "SELECT COALESCE(MAX(seq),0) FROM engine_message WHERE session_id=?1",
                [&session],
                |row| row.get(0),
            )?)
        })
        .await
    }

    /// The gate-① anchor: the newest usage event's normalized context tokens
    /// plus the highest message seq that report counted. An event without the
    /// marker predates the anchor, so it reports `None` rather than inventing
    /// one; the trigger stays off until a later turn reports a marked usage.
    pub async fn context_anchor(&self, session: &str) -> Result<Option<(u64, u64)>, Error> {
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
            let event = serde_json::from_str::<Value>(&data)?;
            let Some(through) = event["context_message_seq"].as_u64() else {
                return Ok(None);
            };
            let usage = &event["usage"];
            let input = usage["inputTokens"].as_u64().unwrap_or(0);
            let output = usage["outputTokens"].as_u64().unwrap_or(0);
            Ok(Some((input.saturating_add(output), through)))
        })
        .await
    }

    /// The messages committed after the anchor's count, plus their serialized
    /// chars: exactly the delta the provider still has to count.
    pub async fn pending_context(
        &self,
        session: &str,
        counted_through: u64,
    ) -> Result<(Vec<Message>, u64), Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT role,content,recorded_at_ms FROM engine_message WHERE session_id=?1 AND seq>?2 AND reverted=0 ORDER BY seq",
            )?;
            let mut rows = stmt.query(rusqlite::params![session, counted_through])?;
            let mut chars = 0usize;
            let mut messages = Vec::new();
            while let Some(row) = rows.next()? {
                let content: String = row.get(1)?;
                chars += content.len();
                messages.push(Message {
                    role: row.get(0)?,
                    content: serde_json::from_str(&content)?,
                    checkpoint: None,
                    recorded_at_ms: row.get(2)?,
                });
            }
            Ok((messages, chars as u64))
        })
        .await
    }

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
    fn prune_elides_oversized_tool_output_and_protects_recent_turns() {
        let mut messages = vec![
            Message {
                role: "user".into(),
                content: json!([{"type":"tool_result","content":"x".repeat(4000)}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
            Message {
                role: "assistant".into(),
                content: json!([{"type":"text","text":"ok"}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
            Message {
                role: "user".into(),
                content: json!([{"type":"tool_result","content":"y".repeat(4000)}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
        ];
        // The newest user message keeps its output; the older one is elided.
        let (elided, dropped) = prune_history(&mut messages, 1000, 1);
        assert_eq!(elided, 1);
        assert!(dropped > 0);
        let kept = messages[2].content[0]["content"].as_str().unwrap();
        assert_eq!(kept.len(), 4000);
        let pruned = messages[0].content[0]["content"].as_str().unwrap();
        assert!(pruned.contains("elided by context management"), "{pruned}");
        assert!(pruned.len() < 4000);

        // Within budget nothing is touched, and protecting every turn is a no-op.
        let mut small = vec![Message {
            role: "user".into(),
            content: json!([{"type":"tool_result","content":"z".repeat(50)}]),
            checkpoint: None,
            recorded_at_ms: None,
        }];
        assert_eq!(prune_history(&mut small, 1000, 0), (0, 0));
        assert_eq!(prune_history(&mut messages, 1000, 3), (0, 0));
    }

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
    fn wire_form_parses_camel_case_and_rejects_garbage() {
        let limits = ContextLimits::from_wire(
            r#"{"window":200000,"ratio":0.85,"headroom":20000,"perPass":50}"#,
        )
        .unwrap();
        assert_eq!(limits.window, 200_000);
        assert_eq!((limits.ratio * 100.0) as u64, 85);
        assert_eq!(limits.headroom, 20_000);
        assert_eq!(limits.per_pass, 50);
        assert!(ContextLimits::from_wire(r#"{"ratio":0.5}"#).is_err());
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

    #[test]
    fn summarizer_body_bounds_messages_and_names_archived_outputs() {
        let messages = vec![
            Message {
                role: "user".into(),
                content: json!([{"type": "text", "text": "x".repeat(150)}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
            Message {
                role: "user".into(),
                content: json!([{"type": "tool_result", "tool_use_id": "call_big", "content": "y".repeat(10_000)}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
        ];
        let body = summarizer_body(&messages, 100);
        assert!(body.contains("- user:"), "{body}");
        assert!(body.contains("…[truncated]"), "{body}");
        assert!(
            body.contains(r#"recall {"tool_use_id":"call_big"} to restore"#),
            "{body}"
        );
        // The archived payload's body never reaches the summarizer.
        assert!(body.len() < 1_000, "{body}");
    }

    #[test]
    fn durable_state_block_carries_goal_and_open_tasks_verbatim() {
        let state = json!({
            "goal": {"value": {"objective": "land the fix", "status": "active"}},
            "todos": {"value": {"todos": [
                {"content": "write test", "status": "pending", "priority": "high"},
                {"content": "done item", "status": "completed", "priority": "low"},
                {"content": "dropped item", "status": "cancelled", "priority": "low"}
            ]}}
        });
        let block = durable_state_block(&state);
        assert!(
            block.contains("Objective: land the fix (status: active)"),
            "{block}"
        );
        assert!(block.contains("- [ ] write test"), "{block}");
        assert!(!block.contains("done item"), "{block}");
        assert!(!block.contains("dropped item"), "{block}");

        // No durable state, no block: explicit compact keeps its plain summary.
        assert_eq!(durable_state_block(&json!({})), "");
    }

    #[tokio::test]
    async fn checkpoint_summary_keeps_the_durable_block_within_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        store
            .admit(crate::protocol::Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "task".into(),
                delivery: crate::protocol::Delivery::Steer,
            })
            .await
            .unwrap();
        store
            .update_state(
                "s",
                "op-goal",
                crate::state::Mutation {
                    kind: "goal",
                    value: json!({"objective": "finish", "status": "active"}),
                    expected: None,
                },
            )
            .await
            .unwrap();
        let huge = vec!["z".repeat(MAX_CHECKPOINT_CHARS); 2];
        let summary = checkpoint_summary(&store, &huge, "s").await;
        assert!(summary.len() <= MAX_CHECKPOINT_CHARS, "{}", summary.len());
        assert!(
            summary.ends_with("finish (status: active)") || summary.contains("Objective: finish"),
            "{summary}"
        );
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
