//! Canonical provider usage.
//!
//! Both engines report the same numbers, so a reader of the product layer sees
//! the vocabulary it already documents: inclusive `inputTokens`/`outputTokens`,
//! a non-overlapping `nonCachedInputTokens` + `cacheReadInputTokens` +
//! `cacheWriteInputTokens` breakdown, and `reasoningTokens` as a subset of
//! `outputTokens`. Each protocol computes whichever side it does not receive
//! natively, clamped at zero against provider bugs.
//!
//! The provider's raw payload is kept as `providerMetadata`: audit-only, and
//! deliberately excluded from run aggregation so normalized numbers are not
//! counted twice alongside their raw counterparts.

use serde_json::{json, Map, Value};

/// Audit-only raw provider payload; usage aggregation never sums into it.
pub const PROVIDER_METADATA: &str = "providerMetadata";

/// The money a gateway reported for the turn, in the ledger's `cost` shape.
pub const BILLING: &str = "billing";

/// Read the money a provider reported for one turn out of its raw usage object.
///
/// OpenCode's gateway answers `usage.cost` in US dollars beside an `opencode`
/// object that names the list price, which source paid (`go`, `go-plus`,
/// `balance`, `byok`, `free`), whether the figure is an estimate at list price,
/// and, on a Go plan, the allowance the request consumed. Only what the
/// provider said is kept: a figure it did not report stays absent rather than
/// becoming a zero that reads as free, and nothing here is computed from our
/// own rates.
pub fn billing(raw: &Value) -> Option<Value> {
    let amount = money(raw.get("cost"))?;
    let detail = raw.get("opencode");
    let field = |key: &str| detail.and_then(|detail| detail.get(key));
    let mut billing = Map::new();
    billing.insert("amount".into(), json!(amount));
    billing.insert("currency".into(), json!("USD"));
    if let Some(source) = field("billing_source").and_then(Value::as_str) {
        billing.insert("source".into(), json!(source));
    }
    if let Some(list) = money(field("list_cost")) {
        billing.insert("list".into(), json!(list));
    }
    if field("estimated").and_then(Value::as_bool) == Some(true) {
        billing.insert("estimated".into(), json!(true));
    }
    if let Some(allowance) = money(field("allowance")) {
        billing.insert("allowance".into(), json!(allowance));
    }
    Some(Value::Object(billing))
}

/// A money figure is finite and not negative. A quad or a negative amount is a
/// provider bug, and a zero is still a real answer ("this turn was free").
fn money(value: Option<&Value>) -> Option<f64> {
    let amount = value?.as_f64()?;
    (amount.is_finite() && amount >= 0.0).then_some(amount)
}

const AXES: [(&str, &str); 6] = [
    ("inputTokens", "input"),
    ("outputTokens", "output"),
    ("cacheReadInputTokens", "cacheRead"),
    ("cacheWriteInputTokens", "cacheWrite"),
    ("nonCachedInputTokens", "nonCached"),
    ("reasoningTokens", "reasoning"),
];

/// Normalized observed axes only. Missing axes stay absent and raw metadata is never billed twice.
pub(crate) fn observed(usage: &Value) -> Value {
    Value::Object(
        AXES.iter()
            .filter_map(|(field, _)| {
                usage[*field]
                    .as_u64()
                    .map(|value| ((*field).to_owned(), json!(value)))
            })
            .collect(),
    )
}

