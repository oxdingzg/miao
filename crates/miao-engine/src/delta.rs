//! Normalized provider deltas.
//!
//! A provider emits its own wire frames (OpenAI `choices`, Anthropic
//! `content_block_delta`, Responses typed events, Gemini `candidates`). The
//! engine keeps those frames for its own first-event and tool-input logic, and
//! additionally publishes a normalized delta so a client never has to parse a
//! provider format. Shapes are recognized by their own structure; the framings
//! are unambiguous, so no protocol name is needed here.

use serde_json::Value;

/// Normalize one provider frame into the shared delta vocabulary, or `None`
/// when the frame carries no normalized fact. Text only for now.
pub(crate) fn normalize(frame: &Value) -> Option<Value> {
    let text = [
        responses_text(frame),
        anthropic_text(frame),
        chat_text(frame),
        gemini_text(frame),
    ]
    .into_iter()
    .flatten()
    .find_map(|text| text)?;
    Some(text_delta(&text))
}

fn text_delta(text: &str) -> Value {
    serde_json::json!({"kind": "text.delta", "text": text})
}

fn non_empty(text: Option<&Value>) -> Option<String> {
    let text = text?.as_str()?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_owned())
}

fn responses_text(frame: &Value) -> Option<Option<String>> {
    if frame["type"].as_str() != Some("response.output_text.delta") {
        return None;
    }
    Some(non_empty(frame.get("delta")))
}

fn anthropic_text(frame: &Value) -> Option<Option<String>> {
    if frame["type"].as_str() != Some("content_block_delta") {
        return None;
    }
    if frame["delta"]["type"].as_str() != Some("text_delta") {
        return Some(None);
    }
    Some(non_empty(frame["delta"].get("text")))
}

fn chat_text(frame: &Value) -> Option<Option<String>> {
    let choices = frame.get("choices")?.as_array()?;
    if choices.len() != 1 || choices[0]["index"] != 0 {
        return Some(None);
    }
    Some(non_empty(choices[0]["delta"].get("content")))
}

fn gemini_text(frame: &Value) -> Option<Option<String>> {
    let candidates = frame.get("candidates")?.as_array()?;
    if candidates.len() != 1 || candidates[0].get("index").is_some_and(|index| index != 0) {
        return Some(None);
    }
    let text = candidates[0]["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["thought"] != true)
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    Some(if text.is_empty() { None } else { Some(text) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognizes_each_protocols_text_delta() {
        assert_eq!(
            normalize(&json!({"type":"response.output_text.delta","delta":"a"})),
            Some(json!({"kind":"text.delta","text":"a"}))
        );
        assert_eq!(
            normalize(
                &json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}})
            ),
            Some(json!({"kind":"text.delta","text":"b"}))
        );
        assert_eq!(
            normalize(&json!({"choices":[{"index":0,"delta":{"content":"c"}}]})),
            Some(json!({"kind":"text.delta","text":"c"}))
        );
        assert_eq!(
            normalize(&json!({"candidates":[{"content":{"parts":[{"text":"d"}]}}]})),
            Some(json!({"kind":"text.delta","text":"d"}))
        );
    }

    #[test]
    fn rejects_alternative_candidates_and_ignores_empty_payloads() {
        assert_eq!(
            normalize(&json!({"choices":[{"delta":{"content":"a"}},{"delta":{"content":"b"}}]})),
            None
        );
        assert_eq!(
            normalize(&json!({"choices":[{"index":1,"delta":{"content":"alternative"}}]})),
            None
        );
        assert_eq!(
            normalize(
                &json!({"candidates":[{"index":0,"content":{"parts":[{"text":"a"}]}},{"index":1,"content":{"parts":[{"text":"b"}]}}]})
            ),
            None
        );
        assert_eq!(
            normalize(
                &json!({"candidates":[{"index":1,"content":{"parts":[{"text":"alternative"}]}}]})
            ),
            None
        );
        assert_eq!(
            normalize(&json!({"choices":[{"delta":{"role":"assistant"}}]})),
            None
        );
        assert_eq!(
            normalize(&json!({"candidates":[{"content":{"parts":[]}}]})),
            None
        );
        assert_eq!(
            normalize(&json!({"type":"content_block_delta","delta":{"type":"input_json_delta"}})),
            None
        );
    }

    #[test]
    fn gemini_answer_text_excludes_thought_parts() {
        assert_eq!(
            normalize(&json!({"candidates":[{"content":{"parts":[
                {"text":"private reasoning","thought":true},
                {"text":"answer "},{"text":"fragment"}
            ]}}]})),
            Some(json!({"kind":"text.delta","text":"answer fragment"}))
        );
        assert_eq!(
            normalize(
                &json!({"candidates":[{"content":{"parts":[{"text":"reasoning","thought":true}]}}]})
            ),
            None
        );
    }

    #[test]
    fn non_text_frames_are_not_normalized() {
        assert_eq!(
            normalize(&json!({"type":"message_start","message":{}})),
            None
        );
        assert_eq!(normalize(&json!({"usage":{"input_tokens":1}})), None);
        assert_eq!(
            normalize(&json!({"candidates":[{"finishReason":"STOP"}]})),
            None
        );
    }
}
