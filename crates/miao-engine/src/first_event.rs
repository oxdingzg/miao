use serde_json::Value;
use std::time::Duration;
use tokio::time::Instant;

/// Starts at provider dispatch and is released after a canonical provider event.
#[derive(Clone, Copy)]
pub(crate) struct FirstEventDeadline(pub(crate) Option<Instant>);

impl Default for FirstEventDeadline {
    fn default() -> Self {
        let milliseconds = std::env::var("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(60_000.0);
        if milliseconds == 0.0 {
            return Self(None);
        }
        Self(Some(
            Instant::now()
                + Duration::try_from_secs_f64(milliseconds / 1000.0)
                    .unwrap_or(Duration::from_secs(60)),
        ))
    }
}

pub(crate) fn semantic_event(event: &Value) -> bool {
    if event["type"] == "ping" {
        return false;
    }
    if event["choices"].as_array().is_some_and(Vec::is_empty) && event["usage"].is_null() {
        return false;
    }
    true
}
