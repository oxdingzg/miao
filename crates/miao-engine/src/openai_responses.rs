use crate::{
    credential::{Credential, Kind, Source},
    protocol::{Message, ModelRequest},
    provider::{read_stream, request_with_retry, Frame, Parser, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// API-key Responses adapter. Subscription OAuth, account routing and refresh
/// are a separate credential integration, not implicit endpoint substitution.
#[derive(Clone, Copy)]
pub enum Profile {
    Api,
    Subscription,
}

#[derive(Clone)]
pub struct OpenAIResponses {
    profile: Profile,
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
    cache_contract: Option<crate::responses_cache::Contract>,
    websocket_contract: Option<crate::responses_websocket::Contract>,
    websocket_pool: std::sync::Arc<crate::responses_websocket::Pool>,
}
impl OpenAIResponses {
    pub fn new(endpoint: String, key: String, model: String) -> Result<Self, reqwest::Error> {
        Self::with_source(
            endpoint,
            Source::Static(Credential::key(key)),
            model,
            Profile::Api,
        )
    }
    pub fn with_source(
        endpoint: String,
        source: Source,
        model: String,
        profile: Profile,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            endpoint,
            source,
            model,
            profile,
            cache_contract: None,
            websocket_contract: None,
            websocket_pool: std::sync::Arc::new(crate::responses_websocket::Pool::default()),
        })
    }
    pub fn with_cache_contract(
        mut self,
        contract: crate::responses_cache::Contract,
    ) -> Result<Self, String> {
        let endpoint = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| "invalid Responses endpoint".to_owned())?;
        contract.validate(
            &self.model,
            &endpoint,
            matches!(self.profile, Profile::Subscription),
        )?;
        self.cache_contract = Some(contract);
        Ok(self)
    }
    pub fn with_websocket_contract(
        mut self,
        contract: crate::responses_websocket::Contract,
    ) -> Result<Self, String> {
        let endpoint =
            reqwest::Url::parse(&self.endpoint).map_err(|_| "invalid Responses endpoint")?;
        contract.validate(
            &self.model,
            &endpoint,
            matches!(self.profile, Profile::Subscription),
        )?;
        self.websocket_contract = Some(contract);
        Ok(self)
    }
}
#[async_trait]
impl Provider for OpenAIResponses {
    fn for_model(&self, model: &str) -> Option<std::sync::Arc<dyn Provider>> {
        if !crate::provider::valid_model(model) {
            return None;
        }
        let mut selected = self.clone();
        selected.model = model.to_owned();
        if selected
            .websocket_contract
            .as_ref()
            .is_some_and(|contract| contract.model != model)
        {
            selected.websocket_contract = None;
        }
        if selected
            .cache_contract
            .as_ref()
            .is_some_and(|contract| contract.model != model)
        {
            selected.cache_contract = None;
        }
        Some(std::sync::Arc::new(selected))
    }
    fn identity(&self) -> Option<crate::provider::Identity> {
        Some(crate::provider::Identity {
            protocol: "openai-responses".into(),
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
impl OpenAIResponses {
    async fn stream_mode(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
        without_tools: bool,
    ) -> Result<Reply, ProviderError> {
        let credential = self.source.load().await?;
        if !matches!(
            (self.profile, credential.kind()),
            (Profile::Api, Kind::Key) | (Profile::Subscription, Kind::OAuth)
        ) {
            return Err(ProviderError::AuthProfile);
        }
        let input = items(&request.messages, &self.model)?;
        let tools:Vec<Value>=request.tools.iter().map(|tool|json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.input_schema})).collect();
        let cache_key = crate::cache_affinity::key();
        let mut body = json!({"model":self.model,"instructions":request.system,"input":input,"tools":tools,"stream":true,"store":false,"include":["reasoning.encrypted_content"]});
        if let Some(key) = &cache_key {
            body["prompt_cache_key"] = json!(key);
        }
        if let Some(contract) = &self.cache_contract {
            contract
                .project(&mut body, &request.system)
                .map_err(ProviderError::Stream)?;
        }
        if without_tools {
            body["tool_choice"] = json!("none");
        }
        let mut builder = self
            .client
            .post(&self.endpoint)
            .bearer_auth(credential.secret())
            .json(&body);
        if matches!(self.profile, Profile::Subscription) {
            // The subscription backend routes its prefix cache by this header;
            // a body key alone does not keep successive requests cache-affine.
            if let Some(key) = &cache_key {
                builder = builder.header("session-id", key);
            }
            builder = builder.header("originator", "miao").header(
                reqwest::header::USER_AGENT,
                format!("miao-engine/{}", env!("MIAO_ENGINE_VERSION")),
            );
            if let Some(account) = credential.account() {
                builder = builder.header("ChatGPT-Account-Id", account);
            }
        }
        let request = builder.build().map_err(|_| ProviderError::Transport)?;
        if let Some(contract) = &self.websocket_contract {
            if let Some(reply) = crate::responses_websocket::try_stream(
                &self.websocket_pool,
                contract,
                &request,
                progress.clone(),
                cancel.clone(),
                ResponsesState {
                    model: self.model.clone(),
                    ..Default::default()
                },
                |reply| {
                    items(
                        &[Message {
                            role: "assistant".into(),
                            content: reply.content.clone(),
                            checkpoint: None,
                            recorded_at_ms: None,
                        }],
                        &self.model,
                    )
                },
            )
            .await?
            {
                return Ok(reply);
            }
            let _ = progress.try_send(
                json!({"kind":"transport.http_fallback","from":"websocket","history":"full"}),
            );
        }
        let response = request_with_retry(
            "openai-responses",
            &self.client,
            request,
            &progress,
            &cancel,
        )
        .await?;
        read_stream(
            response,
            progress,
            cancel,
            ResponsesState {
                model: self.model.clone(),
                ..Default::default()
            },
        )
        .await
    }
}

fn items(history: &[Message], model: &str) -> Result<Vec<Value>, ProviderError> {
    let invalid = || ProviderError::Stream("history cannot be lowered to Responses".into());
    let mut items = Vec::new();
    for message in history {
        for block in message.content.as_array().ok_or_else(invalid)? {
            match (message.role.as_str(), block["type"].as_str()) {
                ("user" | "assistant", Some("text")) => {
                    items.push(json!({"role":message.role,"content":[{"type":if message.role=="user"{"input_text"}else{"output_text"},"text":block["text"].as_str().ok_or_else(invalid)?}]}));
                }
                ("user", Some("image")) => {
                    let mime = block["mime"].as_str().ok_or_else(invalid)?;
                    let data = block["data"].as_str().ok_or_else(invalid)?;
                    items.push(json!({"role":"user","content":[{"type":"input_image","image_url":format!("data:{mime};base64,{data}")}]}));
                }
                ("assistant", Some("tool_use")) => {
                    if !block["input"].is_object() {
                        return Err(invalid());
                    }
                    items.push(json!({"type":"function_call","call_id":block["id"].as_str().ok_or_else(invalid)?,"name":block["name"].as_str().ok_or_else(invalid)?,"arguments":serde_json::to_string(&block["input"]).map_err(|_|invalid())?}));
                }
                ("user", Some("tool_result")) => {
                    let content = block["content"].as_str().ok_or_else(invalid)?;
                    items.push(json!({"type":"function_call_output","call_id":block["tool_use_id"].as_str().ok_or_else(invalid)?,"output":if block["is_error"]==true{format!("Tool error: {content}")}else{content.into()}}));
                }
                ("assistant", Some("provider_opaque"))
                    if block["provider"] == "openai-responses"
                        && block["model"] == model
                        && block["item"]["type"] == "reasoning" =>
                {
                    items.push(block["item"].clone())
                }
                _ => return Err(invalid()),
            }
        }
    }
    Ok(items)
}

#[derive(Default)]
struct ResponsesState {
    model: String,
    created: bool,
    completed: Option<Value>,
    /// Output items finalized via `response.output_item.done`. Some upstreams
    /// (observed on subscription-responses) send the authoritative items here
    /// and a compact `response.completed.output` of `[]`, so the completed array
    /// alone would lose every tool call.
    items: Vec<Value>,
    partial_text: BTreeMap<(u64, u64), String>,
    pending_reasoning: HashSet<u64>,
    finalized_reasoning: HashSet<u64>,
    pending_calls: HashSet<u64>,
    unsafe_partial: bool,
}
impl Parser for ResponsesState {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError> {
        let Frame::Json(event) = frame else {
            return Err(ProviderError::Stream(
                "Responses ended before completed".into(),
            ));
        };
        match event["type"].as_str() {
            Some("response.created") => {
                if self.created {
                    return Err(ProviderError::Stream("duplicate response.created".into()));
                }
                self.created = true;
            }
            Some("response.completed") => self.completed = Some(event["response"].clone()),
            Some("response.failed" | "response.incomplete" | "error") => {
                return Err(ProviderError::Stream(
                    "Responses did not complete successfully".into(),
                ))
            }
            Some("response.output_item.done") => {
                let item = event["item"].clone();
                if !item.is_object() {
                    return Err(ProviderError::Stream(
                        "invalid finalized Responses output item".into(),
                    ));
                }
                if let Some(index) = event["output_index"].as_u64() {
                    if item["type"] == "reasoning" {
                        self.pending_reasoning.remove(&index);
                        if !self.finalized_reasoning.insert(index) {
                            self.unsafe_partial = true;
                        }
                    }
                    if item["type"] == "function_call" {
                        self.pending_calls.remove(&index);
                    }
                    if item["type"] == "message" {
                        self.partial_text.retain(|key, _| key.0 != index);
                    }
                }
                if !matches!(
                    item["type"].as_str(),
                    Some("message" | "reasoning" | "function_call")
                ) {
                    self.unsafe_partial = true;
                }
                self.items.push(item);
            }
            Some("response.output_item.added") => {
                match (
                    event["item"]["type"].as_str(),
                    event["output_index"].as_u64(),
                ) {
                    (Some("reasoning"), Some(index)) => {
                        self.pending_reasoning.insert(index);
                    }
                    (Some("function_call"), Some(index)) => {
                        self.pending_calls.insert(index);
                    }
                    (Some("message"), Some(_)) if event["item"]["role"] == "assistant" => {}
                    _ => self.unsafe_partial = true,
                }
            }
            Some("response.output_text.delta" | "response.output_text.done") => {
                if let (Some(index), Some(part), Some(text)) = (
                    event["output_index"].as_u64(),
                    event["content_index"].as_u64(),
                    event[if event["type"] == "response.output_text.delta" {
                        "delta"
                    } else {
                        "text"
                    }]
                    .as_str(),
                ) {
                    let entry = self.partial_text.entry((index, part)).or_default();
                    if event["type"] == "response.output_text.delta" {
                        entry.push_str(text);
                    } else {
                        *entry = text.into();
                    }
                } else {
                    self.unsafe_partial = true;
                }
            }
            Some(
                "response.reasoning_summary_part.added"
                | "response.reasoning_summary_part.done"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning_summary_text.done"
                | "response.reasoning_text.delta"
                | "response.reasoning_text.done",
            ) => {
                if let Some(index) = event["output_index"].as_u64() {
                    if !self.finalized_reasoning.contains(&index) {
                        self.pending_reasoning.insert(index);
                    }
                } else {
                    self.unsafe_partial = true;
                }
            }
            Some("response.output_text.annotation.added") => self.unsafe_partial = true,
            Some(
                "response.function_call_arguments.delta" | "response.function_call_arguments.done",
            ) => {
                if let Some(index) = event["output_index"].as_u64() {
                    self.pending_calls.insert(index);
                } else {
                    self.unsafe_partial = true;
                }
            }
            Some(
                "response.in_progress"
                | "response.content_part.added"
                | "response.content_part.done"
                | "response.queued",
            ) => {}
            // Unrecognized but sequenced checkpoint events do not invalidate a
            // completed response; the completed output array is the authority.
            Some(other)
                if other.starts_with("response.") && event.get("sequence_number").is_some() =>
            {
                let _ = other;
                self.unsafe_partial = true;
            }

            _ => return Err(ProviderError::Stream("unsupported Responses event".into())),
        }
        Ok(())
    }
    fn terminal(&self) -> bool {
        self.completed.is_some()
    }
    fn interrupted(self) -> ProviderError {
        if !self.created || self.unsafe_partial || !self.pending_reasoning.is_empty() {
            return ProviderError::ResponseTransport;
        }
        let mut content = Vec::new();
        let mut unexecuted_calls = self.pending_calls.len();
        for item in self.items {
            if item
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status != "completed")
            {
                return ProviderError::ResponseTransport;
            }
            match item["type"].as_str() {
                Some("reasoning") => content.push(json!({"type":"provider_opaque","provider":"openai-responses","model":self.model,"item":item})),
                Some("function_call") => unexecuted_calls += 1,
                Some("message") if item["role"] == "assistant" => {
                    let Some(parts) = item["content"].as_array() else { return ProviderError::ResponseTransport; };
                    for part in parts {
                        let Some(text) = part["text"].as_str().filter(|_| part["type"] == "output_text") else { return ProviderError::ResponseTransport; };
                        content.push(json!({"type":"text","text":text,"annotations":part.get("annotations").cloned().unwrap_or_else(|| json!([]))}));
                    }
                }
                _ => return ProviderError::ResponseTransport,
            }
        }
        for text in self
            .partial_text
            .into_values()
            .filter(|text| !text.is_empty())
        {
            content.push(json!({"type":"text","text":text,"annotations":[]}));
        }
        if content.is_empty() && unexecuted_calls == 0 {
            return ProviderError::ResponseTransport;
        }
        ProviderError::ContinuableTransport {
            partial: Reply {
                content: Value::Array(content),
                usage: Value::Null,
                needs_tools: false,
            },
            unexecuted_calls,
        }
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        let invalid = || ProviderError::Stream("invalid completed Responses output".into());
        if !self.created {
            return Err(invalid());
        }
        let response = self.completed.ok_or_else(|| {
            ProviderError::Stream("stream ended before response.completed".into())
        })?;
        if response["status"] != "completed" {
            return Err(invalid());
        }
        let mut content = Vec::new();
        let mut calls = HashSet::new();
        // Finalized `output_item.done` items take precedence: a compact
        // `response.completed.output` must not drop them. Fall back only when the
        // stream never finalized any item.
        let output: &[Value] = if self.items.is_empty() {
            response["output"].as_array().ok_or_else(invalid)?
        } else {
            &self.items
        };
        for item in output {
            match item["type"].as_str() {
                Some("message") => {
                    if item["role"] != "assistant" {
                        return Err(invalid());
                    }
                    for part in item["content"].as_array().ok_or_else(invalid)? {
                        if part["type"] != "output_text" {
                            return Err(ProviderError::Stream(
                                "refused or unsupported Responses content".into(),
                            ));
                        }
                        let text = part["text"].as_str().ok_or_else(invalid)?;
                        content.push(json!({"type":"text","text":text,"annotations":part.get("annotations").cloned().unwrap_or_else(||json!([]))}));
                    }
                }
                Some("function_call") => {
                    if item
                        .get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| status != "completed")
                    {
                        return Err(invalid());
                    }
                    let id = item["call_id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(invalid)?;
                    if !calls.insert(id.to_owned()) {
                        return Err(invalid());
                    }
                    content.push(crate::provider::decode_tool_call(
                        id,
                        item["name"].as_str().ok_or_else(invalid)?,
                        item["arguments"].as_str().ok_or_else(invalid)?,
                    )?);
                }
                Some("reasoning") => {
                    // Preserve provider continuation identity verbatim. Other
                    // adapters must reject it, not discard or reinterpret it.
                    content.push(json!({"type":"provider_opaque","provider":"openai-responses","model":self.model,"item":item}));
                }
                _ => {
                    return Err(ProviderError::Stream(
                        "hosted or unknown output item is unsupported".into(),
                    ))
                }
            }
        }
        let needs_tools = !calls.is_empty();
        if !needs_tools
            && !content
                .iter()
                .any(|b| b["type"] == "text" && b["text"].as_str().is_some_and(|s| !s.is_empty()))
        {
            return Err(ProviderError::Stream(
                "empty completed Responses message".into(),
            ));
        }
        Ok(Reply {
            content: Value::Array(content),
            usage: crate::usage::responses(&response["usage"]),
            needs_tools,
        })
    }
}

#[cfg(test)]
#[path = "openai_responses_websocket_tests.rs"]
mod websocket_tests;