#[derive(Default)]
pub(crate) struct Totals {
    observations: u64,
    known: u64,
    tokens: [u64; 6],
    coverage: [u64; 6],
    invalid: u64,
}
impl Totals {
    pub fn observe(&mut self, usage: &Value) {
        self.observations += 1;
        let mut known = false;
        for (index, (field, _)) in AXES.iter().enumerate() {
            if let Some(value) = usage[*field].as_u64() {
                self.tokens[index] = self.tokens[index].saturating_add(value);
                self.coverage[index] += 1;
                known = true;
            }
        }
        self.known += u64::from(known);
        if usage["inputTokens"].as_u64().is_some_and(|input| {
            usage["cacheReadInputTokens"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(usage["cacheWriteInputTokens"].as_u64().unwrap_or(0))
                > input
        }) {
            self.invalid += 1;
        }
    }
    pub fn report(&self) -> Value {
        let tokens: Map<String, Value> = AXES
            .iter()
            .enumerate()
            .map(|(index, (_, key))| {
                (
                    (*key).into(),
                    if self.coverage[index] > 0 {
                        json!(self.tokens[index])
                    } else {
                        Value::Null
                    },
                )
            })
            .collect();
        let coverage: Map<String, Value> = AXES
            .iter()
            .enumerate()
            .map(|(index, (_, key))| ((*key).into(), json!(self.coverage[index])))
            .collect();
        let measured = self.observations > 0
            && self.invalid == 0
            && self.coverage[0] == self.observations
            && self.coverage[2] == self.observations;
        json!({"observations":self.observations,"knownUsageObservations":self.known,"missingUsageObservations":self.observations-self.known,"tokens":tokens,"coverage":coverage,"invalidBreakdowns":self.invalid,
            "hitRatio": if measured { hit_ratio(self.tokens[0], self.tokens[2]) } else { None }})
    }
}

/// The middle idle gap in minutes between consecutive turns, or `None` when no
/// gap was observed. Reported, not judged: how long a route keeps a prefix
/// cached is the provider's to state, so this figure lets a reader separate
/// "the prefix expired while the Session was idle" from "the prefix changed".
pub(crate) fn median_gap_minutes(gaps: &mut [u64]) -> Option<f64> {
    if gaps.is_empty() {
        return None;
    }
    gaps.sort_unstable();
    let middle = gaps.len() / 2;
    let milliseconds = if gaps.len() % 2 == 0 {
        (gaps[middle - 1] + gaps[middle]) / 2
    } else {
        gaps[middle]
    };
    Some((milliseconds as f64 / 60_000.0 * 10.0).round() / 10.0)
}

/// Provider-reported token counts are integers; a JSON string is accepted
/// because some gateways quote them. Invalid counters stay unknown; coercing
/// a negative or fractional count to zero would create false billing coverage.
fn number(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    if let Some(value) = value.as_f64() {
        return (value.is_finite()
            && value >= 0.0
            && value.fract() == 0.0
            && value < u64::MAX as f64)
            .then_some(value as u64);
    }
    value.as_str()?.trim().parse().ok()
}

fn field(raw: &Value, path: &[&str]) -> Option<u64> {
    let mut current = raw;
    for key in path {
        current = current.get(key)?;
    }
    number(Some(current))
}

fn finish(mut usage: Map<String, Value>, protocol: &str, raw: &Value, total: Option<u64>) -> Value {
    if let Some(total) = total {
        usage.insert("totalTokens".into(), json!(total));
    }
    if let Some(billing) = billing(raw) {
        usage.insert(BILLING.into(), billing);
    }
    if raw.as_object().is_some_and(|raw| !raw.is_empty()) {
        usage.insert(PROVIDER_METADATA.into(), json!({protocol: raw.clone()}));
    }
    Value::Object(usage)
}

fn insert(usage: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        usage.insert(key.into(), json!(value));
    }
}

/// Anthropic reports the breakdown natively: `input_tokens` is the non-cached
/// remainder, and extended thinking is billed inside `output_tokens`, so
/// `reasoningTokens` stays unknown rather than guessed.
/// Bedrock input counts include cache reads/writes rather than adding to them.
pub fn bedrock(raw: &Value) -> Value {
    let input = field(raw, &["inputTokens"]);
    let output = field(raw, &["outputTokens"]);
    let cache_read = field(raw, &["cacheReadInputTokens"]);
    let cache_write = field(raw, &["cacheWriteInputTokens"]);
    let mut usage = Map::new();
    insert(&mut usage, "inputTokens", input);
    insert(&mut usage, "outputTokens", output);
    insert(
        &mut usage,
        "nonCachedInputTokens",
        input.map(|input| {
            input
                .saturating_sub(cache_read.unwrap_or(0))
                .saturating_sub(cache_write.unwrap_or(0))
        }),
    );
    insert(&mut usage, "cacheReadInputTokens", cache_read);
    insert(&mut usage, "cacheWriteInputTokens", cache_write);
    finish(
        usage,
        "bedrock",
        raw,
        field(raw, &["totalTokens"]).or_else(|| {
            input
                .zip(output)
                .and_then(|(input, output)| input.checked_add(output))
        }),
    )
}

