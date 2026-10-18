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

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum AuthStyle {
    #[default]
    Bearer,
    /// Microsoft Azure Front Door style: the secret travels in an `api-key`
    /// header, never an Authorization bearer.
    ApiKey,
}

#[derive(Clone)]
pub struct OpenAIChat {
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
    request_options: crate::request_options::Options,
    input_modalities: Vec<String>,
    auth_style: AuthStyle,
    query: Option<String>,
    extra_headers: std::collections::BTreeMap<String, String>,
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
        Self::with_auth(
            endpoint,
            source,
            model,
            AuthStyle::default(),
            Default::default(),
            None,
        )
    }

    /// Azure OpenAI authenticates with an `api-key` header against a
    /// deployment-scoped endpoint and pins the service version by query.
    pub fn with_azure(
        endpoint: String,
        source: Source,
        model: String,
        api_version: &str,
    ) -> Result<Self, reqwest::Error> {
        Self::with_auth(
            endpoint,
            source,
            model,
            AuthStyle::ApiKey,
            Default::default(),
            Some(format!("api-version={}", api_version)),
        )
    }

    /// Declarative constructor for gateway/provider manifests: auth style,
    /// extra trusted headers, and literal query parameters.
    pub fn with_auth(
        endpoint: String,
        source: Source,
        model: String,
        auth_style: AuthStyle,
        extra_headers: std::collections::BTreeMap<String, String>,
        query: Option<String>,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            endpoint,
            source,
            model,
            request_options: Default::default(),
            input_modalities: vec![],
            auth_style,
            query,
            extra_headers,
        })
    }
}

#[async_trait]
impl Provider for OpenAIChat {
    fn with_route_auth(
        &self,
        auth: &crate::model_routes::Auth,
    ) -> Result<std::sync::Arc<dyn Provider>, ProviderError> {
        auth.validate()?;
        let mut selected = self.clone();
        selected.auth_style = match auth.style.as_deref() {
            None => selected.auth_style,
            Some("bearer") => AuthStyle::Bearer,
            Some("api-key") => AuthStyle::ApiKey,
            _ => {
                return Err(ProviderError::Stream(
                    "unsupported Chat route auth style".into(),
                ))
            }
        };
        if let Some(query) = auth.query_string()? {
            selected.query = Some(query);
        }
        auth.apply_headers(&mut selected.extra_headers);
        Ok(std::sync::Arc::new(selected))
    }
    fn with_input_modalities(
        &self,
        input: Vec<String>,
    ) -> Result<std::sync::Arc<dyn Provider>, ProviderError> {
        crate::media::validate_modalities(&input)?;
        let mut selected = self.clone();
        selected.input_modalities = input;
        Ok(std::sync::Arc::new(selected))
    }
    fn with_request_options(
        &self,
        mut options: crate::request_options::Options,
    ) -> Result<std::sync::Arc<dyn Provider>, ProviderError> {
        options.validate()?;
        let mut selected = self.clone();
        for (name, value) in std::mem::take(&mut options.headers) {
            selected
                .extra_headers
                .retain(|key, _| !key.eq_ignore_ascii_case(&name));
            selected.extra_headers.insert(name, value);
        }
        selected.request_options = self.request_options.merged(&options)?;
        Ok(std::sync::Arc::new(selected))
    }
    fn for_model(&self, model: &str) -> Option<std::sync::Arc<dyn Provider>> {
        if !crate::provider::valid_model(model) {
            return None;
        }
        let mut selected = self.clone();
        selected.model = model.to_owned();
        Some(std::sync::Arc::new(selected))
    }
    fn identity(&self) -> Option<crate::provider::Identity> {
        Some(crate::provider::Identity {
            protocol: "openai-chat".into(),
            model: self.model.clone(),
        })
    }
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
        self.stream_mode(request, progress, cancel, false).await
    }
    fn supports_tool_free_stream(&self) -> bool {
        true
    }
    async fn stream_without_tools(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.stream_mode(request, progress, cancel, true).await
    }
}
impl OpenAIChat {
    async fn stream_mode(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
        without_tools: bool,
    ) -> Result<Reply, ProviderError> {
        let request = crate::media::normalize(request, "openai-chat", &self.input_modalities)?;
        let credential = self.source.load().await?;
        if credential.kind() != Kind::Key {
            return Err(ProviderError::AuthProfile);
        }
        let mut messages = messages(&request.messages)?;
        if !request.system.is_empty() {
            messages.insert(0, json!({"role":"system","content":request.system}));
        }
        let tools:Vec<Value>=request.tools.iter().map(|tool|json!({"type":"function","function":{"name":tool.name,"description":tool.description,"parameters":tool.input_schema}})).collect();
        let mut body = json!({"model":self.model,"messages":messages,"tools":tools,"stream":true,"stream_options":{"include_usage":true},"n":1});
        self.request_options.apply(&mut body);
        if without_tools {
            body["tool_choice"] = json!("none");
        }
        let mut url = reqwest::Url::parse(&self.endpoint).map_err(|_| ProviderError::Transport)?;
        if let Some(query) = self.query.as_deref() {
            url.set_query(Some(query));
        }
        let mut request = self.client.post(url).json(&body);
        request = match self.auth_style {
            AuthStyle::Bearer => request.bearer_auth(credential.secret()),
            AuthStyle::ApiKey => request.header("api-key", credential.secret()),
        };
        let request = crate::provider::route_headers(
            self.request_options.headers(request)?,
            &self.extra_headers,
        )?
        .build()
        .map_err(|_| ProviderError::Transport)?;
        let response =
            request_with_retry("openai-chat", &self.client, request, &progress, &cancel).await?;
        read_stream(response, progress, cancel, ChatState::default()).await
    }
}

