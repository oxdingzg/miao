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
        json!({"observations":self.observations,"knownUsageObservations":self.known,"missingUsageObservations":self.observations-self.known,"tokens":tokens,"coverage":coverage,"invalidBreakdowns":self.invalid,
            "hitRatio":if self.observations>0 && self.invalid==0 && self.coverage[0]==self.observations && self.coverage[2]==self.observations && self.tokens[0]>0 {Some(self.tokens[2] as f64/self.tokens[0] as f64)} else {None}})
    }
}

/// Provider-reported token counts are integers; a JSON string is accepted
/// because some gateways quote them.
fn number(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    if let Some(value) = value.as_f64() {
        return Some(value.max(0.0) as u64);
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
                .map(|(input, output)| input.saturating_add(output))
        }),
    )
}

pub fn anthropic(raw: &Value) -> Value {
    let non_cached = field(raw, &["input_tokens"]);
    let cache_read = field(raw, &["cache_read_input_tokens"]);
    let cache_write = field(raw, &["cache_creation_input_tokens"]);
    let output = field(raw, &["output_tokens"]);
    let input = non_cached
        .is_some()
        .then(|| non_cached.unwrap_or(0) + cache_read.unwrap_or(0) + cache_write.unwrap_or(0));
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
        input.zip(output).map(|(input, output)| input + output),
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
    let total = field(raw, &["total_tokens"])
        .or_else(|| input.zip(output).map(|(input, output)| input + output));
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
    let total = field(raw, &["total_tokens"])
        .or_else(|| input.zip(output).map(|(input, output)| input + output));
    finish(usage, "openai-responses", raw, total)
}

/// Gemini reports inclusive `promptTokenCount`, cached input separately, and
/// thinking as `thoughtsTokenCount` outside `candidatesTokenCount`.
pub fn gemini(raw: &Value) -> Value {
    let input = field(raw, &["promptTokenCount"]);
    // `candidatesTokenCount` is visible-only: sum thoughts to keep
    // `outputTokens` inclusive, and only when the visible part is reported.
    let output = field(raw, &["candidatesTokenCount"])
        .map(|visible| visible + field(raw, &["thoughtsTokenCount"]).unwrap_or(0));
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
    let total = field(raw, &["totalTokenCount"])
        .or_else(|| input.zip(output).map(|(input, output)| input + output));
    finish(usage, "gemini", raw, total)
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
        if let Some(input) = pick("inputTokens") {
            if input > 0 {
                let ratio = (read as f64 / input as f64 * 1000.0).round() / 1000.0;
                out.insert("hitRatio".into(), json!(ratio));
            }
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
