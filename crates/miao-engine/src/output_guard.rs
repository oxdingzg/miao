//! Repetitive-output guard.
//!
//! Ported from `packages/core/src/session/runner/output-guard.ts`. A model can
//! loop on a short prose refrain without ever calling a tool, so the bounded
//! tool-call loop never sees it. This guard watches streamed text and reasoning
//! per part and reports a loop once the last [`WINDOW_LINES`] prose lines are
//! almost entirely a small recurring vocabulary.
//!
//! The observer is scoped to one stream attempt: a retried request starts with
//! fresh state, exactly like a new TypeScript stream subscription. Historical
//! loops are neutralized in the provider-facing copy of the history by
//! [`neutralize`] without rewriting the durable transcript.

use crate::{protocol::Message, provider::Reply};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::OnceLock,
};

const WINDOW_LINES: usize = 64;
const MAX_LINE: usize = 160;
const MAX_PARTS: usize = 16;

/// Request-only replacement for an earlier assistant part that looped. Tool
/// calls and their results stay exactly as recorded, so the model keeps the
/// side effects and loses only the refrain it was imitating.
pub(crate) const NEUTRALIZED: &str = "[Removed from model context: repetitive output from an earlier assistant turn. Any recorded tool calls and their results are retained; do not repeat completed side effects.]";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Channel {
    Text,
    Reasoning,
}

impl Channel {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Reasoning => "reasoning",
        }
    }
    fn of(kind: &str) -> Option<Self> {
        match kind {
            "text.delta" => Some(Self::Text),
            "reasoning.delta" => Some(Self::Reasoning),
            _ => None,
        }
    }
    fn part_type(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Reasoning => "reasoning",
        }
    }
}

#[derive(Default)]
struct Part {
    pending: String,
    pending_units: usize,
    oversized: bool,
    fenced: bool,
    lines: VecDeque<String>,
}

/// One stream attempt's detection state. `text` and `reasoning` retain what was
/// streamed so a stopped turn can keep exactly what the user already saw.
#[derive(Default)]
pub(crate) struct Guard {
    parts: HashMap<(Channel, u64), Part>,
    order: VecDeque<(Channel, u64)>,
    seen: Vec<Channel>,
    text: String,
    reasoning: String,
}

impl Guard {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Observe one normalized provider delta. Returns the channel when the
    /// part's recent window is a loop.
    pub(crate) fn observe(&mut self, delta: &Value) -> Option<Channel> {
        let channel = Channel::of(delta["kind"].as_str()?)?;
        let text = delta["text"].as_str()?;
        // Providers that publish no block index still stream one logical part
        // per channel, so the index is only an identity when it exists.
        let key = (channel, delta["index"].as_u64().unwrap_or(0));
        if !self.parts.contains_key(&key) && self.parts.len() >= MAX_PARTS {
            if let Some(oldest) = self.order.pop_front() {
                self.parts.remove(&oldest);
            }
        }
        if !self.parts.contains_key(&key) {
            self.order.push_back(key);
        }
        if !self.seen.contains(&channel) {
            self.seen.push(channel);
        }
        match channel {
            Channel::Text => self.text.push_str(text),
            Channel::Reasoning => self.reasoning.push_str(text),
        }
        let part = self.parts.entry(key).or_default();
        for character in text.chars() {
            if character != '\n' {
                if part.oversized {
                    continue;
                }
                part.pending.push(character);
                part.pending_units += character.len_utf16();
                if part.pending_units > MAX_LINE {
                    part.pending.clear();
                    part.pending_units = 0;
                    part.oversized = true;
                    part.lines.clear();
                }
                continue;
            }
            let line = part.pending.trim().to_lowercase();
            part.pending.clear();
            part.pending_units = 0;
            if part.oversized {
                part.oversized = false;
                continue;
            }
            if line.starts_with("```") || line.starts_with("~~~") {
                part.fenced = !part.fenced;
                part.lines.clear();
                continue;
            }
            if part.fenced || line.is_empty() {
                continue;
            }
            // Markdown emphasis is formatting, not content, so `**do**.` is the
            // same prose line as `do.`. Leaving the markers in the charset test
            // made every bold line reset the window, so an alternating bold and
            // plain refrain never filled it and ran for thousands of lines.
            let prose = line.replace(['*', '_'], "");
            // Exclude code, JSON, tables, numbered lists and punctuation-only art.
            if is_bullet(&line)
                || !letter_pattern().is_match(&prose)
                || !prose_pattern().is_match(&prose)
            {
                part.lines.clear();
                continue;
            }
            part.lines.push_back(prose);
            if part.lines.len() > WINDOW_LINES {
                part.lines.pop_front();
            }
            if part.lines.len() != WINDOW_LINES {
                continue;
            }
            let mut counts: HashMap<&str, usize> = HashMap::new();
            for line in &part.lines {
                *counts.entry(line.as_str()).or_default() += 1;
            }
            // Count the whole recurring vocabulary, not just its two most
            // frequent lines: a four-way "let me run/go/do it/execute" loop
            // evaded the old threshold. Requiring 58 of 64 lines keeps ordinary
            // progress with a repeated refrain below the bar.
            let recurring: Vec<usize> = counts.into_values().filter(|count| *count >= 4).collect();
            if recurring.len() > 8 || recurring.iter().sum::<usize>() < 58 {
                continue;
            }
            return Some(channel);
        }
        None
    }

