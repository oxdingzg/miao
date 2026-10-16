//! Explicit deployment-scoped Responses WebSocket transport; HTTP remains the default.
use crate::{
    permission::digest,
    provider::{read_stream, Parser, ProviderError, Reply},
    responses_cache::Authentication,
};
use futures_util::{stream, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub model: String,
    pub endpoint: String,
    pub authentication: Authentication,
    pub mode: Mode,
    #[serde(default)]
    pub beta: bool,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Full,
    Delta,
}
impl Contract {
    pub fn from_wire(input: &str) -> Result<Self, String> {
        serde_json::from_str(input).map_err(|_| "invalid Responses WebSocket contract".into())
    }
    pub(crate) fn validate(
        &self,
        model: &str,
        endpoint: &reqwest::Url,
        subscription: bool,
    ) -> Result<(), String> {
        let declared = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| "invalid Responses WebSocket endpoint")?;
        if self.model != model
            || &declared != endpoint
            || !matches!(declared.scheme(), "http" | "https")
            || declared.fragment().is_some()
            || !declared.username().is_empty()
            || declared.password().is_some()
            || (self.authentication == Authentication::Subscription) != subscription
        {
            return Err(
                "Responses WebSocket contract does not match model, endpoint or authentication"
                    .into(),
            );
        }
        Ok(())
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
#[derive(Default)]
struct Slot {
    socket: Option<Arc<tokio::sync::Mutex<Socket>>>,
    chain: Option<Chain>,
}
struct Chain {
    parameters: String,
    prefix: Vec<Value>,
    id: String,
}
struct Entry {
    slot: Arc<tokio::sync::Mutex<Slot>>,
    used: tokio::time::Instant,
}
#[derive(Default)]
pub(crate) struct Pool {
    slots: tokio::sync::Mutex<BTreeMap<String, Entry>>,
}
impl Pool {
    async fn slot(&self, key: Option<String>) -> Option<Arc<tokio::sync::Mutex<Slot>>> {
        let Some(key) = key else {
            return Some(Arc::new(tokio::sync::Mutex::new(Slot::default())));
        };
        let mut slots = self.slots.lock().await;
        let now = tokio::time::Instant::now();
        slots.retain(|_, entry| {
            Arc::strong_count(&entry.slot) > 1
                || now.duration_since(entry.used) < Duration::from_secs(180)
        });
        if !slots.contains_key(&key) && slots.len() >= 32 {
            let evict = slots
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.slot) == 1)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            if let Some(evict) = evict {
                slots.remove(&evict);
            }
        }
        if !slots.contains_key(&key) && slots.len() >= 32 {
            return None;
        }
        let entry = slots.entry(key).or_insert_with(|| Entry {
            slot: Arc::new(tokio::sync::Mutex::new(Slot::default())),
            used: now,
        });
        entry.used = now;
        Some(entry.slot.clone())
    }
}

#[derive(Default)]
struct Capture {
    created: Option<String>,
    completed: Option<String>,
    frames: usize,
    received: usize,
    rejected_chain: bool,
    confirmed_output: Option<Vec<Value>>,
}

/// Compare native history to acknowledged wire item boundaries and argument bytes.
/// Compact completion packets cannot prove their omitted output sequence here.
fn confirmed_output(response: &Value) -> Option<Vec<Value>> {
    let items = response["output"]
        .as_array()
        .filter(|items| !items.is_empty())?;
    let output:Vec<_>=items.iter().map(|item|match item["type"].as_str()? {
        "message" if item["role"]=="assistant"=>{
            let content:Vec<_>=item["content"].as_array()?.iter().map(|part| {
                if part["type"]!="output_text" {return None;}
                Some(json!({"type":"output_text","text":part["text"].as_str()?}))
            }).collect::<Option<_>>()?;
            Some(json!({"role":"assistant","content":content}))
        }
        "function_call"=>Some(json!({"type":"function_call","call_id":item["call_id"].as_str()?,"name":item["name"].as_str()?,"arguments":item["arguments"].as_str()?})),
        "reasoning"=>Some(item.clone()),
        _=>None,
    }).collect::<Option<_>>()?;
    serde_json::to_vec(&output)
        .ok()
        .filter(|bytes| bytes.len() <= 1024 * 1024)
        .map(|_| output)
}

