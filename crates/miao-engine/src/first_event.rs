use serde_json::Value;
use std::time::Duration;
use tokio::time::Instant;

const REQUEST_BYTES_PER_SECOND: f64 = 32.0 * 1024.0;
const MAX_REQUEST_ALLOWANCE: Duration = Duration::from_secs(30 * 60);

fn milliseconds(key: &str, fallback: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(fallback)
}

fn seconds(key: &str, fallback: f64) -> Duration {
    Duration::try_from_secs_f64(milliseconds(key, fallback) / 1000.0)
        .unwrap_or(Duration::try_from_secs_f64(fallback / 1000.0).unwrap_or(Duration::ZERO))
}

/// Layered per-attempt liveness bounds, mirroring the session runner's phases.
///
/// `header` bounds dispatch through response headers and is widened by the
/// encoded request size; `byte_idle` bounds silence between body bytes, with
/// protocol keep-alives counting as bytes; `event` bounds the wait for a
/// canonical event and is not extended by keep-alive traffic. Setting
/// `MIAO_LLM_FIRST_BYTE_TIMEOUT_MS=0` disables the whole watchdog, as it did
/// when the phases shared one deadline.
#[derive(Clone, Copy)]
pub(crate) struct Watchdogs {
    header: Option<Instant>,
    pub(crate) byte_idle: Duration,
    pub(crate) event: Option<Instant>,
}

impl Watchdogs {
    /// Anchors every phase at provider dispatch. Callers without a readable
    /// request body pass `0`, which simply skips the size allowance.
    pub(crate) fn at(request_bytes: usize) -> Self {
        let started_at = Instant::now();
        let first_byte_ms = milliseconds("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", 180_000.0);
        if first_byte_ms == 0.0 {
            return Self {
                header: None,
                byte_idle: Duration::ZERO,
                event: None,
            };
        }
        let allowance = Duration::try_from_secs_f64(
            (request_bytes as f64 / REQUEST_BYTES_PER_SECOND).floor(), // seconds
        )
        .unwrap_or(Duration::ZERO)
        .min(MAX_REQUEST_ALLOWANCE);
        Self {
            header: Some(
                started_at + seconds("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", 180_000.0) + allowance,
            ),
            byte_idle: seconds("MIAO_LLM_STREAM_IDLE_TIMEOUT_MS", 180_000.0),
            event: {
                let event = seconds("MIAO_LLM_EVENT_IDLE_TIMEOUT_MS", 300_000.0);
                (event > Duration::ZERO).then(|| started_at + event)
            },
        }
    }

    /// Deadline for response headers, before any body byte arrives.
    pub(crate) fn header_deadline(&self) -> Option<Instant> {
        self.header
    }
}

/// A watchdog that never fires, for streams that carry no anchored attempt.
impl Default for Watchdogs {
    fn default() -> Self {
        Self {
            header: None,
            byte_idle: Duration::ZERO,
            event: None,
        }
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

#[cfg(test)]
mod tests {
    use super::Watchdogs;
    use std::time::Duration;
    use tokio::time::Instant;

    /// Deadline widths measured from a moment just before construction; the
    /// constructor only runs a few env reads in between, so a small tolerance
    /// keeps this exact without exposing internal state.
    fn within(actual: Duration, seconds: u64) -> bool {
        let expected = Duration::from_secs(seconds);
        actual >= expected && actual - expected <= Duration::from_millis(50)
    }

    #[test]
    fn env_deadlines_layer_and_zero_first_byte_disables_everything() {
        std::env::set_var("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", "1000");
        std::env::set_var("MIAO_LLM_STREAM_IDLE_TIMEOUT_MS", "2000");
        std::env::set_var("MIAO_LLM_EVENT_IDLE_TIMEOUT_MS", "4000");
        let anchor = Instant::now();
        let watchdogs = Watchdogs::at(64 * 1024);
        assert!(within(watchdogs.header_deadline().unwrap() - anchor, 3));
        assert_eq!(watchdogs.byte_idle, Duration::from_secs(2));
        assert!(within(watchdogs.event.unwrap() - anchor, 4));

        std::env::set_var("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS", "0");
        let watchdogs = Watchdogs::at(0);
        assert!(watchdogs.header_deadline().is_none());
        assert_eq!(watchdogs.byte_idle, Duration::ZERO);
        assert!(watchdogs.event.is_none());

        std::env::remove_var("MIAO_LLM_FIRST_BYTE_TIMEOUT_MS");
        std::env::remove_var("MIAO_LLM_STREAM_IDLE_TIMEOUT_MS");
        std::env::remove_var("MIAO_LLM_EVENT_IDLE_TIMEOUT_MS");
    }
}
