use crate::{
    credential::{Credential, Kind, Source},
    protocol::{Message, ModelRequest},
    provider::{read_stream, request_with_retry, Frame, Parser, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PROTOCOL: &str = "gemini-generate-content";
pub struct Gemini {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    source: Source,
    model: String,
}
impl Gemini {
    pub fn new(endpoint: String, key: String, model: String) -> Result<Self, ProviderError> {
        Self::with_source(endpoint, Source::Static(Credential::key(key)), model)
    }
    pub fn with_source(
        endpoint: String,
        source: Source,
        model: String,
    ) -> Result<Self, ProviderError> {
        let model = model.strip_prefix("models/").unwrap_or(&model).to_owned();
        if model.is_empty()
            || model.len() > 256
            || !model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(invalid("unsupported Gemini model identity"));
        }
        let mut endpoint =
            reqwest::Url::parse(&endpoint).map_err(|_| invalid("invalid Gemini endpoint"))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(invalid("invalid Gemini endpoint"));
        }
        if endpoint
            .query_pairs()
            .any(|(key, value)| key == "alt" && value != "sse")
        {
            return Err(invalid("Gemini endpoint must use SSE"));
        }
        if !endpoint.query_pairs().any(|(key, _)| key == "alt") {
            endpoint.query_pairs_mut().append_pair("alt", "sse");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| ProviderError::Transport)?,
            endpoint,
            source,
            model,
        })
    }
}
#[async_trait]
impl Provider for Gemini {
    fn identity(&self) -> Option<crate::provider::Identity> {
        Some(crate::provider::Identity {
            protocol: "gemini-generate-content".into(),
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
        if credential.kind() != Kind::Key {
            return Err(ProviderError::AuthProfile);
        }
        let contents = lower(&request.messages, &self.model)?;
        let declarations=request.tools.iter().map(|tool|json!({"name":tool.name,"description":tool.description,"parametersJsonSchema":tool.input_schema})).collect::<Vec<_>>();
        let mut body = json!({"contents":contents,"generationConfig":{"candidateCount":1,"maxOutputTokens":8192},"systemInstruction":{"parts":[{"text":request.system}]}});
        if !declarations.is_empty() {
            body["tools"] = json!([{"functionDeclarations":declarations}]);
            body["toolConfig"] = json!({"functionCallingConfig":{"mode":"AUTO"}});
        }
        let request = self
            .client
            .post(self.endpoint.clone())
            .header("x-goog-api-key", credential.header()?)
            .json(&body)
            .build()
            .map_err(|_| ProviderError::Transport)?;
        let response = request_with_retry(&self.client, request, &progress, &cancel).await?;
        read_stream(
            response,
            progress,
            cancel,
            State {
                model: self.model.clone(),
                parts: vec![],
                usage: Value::Null,
                finished: false,
                done: false,
                bytes: 0,
            },
        )
        .await
    }
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::Stream(message.into())
}
fn validate_part(part: &Value) -> Result<(), ProviderError> {
    let object = part
        .as_object()
        .ok_or_else(|| invalid("invalid Gemini part"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "text" | "functionCall" | "thoughtSignature" | "thought"
        )
    }) || usize::from(part.get("text").is_some())
        + usize::from(part.get("functionCall").is_some())
        != 1
    {
        return Err(invalid("unsupported Gemini part"));
    }
    if part
        .get("thoughtSignature")
        .is_some_and(|signature| !signature.is_string())
        || part
            .get("thought")
            .is_some_and(|thought| !thought.is_boolean())
    {
        return Err(invalid("invalid Gemini thought metadata"));
    }
    if let Some(text) = part.get("text") {
        if !text.is_string() {
            return Err(invalid("invalid Gemini text"));
        }
        return Ok(());
    }
    let call = part["functionCall"]
        .as_object()
        .ok_or_else(|| invalid("invalid Gemini function call"))?;
    if call
        .keys()
        .any(|key| !matches!(key.as_str(), "name" | "args" | "id"))
        || part["thought"] == true
    {
        return Err(invalid("unsupported Gemini function call"));
    }
    let name = part["functionCall"]["name"]
        .as_str()
        .ok_or_else(|| invalid("Gemini function name missing"))?;
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
        || !name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        || call.get("args").is_some_and(|args| !args.is_object())
        || call
            .get("id")
            .is_some_and(|id| !id.is_string() || id.as_str().is_some_and(|id| id.len() > 256))
    {
        return Err(invalid("invalid Gemini function call"));
    }
    Ok(())
}
fn args(part: &Value) -> Value {
    part["functionCall"]
        .get("args")
        .cloned()
        .unwrap_or_else(|| json!({}))
}
fn wire_id(part: &Value) -> Option<&str> {
    part["functionCall"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
}
fn visible(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|part| part["thought"] != true)
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

fn portable_text(block: &Value) -> Result<&str, ProviderError> {
    if block["type"] != "text"
        || block.get("annotations").is_some_and(|annotations| {
            annotations
                .as_array()
                .is_none_or(|annotations| !annotations.is_empty())
        })
    {
        return Err(invalid("annotated or incompatible Gemini text history"));
    }
    block["text"]
        .as_str()
        .ok_or_else(|| invalid("invalid Gemini text history"))
}

/// Native parts are echoed as returned. Neutral tool IDs are process-independent
/// transcript keys; provider call IDs stay in the protocol-bound capsule.
fn lower(history: &[Message], model: &str) -> Result<Vec<Value>, ProviderError> {
    let mut contents: Vec<Value> = vec![];
    let mut pending = BTreeMap::<String, Value>::new();
    let mut used = BTreeSet::new();
    for message in history {
        let blocks = message
            .content
            .as_array()
            .ok_or_else(|| invalid("unsupported Gemini history"))?;
        let mut parts = vec![];
        if message.role == "assistant" {
            let opaque = blocks
                .iter()
                .filter(|block| block["type"] == "provider_opaque")
                .collect::<Vec<_>>();
            if opaque.len() > 1 {
                return Err(invalid("multiple Gemini native capsules"));
            }
            if let Some(opaque) = opaque.first() {
                if opaque["protocol"] != PROTOCOL || opaque["model"] != model {
                    return Err(invalid(
                        "opaque history does not match Gemini protocol/model",
                    ));
                }
                let native = opaque["payload"]["parts"]
                    .as_array()
                    .ok_or_else(|| invalid("invalid Gemini native history"))?;
                for part in native {
                    validate_part(part)?;
                }
                let calls = opaque["payload"]["calls"]
                    .as_array()
                    .ok_or_else(|| invalid("invalid Gemini call mapping"))?;
                let mut wire_ids = BTreeSet::new();
                let wire = native
                    .iter()
                    .filter(|part| part.get("functionCall").is_some())
                    .collect::<Vec<_>>();
                let neutral = blocks
                    .iter()
                    .filter(|block| block["type"] == "tool_use")
                    .collect::<Vec<_>>();
                if calls.len() != wire.len() || calls.len() != neutral.len() {
                    return Err(invalid("Gemini native/neutral call mismatch"));
                }
                for ((call, part), neutral) in calls.iter().zip(wire).zip(neutral) {
                    let id = call["id"]
                        .as_str()
                        .filter(|id| !id.is_empty() && id.len() <= 256)
                        .ok_or_else(|| invalid("invalid Gemini tool id"))?;
                    if wire_id(part).is_some_and(|wire_id| !wire_ids.insert(wire_id.to_owned()))
                        || !used.insert(id.to_owned())
                        || neutral["id"] != id
                        || neutral["name"] != part["functionCall"]["name"]
                        || neutral["input"] != args(part)
                        || call["name"] != neutral["name"]
                        || call["input"] != neutral["input"]
                        || call["wire_id"] != json!(wire_id(part))
                    {
                        return Err(invalid("Gemini native/neutral call mismatch"));
                    }
                    pending.insert(id.to_owned(), call.clone());
                }
                let text = blocks
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .map(portable_text)
                    .collect::<Result<Vec<_>, _>>()?
                    .join("");
                if text != visible(native)
                    || blocks.iter().any(|block| {
                        !matches!(
                            block["type"].as_str(),
                            Some("text" | "provider_opaque" | "tool_use")
                        )
                    })
                {
                    return Err(invalid("Gemini native/neutral text mismatch"));
                }
                parts.extend(native.clone());
            } else {
                for block in blocks {
                    parts.push(json!({"text":portable_text(block)?}));
                }
            }
        } else if message.role == "user" {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => parts.push(json!({"text":portable_text(block)?})),
                    Some("tool_result") => {
                        let id = block["tool_use_id"]
                            .as_str()
                            .ok_or_else(|| invalid("invalid Gemini tool result"))?;
                        let call = pending
                            .remove(id)
                            .ok_or_else(|| invalid("Gemini result has no native call"))?;
                        let text = block["content"]
                            .as_str()
                            .ok_or_else(|| invalid("invalid Gemini tool result"))?;
                        let output =
                            serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!(text));
                        let mut response = json!({"name":call["name"],"response":{"result":output,"is_error":block["is_error"]==true}});
                        if let Some(id) = call["wire_id"].as_str() {
                            response["id"] = json!(id);
                        }
                        parts.push(json!({"functionResponse":response}));
                    }
                    _ => return Err(invalid("unsupported Gemini user history")),
                }
            }
        } else {
            return Err(invalid("unsupported Gemini role"));
        }
        let role = if message.role == "assistant" {
            "model"
        } else {
            "user"
        };
        if parts.is_empty() {
            return Err(invalid("empty Gemini content"));
        }
        if role == "user"
            && contents
                .last()
                .is_some_and(|content| content["role"] == "user")
        {
            contents
                .last_mut()
                .and_then(|content| content["parts"].as_array_mut())
                .ok_or_else(|| invalid("invalid Gemini contents"))?
                .extend(parts);
        } else {
            contents.push(json!({"role":role,"parts":parts}));
        }
    }
    if !pending.is_empty() {
        return Err(invalid("Gemini history has unresolved native calls"));
    }
    Ok(contents)
}
struct State {
    model: String,
    parts: Vec<Value>,
    usage: Value,
    finished: bool,
    done: bool,
    bytes: usize,
}
impl Parser for State {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError> {
        let Frame::Json(event) = frame else {
            if !self.finished {
                return Err(invalid("Gemini ended before finishReason"));
            }
            self.done = true;
            return Ok(());
        };
        if event.get("error").is_some()
            || event["promptFeedback"]
                .get("blockReason")
                .is_some_and(|reason| reason != "BLOCK_REASON_UNSPECIFIED")
        {
            return Err(invalid("Gemini request blocked or failed"));
        }
        if let Some(usage) = event.get("usageMetadata") {
            if !usage.is_object() {
                return Err(invalid("invalid Gemini usage"));
            }
            self.usage = usage.clone();
        }
        let Some(candidates) = event.get("candidates") else {
            if event.get("usageMetadata").is_some() {
                return Ok(());
            }
            return Err(invalid("Gemini candidates missing"));
        };
        let candidates = candidates
            .as_array()
            .ok_or_else(|| invalid("invalid Gemini candidates"))?;
        if candidates.is_empty() && event.get("usageMetadata").is_some() {
            return Ok(());
        }
        if candidates.len() != 1 || candidates[0].get("index").is_some_and(|index| index != 0) {
            return Err(invalid("Gemini requires exactly one candidate"));
        }
        let candidate = &candidates[0];
        if candidate["safetyRatings"]
            .as_array()
            .is_some_and(|ratings| ratings.iter().any(|rating| rating["blocked"] == true))
        {
            return Err(invalid("Gemini candidate blocked"));
        }
        if let Some(content) = candidate.get("content") {
            if self.finished || content.get("role").is_some_and(|role| role != "model") {
                return Err(invalid("Gemini content after finish or incompatible role"));
            }
            if let Some(parts) = content.get("parts") {
                let parts = parts
                    .as_array()
                    .ok_or_else(|| invalid("invalid Gemini parts"))?;
                for part in parts {
                    validate_part(part)?;
                    self.bytes += serde_json::to_vec(part)
                        .map_err(|_| invalid("invalid Gemini part"))?
                        .len();
                    if self.bytes > 512 * 1024 {
                        return Err(invalid("Gemini reply exceeds budget"));
                    }
                    self.parts.push(part.clone());
                }
            }
        }
        if let Some(reason) = candidate.get("finishReason") {
            if self.finished || reason != "STOP" {
                return Err(invalid("Gemini has unsupported or duplicate finishReason"));
            }
            self.finished = true;
        }
        Ok(())
    }
    fn terminal(&self) -> bool {
        self.done
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        if !self.finished {
            return Err(invalid("Gemini stream ended without finishReason"));
        }
        let text = visible(&self.parts);
        let mut content = vec![];
        let mut calls = vec![];
        let mut ids = BTreeSet::new();
        for part in &self.parts {
            if part.get("functionCall").is_none() {
                continue;
            }
            if calls.len() >= 128 || wire_id(part).is_some_and(|id| !ids.insert(id.to_owned())) {
                return Err(invalid("duplicate or excessive Gemini function calls"));
            }
            let id = format!("gemini_{}", uuid::Uuid::new_v4());
            let name = &part["functionCall"]["name"];
            let input = args(part);
            calls.push(json!({"id":id,"name":name,"input":input,"wire_id":wire_id(part)}));
            content.push(json!({"type":"tool_use","id":id,"name":name,"input":input}));
        }
        if !text.is_empty() {
            content.insert(0, json!({"type":"text","text":text}));
        }
        if content.is_empty() {
            return Err(invalid("empty Gemini reply"));
        }
        if !calls.is_empty()
            || self
                .parts
                .iter()
                .any(|part| part.get("thoughtSignature").is_some() || part["thought"] == true)
        {
            content.insert(0,json!({"type":"provider_opaque","protocol":PROTOCOL,"model":self.model,"payload":{"parts":self.parts,"calls":calls}}));
        }
        if serde_json::to_vec(&content)
            .map_err(|_| invalid("invalid Gemini reply"))?
            .len()
            > 512 * 1024
        {
            return Err(invalid("Gemini projected reply exceeds budget"));
        }
        Ok(Reply {
            needs_tools: !calls.is_empty(),
            content: Value::Array(content),
            usage: self.usage,
        })
    }
}
