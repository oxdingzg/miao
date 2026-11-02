//! Per-turn dollars from a route's tiered list rates.
//!
//! The engine records tokens and leaves money to whoever holds the rates
//! (`store.rs` says as much next to `usage_report`). The rates live on the model
//! route, so this module turns one observed usage into the same figure the
//! product computes in `SessionCost.ofTurn`: input, visible output, reasoning at
//! the output rate, and cache read/write, each per million tokens, with the
//! largest matching context tier winning.

use serde_json::Value;

const MILLION: f64 = 1_000_000.0;

fn positive(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
}

fn tokens(usage: &Value, field: &str) -> f64 {
    positive(usage.get(field))
}

/// The tier whose context size the request passed, else the base (untiered) entry.
pub fn rate_for(costs: &[Value], context_tokens: f64) -> Option<&Value> {
    let mut tiered = costs
        .iter()
        .filter(|entry| {
            entry
                .get("tier")
                .and_then(|tier| tier.get("size"))
                .and_then(Value::as_f64)
                .is_some_and(|size| context_tokens > size)
        })
        .collect::<Vec<_>>();
    tiered.sort_by(|a, b| {
        let size = |entry: &Value| {
            entry
                .get("tier")
                .and_then(|tier| tier.get("size"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        size(b)
            .partial_cmp(&size(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    tiered
        .first()
        .copied()
        .or_else(|| costs.iter().find(|entry| entry.get("tier").is_none()))
}

/// Dollars for one billed turn, or `None` when the route declares no base rate —
/// the caller counts those attempts instead of pricing them at zero.
pub fn turn(costs: &Value, usage: &Value) -> Option<f64> {
    let entries = costs.as_array()?;
    let rate = rate_for(entries, tokens(usage, "inputTokens"))?;
    let per_million =
        |token_count: f64, value: Option<&Value>| positive(value) * token_count / MILLION;
    let cache = |field: &str| rate.get("cache").and_then(|cache| cache.get(field));
    let output = tokens(usage, "outputTokens");
    let reasoning = tokens(usage, "reasoningTokens");
    let visible_output = (output - reasoning).max(0.0);
    Some(
        per_million(tokens(usage, "nonCachedInputTokens"), rate.get("input"))
            + per_million(visible_output, rate.get("output"))
            + per_million(reasoning, rate.get("output"))
            + per_million(tokens(usage, "cacheReadInputTokens"), cache("read"))
            + per_million(tokens(usage, "cacheWriteInputTokens"), cache("write")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!([{ "input": 1.0, "output": 2.0, "cache": { "read": 0.1, "write": 0.5 } }])
    }

    #[test]
    fn prices_non_cached_input_output_reasoning_and_cache() {
        let usage = json!({
            "inputTokens": 13_000,
            "nonCachedInputTokens": 1_000,
            "outputTokens": 600,
            "reasoningTokens": 100,
            "cacheReadInputTokens": 12_000,
            "cacheWriteInputTokens": 0,
        });
        // 1000*1 + 500*2 + 100*2 (reasoning at the output rate) + 12000*0.1, per million.
        let expected = (1_000.0 + 1_000.0 + 200.0 + 1_200.0) / MILLION;
        let priced = turn(&base(), &usage).expect("a base rate exists");
        assert!((priced - expected).abs() < 1e-12, "{priced} != {expected}");
    }

    #[test]
    fn a_context_tier_beats_the_base_once_input_crosses_it() {
        let costs = json!([
            { "input": 1.0, "output": 2.0, "cache": { "read": 0.0, "write": 0.0 } },
            { "tier": { "type": "context", "size": 200_000 }, "input": 3.0, "output": 6.0, "cache": { "read": 0.0, "write": 0.0 } },
        ]);
        let small = turn(
            &costs,
            &json!({ "inputTokens": 1_000, "nonCachedInputTokens": 1_000.0 }),
        )
        .unwrap();
        let large = turn(
            &costs,
            &json!({ "inputTokens": 250_000, "nonCachedInputTokens": 1_000_000.0 }),
        )
        .unwrap();
        assert!((small - 1_000.0 / MILLION).abs() < 1e-12);
        assert!((large - 3_000_000.0 / MILLION).abs() < 1e-12);
    }

    #[test]
    fn a_route_without_a_base_rate_reports_no_price_instead_of_zero() {
        assert_eq!(turn(&json!([]), &json!({ "inputTokens": 5 })), None);
        assert_eq!(
            turn(
                &json!([{ "tier": { "size": 1_000 }, "input": 1.0 }]),
                &json!({ "inputTokens": 5 })
            ),
            None
        );
    }
}
