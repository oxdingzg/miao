use crate::provider::{decode_tool_call, Frame, ProviderError, Reply};
use aws_sdk_bedrockruntime::types;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct State {
    started: bool,
    stopped: bool,
    stop: Option<String>,
    blocks: BTreeMap<i32, Block>,
    usage: Option<Value>,
    bytes: usize,
    budget: crate::tool_input::ToolInputBudget,
}
struct Block {
    content: Value,
    arguments: String,
    redacted: Vec<u8>,
    open: bool,
}
impl State {
    pub(crate) fn deadline(&self) -> Option<tokio::time::Instant> {
        self.budget.deadline()
    }
    pub(crate) fn timeout(&self) -> ProviderError {
        self.budget.timeout_error()
    }
    pub(crate) fn event(
        &mut self,
        event: types::ConverseStreamOutput,
        model: &str,
    ) -> Result<Vec<Value>, ProviderError> {
        use types::ConverseStreamOutput;
        if self
            .budget
            .deadline()
            .is_some_and(|deadline| deadline <= tokio::time::Instant::now())
        {
            return Err(self.budget.timeout_error());
        }
        if let ConverseStreamOutput::MessageStart(start) = &event {
            if self.started || start.role().as_str() != "assistant" {
                return Err(invalid());
            }
            self.started = true;
            return Ok(vec![]);
        }
        if !self.started {
            return Err(invalid());
        }
        if let ConverseStreamOutput::Metadata(metadata) = event {
            if !self.stopped || self.usage.is_some() {
                return Err(invalid());
            }
            let usage = metadata.usage().ok_or_else(invalid)?;
            self.usage = Some(
                json!({"inputTokens":usage.input_tokens(),"outputTokens":usage.output_tokens(),"totalTokens":usage.total_tokens(),"cacheReadInputTokens":usage.cache_read_input_tokens(),"cacheWriteInputTokens":usage.cache_write_input_tokens()}),
            );
            return Ok(vec![]);
        }
        if self.stopped {
            return Err(invalid());
        }
        match event {
            ConverseStreamOutput::ContentBlockStart(start) => {
                let index = start.content_block_index();
                if !(0..1024).contains(&index) || self.blocks.contains_key(&index) {
                    return Err(invalid());
                }
                let Some(types::ContentBlockStart::ToolUse(tool)) = start.start() else {
                    return Err(invalid());
                };
                self.budget.frame(&Frame::Json(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","input":{}}})))?;
                self.blocks.insert(index,Block {content:json!({"type":"tool_use","id":tool.tool_use_id(),"name":tool.name()}),arguments:String::new(),redacted:Vec::new(),open:true});
                Ok(vec![
                    json!({"kind":"tool.input.start","index":index,"id":tool.tool_use_id(),"name":tool.name()}),
                ])
            }
            ConverseStreamOutput::ContentBlockDelta(delta) => {
                let index = delta.content_block_index();
                if !(0..1024).contains(&index) {
                    return Err(invalid());
                }
                let delta = delta.delta().ok_or_else(invalid)?;
                let (kind, field, text, initial) = match delta {
                    types::ContentBlockDelta::Text(text) => (
                        "text.delta",
                        "text",
                        text.as_str(),
                        json!({"type":"text","text":""}),
                    ),
                    types::ContentBlockDelta::ToolUse(tool) => {
                        ("tool.input.delta", "arguments", tool.input(), Value::Null)
                    }
                    types::ContentBlockDelta::ReasoningContent(
                        types::ReasoningContentBlockDelta::Text(text),
                    ) => (
                        "reasoning.delta",
                        "text",
                        text.as_str(),
                        json!({"type":"reasoning","text":"","signature":""}),
                    ),
                    types::ContentBlockDelta::ReasoningContent(
                        types::ReasoningContentBlockDelta::Signature(signature),
                    ) => (
                        "signature",
                        "signature",
                        signature.as_str(),
                        json!({"type":"reasoning","text":"","signature":""}),
                    ),
                    types::ContentBlockDelta::ReasoningContent(
                        types::ReasoningContentBlockDelta::RedactedContent(bytes),
                    ) => {
                        let encoded =
                            base64::engine::general_purpose::STANDARD.encode(bytes.as_ref());
                        self.bytes = self.bytes.saturating_add(encoded.len());
                        if self.bytes > 8 * 1024 * 1024 {
                            return Err(invalid());
                        }
                        let block = self.blocks.entry(index).or_insert_with(|| Block {
                            content: json!({"type":"redacted_reasoning","data":""}),
                            arguments: String::new(),
                            redacted: Vec::new(),
                            open: true,
                        });
                        if !block.open || block.content["type"] != "redacted_reasoning" {
                            return Err(invalid());
                        }
                        block.redacted.extend_from_slice(bytes.as_ref());
                        return Ok(vec![]);
                    }
                    _ => return Err(invalid()),
                };
                self.bytes = self.bytes.saturating_add(text.len());
                if self.bytes > 8 * 1024 * 1024 {
                    return Err(invalid());
                }
                if kind == "tool.input.delta" {
                    self.budget.frame(&Frame::Json(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":text}})))?;
                }
                let block = match self.blocks.entry(index) {
                    std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::btree_map::Entry::Vacant(entry) if !initial.is_null() => {
                        entry.insert(Block {
                            content: initial,
                            arguments: String::new(),
                            redacted: Vec::new(),
                            open: true,
                        })
                    }
                    _ => return Err(invalid()),
                };
                if !block.open {
                    return Err(invalid());
                }
                if field == "arguments" {
                    if block.content["type"] != "tool_use" {
                        return Err(invalid());
                    }
                    block.arguments.push_str(text);
                    return Ok(if text.is_empty() {
                        vec![]
                    } else {
                        vec![json!({"kind":kind,"index":index,"delta":text})]
                    });
                }
                let expected = if kind == "text.delta" {
                    "text"
                } else {
                    "reasoning"
                };
                if block.content["type"] != expected {
                    return Err(invalid());
                }
                let Some(Value::String(value)) = block.content.get_mut(field) else {
                    return Err(invalid());
                };
                value.push_str(text);
                if kind == "signature" || text.is_empty() {
                    return Ok(vec![]);
                }
                Ok(vec![json!({"kind":kind,"index":index,"text":text})])
            }
            ConverseStreamOutput::ContentBlockStop(stop) => {
                let index = stop.content_block_index();
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|block| block.open)
                    .ok_or_else(invalid)?;
                block.open = false;
                if block.content["type"] == "tool_use" {
                    block.content = decode_tool_call(
                        block.content["id"].as_str().ok_or_else(invalid)?,
                        block.content["name"].as_str().ok_or_else(invalid)?,
                        &block.arguments,
                    )?;
                    self.budget.frame(&Frame::Json(
                        json!({"type":"content_block_stop","index":index}),
                    ))?;
                }
                if block.content["type"] == "redacted_reasoning" {
                    block.content["data"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(&block.redacted));
                }
                if block.content["type"] == "reasoning"
                    || block.content["type"] == "redacted_reasoning"
                {
                    block.content = json!({"type":"provider_opaque","provider":"bedrock-converse","model":model,"item":block.content});
                }
                Ok(vec![])
            }
            ConverseStreamOutput::MessageStop(stop) => {
                if self.blocks.values().any(|block| block.open) {
                    return Err(invalid());
                }
                self.stopped = true;
                self.stop = Some(stop.stop_reason().as_str().into());
                Ok(vec![])
            }
            _ => Err(invalid()),
        }
    }
    pub(crate) fn finish(self) -> Result<Reply, ProviderError> {
        if !self.started
            || !self.stopped
            || self.blocks.is_empty()
            || self.blocks.values().any(|block| block.open)
        {
            return Err(invalid());
        }
        let needs_tools = self
            .blocks
            .values()
            .any(|block| block.content["type"] == "tool_use");
        if needs_tools != (self.stop.as_deref() == Some("tool_use"))
            || !matches!(
                self.stop.as_deref(),
                Some("end_turn" | "tool_use" | "max_tokens" | "stop_sequence")
            )
        {
            return Err(invalid());
        }
        if !needs_tools
            && !self.blocks.values().any(|block| {
                block.content["text"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
                    || block.content["item"]["text"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty())
            })
        {
            return Err(invalid());
        }
        Ok(Reply {
            content: Value::Array(
                self.blocks
                    .into_values()
                    .map(|block| block.content)
                    .collect(),
            ),
            usage: crate::usage::bedrock(&self.usage.unwrap_or_else(|| json!({}))),
            needs_tools,
        })
    }
}
fn invalid() -> ProviderError {
    ProviderError::Stream("incomplete or unsupported Bedrock stream".into())
}
