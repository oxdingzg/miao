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
}

fn notice_description(notice: &Value) -> Option<&str> {
    notice
        .get("description")
        .and_then(Value::as_str)
        .filter(|description| !description.is_empty())
}

fn notice_with_lines(head: String, notice: &Value) -> String {
    let mut text = head;
    if let Some(lines) = notice.get("lines").and_then(Value::as_array) {
        let lines: Vec<&str> = lines.iter().filter_map(Value::as_str).collect();
        if !lines.is_empty() {
            text.push('\n');
            text.push_str(&lines.join("\n"));
        }
    }
    if notice.get("suppressed").and_then(Value::as_bool) == Some(true) {
        text.push_str("\n(earlier matching lines were suppressed)");
    }
    text
}

/// Durable input text for a mid-stream notice: the matched lines verbatim
/// instead of the internal notice envelope.
pub fn render_notice_text(_job: &str, notice: &Value) -> String {
    let head = match notice_description(notice) {
        Some(description) => format!("watch \"{description}\" matched:"),
        None => "watch matched:".to_string(),
    };
    notice_with_lines(head, notice)
}

/// Durable input text for a monitor's terminal settle. Merges the terminal
/// state with the final matched lines so exit and output wake the model once.
pub fn render_finish_text(_job: &str, state_text: &str, notice: Option<&Value>) -> String {
    let head = match notice.and_then(notice_description) {
        Some(description) => format!("watch \"{description}\" {state_text}."),
        None => format!("watch {state_text}."),
    };
    match notice {
        Some(notice) => notice_with_lines(head, notice),
        None => head,
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
        for _ in 0..MAX_NOTICES {
            batcher.feed(None, "tick");
            assert!(batcher.flush(true, "job", None).is_some());
        }
        batcher.feed(None, "tick");
        assert!(batcher.flush(true, "job", None).is_none());
        batcher.feed(None, "tick");
        assert!(batcher.flush(true, "job", None).is_none());
    }

    #[test]
    fn notice_text_quotes_lines_without_the_envelope() {
        let notice = json!({
            "kind":"monitor.notice",
            "job_id":"job-1",
            "description":"等待 foundation job 完成",
            "lines":["FINAL completed/success"],
            "suppressed":false,
        });
        assert_eq!(
            render_notice_text("job-1", &notice),
            "watch \"等待 foundation job 完成\" matched:\nFINAL completed/success"
        );
    }

    #[test]
    fn notice_text_handles_missing_description_and_suppression() {
        let notice = json!({
            "kind":"monitor.notice",
            "job_id":"job-1",
            "description":null,
            "lines":["a","b"],
            "suppressed":true,
        });
        assert_eq!(
            render_notice_text("job-1", &notice),
            "watch matched:\na\nb\n(earlier matching lines were suppressed)"
        );
    }

    #[test]
    fn finish_text_merges_state_with_final_lines() {
        let notice = json!({
            "kind":"monitor.notice",
            "job_id":"job-1",
            "description":null,
            "lines":["READY-final"],
            "suppressed":false,
        });
        assert_eq!(
            render_finish_text("job-1", "finished (exit code 0)", Some(&notice)),
            "watch finished (exit code 0).\nREADY-final"
        );
        assert_eq!(
            render_finish_text("job-1", "timed out after 30000 ms", None),
            "watch timed out after 30000 ms."
        );
    }
}
