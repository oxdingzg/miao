//! Normalized provider deltas.
//!
//! A provider emits its own wire frames (OpenAI `choices`, Anthropic
//! `content_block_delta`, Responses typed events, Gemini `candidates`). The
//! engine keeps those frames for its own first-event and tool-input logic, and
//! additionally publishes a normalized delta so a client never has to parse a
//! provider format. Shapes are recognized by their own structure; the framings
//! are unambiguous, so no protocol name is needed here.
//!
//! Vocabulary: `text.delta` and `reasoning.delta` carry `text` plus the
//! provider block `index` when the protocol provides one; `tool.input.delta`
//! carries the tool-call `index` and the raw JSON argument fragment. Frames
//! the engine handles elsewhere (signatures, block starts/dones, complete
//! Gemini function calls) are claimed but produce no normalized delta.

use serde_json::{json, Value};

/// Normalize one provider frame into the shared delta vocabulary. Empty when
/// the frame carries no normalized fact.
pub(crate) fn normalize(frame: &Value) -> Vec<Value> {
    let mut deltas = Vec::new();
    deltas.extend(responses_deltas(frame));
    deltas.extend(anthropic_deltas(frame));
    deltas.extend(chat_deltas(frame));
    deltas.extend(gemini_deltas(frame));
    deltas
}

fn text_delta(text: &str, index: Option<u64>) -> Value {
    with_index(json!({"kind": "text.delta", "text": text}), index)
}

fn reasoning_delta(text: &str, index: Option<u64>) -> Value {
    with_index(json!({"kind": "reasoning.delta", "text": text}), index)
}

fn tool_input_delta(index: u64, fragment: &str) -> Value {
    json!({"kind": "tool.input.delta", "index": index, "delta": fragment})
}

fn with_index(mut delta: Value, index: Option<u64>) -> Value {
    if let (Some(object), Some(index)) = (delta.as_object_mut(), index) {
        object.insert("index".into(), json!(index));
    }
    delta
}

fn non_empty(text: Option<&Value>) -> Option<String> {
    let text = text?.as_str()?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_owned())
}

fn responses_deltas(frame: &Value) -> Vec<Value> {
    let index = frame["output_index"].as_u64();
    if frame["type"].as_str() == Some("response.output_item.added")
        && frame["item"]["type"].as_str() == Some("function_call")
    {
        return tool_start(
            frame["item"]["call_id"].as_str(),
            frame["item"]["name"].as_str(),
            index,
        );
    }
    match frame["type"].as_str() {
        Some("response.output_text.delta") => {
            let mut deltas = Vec::new();
            if let Some(text) = non_empty(frame.get("delta")) {
                deltas.push(text_delta(&text, index));
            }
            deltas
        }
        Some("response.reasoning_text.delta" | "response.reasoning_summary_text.delta") => {
            let mut deltas = Vec::new();
            if let Some(text) = non_empty(frame.get("delta")) {
                deltas.push(reasoning_delta(&text, index));
            }
            deltas
        }
        Some("response.function_call_arguments.delta") => {
            let mut deltas = Vec::new();
            if let (Some(index), Some(fragment)) = (index, non_empty(frame.get("delta"))) {
                deltas.push(tool_input_delta(index, &fragment));
            }
            deltas
        }
        // Block starts/dones and annotations belong to the engine's own
        // response-item logic; the raw frame stays on the notice either way.
        _ => Vec::new(),
    }
}