/// `None` means no generation was delivered, or a suffix was explicitly rejected
/// before any other JSON frame. Ambiguous delivery is always an error, never HTTP replay.
pub(crate) async fn try_stream<P: Parser>(
    pool: &Pool,
    contract: &Contract,
    request: &reqwest::Request,
    progress: mpsc::Sender<Value>,
    cancel: CancellationToken,
    parser: P,
    output: impl Fn(&Reply) -> Result<Vec<Value>, ProviderError>,
) -> Result<Option<Reply>, ProviderError> {
    // The HTTP client owns proxy routing. This transport does not bypass it.
    if [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
    {
        return Ok(None);
    }
    let mut endpoint = request.url().clone();
    let scheme = if endpoint.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    endpoint
        .set_scheme(scheme)
        .map_err(|_| ProviderError::Transport)?;
    let session = crate::cache_affinity::session_key();
    let affinity=session.as_ref().map(|session|digest(&serde_json::to_vec(&json!({"session":session,"endpoint":endpoint.as_str(),"model":contract.model,"authentication":contract.authentication,"beta":contract.beta,"authorization":request.headers().get(reqwest::header::AUTHORIZATION).and_then(|value|value.to_str().ok()),"account":request.headers().get("ChatGPT-Account-Id").and_then(|value|value.to_str().ok())})).unwrap()));
    let Some(slot) = pool.slot(affinity).await else {
        return Ok(None);
    };
    let mut slot = tokio::select! { _=cancel.cancelled()=>return Err(ProviderError::Interrupted),slot=slot.lock()=>slot };
    let mut frame: Value = serde_json::from_slice(
        request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .ok_or(ProviderError::Transport)?,
    )
    .map_err(|_| ProviderError::Transport)?;
    frame
        .as_object_mut()
        .ok_or(ProviderError::Transport)?
        .remove("stream");
    frame["type"] = json!("response.create");
    let full_input = frame["input"]
        .as_array()
        .ok_or(ProviderError::Transport)?
        .clone();
    let mut parameters = frame.clone();
    parameters.as_object_mut().unwrap().remove("input");
    let parameters=digest(&serde_json::to_vec(&json!({"parameters":parameters,"context_epoch":crate::runtime_profile::context_epoch()})).unwrap());
    let delta = contract.mode == Mode::Delta
        && session.is_some()
        && slot.socket.is_some()
        && slot.chain.as_ref().is_some_and(|chain| {
            chain.parameters == parameters
                && full_input.len() > chain.prefix.len()
                && full_input.starts_with(&chain.prefix)
        });
    if delta {
        let chain = slot.chain.as_ref().unwrap();
        frame["input"] = json!(&full_input[chain.prefix.len()..]);
        frame["previous_response_id"] = json!(chain.id);
    }
    let wire = serde_json::to_string(&frame).map_err(|_| ProviderError::Transport)?;
    if wire.len() > 8 * 1024 * 1024 {
        return Err(ProviderError::Stream(
            "WebSocket request exceeds 8 MiB".into(),
        ));
    }
    let (deadline, attempt) = crate::provider::transport_attempt()?;
    let first_event = crate::first_event::FirstEventDeadline::default();
    let request_deadline = first_event.0.map_or(deadline, |first| deadline.min(first));
    let connect_deadline =
        request_deadline.min(tokio::time::Instant::now() + Duration::from_secs(15));
    let reused = slot.socket.is_some();
    // Taking both state axes poisons the chain on every early return and cancellation.
    let existing = slot.socket.take();
    slot.chain = None;
    let socket = match existing {
        Some(socket) => socket,
        None => {
            let mut handshake = endpoint
                .as_str()
                .into_client_request()
                .map_err(|_| ProviderError::Transport)?;
            for (name, value) in request.headers() {
                handshake.headers_mut().insert(name.clone(), value.clone());
            }
            if contract.beta {
                handshake.headers_mut().insert(
                    "OpenAI-Beta",
                    "responses_websockets=2026-02-06".parse().unwrap(),
                );
            }
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(8 * 1024 * 1024);
            config.max_frame_size = Some(8 * 1024 * 1024);
            let connected = tokio::select! { _=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout_at(connect_deadline,connect_async_with_config(handshake,Some(config),false))=>result };
            match connected {
                Ok(Ok((socket, _))) => Arc::new(tokio::sync::Mutex::new(socket)),
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response)))
                    if matches!(response.status().as_u16(), 401 | 403 | 429) =>
                {
                    return Err(ProviderError::Http(response.status().as_u16()))
                }
                _ => return Ok(None),
            }
        }
    };
    // Buffered logical request evidence hashes the actual WS JSON frame, not HTTP's full body.
    let mut observation = reqwest::Request::new(reqwest::Method::GET, endpoint);
    *observation.headers_mut() = request.headers().clone();
    *observation.body_mut() = Some(reqwest::Body::from(wire.clone()));
    let request_seq =
        crate::runtime_profile::record("openai-responses", &observation, attempt).await?;
    let mut writer = socket.lock().await;
    let sent = tokio::select! { _=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout_at(request_deadline,writer.send(Message::Text(wire.clone().into())))=>result };
    drop(writer);
    if !matches!(sent, Ok(Ok(()))) {
        crate::runtime_profile::result(request_seq, None, "websocket_delivery_unknown", None)
            .await?;
        return Err(ProviderError::ResponseTransport);
    }
    crate::runtime_profile::result(request_seq, Some(101), "websocket_frame_sent", None).await?;
    let capture = Arc::new(Mutex::new(Capture::default()));
    let stream = stream::unfold(
        (socket.clone(), capture.clone()),
        |(socket, capture)| async move {
            loop {
                let message = socket.lock().await.next().await;
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.lock().await.send(Message::Pong(payload)).await;
                        continue;
                    }
                    Some(Ok(Message::Pong(_))) => continue,
                    _ => {
                        return Some((
                            Err(std::io::Error::other("WebSocket response interrupted")),
                            (socket, capture),
                        ))
                    }
                };
                let event: Value = match serde_json::from_str(&text) {
                    Ok(event) => event,
                    Err(_) => {
                        return Some((
                            Err(std::io::Error::other("invalid WebSocket JSON")),
                            (socket, capture),
                        ))
                    }
                };
                {
                    let mut capture = capture.lock().unwrap();
                    capture.frames += 1;
                    capture.received += text.len();
                    if event["type"] == "response.created" {
                        capture.created = event["response"]["id"]
                            .as_str()
                            .filter(|id| !id.is_empty() && id.len() <= 256)
                            .map(str::to_owned);
                    }
                    if event["type"] == "response.completed" {
                        capture.completed = event["response"]["id"]
                            .as_str()
                            .filter(|id| !id.is_empty() && id.len() <= 256)
                            .map(str::to_owned);
                        capture.confirmed_output = confirmed_output(&event["response"]);
                    }
                    capture.rejected_chain = capture.frames == 1
                        && event["type"] == "error"
                        && matches!(
                            event["error"]["code"].as_str(),
                            Some(
                                "previous_response_not_found"
                                    | "previous_response_id_not_found"
                                    | "invalid_previous_response_id"
                            )
                        );
                }
                let bytes = format!("data: {}\n\n", event).into_bytes();
                return Some((Ok::<_, std::io::Error>(bytes), (socket, capture)));
            }
        },
    );
    let response = tokio_tungstenite::tungstenite::http::Response::builder()
        .status(200)
        .body(reqwest::Body::wrap_stream(stream))
        .map_err(|_| ProviderError::Transport)?;
    let mut response = reqwest::Response::from(response);
    response.extensions_mut().insert(first_event);
    let result = read_stream(response, progress.clone(), cancel.clone(), parser).await;
    let capture = capture.lock().unwrap();
    let _=progress.try_send(json!({"kind":"transport.websocket","reused":reused,"delta":delta,"json_sent_bytes":wire.len(),"json_received_bytes":capture.received}));
    match result {
        Ok(reply) => {
            if cancel.is_cancelled() {
                return Err(ProviderError::Interrupted);
            }
            if contract.mode == Mode::Delta
                && session.is_some()
                && capture.created.is_some()
                && capture.created == capture.completed
            {
                let native_output = output(&reply)?;
                if capture.confirmed_output.as_ref() == Some(&native_output) {
                    let mut prefix = full_input;
                    prefix.extend(native_output);
                    if serde_json::to_vec(&prefix).is_ok_and(|bytes| bytes.len() <= 1024 * 1024) {
                        slot.chain = Some(Chain {
                            parameters,
                            prefix,
                            id: capture.completed.clone().unwrap(),
                        });
                    }
                }
            }
            slot.socket = Some(socket);
            Ok(Some(reply))
        }
        Err(_) if delta && capture.rejected_chain => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::Pool;
    #[tokio::test(start_paused = true)]
    async fn connection_slots_are_bounded_and_idle_slots_expire_without_evicting_busy_sessions() {
        let pool = Pool::default();
        let mut busy = vec![];
        for index in 0..32 {
            busy.push(pool.slot(Some(format!("session-{index}"))).await.unwrap());
        }
        assert!(pool.slot(Some("overflow".into())).await.is_none());
        drop(busy.pop());
        let replacement = pool.slot(Some("replacement".into())).await.unwrap();
        assert_eq!(pool.slots.lock().await.len(), 32);
        drop(replacement);
        drop(busy);
        tokio::time::advance(std::time::Duration::from_secs(181)).await;
        let _next = pool.slot(Some("fresh".into())).await.unwrap();
        assert_eq!(pool.slots.lock().await.len(), 1);
    }
}
