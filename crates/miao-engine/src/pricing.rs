//! Native-currency model pricing from the product's configuration.
//!
//! `providers.<id>.models.<m>.cost` declares per-million-token rates in the
//! provider's own currency, and `providers.<id>.models.<m>.currency` names that
//! currency. There is no conversion here on purpose: CNY and USD spend are
//! reported side by side, never summed into one number whose unit is a guess.
//!
//! An entry that declares a cost without a currency is not a price. The caller
//! reports that spend as unknown rather than counting it as zero.

use serde_json::Value;
use std::collections::BTreeMap;

/// Rates per million tokens, in the currency the entry names.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Price {
    pub currency: String,
    pub rates: Rates,
}

/// Tokens one usage report billed, split the way a provider prices them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    /// Read the normalized usage counters. `input` is the provider's total input
    /// count, which already includes the cached parts, so a payload without an
    /// explicit non-cached counter is split by subtracting them.
    pub fn from_usage(usage: &Value) -> Self {
        let read = |key: &str| usage[key].as_u64().unwrap_or(0);
        let input = read("inputTokens");
        let cache_read = read("cacheReadInputTokens");
        let cache_write = read("cacheWriteInputTokens");
        let non_cached = usage["nonCachedInputTokens"]
            .as_u64()
            .unwrap_or_else(|| input.saturating_sub(cache_read.saturating_add(cache_write)));
        Self {
            input: non_cached,
            output: read("outputTokens"),
            cache_read,
            cache_write,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Charge {
    pub currency: String,
    pub amount: f64,
    /// The rates the amount was computed from, so a stored estimate stays
    /// attributable when the price table changes later. A gateway-reported
    /// figure carries no rates: the money moved at the provider's own price.
    pub rates: Rates,
}

/// Prices keyed by the route that served the turn (`provider/model`), which is
/// exactly what a Session's model binding records.
#[derive(Clone, Debug, Default)]
pub struct Table {
    prices: BTreeMap<String, Price>,
}

impl Table {
    pub fn from_config(config: &Value) -> Self {
        let mut prices = BTreeMap::new();
        let providers = config.get("providers").and_then(Value::as_object);
        for (provider, entry) in providers.into_iter().flatten() {
            let models = entry.get("models").and_then(Value::as_object);
            for (model, model_entry) in models.into_iter().flatten() {
                let Some(currency) = model_entry.get("currency").and_then(Value::as_str) else {
                    continue;
                };
                let Some(cost) = model_entry.get("cost") else {
                    continue;
                };
                // A single rate set is the common case; an array is a tiered
                // schedule this version cannot attribute per turn, so it stays
                // unpriced instead of being collapsed into one rate.
                let Some(rate) = cost.as_object() else {
                    continue;
                };
                let number = |key: &str| rate.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                prices.insert(
                    format!("{provider}/{model}"),
                    Price {
                        currency: currency.to_owned(),
                        rates: Rates {
                            input: number("input"),
                            output: number("output"),
                            cache_read: number("cache_read"),
                            cache_write: number("cache_write"),
                        },
                    },
                );
            }
        }
        Self { prices }
    }

    pub fn price(&self, route: &str) -> Option<&Price> {
        self.prices.get(route)
    }

    /// What the reported tokens cost at this route's declared rates, rounded to
    /// six decimals so a stored figure is stable. `None` means unpriced: the
    /// caller must not substitute zero.
    pub fn charge(&self, route: &str, tokens: Tokens) -> Option<Charge> {
        let price = self.price(route)?;
        let rates = price.rates;
        let amount = (tokens.input as f64 * rates.input
            + tokens.output as f64 * rates.output
            + tokens.cache_read as f64 * rates.cache_read
            + tokens.cache_write as f64 * rates.cache_write)
            / 1_000_000.0;
        Some(Charge {
            currency: price.currency.clone(),
            amount: (amount * 1_000_000.0).round() / 1_000_000.0,
            rates,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Table, Tokens};
    use serde_json::json;

    fn config() -> serde_json::Value {
        json!({
            "providers": {
                "deepseek": {
                    "models": {
                        "deepseek-chat": {
                            "currency": "CNY",
                            "cost": {"input": 2.0, "output": 8.0, "cache_read": 0.5}
                        },
                        "unpriced": {"cost": {"input": 1.0}},
                        "tiered": {
                            "currency": "USD",
                            "cost": [{"input": 1.0}, {"input": 2.0}]
                        }
                    }
                },
                "openai": {
                    "models": {
                        "gpt-5": {
                            "currency": "USD",
                            "cost": {"input": 1.25, "output": 10.0, "cache_read": 0.125}
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn a_cost_without_a_currency_is_not_a_price() {
        let table = Table::from_config(&config());
        assert!(table.price("deepseek/unpriced").is_none());
        assert!(table.price("deepseek/tiered").is_none());
        assert!(table.price("deepseek/missing").is_none());
        assert_eq!(table.prices.len(), 2);
    }

    #[test]
    fn spend_is_priced_in_the_provider_currency_and_never_converted() {
        let table = Table::from_config(&config());
        let cny = table
            .charge(
                "deepseek/deepseek-chat",
                Tokens {
                    input: 1_000_000,
                    output: 0,
                    cache_read: 1_000_000,
                    cache_write: 0,
                },
            )
            .unwrap();
        assert_eq!(cny.currency, "CNY");
        assert_eq!(cny.amount, 2.5);
        // The charge carries the rates it used, so a stored estimate stays
        // attributable when the table changes later.
        assert_eq!(cny.rates.input, 2.0);
        assert_eq!(cny.rates.cache_read, 0.5);
        let usd = table
            .charge(
                "openai/gpt-5",
                Tokens {
                    input: 0,
                    output: 1_000_000,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(usd.currency, "USD");
        assert_eq!(usd.amount, 10.0);
    }

    #[test]
    fn cached_input_is_not_billed_at_the_uncached_rate() {
        // The provider's input counter includes what it served from cache; a
        // payload without an explicit non-cached counter must not bill the
        // cached share twice.
        let tokens = Tokens::from_usage(&json!({
            "inputTokens": 1_000_000,
            "cacheReadInputTokens": 900_000,
            "outputTokens": 0
        }));
        assert_eq!(tokens.input, 100_000);
        assert_eq!(tokens.cache_read, 900_000);
        let table = Table::from_config(&config());
        let charge = table.charge("deepseek/deepseek-chat", tokens).unwrap();
        // 0.1M × 2.0 + 0.9M × 0.5 = 0.2 + 0.45
        assert_eq!(charge.amount, 0.65);
    }
}