fn anthropic_deltas(frame: &Value) -> Vec<Value> {
    if frame["type"].as_str() == Some("content_block_start")
        && frame["content_block"]["type"].as_str() == Some("tool_use")
    {
        return tool_start(
            frame["content_block"]["id"].as_str(),
            frame["content_block"]["name"].as_str(),
            frame["index"].as_u64(),
        );
    }
    if frame["type"].as_str() != Some("content_block_delta") {
        return Vec::new();
    }
    let index = frame["index"].as_u64();
    match frame["delta"]["type"].as_str() {
        Some("text_delta") => non_empty(frame["delta"].get("text"))
            .map(|text| vec![text_delta(&text, index)])
            .unwrap_or_default(),
        Some("thinking_delta") => non_empty(frame["delta"].get("thinking"))
            .map(|text| vec![reasoning_delta(&text, index)])
            .unwrap_or_default(),
        Some("input_json_delta") => match (index, non_empty(frame["delta"].get("partial_json"))) {
            (Some(index), Some(fragment)) => vec![tool_input_delta(index, &fragment)],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn chat_deltas(frame: &Value) -> Vec<Value> {
    let Some(choices) = frame.get("choices").and_then(Value::as_array) else {
        return Vec::new();
    };
    if choices.len() != 1 || choices[0]["index"] != 0 {
        return Vec::new();
    }
    let delta = &choices[0]["delta"];
    let mut deltas = Vec::new();
    for call in delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        deltas.extend(tool_start(
            call["id"].as_str(),
            call["function"]["name"].as_str(),
            call["index"].as_u64(),
        ));
    }
    if let Some(text) = non_empty(delta.get("content")) {
        deltas.push(text_delta(&text, None));
    }
    for field in ["reasoning_content", "reasoning_text"] {
        if let Some(text) = non_empty(delta.get(field)) {
            deltas.push(reasoning_delta(&text, None));
            break;
        }
    }
    for call in delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let (Some(index), Some(fragment)) = (
            call["index"].as_u64(),
            non_empty(Some(&call["function"]["arguments"])),
        ) {
            deltas.push(tool_input_delta(index, &fragment));
        }
    }
    deltas
}

/// A streamed tool call's identity. Requires an id and a call index: without
/// either, a client cannot key the fragments that follow.
fn tool_start(id: Option<&str>, name: Option<&str>, index: Option<u64>) -> Vec<Value> {
    match (id, name, index) {
        (Some(id), Some(name), Some(index)) if !id.is_empty() && !name.is_empty() => {
            vec![json!({"kind": "tool.start", "index": index, "id": id, "name": name})]
        }
        _ => Vec::new(),
    }
}

fn gemini_deltas(frame: &Value) -> Vec<Value> {
    let Some(candidates) = frame.get("candidates").and_then(Value::as_array) else {
        return Vec::new();
    };
    if candidates.len() != 1 || candidates[0].get("index").is_some_and(|index| index != 0) {
        return Vec::new();
    }
    let parts = candidates[0]["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten();
    let mut deltas = Vec::new();
    let mut text = String::new();
    let mut reasoning = String::new();
    for part in parts {
        match part["thought"] {
            Value::Bool(true) => {
                if let Some(fragment) = part["text"].as_str() {
                    reasoning.push_str(fragment);
                }
            }
            _ => {
                if let Some(fragment) = part["text"].as_str() {
                    text.push_str(fragment);
                }
            }
        }
    }
    if !text.is_empty() {
        deltas.push(text_delta(&text, None));
    }
    if !reasoning.is_empty() {
        deltas.push(reasoning_delta(&reasoning, None));
    }
    deltas
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kinds(deltas: &[Value]) -> Vec<&str> {
        deltas
            .iter()
            .filter_map(|delta| delta["kind"].as_str())
            .collect()
    }

    #[test]
    fn recognizes_each_protocols_text_delta() {
        assert_eq!(
            normalize(&json!({"type":"response.output_text.delta","output_index":0,"delta":"a"})),
            vec![json!({"kind":"text.delta","text":"a","index":0})]
        );
        assert_eq!(
            normalize(
                &json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"b"}})
            ),
            vec![json!({"kind":"text.delta","text":"b","index":1})]
        );
        assert_eq!(
            normalize(&json!({"choices":[{"index":0,"delta":{"content":"c"}}]})),
            vec![json!({"kind":"text.delta","text":"c"})]
        );
        assert_eq!(
            normalize(&json!({"candidates":[{"content":{"parts":[{"text":"d"}]}}]})),
            vec![json!({"kind":"text.delta","text":"d"})]
        );
    }

    #[test]
    fn empty_fragments_stay_silent() {
        assert!(normalize(&json!({"type":"response.output_text.delta","delta":""})).is_empty());
        assert!(normalize(
            &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}})
        )
        .is_empty());
        assert!(normalize(&json!({"choices":[{"index":0,"delta":{}}]})).is_empty());
    }

    #[test]
    fn reasoning_fragments_normalize_across_protocols() {
        assert_eq!(
            normalize(
                &json!({"type":"response.reasoning_text.delta","output_index":1,"delta":"think"})
            ),
            vec![json!({"kind":"reasoning.delta","text":"think","index":1})]
        );
        assert_eq!(
            normalize(&json!({"type":"response.reasoning_summary_text.delta","delta":"sum"})),
            vec![json!({"kind":"reasoning.delta","text":"sum"})]
        );
        assert_eq!(
            normalize(
                &json!({"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"hmm"}})
            ),
            vec![json!({"kind":"reasoning.delta","text":"hmm","index":2})]
        );
        assert_eq!(
            normalize(&json!({"choices":[{"index":0,"delta":{"reasoning_content":"why"}}]})),
            vec![json!({"kind":"reasoning.delta","text":"why"})]
        );
        assert_eq!(
            normalize(&json!({"choices":[{"index":0,"delta":{"reasoning_text":"how"}}]})),
            vec![json!({"kind":"reasoning.delta","text":"how"})]
        );
        assert_eq!(
            normalize(
                &json!({"candidates":[{"content":{"parts":[{"text":"deep","thought":true}]}}]})
            ),
            vec![json!({"kind":"reasoning.delta","text":"deep"})]
        );
    }

    #[test]
    fn tool_input_fragments_carry_their_call_index() {
        assert_eq!(
            normalize(
                &json!({"type":"response.function_call_arguments.delta","output_index":3,"delta":"[3,4"})
            ),
            vec![json!({"kind":"tool.input.delta","index":3,"delta":"[3,4"})]
        );
        assert_eq!(
            normalize(
                &json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"[1,2"}})
            ),
            vec![json!({"kind":"tool.input.delta","index":1,"delta":"[1,2"})]
        );
        assert_eq!(
            normalize(
                &json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[5,6"}}]}}]})
            ),
            vec![json!({"kind":"tool.input.delta","index":0,"delta":"[5,6"})]
        );
    }

    #[test]
    fn one_frame_can_carry_several_fragments() {
        let deltas = normalize(&json!({"choices":[{"index":0,"delta":{
            "content":"hi",
            "reasoning_content":"hmm",
            "tool_calls":[{"index":2,"function":{"arguments":"{}"}}]
        }}]}));
        assert_eq!(
            kinds(&deltas),
            vec!["text.delta", "reasoning.delta", "tool.input.delta"]
        );
    }

    #[test]
    fn tool_starts_carry_identity_and_index() {
        assert_eq!(
            normalize(
                &json!({"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}})
            ),
            vec![json!({"kind":"tool.start","index":4,"id":"toolu_1","name":"read_file"})]
        );
        assert_eq!(
            normalize(
                &json!({"type":"response.output_item.added","output_index":5,"item":{"type":"function_call","call_id":"call_1","name":"grep"}})
            ),
            vec![json!({"kind":"tool.start","index":5,"id":"call_1","name":"grep"})]
        );
        assert_eq!(
            normalize(
                &json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"bash","arguments":""}}]}}]})
            ),
            vec![json!({"kind":"tool.start","index":0,"id":"call","name":"bash"})]
        );
    }

    #[test]
    fn tool_starts_without_identity_stay_silent() {
        assert!(normalize(&json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})).is_empty());
        assert!(normalize(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"","name":"read_file"}})).is_empty());
        // An id-less chat call still streams its fragments; only the start needs identity.
        assert_eq!(
            normalize(
                &json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]})
            ),
            vec![json!({"kind":"tool.input.delta","index":0,"delta":"{}"})]
        );
    }

    #[test]
    fn signature_and_lifecycle_frames_are_claimed_silently() {
        assert!(normalize(&json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}})).is_empty());
        assert!(normalize(&json!({"type":"response.output_text.done","text":"done"})).is_empty());
        assert!(normalize(
            &json!({"type":"response.function_call_arguments.done","arguments":"{}"})
        )
        .is_empty());
        // Complete Gemini function calls are not deltas.
        assert!(normalize(
            &json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file"}}]}}]})
        )
        .is_empty());
    }

    #[test]
    fn gemini_thought_and_text_stay_separate() {
        let deltas = normalize(&json!({"candidates":[{"content":{"parts":[
            {"text":"why","thought":true},{"text":"answer"}
        ]}}]}));
        assert_eq!(kinds(&deltas), vec!["text.delta", "reasoning.delta"]);
        assert_eq!(deltas[0]["text"], "answer");
        assert_eq!(deltas[1]["text"], "why");
    }

    #[test]
    fn normalized_deltas_never_carry_a_map_outside_the_known_keys() {
        let deltas = normalize(
            &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}),
        );
        assert_eq!(deltas[0].as_object().map(|object| object.len()), Some(3));
    }
}
