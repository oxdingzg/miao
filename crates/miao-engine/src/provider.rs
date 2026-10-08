use crate::protocol::Message;
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("interrupted")]
    Interrupted,
    #[error("provider transport failed")]
    Transport,
    #[error("provider HTTP {0}")]
    Http(u16),
    #[error("invalid provider stream: {0}")]
    Stream(String),
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
    async fn stream(
        &self,
        history: Vec<Message>,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError>;
}

pub struct Anthropic {
    client: reqwest::Client,
    endpoint: String,
    key: String,
    model: String,
}

impl Anthropic {
    pub fn new(endpoint: String, key: String, model: String) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            endpoint,
            key,
            model,
        })
    }
}

#[async_trait]
impl Provider for Anthropic {
    async fn stream(
        &self,
        history: Vec<Message>,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        // Only pre-output failures may retry. A single attempt ceiling and time
        // budget covers both connection/HTTP failures; no nested retry policy.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        for attempt in 0..3 {
            let request = self.client.post(&self.endpoint)
                .header("x-api-key", &self.key).header("anthropic-version", "2023-06-01")
                .json(&json!({"model":self.model,"max_tokens":4096,"stream":true,"messages":history,
                    "tools":[{"name":"read_file","description":"Read a UTF-8 file under the configured workspace. Maximum 32768 bytes.","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}]}));
            let response = tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Interrupted),
                r = tokio::time::timeout_at(deadline,request.send()) => match r {
                    Ok(Ok(r)) => Ok(r),
                    _ => Err(ProviderError::Transport),
                },
            };
            let error = match response {
                Ok(response) if response.status().is_success() => {
                    // Once a successful body begins, no transparent replay: a
                    // hosted action/semantic block might already have started.
                    return read_stream(response, progress, cancel).await;
                }
                Ok(response) => ProviderError::Http(response.status().as_u16()),
                Err(error) => error,
            };
            let retryable = matches!(
                error,
                ProviderError::Transport | ProviderError::Http(429 | 500 | 502 | 503 | 504 | 529)
            );
            if !retryable || attempt == 2 || tokio::time::Instant::now() >= deadline {
                return Err(error);
            }
            let retry = json!({"kind":"provider.retry","attempt":attempt+1});
            tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Interrupted),
                _ = progress.send(retry) => {},
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Interrupted),
                _ = tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))) => {},
            }
        }
        unreachable!()
    }
}

/// Byte-oriented framing preserves UTF-8 split across network chunks. Both
/// CRLF and multiline data are legal SSE; frames are bounded before decoding.
#[derive(Default)]
pub struct SseDecoder {
    line: Vec<u8>,
    data: String,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, ProviderError> {
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
                    values.push(
                        serde_json::from_str(self.data.trim_end_matches('\n'))
                            .map_err(|_| ProviderError::Stream("invalid SSE JSON".into()))?,
                    );
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

async fn read_stream(
    response: reqwest::Response,
    progress: mpsc::Sender<Value>,
    cancel: CancellationToken,
) -> Result<Reply, ProviderError> {
    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut state = StreamState::default();
    let mut total = 0;
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err(ProviderError::Interrupted),
            result=tokio::time::timeout(Duration::from_secs(120),bytes.next()) => result.map_err(|_|ProviderError::Stream("provider idle timeout".into()))?,
        };
        let Some(chunk) = chunk else {
            return state.finish();
        };
        let chunk = chunk.map_err(|_| ProviderError::Transport)?;
        total += chunk.len();
        if total > 8 * 1024 * 1024 {
            return Err(ProviderError::Stream("message exceeds 8 MiB".into()));
        }
        for event in decoder.push(&chunk)? {
            state.event(&event)?;
            tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Interrupted),
                sent=progress.send(event) => if sent.is_err() { return Err(ProviderError::Interrupted); },
            }
            if state.stopped {
                return state.finish();
            }
        }
    }
}