pub fn anthropic(raw: &Value) -> Value {
    let non_cached = field(raw, &["input_tokens"]);
    let cache_read = field(raw, &["cache_read_input_tokens"]);
    let cache_write = field(raw, &["cache_creation_input_tokens"]);
    let output = field(raw, &["output_tokens"]);
    let input = non_cached.and_then(|input| {
        input
            .checked_add(cache_read.unwrap_or(0))?
            .checked_add(cache_write.unwrap_or(0))
    });
    let mut usage = Map::new();
    insert(&mut usage, "inputTokens", input);
    insert(&mut usage, "outputTokens", output);
    insert(&mut usage, "nonCachedInputTokens", non_cached);
    insert(&mut usage, "cacheReadInputTokens", cache_read);
    insert(&mut usage, "cacheWriteInputTokens", cache_write);
    finish(
        usage,
        "anthropic-messages",
        raw,
        input
            .zip(output)
            .and_then(|(input, output)| input.checked_add(output)),
    )
}

/// OpenAI Chat Completions is inclusive, and also covers DeepSeek and GLM
/// gateways. DeepSeek names cache reads `prompt_cache_hit_tokens` with an
/// explicit miss count instead of a cached subset.
pub fn chat(raw: &Value) -> Value {
    let input = field(raw, &["prompt_tokens"]);
    let output = field(raw, &["completion_tokens"]);
    let cache_read = field(raw, &["prompt_tokens_details", "cached_tokens"])
        .or_else(|| field(raw, &["prompt_cache_hit_tokens"]));
    let non_cached = field(raw, &["prompt_cache_miss_tokens"]).or_else(|| {
        input
            .zip(cache_read)
            .map(|(input, read)| input.saturating_sub(read))
    });
    let reasoning = field(raw, &["completion_tokens_details", "reasoning_tokens"]);
    let mut usage = Map::new();
    insert(&mut usage, "inputTokens", input);
    insert(&mut usage, "outputTokens", output);
    insert(&mut usage, "nonCachedInputTokens", non_cached);
    insert(&mut usage, "cacheReadInputTokens", cache_read);
    insert(&mut usage, "reasoningTokens", reasoning);
    let total = field(raw, &["total_tokens"]).or_else(|| {
        input
            .zip(output)
            .and_then(|(input, output)| input.checked_add(output))
    });
    finish(usage, "openai-chat", raw, total)
}

/// OpenAI Responses reports the same inclusive shape as Chat Completions under
/// `input_tokens_details` / `output_tokens_details`.
pub fn responses(raw: &Value) -> Value {
    let input = field(raw, &["input_tokens"]);
    let output = field(raw, &["output_tokens"]);
    let cache_read = field(raw, &["input_tokens_details", "cached_tokens"]);
    let cache_write = field(raw, &["input_tokens_details", "cache_write_tokens"]);
    let non_cached = input.zip(cache_read).map(|(input, read)| {
        input
            .saturating_sub(read)
            .saturating_sub(cache_write.unwrap_or(0))
    });
    let reasoning = field(raw, &["output_tokens_details", "reasoning_tokens"]);
    let mut usage = Map::new();
    insert(&mut usage, "inputTokens", input);
    insert(&mut usage, "outputTokens", output);
    insert(&mut usage, "nonCachedInputTokens", non_cached);
    insert(&mut usage, "cacheReadInputTokens", cache_read);
    insert(&mut usage, "cacheWriteInputTokens", cache_write);
    insert(&mut usage, "reasoningTokens", reasoning);
    let total = field(raw, &["total_tokens"]).or_else(|| {
        input
            .zip(output)
            .and_then(|(input, output)| input.checked_add(output))
    });
    finish(usage, "openai-responses", raw, total)
}

