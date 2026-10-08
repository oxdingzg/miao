use crate::{
    credential::{Credential, Kind, Source},
    protocol::{Message, ModelRequest},
    provider::{read_stream, request_with_retry, Frame, Parser, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct OpenAIChat {
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
}

impl OpenAIChat {
    pub fn new(endpoint: String, key: String, model: String) -> Result<Self, reqwest::Error> {
        Self::with_source(endpoint, Source::Static(Credential::key(key)), model)
    }
    pub fn with_source(
        endpoint: String,
        source: Source,
        model: String,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            endpoint,
            source,
            model,
        })
    }
}

#[async_trait]
impl Provider for OpenAIChat {
    fn protected_resources(&self) -> Vec<std::path::PathBuf> {
        self.source
            .path()
            .map(|path| vec![path.to_owned()])
            .unwrap_or_default()
    }
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let credential = self.source.load().await?;
        if credential.kind() != Kind::Key {
            return Err(ProviderError::AuthProfile);
        }
        let mut messages = messages(&request.messages)?;
        if !request.system.is_empty() {
            messages.insert(0, json!({"role":"system","content":request.system}));
        }
        let tools:Vec<Value>=request.tools.iter().map(|tool|json!({"type":"function","function":{"name":tool.name,"description":tool.description,"parameters":tool.input_schema}})).collect();
        let body = json!({"model":self.model,"messages":messages,"tools":tools,"stream":true,"stream_options":{"include_usage":true},"n":1});
        let request = self
            .client
            .post(&self.endpoint)
            .bearer_auth(credential.secret())
            .json(&body)
            .build()
            .map_err(|_| ProviderError::Transport)?;
        let response = request_with_retry(&self.client, request, &progress, &cancel).await?;
        read_stream(response, progress, cancel, ChatState::default()).await
    }
}

/// Preserve text/tool-result chronology, and reject opaque blocks rather than
/// dropping them during a model/protocol switch. No implicit fallback here.
fn messages(history: &[Message]) -> Result<Vec<Value>, ProviderError> {
    let invalid = || ProviderError::Stream("history cannot be lowered to Chat Completions".into());
    let mut output = Vec::new();
    for message in history {
        let blocks = message.content.as_array().ok_or_else(invalid)?;
        let mut text = Vec::new();
        let mut calls = Vec::new();
        for block in blocks {
            match (message.role.as_str(), block["type"].as_str()) {
                ("user" | "assistant", Some("text")) => {
                    text.push(block["text"].as_str().ok_or_else(invalid)?.to_owned())
                }
                ("assistant", Some("tool_use")) => {
                    if !block["input"].is_object() {
                        return Err(invalid());
                    }
                    calls.push(json!({"id":block["id"].as_str().ok_or_else(invalid)?,"type":"function","function":{"name":block["name"].as_str().ok_or_else(invalid)?,"arguments":serde_json::to_string(&block["input"]).map_err(|_|invalid())?}}));
                }
                ("user", Some("tool_result")) => {
                    if !text.is_empty() {
                        output.push(json!({"role":"user","content":text.join("\n")}));
                        text.clear();
                    }
                    let content = block["content"].as_str().ok_or_else(invalid)?;
                    let content = if block["is_error"] == true {
                        format!("Tool error: {content}")
                    } else {
                        content.into()
                    };
                    output.push(json!({"role":"tool","tool_call_id":block["tool_use_id"].as_str().ok_or_else(invalid)?,"content":content}));
                }
                _ => return Err(invalid()),
            }
        }
        if message.role == "assistant" {
            let mut message = json!({"role":"assistant","content":if text.is_empty(){None}else{Some(text.join("\n"))}});
            if !calls.is_empty() {
                message["tool_calls"] = Value::Array(calls);
            }
            output.push(message);
        } else if !text.is_empty() {
            output.push(json!({"role":"user","content":text.join("\n")}));
        }
    }
    Ok(output)
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}
#[derive(Default)]
struct ChatState {
    text: String,
    calls: BTreeMap<u64, Call>,
    finish: Option<String>,
    usage: Value,
    done: bool,
}

