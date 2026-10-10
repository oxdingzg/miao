use crate::{
    credential::{Credential, Kind, Source},
    protocol::{Message, ModelRequest},
    provider::{read_stream, request_with_retry, Frame, Parser, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// API-key Responses adapter. Subscription OAuth, account routing and refresh
/// are a separate credential integration, not implicit endpoint substitution.
#[derive(Clone, Copy)]
pub enum Profile {
    Api,
    Subscription,
}

pub struct OpenAIResponses {
    profile: Profile,
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
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
        })
    }
}
#[async_trait]
impl Provider for OpenAIResponses {
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
        let credential = self.source.load().await?;
        if !matches!(
            (self.profile, credential.kind()),
            (Profile::Api, Kind::Key) | (Profile::Subscription, Kind::OAuth)
        ) {
            return Err(ProviderError::AuthProfile);
        }
        let input = items(&request.messages, &self.model)?;
        let tools:Vec<Value>=request.tools.iter().map(|tool|json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.input_schema})).collect();
        let body = json!({"model":self.model,"instructions":request.system,"input":input,"tools":tools,"stream":true,"store":false,"include":["reasoning.encrypted_content"]});
        let mut builder = self
            .client
            .post(&self.endpoint)
            .bearer_auth(credential.secret())
            .json(&body);
        if matches!(self.profile, Profile::Subscription) {
            builder = builder.header("originator", "miao").header(
                reqwest::header::USER_AGENT,
                format!("miao-engine/{}", env!("MIAO_ENGINE_VERSION")),
            );
            if let Some(account) = credential.account() {
                builder = builder.header("ChatGPT-Account-Id", account);
            }
        }
        let request = builder.build().map_err(|_| ProviderError::Transport)?;
        let response = request_with_retry(&self.client, request, &progress, &cancel).await?;
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
                self.items.push(item);
            }
            Some(
                "response.in_progress"
                | "response.output_item.added"
                | "response.content_part.added"
                | "response.content_part.done"
                | "response.output_text.delta"
                | "response.output_text.done"
                | "response.output_text.annotation.added"
                | "response.function_call_arguments.delta"
                | "response.function_call_arguments.done"
                | "response.reasoning_summary_part.added"
                | "response.reasoning_summary_part.done"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning_summary_text.done"
                | "response.reasoning_text.delta"
                | "response.reasoning_text.done"
                | "response.queued",
            ) => {}
            // Unrecognized but sequenced checkpoint events do not invalidate a
            // completed response; the completed output array is the authority.
            Some(other)
                if other.starts_with("response.") && event.get("sequence_number").is_some() =>
            {
                let _ = other;
            }

            _ => return Err(ProviderError::Stream("unsupported Responses event".into())),
        }
        Ok(())
    }
    fn terminal(&self) -> bool {
        self.completed.is_some()
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
                    let input: Value =
                        serde_json::from_str(item["arguments"].as_str().ok_or_else(invalid)?)
                            .map_err(|_| invalid())?;
                    if !input.is_object() {
                        return Err(invalid());
                    }
                    content.push(json!({"type":"tool_use","id":id,"name":item["name"].as_str().ok_or_else(invalid)?,"input":input}));
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
            usage: response["usage"].clone(),
            needs_tools,
        })
    }
}