/// Gemini reports inclusive `promptTokenCount`, cached input separately, and
/// thinking as `thoughtsTokenCount` outside `candidatesTokenCount`.
pub fn gemini(raw: &Value) -> Value {
    let input = field(raw, &["promptTokenCount"]);
    // `candidatesTokenCount` is visible-only: sum thoughts to keep
    // `outputTokens` inclusive, and only when the visible part is reported.
    let output = field(raw, &["candidatesTokenCount"])
        .and_then(|visible| visible.checked_add(field(raw, &["thoughtsTokenCount"]).unwrap_or(0)));
    let cache_read = field(raw, &["cachedContentTokenCount"]);
    let non_cached = input
        .zip(cache_read)
        .map(|(input, read)| input.saturating_sub(read));
    let reasoning = field(raw, &["thoughtsTokenCount"]);
    let mut usage = Map::new();
    insert(&mut usage, "inputTokens", input);
    insert(&mut usage, "outputTokens", output);
    insert(&mut usage, "nonCachedInputTokens", non_cached);
    insert(&mut usage, "cacheReadInputTokens", cache_read);
    insert(&mut usage, "reasoningTokens", reasoning);
    let total = field(raw, &["totalTokenCount"]).or_else(|| {
        input
            .zip(output)
            .and_then(|(input, output)| input.checked_add(output))
    });
    finish(usage, "gemini", raw, total)
}

/// The cached share of one request's prompt tokens.
///
/// Every normalizer here reports `inputTokens` as the whole prompt, cache reads
/// and writes included — that is why `nonCachedInputTokens` is the remainder
/// instead of the whole. The prompt is therefore the denominator, and adding a
/// cache axis back would cap a fully cached turn at 50%, which reads as an
/// unhealthy cache on every busy Session.
pub fn hit_ratio(input_tokens: u64, cache_read: u64) -> Option<f64> {
    (input_tokens > 0).then(|| cache_read.min(input_tokens) as f64 / input_tokens as f64)
}

