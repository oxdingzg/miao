use crate::{
    credential::{Credential, Kind, Source},
    protocol::ModelRequest,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("interrupted")]
    Interrupted,
    #[error("provider transport failed")]
    Transport,
    #[error("provider response transport failed; outcome is not replayable")]
    ResponseTransport,
    #[error("{source}")]
    Routed {
        selection: Value,
        #[source]
        source: Box<ProviderError>,
    },
    #[error("credential: {0}")]
    Auth(#[from] crate::credential::Error),
    #[error("credential type is incompatible with the selected authentication profile")]
    AuthProfile,
    #[error("provider HTTP {0}")]
    Http(u16),
    #[error("invalid provider stream: {0}")]
    Stream(String),
}

impl ProviderError {
    pub(crate) fn can_fallback(&self) -> bool {
        matches!(
            self,
            Self::Transport | Self::Http(429 | 500 | 502 | 503 | 504 | 529)
        )
    }
    pub fn routing(&self) -> Option<&Value> {
        match self {
            Self::Routed { selection, .. } => Some(selection),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Identity {
    pub protocol: String,
    pub model: String,
}

pub(crate) struct Budget {
    pub deadline: tokio::time::Instant,
    attempts: AtomicUsize,
}
impl Budget {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            deadline: tokio::time::Instant::now() + Duration::from_secs(60),
            attempts: AtomicUsize::new(0),
        })
    }
    pub fn used(&self) -> usize {
        self.attempts.load(Ordering::Relaxed)
    }
    fn take(&self) -> bool {
        // Keep the declared MSRV across newer atomics API renames.
        loop {
            let used = self.used();
            if used >= 3 {
                return false;
            }
            if self
                .attempts
                .compare_exchange(used, used + 1, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return true;
            }
        }
    }
}
#[derive(Clone)]
struct RetryScope {
    budget: Arc<Budget>,
    limit: usize,
}
tokio::task_local! {static RETRY_SCOPE:RetryScope;}
pub(crate) async fn scoped<F: std::future::Future<Output = Result<Reply, ProviderError>>>(
    budget: Arc<Budget>,
    limit: usize,
    future: F,
) -> Result<Reply, ProviderError> {
    RETRY_SCOPE
        .scope(RetryScope { budget, limit }, future)
        .await
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub content: Value,
    pub usage: Value,
    pub needs_tools: bool,
}

/// A provider gets projected history, never Session/store ownership. Progress
/// feeds the execution task, not a potentially slow external subscriber.
#[async_trait]
pub trait Provider: Send + Sync {
    fn identity(&self) -> Option<Identity> {
        None
    }
    fn protected_resources(&self) -> Vec<std::path::PathBuf> {
        vec![]
    }
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError>;
}

pub struct Anthropic {
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
}

impl Anthropic {
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
impl Provider for Anthropic {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "anthropic-messages".into(),
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
        let mut messages = request.messages;
        for message in &mut messages {
            let blocks = message
                .content
                .as_array_mut()
                .ok_or_else(|| ProviderError::Stream("unsupported Anthropic history".into()))?;
            for block in blocks {
                if !matches!(
                    (message.role.as_str(), block["type"].as_str()),
                    ("user" | "assistant", Some("text"))
                        | ("assistant", Some("tool_use"))
                        | ("user", Some("tool_result"))
                ) {
                    return Err(ProviderError::Stream(
                        "opaque or incompatible Anthropic history".into(),
                    ));
                }
                if block
                    .get("annotations")
                    .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
                {
                    return Err(ProviderError::Stream(
                        "annotated text is not portable to Anthropic".into(),
                    ));
                }
                if let Some(object) = block.as_object_mut() {
                    object.remove("annotations");
                }
            }
        }
        let request=self.client.post(&self.endpoint)
            .header("x-api-key",credential.header()?).header("anthropic-version","2023-06-01")
            .json(&json!({"model":self.model,"max_tokens":4096,"stream":true,"messages":messages,"system":request.system,"tools":request.tools}))
            .build().map_err(|_|ProviderError::Transport)?;
        let response = request_with_retry(&self.client, request, &progress, &cancel).await?;
        read_stream(response, progress, cancel, StreamState::default()).await
    }
}

