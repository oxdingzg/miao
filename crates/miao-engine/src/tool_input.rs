use crate::provider::{Frame, ProviderError};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;

/// Per-call wire budgets are independent of network activity and SSE frame size.
pub(crate) struct ToolInputBudget {
    max_bytes: usize,
    timeout: Duration,
    pending: BTreeMap<String, (usize, Instant)>,
}

impl Default for ToolInputBudget {
    fn default() -> Self {
        Self {
            max_bytes: std::env::var("MIAO_TOOL_INPUT_MAX_BYTES")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|value| *value > 0)
                .unwrap_or(1024 * 1024),
            timeout: Duration::from_millis(
                std::env::var("MIAO_TOOL_INPUT_TIMEOUT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(120_000),
            ),
            pending: BTreeMap::new(),
        }
    }
}

impl ToolInputBudget {
    #[cfg(test)]
    pub(crate) fn testing(max_bytes: usize, timeout: Duration) -> Self {
        Self {
            max_bytes,
            timeout,
            pending: BTreeMap::new(),
        }
    }

    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.pending.values().map(|value| value.1).min()
    }

    fn append(&mut self, id: String, bytes: usize) -> Result<(), ProviderError> {
        let value = self
            .pending
            .entry(id)
            .or_insert_with(|| (0, Instant::now() + self.timeout));
        value.0 = value.0.saturating_add(bytes);
        let bytes = value.0;
        self.size(bytes)
    }

    fn size(&self, bytes: usize) -> Result<(), ProviderError> {
        if bytes > self.max_bytes {
            return Err(ProviderError::Stream(
                "tool input exceeds byte budget".into(),
            ));
        }
        Ok(())
    }

    fn object(&self, input: &Value) -> Result<(), ProviderError> {
        self.size(
            serde_json::to_vec(input)
                .map_err(|_| ProviderError::Stream("invalid tool input".into()))?
                .len(),
        )
    }

    pub(crate) fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError> {
        if self
            .deadline()
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            return Err(ProviderError::Stream(
                "tool input time budget exceeded".into(),
            ));
        }
        let Frame::Json(event) = frame else {
            return Ok(());
        };
        match event["type"].as_str() {
            Some("content_block_start") if event["content_block"]["type"] == "tool_use" => {
                self.object(&event["content_block"]["input"])?;
                self.append(format!("anthropic:{}", event["index"]), 0)?;
            }
            Some("content_block_delta") if event["delta"]["type"] == "input_json_delta" => {
                self.append(
                    format!("anthropic:{}", event["index"]),
                    event["delta"]["partial_json"].as_str().unwrap_or("").len(),
                )?;
            }
            Some("content_block_stop") => {
                self.pending
                    .remove(&format!("anthropic:{}", event["index"]));
            }
            Some("response.output_item.added") if event["item"]["type"] == "function_call" => {
                self.append(format!("responses:{}", event["output_index"]), 0)?;
                self.size(event["item"]["arguments"].as_str().unwrap_or("").len())?;
            }
            Some("response.function_call_arguments.delta") => {
                self.append(
                    format!("responses:{}", event["output_index"]),
                    event["delta"].as_str().unwrap_or("").len(),
                )?;
            }
            Some("response.function_call_arguments.done") => {
                self.size(event["arguments"].as_str().unwrap_or("").len())?;
                self.pending
                    .remove(&format!("responses:{}", event["output_index"]));
            }
            Some("response.output_item.done") if event["item"]["type"] == "function_call" => {
                self.size(event["item"]["arguments"].as_str().unwrap_or("").len())?;
                self.pending
                    .remove(&format!("responses:{}", event["output_index"]));
            }
            Some("response.completed") => {
                for item in event["response"]["output"].as_array().into_iter().flatten() {
                    if item["type"] == "function_call" {
                        self.size(item["arguments"].as_str().unwrap_or("").len())?;
                    }
                }
            }
            _ => {}
        }
        for choice in event["choices"].as_array().into_iter().flatten() {
            for call in choice["delta"]["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
            {
                self.append(
                    format!("chat:{}:{}", choice["index"], call["index"]),
                    call["function"]["arguments"].as_str().unwrap_or("").len(),
                )?;
            }
            if choice["finish_reason"].as_str().is_some() {
                let prefix = format!("chat:{}:", choice["index"]);
                self.pending.retain(|id, _| !id.starts_with(&prefix));
            }
        }
        for candidate in event["candidates"].as_array().into_iter().flatten() {
            for part in candidate["content"]["parts"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(call) = part.get("functionCall") {
                    self.object(&call["args"])?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ToolInputBudget;
    use crate::provider::Frame;
    use serde_json::json;
    use std::{collections::BTreeMap, time::Duration};

    fn budget() -> ToolInputBudget {
        ToolInputBudget {
            max_bytes: 8,
            timeout: Duration::from_millis(10),
            pending: BTreeMap::new(),
        }
    }

    #[test]
    fn deltas_count_utf8_bytes_per_call_across_frames() {
        let mut budget = budget();
        for index in [0, 1] {
            budget.frame(&Frame::Json(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","input":{}}}))).unwrap();
            budget.frame(&Frame::Json(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":"你好"}}))).unwrap();
        }
        assert!(budget.frame(&Frame::Json(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"你"}}))).is_err());
    }

    #[test]
    fn chat_and_responses_accumulate_across_small_frames() {
        let mut chat = budget();
        let frame = Frame::Json(
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"12345"}}]}}]}),
        );
        chat.frame(&frame).unwrap();
        assert!(chat.frame(&frame).is_err());
        let mut responses = budget();
        let frame = Frame::Json(
            json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"12345"}),
        );
        responses.frame(&frame).unwrap();
        assert!(responses.frame(&frame).is_err());
    }

    #[test]
    fn final_only_calls_and_authoritative_arguments_are_bounded() {
        for event in [
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","input":{"x":"12345"}}}),
            json!({"type":"response.function_call_arguments.done","output_index":0,"arguments":"123456789"}),
            json!({"type":"response.output_item.done","item":{"type":"function_call","arguments":"123456789"}}),
            json!({"type":"response.completed","response":{"output":[{"type":"function_call","arguments":"123456789"}]}}),
            json!({"candidates":[{"content":{"parts":[{"functionCall":{"args":{"x":"12345"}}}]}}]}),
        ] {
            assert!(budget().frame(&Frame::Json(event)).is_err());
        }
    }

    #[tokio::test]
    async fn pings_do_not_refill_deadlines_and_finished_calls_release_them() {
        let mut budget = budget();
        budget.frame(&Frame::Json(json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call"}}))).unwrap();
        let deadline = budget.deadline().unwrap();
        budget
            .frame(&Frame::Json(json!({"type":"response.in_progress"})))
            .unwrap();
        assert_eq!(budget.deadline(), Some(deadline));
        tokio::time::sleep_until(deadline).await;
        assert!(budget
            .frame(&Frame::Json(json!({"type":"response.in_progress"})))
            .is_err());
        let mut finished = super::ToolInputBudget {
            timeout: Duration::from_secs(1),
            ..self::budget()
        };
        finished.frame(&Frame::Json(json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}))).unwrap();
        finished.frame(&Frame::Json(json!({"type":"response.function_call_arguments.done","output_index":0,"arguments":"{}"}))).unwrap();
        assert!(finished.deadline().is_none());
    }
}
