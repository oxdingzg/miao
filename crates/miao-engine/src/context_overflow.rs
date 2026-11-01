//! Recognising an endpoint's own context-window refusal.
//!
//! The engine plans its request against the window the product configured
//! (`--context-limits`). A Session whose model is not the engine's default, or
//! whose route publishes no window, runs with no budget at all, so the first
//! sign that the history no longer fits is the endpoint answering:
//!
//! ```text
//! This model's maximum context length is 1048576 tokens. However, you
//! requested 1140636 tokens ... Please reduce the length of the messages.
//! ```
//!
//! That refusal is not a malformed input and not an availability problem: it is
//! the window, stated by the only party that knows it. Classifying it here lets
//! the runtime learn the real window, compact, and stop quarantining the
//! operator's message — without it every later prompt replays the same
//! oversized request and the Session cannot be continued at all.

use regex::Regex;
use std::sync::LazyLock;

fn compile(patterns: &[&str]) -> Vec<Regex> {
    patterns
        .iter()
        .map(|pattern| Regex::new(pattern).expect("context-overflow pattern compiles"))
        .collect()
}

/// Refusals that name an oversized request. Kept in step with the TypeScript
/// matcher in `packages/llm/src/provider-error.ts`; the two must agree, or a
/// host and an engine disagree about whether a Session may compact.
fn patterns() -> &'static Vec<Regex> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        compile(&[
            r"(?i)prompt is too long",
            r"(?i)request_too_large",
            r"(?i)input is too long for requested model",
            r"(?i)exceeds the context window",
            r"(?i)exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))",
            r"(?i)input token count.*exceeds the maximum",
            r"(?i)tokens in request more than max tokens allowed",
            r"(?i)maximum prompt length is \d+",
            r"(?i)reduce the length of the messages",
            r"(?i)maximum context length is \d+ tokens",
            r"(?i)exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?",
            r"(?i)input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)",
            r"(?i)exceeds the limit of \d+",
            r"(?i)exceeds the available context size",
            r"(?i)greater than the context length",
            r"(?i)context window exceeds limit",
            r"(?i)exceeded model token limit",
            r"(?i)context[_ ]length[_ ]exceeded",
            r"(?i)request entity too large",
            r"(?i)context length is only \d+ tokens",
            r"(?i)input length.*exceeds.*context length",
            r"(?i)prompt too long; exceeded (?:max )?context length",
            r"(?i)too large for model with \d+ maximum context length",
            r"(?i)prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?",
            r"(?i)model_context_window_exceeded",
            r"(?i)too many tokens",
            r"(?i)token limit exceeded",
        ])
    });
    &PATTERNS
}

/// Refusals that mention tokens but have a different remedy. A throttled or
/// rate-limited turn must be retried, not compacted.
fn exclusions() -> &'static Vec<Regex> {
    static EXCLUSIONS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        compile(&[
            r"(?i)^(?:throttling error|service unavailable):",
            r"(?i)rate limit",
            r"(?i)too many requests",
        ])
    });
    &EXCLUSIONS
}

/// Whether `message` is the endpoint refusing a request that no longer fits its
/// context window.
pub fn is_context_overflow(message: &str) -> bool {
    if exclusions().iter().any(|pattern| pattern.is_match(message)) {
        return false;
    }
    patterns().iter().any(|pattern| pattern.is_match(message))
}

/// The window the endpoint named, when the refusal states one. The engine uses
/// it as the effective window for that route, so a model the product never
/// described still gets a budget instead of an unbounded history.
pub fn overflow_limit(message: &str) -> Option<u64> {
    static LIMITS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        compile(&[
            r"(?i)maximum context length is ([\d,]+) tokens?",
            r"(?i)maximum context length(?: of | \()([\d,]+)",
            r"(?i)maximum prompt length is ([\d,]+)",
            r"(?i)exceeds the limit of ([\d,]+)",
            r"(?i)context length is only ([\d,]+) tokens",
            r"(?i)too large for model with ([\d,]+) maximum context length",
            r"(?i)configured context size is ([\d,]+) tokens?",
            r"(?i)maximum allowed input length of ([\d,]+) tokens?",
            r"(?i)context length \(([\d,]+) tokens\)",
        ])
    });
    LIMITS.iter().find_map(|pattern| {
        let captured = pattern.captures(message)?;
        let digits: String = captured.get(1)?.as_str().replace(',', "");
        digits.parse::<u64>().ok().filter(|limit| *limit > 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_endpoint_refusal_that_bricked_a_session() {
        let message = "invalid request: provider HTTP 400: Upstream request failed: [invalid_request_error] This model's maximum context length is 1048576 tokens. However, you requested 1140636 tokens (1140636 in the messages, 0 in the completion). Please reduce the length of the messages or completion. (request_id: a20ae8ae-d33f-46c3-b1dc-fa95e34d9470)";
        assert!(is_context_overflow(message));
        assert_eq!(overflow_limit(message), Some(1_048_576));
    }

    #[test]
    fn recognises_the_other_vendor_wordings() {
        for message in [
            "prompt is too long: 265330 tokens > 262144 maximum",
            "This model's maximum context length is 200000 tokens",
            "input (265330 tokens) is longer than the model's context length (262144 tokens)",
            "context_length_exceeded: prompt too long",
            "Requested token count exceeds the model's maximum context length of 131072 tokens.",
            "too large for model with 8192 maximum context length",
            "prompt has 131072 tokens, but the configured context size is 65536 tokens",
        ] {
            assert!(is_context_overflow(message), "{message}");
        }
    }

    #[test]
    fn leaves_other_refusals_alone() {
        for message in [
            "invalid request: provider HTTP 429: rate limit exceeded",
            "invalid request: provider HTTP 400: malformed tool schema",
            "throttling error: too many tokens",
            "connection refused (os error 61)",
        ] {
            assert!(!is_context_overflow(message), "{message}");
        }
    }

    #[test]
    fn a_refusal_without_a_number_still_counts_but_teaches_no_window() {
        assert!(is_context_overflow("request entity too large"));
        assert_eq!(overflow_limit("request entity too large"), None);
    }
}