pub(crate) async fn request_with_retry(
    client: &reqwest::Client,
    request: reqwest::Request,
    progress: &mpsc::Sender<Value>,
    cancel: &CancellationToken,
) -> Result<reqwest::Response, ProviderError> {
    let scope = RETRY_SCOPE
        .try_with(Clone::clone)
        .unwrap_or_else(|_| RetryScope {
            budget: Budget::new(),
            limit: 3,
        });
    let deadline = scope.budget.deadline;
    for attempt in 0..scope.limit {
        if tokio::time::Instant::now() >= deadline || !scope.budget.take() {
            return Err(ProviderError::Transport);
        }
        let request = request
            .try_clone()
            .ok_or_else(|| ProviderError::Stream("request cannot be replayed".into()))?;
        let response = tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            result=tokio::time::timeout_at(deadline,client.execute(request))=>match result {Ok(Ok(response))=>Ok(response),_=>Err(ProviderError::Transport)},
        };
        let error = match response {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => ProviderError::Http(response.status().as_u16()),
            Err(error) => error,
        };
        if !matches!(
            error,
            ProviderError::Transport | ProviderError::Http(429 | 500 | 502 | 503 | 504 | 529)
        ) || attempt + 1 >= scope.limit
            || scope.budget.used() >= 3
            || tokio::time::Instant::now() >= deadline
        {
            return Err(error);
        }
        tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            result=progress.send(json!({"kind":"provider.retry","attempt":attempt+1}))=>if result.is_err(){return Err(ProviderError::Interrupted);},
        }
        tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            _=tokio::time::sleep(Duration::from_millis(250*(1<<attempt)))=>{},
        }
    }
    unreachable!()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Json(Value),
    Done,
}

pub(crate) trait Parser {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError>;
    fn terminal(&self) -> bool;
    fn finish(self) -> Result<Reply, ProviderError>;
}

/// Byte-oriented framing preserves UTF-8 split across network chunks. Both
/// CRLF and multiline data are legal SSE; frames are bounded before decoding.
#[derive(Default)]
pub struct SseDecoder {
    line: Vec<u8>,
    data: String,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, ProviderError> {
        let mut values = Vec::new();
        for byte in bytes {
            if *byte != b'\n' {
                self.line.push(*byte);
                if self.line.len() + self.data.len() > 1024 * 1024 {
                    return Err(ProviderError::Stream("frame exceeds 1 MiB".into()));
                }
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let text = std::str::from_utf8(&line)
                .map_err(|_| ProviderError::Stream("invalid UTF-8".into()))?
                .trim_end_matches('\r');
            if text.is_empty() {
                if !self.data.is_empty() {
                    let data = self.data.trim_end_matches('\n');
                    let frame = if data == "[DONE]" {
                        Frame::Done
                    } else {
                        Frame::Json(
                            serde_json::from_str(data)
                                .map_err(|_| ProviderError::Stream("invalid SSE JSON".into()))?,
                        )
                    };
                    values.push(frame);
                    self.data.clear();
                }
                continue;
            }
            if let Some(data) = text.strip_prefix("data:") {
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                self.data.push('\n');
                if self.data.len() > 1024 * 1024 {
                    return Err(ProviderError::Stream("frame exceeds 1 MiB".into()));
                }
            }
        }
        Ok(values)
    }
}

#[derive(Default)]
struct StreamState {
    blocks: BTreeMap<u64, Value>,
    partial: BTreeMap<u64, String>,
    open: BTreeMap<u64, bool>,
    usage: serde_json::Map<String, Value>,
    stop_reason: Option<String>,
    started: bool,
    stopped: bool,
}

impl StreamState {
    fn event(&mut self, event: &Value) -> Result<(), ProviderError> {
        match event["type"].as_str().unwrap_or("") {
            "ping" => {}
            "message_start" => {
                if self.started {
                    return Err(ProviderError::Stream("duplicate message_start".into()));
                }
                self.started = true;
                if let Some(usage) = event["message"]["usage"].as_object() {
                    self.usage.extend(usage.clone());
                }
            }
            "content_block_start" => {
                let index = event["index"]
                    .as_u64()
                    .ok_or_else(|| ProviderError::Stream("missing block index".into()))?;
                let block = &event["content_block"];
                // Unknown hosted tools/thinking must not be silently converted
                // to text or retried against another provider.
                if !matches!(block["type"].as_str(), Some("text" | "tool_use"))
                    || self.blocks.contains_key(&index)
                {
                    return Err(ProviderError::Stream(
                        "unsupported or duplicate content block".into(),
                    ));
                }
                self.blocks.insert(index, block.clone());
                self.open.insert(index, true);
            }
            "content_block_delta" => {
                let index = event["index"]
                    .as_u64()
                    .ok_or_else(|| ProviderError::Stream("missing block index".into()))?;
                if self.open.get(&index) != Some(&true) {
                    return Err(ProviderError::Stream("delta outside open block".into()));
                }
                let block = self.blocks.get_mut(&index).expect("open block exists");
                match event["delta"]["type"].as_str() {
                    Some("text_delta") if block["type"] == "text" => {
                        let text = event["delta"]["text"]
                            .as_str()
                            .ok_or_else(|| ProviderError::Stream("invalid text delta".into()))?;
                        let mut value = block["text"].as_str().unwrap_or("").to_owned();
                        value.push_str(text);
                        block["text"] = Value::String(value);
                    }
                    Some("input_json_delta") if block["type"] == "tool_use" => {
                        let text = event["delta"]["partial_json"]
                            .as_str()
                            .ok_or_else(|| ProviderError::Stream("invalid input delta".into()))?;
                        self.partial.entry(index).or_default().push_str(text);
                    }
                    _ => return Err(ProviderError::Stream("unsupported delta".into())),
                }
            }
            "content_block_stop" => {
                let index = event["index"]
                    .as_u64()
                    .ok_or_else(|| ProviderError::Stream("missing block index".into()))?;
                if self.open.insert(index, false) != Some(true) {
                    return Err(ProviderError::Stream("stop outside open block".into()));
                }
                if let Some(text) = self.partial.remove(&index) {
                    self.blocks.get_mut(&index).expect("block exists")["input"] =
                        serde_json::from_str(&text)
                            .map_err(|_| ProviderError::Stream("incomplete tool input".into()))?;
                }
            }
            "message_delta" => {
                self.stop_reason = event["delta"]["stop_reason"].as_str().map(str::to_owned);
                if let Some(usage) = event["usage"].as_object() {
                    self.usage.extend(usage.clone());
                }
            }
            "message_stop" => self.stopped = true,
            "error" => return Err(ProviderError::Stream("provider emitted error event".into())),
            _ => return Err(ProviderError::Stream("unknown event type".into())),
        }
        Ok(())
    }