/// The billed cache axes of a normalized usage object, for per-turn lineage
/// events and the session usage report. Absent axes stay absent: a provider
/// that reports no cache breakdown must never read as a zero-cache hit.
pub fn cache_lineage(usage: &Value) -> Value {
    let pick = |key: &str| usage.get(key).and_then(Value::as_u64);
    let read = pick("cacheReadInputTokens");
    let write = pick("cacheWriteInputTokens");
    let non_cached = pick("nonCachedInputTokens");
    let mut out = serde_json::Map::new();
    if let Some(value) = read {
        out.insert("read".into(), json!(value));
    }
    if let Some(value) = write {
        out.insert("write".into(), json!(value));
    }
    if let Some(value) = non_cached {
        out.insert("nonCached".into(), json!(value));
    }
    if let Some(read) = read {
        if let Some(ratio) = pick("inputTokens").and_then(|input| hit_ratio(input, read)) {
            out.insert("hitRatio".into(), json!((ratio * 1000.0).round() / 1000.0));
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_middle_idle_gap_is_reported_in_minutes() {
        assert_eq!(median_gap_minutes(&mut []), None);
        assert_eq!(median_gap_minutes(&mut [60_000]), Some(1.0));
        assert_eq!(
            median_gap_minutes(&mut [180_000, 60_000, 120_000]),
            Some(2.0)
        );
        assert_eq!(median_gap_minutes(&mut [60_000, 240_000]), Some(2.5));
    }

    #[test]
    fn invalid_provider_counters_remain_unknown_instead_of_becoming_zero_or_truncated() {
        for invalid in [
            json!(-1),
            json!(1.5),
            json!(1e40),
            json!("-1"),
            json!("1.5"),
        ] {
            let usage = chat(&json!({"prompt_tokens": invalid, "completion_tokens": 2}));
            assert!(usage.get("inputTokens").is_none(), "{usage}");
            assert!(usage.get("totalTokens").is_none(), "{usage}");
            assert_eq!(usage["outputTokens"], 2);
            assert!(usage.get(PROVIDER_METADATA).is_some());
        }
        assert_eq!(chat(&json!({"prompt_tokens": 0}))["inputTokens"], 0);
        assert_eq!(chat(&json!({"prompt_tokens": "42"}))["inputTokens"], 42);
        assert_eq!(chat(&json!({"prompt_tokens": 42.0}))["inputTokens"], 42);
        assert_eq!(
            chat(&json!({"prompt_tokens": u64::MAX}))["inputTokens"],
            u64::MAX
        );
    }

    #[test]
    fn overflowing_derived_totals_stay_unknown_without_panicking_or_wrapping() {
        let raw = json!({"prompt_tokens": u64::MAX, "completion_tokens": 1});
        assert!(chat(&raw).get("totalTokens").is_none());
        assert!(
            responses(&json!({"input_tokens": u64::MAX, "output_tokens": 1}))
                .get("totalTokens")
                .is_none()
        );
        assert!(
            bedrock(&json!({"inputTokens": u64::MAX, "outputTokens": 1}))
                .get("totalTokens")
                .is_none()
        );
        let usage = anthropic(&json!({"input_tokens": u64::MAX, "cache_read_input_tokens": 1}));
        assert!(usage.get("inputTokens").is_none());
        assert_eq!(usage["nonCachedInputTokens"], u64::MAX);
        assert!(
            gemini(&json!({"candidatesTokenCount": u64::MAX, "thoughtsTokenCount": 1}))
                .get("outputTokens")
                .is_none()
        );
        assert!(
            gemini(&json!({"promptTokenCount": u64::MAX, "candidatesTokenCount": 1}))
                .get("totalTokens")
                .is_none()
        );
    }

    #[test]
    fn cache_lineage_reports_present_axes_and_hit_ratio() {
        let usage = json!({
            "inputTokens": 200, "outputTokens": 10,
            "nonCachedInputTokens": 50, "cacheReadInputTokens": 150, "cacheWriteInputTokens": 25,
        });
        let lineage = cache_lineage(&usage);
        assert_eq!(lineage["read"], 150);
        assert_eq!(lineage["write"], 25);
        assert_eq!(lineage["nonCached"], 50);
        assert_eq!(lineage["hitRatio"], 0.75);
    }

    #[test]
    fn cache_lineage_stays_empty_without_a_breakdown() {
        assert_eq!(
            cache_lineage(&json!({"inputTokens": 10, "outputTokens": 1})),
            json!({})
        );
    }

    /// The gateway bills the turn itself, so the money it names rides the same
    /// canonical usage the tokens do: the sidebar's price line and the price we
    /// would have estimated come from one object.
    #[test]
    fn a_gateway_reported_charge_rides_the_canonical_usage() {
        let usage = chat(&json!({
            "prompt_tokens": 16187,
            "completion_tokens": 4,
            "total_tokens": 16191,
            "cost": 0.00202528,
            "opencode": {
                "billing_source": "balance",
                "list_cost": 0.00202528,
                "tokens": {"input": 4, "output": 4, "cache_read": 0, "cache_write_5m": 16183},
            },
        }));
        assert_eq!(usage[BILLING]["amount"], json!(0.00202528));
        assert_eq!(usage[BILLING]["currency"], json!("USD"));
        assert_eq!(usage[BILLING]["source"], json!("balance"));
        assert_eq!(usage[BILLING]["list"], json!(0.00202528));
        assert!(usage[BILLING].get("estimated").is_none());
        assert!(usage[BILLING].get("allowance").is_none());
        // The raw payload is still audit-only and never billed beside the
        // normalized numbers.
        assert!(usage[PROVIDER_METADATA].get("openai-chat").is_some());
    }

    /// A Go plan reports the allowance a request consumed and says whether the
    /// figure is a list-price estimate. Both are the provider's own words.
    #[test]
    fn a_plan_allowance_and_an_estimated_figure_are_carried_as_reported() {
        let usage = chat(&json!({
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "cost": 0.25,
            "opencode": {"billing_source": "go", "estimated": true, "allowance": 0.25},
        }));
        assert_eq!(usage[BILLING]["source"], json!("go"));
        assert_eq!(usage[BILLING]["estimated"], json!(true));
        assert_eq!(usage[BILLING]["allowance"], json!(0.25));
        assert!(usage[BILLING].get("list").is_none());
    }

    /// No reported figure stays absent: a provider that never bills in money
    /// must not read as free. A reported zero, however, is a real answer.
    #[test]
    fn an_unreported_charge_stays_absent_instead_of_becoming_zero() {
        assert!(chat(&json!({"prompt_tokens": 10, "completion_tokens": 1}))
            .get(BILLING)
            .is_none());
        assert!(
            chat(&json!({"prompt_tokens": 10, "cost": -1, "opencode": {}}))
                .get(BILLING)
                .is_none()
        );
        assert!(chat(&json!({"prompt_tokens": 10, "cost": "0.5"}))
            .get(BILLING)
            .is_none());
        let free = chat(&json!({
            "prompt_tokens": 10,
            "cost": 0,
            "opencode": {"billing_source": "free"},
        }));
        assert_eq!(free[BILLING]["amount"].as_f64(), Some(0.0));
        assert_eq!(free[BILLING]["source"], json!("free"));
    }
}