impl Parser for ChatState {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError> {
        let invalid = || ProviderError::Stream("invalid Chat Completions frame".into());
        let event = match frame {
            Frame::Done => {
                self.done = true;
                return Ok(());
            }
            Frame::Json(value) => value,
        };
        if event.get("error").is_some() {
            return Err(ProviderError::Stream("provider emitted an error".into()));
        }
        if let Some(usage) = event.get("usage").filter(|v| v.is_object()) {
            self.usage = usage.clone();
        }
        let choices = event["choices"].as_array().ok_or_else(invalid)?;
        if choices.is_empty() {
            return Ok(());
        }
        if choices.len() != 1 || choices[0]["index"] != 0 {
            return Err(invalid());
        }
        let choice = &choices[0];
        let delta = &choice["delta"];
        if delta.get("refusal").is_some_and(|v| !v.is_null()) {
            return Err(ProviderError::Stream("model refused the request".into()));
        }
        if delta.get("reasoning_content").is_some_and(|v| !v.is_null())
            || delta.get("function_call").is_some()
            || delta.get("audio").is_some()
        {
            return Err(ProviderError::Stream(
                "unsupported reasoning/audio/legacy function content".into(),
            ));
        }
        if self.finish.is_some()
            && (delta.get("content").is_some_and(|v| !v.is_null())
                || delta.get("tool_calls").is_some())
        {
            return Err(invalid());
        }
        if let Some(text) = delta["content"].as_str() {
            self.text.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls") {
            for tool in calls.as_array().ok_or_else(invalid)? {
                if tool.get("type").is_some_and(|v| v != "function") {
                    return Err(invalid());
                }
                let index = tool["index"]
                    .as_u64()
                    .filter(|i| *i < 64)
                    .ok_or_else(invalid)?;
                let call = self.calls.entry(index).or_default();
                if let Some(id) = tool["id"].as_str() {
                    call.id.push_str(id);
                }
                if let Some(name) = tool["function"]["name"].as_str() {
                    call.name.push_str(name);
                }
                if let Some(args) = tool["function"]["arguments"].as_str() {
                    call.arguments.push_str(args);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            if self.finish.is_some() {
                return Err(invalid());
            }
            self.finish = Some(reason.into());
        }
        Ok(())
    }
    fn terminal(&self) -> bool {
        self.done
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        if !self.done {
            return Err(ProviderError::Stream(
                "Chat stream ended before DONE".into(),
            ));
        }
        let needs_tools = !self.calls.is_empty();
        if (needs_tools && self.finish.as_deref() != Some("tool_calls"))
            || (!needs_tools && self.finish.as_deref() != Some("stop"))
        {
            return Err(ProviderError::Stream(
                "incomplete or unsupported Chat finish reason".into(),
            ));
        }
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(json!({"type":"text","text":self.text}));
        }
        let mut ids = std::collections::HashSet::new();
        for call in self.calls.into_values() {
            if call.id.is_empty() || call.name.is_empty() || !ids.insert(call.id.clone()) {
                return Err(ProviderError::Stream("invalid tool identity".into()));
            }
            let input: Value = serde_json::from_str(&call.arguments)
                .map_err(|_| ProviderError::Stream("incomplete tool JSON".into()))?;
            if !input.is_object() {
                return Err(ProviderError::Stream("tool input must be an object".into()));
            }
            content.push(json!({"type":"tool_use","id":call.id,"name":call.name,"input":input}));
        }
        if content.is_empty() {
            return Err(ProviderError::Stream("empty completed Chat message".into()));
        }
        Ok(Reply {
            content: Value::Array(content),
            usage: self.usage,
            needs_tools,
        })
    }
}