    /// What the attempt had already produced when the guard stopped it. The
    /// turn is durable exactly like an interrupted stream: text and reasoning
    /// the user saw are kept, and no tool call is dispatched.
    pub(crate) fn partial(&self) -> Reply {
        let content = self
            .seen
            .iter()
            .filter_map(|channel| {
                let text = match channel {
                    Channel::Text => &self.text,
                    Channel::Reasoning => &self.reasoning,
                };
                (!text.is_empty()).then(|| json!({"type": channel.part_type(), "text": text}))
            })
            .collect::<Vec<_>>();
        Reply {
            content: Value::Array(content),
            usage: Value::Null,
            needs_tools: false,
        }
    }
}

/// Also detects historical loops without rewriting their durable transcripts.
pub(crate) fn detects(text: &str) -> bool {
    let mut guard = Guard::new();
    guard
        .observe(&json!({"kind": "text.delta", "text": text}))
        .is_some()
}

/// Replace repetitive assistant prose in the provider-facing copy of the
/// history only. The model imitates its own prior output, so leaving a loop in
/// the request reseeds it; the durable row keeps what the operator saw.
pub(crate) fn neutralize(history: &mut [Message]) {
    for message in history
        .iter_mut()
        .filter(|message| message.role == "assistant")
    {
        let Some(blocks) = message.content.as_array_mut() else {
            continue;
        };
        let repetitive = blocks.iter().any(|block| {
            matches!(block["type"].as_str(), Some("text" | "reasoning"))
                && block["text"].as_str().is_some_and(detects)
        });
        if !repetitive {
            continue;
        }
        for block in blocks.iter_mut() {
            if !matches!(block["type"].as_str(), Some("text" | "reasoning")) {
                continue;
            }
            block["text"] = json!(NEUTRALIZED);
            // Provenance the replacement did not authenticate is no longer
            // portable, so the reasoning signature must not travel with it.
            if let Some(object) = block.as_object_mut() {
                object.remove("signature");
            }
        }
    }
}

fn is_bullet(line: &str) -> bool {
    let mut characters = line.chars();
    matches!(characters.next(), Some('-' | '*' | '+'))
        && characters.next().is_some_and(char::is_whitespace)
}

fn letter_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\p{L}").expect("letter pattern"))
}

