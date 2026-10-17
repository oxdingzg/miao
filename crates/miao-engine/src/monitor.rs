//! Background command watch with regex-filtered, batched progress notices.
//! Semantics mirror the TS `monitor` builtin: matching stdout lines are
//! collected for a short window, published as bounded notices, and suppressed
//! after a notice budget; an explicit timeout kills the child.

use serde::Deserialize;
use serde_json::{json, Value};

pub const DEFAULT_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
pub const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
pub const BATCH_WINDOW_MS: u64 = 200;
pub const MAX_LINES_PER_NOTICE: usize = 200;
pub const MAX_NOTICES: usize = 64;
pub const MAX_NOTICE_BYTES: usize = 8 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub command: String,
    pub description: Option<String>,
    pub pattern: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl Input {
    pub fn parse(input: Value) -> Result<Self, crate::tools::ToolError> {
        let input: Self =
            serde_json::from_value(input).map_err(|_| crate::tools::ToolError::InvalidInput)?;
        if input.command.is_empty()
            || input.command.len() > 8192
            || input
                .description
                .as_ref()
                .is_some_and(|description| description.len() > 256)
            || input
                .pattern
                .as_ref()
                .is_some_and(|pattern| pattern.is_empty() || pattern.len() > 512)
            || input
                .timeout_ms
                .is_some_and(|timeout| timeout == 0 || timeout > MAX_TIMEOUT_MS)
        {
            return Err(crate::tools::ToolError::InvalidInput);
        }
        Ok(input)
    }

    pub fn timeout(&self) -> u64 {
        self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)
    }

    pub fn matcher(&self) -> Result<Option<regex::Regex>, crate::tools::ToolError> {
        self.pattern
            .as_deref()
            .map(|pattern| {
                regex::Regex::new(pattern).map_err(|_| crate::tools::ToolError::InvalidInput)
            })
            .transpose()
    }
}

/// Line batching state for one monitor. Matches are queued; `flush` drains a
/// bounded slice once the batch window has elapsed. Notices beyond the budget
/// are suppressed while the command keeps running.
#[derive(Default)]
pub struct Batcher {
    queued: Vec<String>,
    bytes: usize,
    notices: usize,
    suppressed: bool,
}

impl Batcher {
    pub fn feed(&mut self, matcher: Option<&regex::Regex>, line: &str) -> bool {
        if let Some(matcher) = matcher {
            if !matcher.is_match(line) {
                return false;
            }
        }
        if self.queued.len() >= MAX_LINES_PER_NOTICE || self.bytes + line.len() > MAX_NOTICE_BYTES {
            self.suppressed = true;
            return false;
        }
        self.bytes += line.len();
        self.queued.push(line.to_owned());
        true
    }

    /// Drain queued lines into one notice if the batch window elapsed and the
    /// notice budget allows. Returns `None` while suppression is active.
    pub fn flush(&mut self, due: bool, job_id: &str, description: Option<&str>) -> Option<Value> {
        if self.queued.is_empty() || !due {
            return None;
        }
        if self.notices >= MAX_NOTICES {
            self.suppressed = true;
            self.queued.clear();
            self.bytes = 0;
            return None;
        }
        self.notices += 1;
        let lines = std::mem::take(&mut self.queued);
        self.bytes = 0;
        Some(json!({
            "kind":"monitor.notice",
            "job_id":job_id,
            "description":description,
            "lines":lines,
            "suppressed":self.suppressed,
        }))
    }

    pub fn suppressed(&self) -> bool {
        self.suppressed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_keeps_matching_lines_only() {
        let input = Input {
            command: "true".into(),
            description: None,
            pattern: Some("error".into()),
            timeout_ms: None,
        };
        let matcher = input.matcher().unwrap();
        let mut batcher = Batcher::default();
        assert!(!batcher.feed(matcher.as_ref(), "ok line"));
        assert!(batcher.feed(matcher.as_ref(), "error: boom"));
    }

    #[test]
    fn flush_requires_window_and_respects_line_cap() {
        let mut batcher = Batcher::default();
        for index in 0..MAX_LINES_PER_NOTICE + 10 {
            batcher.feed(None, &format!("line {index}"));
        }
        assert!(batcher.flush(false, "job", None).is_none());
        let notice = batcher.flush(true, "job", Some("watch")).unwrap();
        assert_eq!(
            notice["lines"].as_array().unwrap().len(),
            MAX_LINES_PER_NOTICE
        );
        assert_eq!(notice["suppressed"], json!(true));
    }

    #[test]
    fn notice_budget_is_bounded() {
        let mut batcher = Batcher::default();
        for _ in 0..=MAX_NOTICES {
            batcher.feed(None, "tick");
            assert!(batcher.flush(true, "job", None).is_some());
        }
        batcher.feed(None, "tick");
        assert!(batcher.flush(true, "job", None).is_none());
        assert!(batcher.suppressed());
    }
}