/// A user turn is a plain string when text-only, and a typed part array when it
/// carries image attachments.
fn user_content(text: &[String], images: &[Value]) -> Value {
    if images.is_empty() {
        return Value::String(text.join("\n"));
    }
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(json!({"type":"text","text":text.join("\n")}));
    }
    parts.extend(images.iter().cloned());
    Value::Array(parts)
}

/// Preserve text/tool-result chronology, and reject opaque blocks rather than
/// dropping them during a model/protocol switch. No implicit fallback here.
fn messages(history: &[Message]) -> Result<Vec<Value>, ProviderError> {
    let invalid = || ProviderError::Stream("history cannot be lowered to Chat Completions".into());
    let mut output = Vec::new();
    for message in history {
        let blocks = message.content.as_array().ok_or_else(invalid)?;
        let mut text = Vec::new();
        let mut images = Vec::new();
        let mut calls = Vec::new();
        let mut reasoning = Vec::new();
        for block in blocks {
            match (message.role.as_str(), block["type"].as_str()) {
                ("user" | "assistant", Some("text")) => {
                    text.push(block["text"].as_str().ok_or_else(invalid)?.to_owned())
                }
                // Reasoning text must return to the provider verbatim and in
                // order; GLM interleaved/preserved thinking and DeepSeek both
                // require it across tool calls.
                ("assistant", Some("reasoning")) => {
                    reasoning.push(block["text"].as_str().ok_or_else(invalid)?.to_owned())
                }
                ("user", Some("image")) => {
                    let mime = block["mime"].as_str().ok_or_else(invalid)?;
                    let data = block["data"].as_str().ok_or_else(invalid)?;
                    images.push(json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{data}")}}));
                }
                ("assistant", Some("tool_use")) => {
                    if !block["input"].is_object() {
                        return Err(invalid());
                    }
                    calls.push(json!({"id":block["id"].as_str().ok_or_else(invalid)?,"type":"function","function":{"name":block["name"].as_str().ok_or_else(invalid)?,"arguments":serde_json::to_string(&block["input"]).map_err(|_|invalid())?}}));
                }
                ("user", Some("tool_result")) => {
                    if !text.is_empty() || !images.is_empty() {
                        output.push(json!({"role":"user","content":user_content(&text,&images)}));
                        text.clear();
                        images.clear();
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
            if !reasoning.is_empty() {
                message["reasoning_content"] = Value::String(reasoning.join(""));
            }
            if !calls.is_empty() {
                message["tool_calls"] = Value::Array(calls);
            }
            output.push(message);
        } else if !text.is_empty() || !images.is_empty() {
            output.push(json!({"role":"user","content":user_content(&text,&images)}));
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
    reasoning: String,
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
        if delta.get("function_call").is_some()
            || delta.get("audio").is_some()
            || delta.get("reasoning_opaque").is_some_and(|v| !v.is_null())
        {
            return Err(ProviderError::Stream(
                "unsupported Chat Completions content field".into(),
            ));
        }
        for field in ["reasoning_content", "reasoning_text"] {
            if let Some(text) = delta[field].as_str() {
                self.reasoning.push_str(text);
            }
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
    fn interrupted(self) -> ProviderError {
        if self.text.is_empty() && self.calls.is_empty() {
            return ProviderError::ResponseTransport;
        }
        ProviderError::ContinuableTransport {
            partial: Reply {
                content: if self.text.is_empty() {
                    json!([])
                } else {
                    json!([{"type":"text","text":self.text}])
                },
                usage: if self.usage.is_null() {
                    Value::Null
                } else {
                    self.usage
                },
                needs_tools: false,
            },
            unexecuted_calls: self.calls.len(),
        }
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        if !self.done {
            return Err(ProviderError::Stream(
                "Chat stream ended before DONE".into(),
            ));
        }
        let needs_tools = !self.calls.is_empty();
        // A `length` stop means the provider truncated the reply. Partial tool
        // arguments must never execute, so the committed partial carries only
        // reasoning and text while the runtime re-issues a bounded
        // continuation from durable history.
        if self.finish.as_deref() == Some("length") {
            let unexecuted_calls = self.calls.len();
            let mut content = Vec::new();
            if !self.reasoning.is_empty() {
                content.push(json!({"type":"reasoning","text":self.reasoning}));
            }
            if !self.text.is_empty() {
                content.push(json!({"type":"text","text":self.text}));
            }
            if content.is_empty() && unexecuted_calls == 0 {
                return Err(ProviderError::ResponseTransport);
            }
            return Err(ProviderError::ContinuableTransport {
                partial: Reply {
                    content: Value::Array(content),
                    usage: self.usage,
                    needs_tools: false,
                },
                unexecuted_calls,
            });
        }
        if (needs_tools && self.finish.as_deref() != Some("tool_calls"))
            || (!needs_tools && self.finish.as_deref() != Some("stop"))
        {
            return Err(ProviderError::Stream(
                "incomplete or unsupported Chat finish reason".into(),
            ));
        }
        if self.text.is_empty() && self.calls.is_empty() {
            return Err(ProviderError::Stream("empty completed Chat message".into()));
        }
        let mut content = Vec::new();
        if !self.reasoning.is_empty() {
            content.push(json!({"type":"reasoning","text":self.reasoning}));
        }
        if !self.text.is_empty() {
            content.push(json!({"type":"text","text":self.text}));
        }
        let mut ids = std::collections::HashSet::new();
        for call in self.calls.into_values() {
            if call.id.is_empty() || call.name.is_empty() || !ids.insert(call.id.clone()) {
                return Err(ProviderError::Stream("invalid tool identity".into()));
            }
            content.push(crate::provider::decode_tool_call(
                &call.id,
                &call.name,
                &call.arguments,
            )?);
        }
        Ok(Reply {
            content: Value::Array(content),
            usage: crate::usage::chat(&self.usage),
            needs_tools,
        })
    }
}