fn prose_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"^[\p{L}\p{M}\s.,!?…。！？，、()（）'’"-]+$"#).expect("prose pattern")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(input: &str) -> Option<Channel> {
        let mut guard = Guard::new();
        guard.observe(&json!({"kind": "text.delta", "text": input}))
    }

    fn reasoning(input: &str) -> Option<Channel> {
        let mut guard = Guard::new();
        guard.observe(&json!({"kind": "reasoning.delta", "text": input}))
    }

    fn looped() -> String {
        "Emit.\n\nedit.\n\n".repeat(80)
    }

    #[test]
    fn detects_single_line_and_alternating_short_prose_loops() {
        assert_eq!(text(&looped()), Some(Channel::Text));
        assert_eq!(
            text(&"我发出工具调用。\n好。\n".repeat(80)),
            Some(Channel::Text)
        );
        assert_eq!(
            text(&"Let me check the entity model.\n".repeat(80)),
            Some(Channel::Text)
        );
    }

    #[test]
    fn detects_four_phrase_loops_and_larger_recurring_vocabulary() {
        let phrases = [
            "Let me run.",
            "Let me go.",
            "Let me do it.",
            "Let me execute.",
        ];
        assert_eq!(
            text(&format!("{}\n", phrases.join("\n")).repeat(100)),
            Some(Channel::Text)
        );
        let variants = [
            "Let me run.",
            "Let me go.",
            "Let me do it.",
            "Let me execute.",
            "I'll run it.",
            "Executing now.",
            "Let me output it.",
            "Here it is.",
        ];
        assert_eq!(
            text(&format!("{}\n", variants.join("\n")).repeat(20)),
            Some(Channel::Text)
        );
        // Occasional new phrasing must not reset a strongly repetitive window.
        let mixed = (0..128)
            .map(|index| match index % 16 {
                0 => format!("A new observation {}.", (b'a' + (index / 16) as u8) as char),
                _ => phrases[index % phrases.len()].to_owned(),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert_eq!(text(&mixed), Some(Channel::Text));
    }

    #[test]
    fn allows_a_refrain_interleaved_with_progress() {
        let progress = (0..128)
            .map(|index| match index % 2 {
                0 => "Let me check.".to_owned(),
                _ => format!(
                    "Inspected module {} and found its entry point.",
                    (b'a' + (index % 26) as u8) as char
                ),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert_eq!(text(&progress), None);
        assert_eq!(
            text(&"Let me run.\nLet me go.\nLet me do it.\nLet me execute.\n".repeat(8)),
            None
        );
    }

    #[test]
    fn is_invariant_to_crlf_and_unicode_chunk_boundaries() {
        let text = "好。\r\n\r\n我输出。\r\n".repeat(80);
        let mut guard = Guard::new();
        let detected = text.chars().any(|character| {
            guard
                .observe(&json!({"kind": "reasoning.delta", "text": character.to_string()}))
                .is_some()
        });
        assert!(detected);
    }

    #[test]
    fn detects_a_bold_refrain_alternating_with_plain_lines() {
        assert_eq!(
            text(&"**做**。\n（跑）\n我跑。\n".repeat(40)),
            Some(Channel::Text)
        );
    }

    #[test]
    fn allows_ordinary_progress_code_tables_lists_and_short_repetition() {
        let examples = [
            "Emit.\nedit.\n".repeat(8),
            (0..200)
                .map(|index| format!("Step {index}: inspect the next result."))
                .collect::<Vec<_>>()
                .join("\n"),
            format!("```text\n{}```\n", looped()),
            format!("~~~text\n{}~~~\n", looped()),
            "return value;\n".repeat(100),
            "{\n}\n".repeat(100),
            "| Yes | No |\n".repeat(100),
            "- item\n".repeat(100),
            "1. item\n".repeat(100),
            "**做**。\n（跑）\n我跑。\n".repeat(5),
            "x".repeat(1_000_000),
        ];
        for example in examples {
            assert_eq!(text(&example), None, "unexpected detection: {example:.80}");
        }
    }

    #[test]
    fn isolates_parts_channels_and_instances() {
        let half = "Emit.\n".repeat(40);
        let mut first = Guard::new();
        let other = json!({"kind": "text.delta", "index": 1, "text": half});
        let reasoning_other = json!({"kind": "reasoning.delta", "index": 1, "text": half});
        assert_eq!(
            first.observe(&json!({"kind": "text.delta", "index": 0, "text": half})),
            None
        );
        assert_eq!(first.observe(&other), None);
        assert_eq!(first.observe(&reasoning_other), None);
        let mut second = Guard::new();
        assert_eq!(
            second.observe(&json!({"kind": "text.delta", "index": 0, "text": half})),
            None
        );
    }

    #[test]
    fn does_not_inspect_tool_input_or_carry_counts_through_structured_output() {
        let mut guard = Guard::new();
        assert_eq!(
            guard.observe(&json!({"kind": "tool.input.delta", "index": 0, "delta": looped()})),
            None
        );
        assert_eq!(
            guard.observe(&json!({"kind": "text.delta", "text": "Emit.\n".repeat(40)})),
            None
        );
        assert_eq!(
            guard.observe(&json!({"kind": "text.delta", "text": "{\"value\": 1}\n"})),
            None
        );
        assert_eq!(
            guard.observe(&json!({"kind": "text.delta", "text": "Emit.\n".repeat(40)})),
            None
        );
    }

    #[test]
    fn detection_keeps_what_was_already_streamed() {
        let mut guard = Guard::new();
        assert_eq!(
            guard.observe(&json!({"kind": "text.delta", "text": "Start.\n"})),
            None
        );
        assert_eq!(
            guard.observe(&json!({"kind": "text.delta", "text": looped()})),
            Some(Channel::Text)
        );
        let partial = guard.partial();
        assert!(!partial.needs_tools);
        assert_eq!(partial.content[0]["type"], "text");
        assert!(partial.content[0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Start."));
    }

    #[test]
    fn neutralize_replaces_repetitive_assistant_prose_and_keeps_tools() {
        let mut history = vec![
            Message {
                role: "assistant".into(),
                content: json!([
                    {"type":"text","text":looped()},
                    {"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}
                ]),
                checkpoint: None,
                recorded_at_ms: None,
            },
            Message {
                role: "assistant".into(),
                content: json!([{"type":"reasoning","text":"我跑。\n".repeat(80),"signature":"sig"}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
            Message {
                role: "assistant".into(),
                content: json!([{"type":"text","text":"A normal answer."}]),
                checkpoint: None,
                recorded_at_ms: None,
            },
        ];
        neutralize(&mut history);
        assert_eq!(history[0].content[0]["text"], json!(NEUTRALIZED));
        assert_eq!(history[0].content[1]["name"], "read_file");
        assert_eq!(history[1].content[0]["text"], json!(NEUTRALIZED));
        assert!(history[1].content[0].get("signature").is_none());
        assert_eq!(history[2].content[0]["text"], "A normal answer.");
    }
}