    fn finish(self) -> Result<Reply, ProviderError> {
        if !self.started || !self.stopped || self.open.values().any(|open| *open) {
            return Err(ProviderError::Stream(
                "stream ended without complete message".into(),
            ));
        }
        let needs_tools = self.blocks.values().any(|b| b["type"] == "tool_use");
        if needs_tools != (self.stop_reason.as_deref() == Some("tool_use"))
            || !matches!(
                self.stop_reason.as_deref(),
                Some("tool_use" | "end_turn" | "stop_sequence")
            )
        {
            return Err(ProviderError::Stream(
                "incomplete or unsupported stop reason".into(),
            ));
        }
        if self.blocks.is_empty()
            || (!needs_tools
                && !self
                    .blocks
                    .values()
                    .any(|b| b["text"].as_str().is_some_and(|s| !s.is_empty())))
        {
            return Err(ProviderError::Stream("empty completed message".into()));
        }
        Ok(Reply {
            content: Value::Array(self.blocks.into_values().collect()),
            usage: Value::Object(self.usage),
            needs_tools,
        })
    }
}

impl Parser for StreamState {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError> {
        match frame {
            Frame::Json(event) => self.event(event),
            Frame::Done => Err(ProviderError::Stream(
                "unexpected DONE in Anthropic stream".into(),
            )),
        }
    }
    fn terminal(&self) -> bool {
        self.stopped
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        StreamState::finish(self)
    }
}

pub(crate) async fn read_stream<P: Parser>(
    response: reqwest::Response,
    progress: mpsc::Sender<Value>,
    cancel: CancellationToken,
    mut parser: P,
) -> Result<Reply, ProviderError> {
    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut total = 0;
    loop {
        let chunk = tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            result=tokio::time::timeout(Duration::from_secs(120),bytes.next())=>result.map_err(|_|ProviderError::Stream("provider idle timeout".into()))?,
        };
        let Some(chunk) = chunk else {
            return parser.finish();
        };
        let chunk = chunk.map_err(|_| ProviderError::ResponseTransport)?;
        total += chunk.len();
        if total > 8 * 1024 * 1024 {
            return Err(ProviderError::Stream("message exceeds 8 MiB".into()));
        }
        for frame in decoder.push(&chunk)? {
            parser.frame(&frame)?;
            let notice = match frame {
                Frame::Json(event) => event,
                Frame::Done => json!({"kind":"stream.done"}),
            };
            tokio::select! {
                _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
                result=progress.send(notice)=>if result.is_err(){return Err(ProviderError::Interrupted);},
            }
            if parser.terminal() {
                return parser.finish();
            }
        }
    }
}
