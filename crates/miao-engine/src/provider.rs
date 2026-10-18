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
    #[error("provider response transport interrupted; local calls were not dispatched")]
    ContinuableTransport {
        partial: Reply,
        unexecuted_calls: usize,
    },
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
    pub(crate) fn continuation(&self) -> Option<(&Reply, usize)> {
        match self {
            Self::ContinuableTransport {
                partial,
                unexecuted_calls,
            } => Some((partial, *unexecuted_calls)),
            Self::Routed { source, .. } => source.continuation(),
            _ => None,
        }
    }

    pub fn routing(&self) -> Option<&Value> {
        match self {
            Self::Routed { selection, .. } => Some(selection),
            _ => None,
        }
    }
}
/// Unavailable arguments remain explicit null in history; raw malformed JSON
/// is not retained in a completed local call or its error result.
pub(crate) fn decode_tool_call(
    id: &str,
    name: &str,
    arguments: &str,
) -> Result<Value, ProviderError> {
    match serde_json::from_str::<Value>(arguments) {
        Ok(input) if input.is_object() => {
            Ok(json!({"type":"tool_use","id":id,"name":name,"input":input}))
        }
        Ok(_) => Err(ProviderError::Stream("tool input must be an object".into())),
        Err(_) => Ok(
            json!({"type":"tool_use","id":id,"name":name,"input":null,"input_error":"invalid_json"}),
        ),
    }
}

pub(crate) fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 512 && !model.chars().any(char::is_control)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
pub(crate) fn transport_attempt() -> Result<(tokio::time::Instant, usize), ProviderError> {
    let scope = RETRY_SCOPE
        .try_with(Clone::clone)
        .unwrap_or_else(|_| RetryScope {
            budget: Budget::new(),
            limit: 3,
        });
    if scope.limit == 0
        || tokio::time::Instant::now() >= scope.budget.deadline
        || !scope.budget.take()
    {
        return Err(ProviderError::Transport);
    }
    Ok((scope.budget.deadline, scope.budget.used()))
}
pub(crate) async fn scoped<F: std::future::Future<Output = Result<Reply, ProviderError>>>(
    budget: Arc<Budget>,
    limit: usize,
    future: F,
) -> Result<Reply, ProviderError> {
    RETRY_SCOPE
        .scope(RetryScope { budget, limit }, future)
        .await
}

/// Trusted route manifests may bind a gateway header to the current opaque
/// Session routing key. Keep that identity out of the model request contract.
pub(crate) fn route_headers(
    mut request: reqwest::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    for (name, value) in headers {
        if value == "$session" {
            let key = crate::cache_affinity::session_key().ok_or_else(|| {
                ProviderError::Stream("session header requires a Session-scoped request".into())
            })?;
            request = request.header(name, key);
            continue;
        }
        request = request.header(name, value);
    }
    Ok(request)
}

#[cfg(test)]
mod route_header_tests {
    use super::*;
    use axum::{extract::State, http::HeaderMap, routing::post, Router};
    use tokio::sync::Mutex;

    type Requests = Arc<Mutex<Vec<(String, String)>>>;

    #[tokio::test]
    async fn gateway_headers_follow_actual_session_across_protocols_and_model_selection() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let router = Router::new()
            .route(
                "/fixture",
                post(
                    |State(seen): State<Requests>, headers: HeaderMap| async move {
                        seen.lock().await.push((
                            headers["x-opencode-session"].to_str().unwrap().to_owned(),
                            headers["x-route-fixture"].to_str().unwrap().to_owned(),
                        ));
                        axum::http::StatusCode::BAD_REQUEST
                    },
                ),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let auth = serde_json::from_value::<crate::model_routes::Auth>(json!({
            "headers": {"x-opencode-session":"$session", "x-route-fixture":"kept"}
        }))
        .unwrap();
        for protocol in ["anthropic", "openai-chat"] {
            let provider = crate::routing::build_with_auth(
                protocol,
                Some(&endpoint),
                Source::Static(Credential::key("fixture".into())),
                "model".into(),
                false,
                Some(&auth),
            )
            .unwrap()
            .for_model("selected-model")
            .unwrap();
            for session in ["parent", "child"] {
                let (progress, _received) = mpsc::channel(16);
                let result = crate::cache_affinity::scoped_with(
                    "shared-affinity".into(),
                    session.into(),
                    provider.stream(
                        ModelRequest {
                            system: String::new(),
                            messages: vec![],
                            tools: vec![],
                        },
                        progress,
                        CancellationToken::new(),
                    ),
                )
                .await;
                assert!(matches!(result, Err(ProviderError::Http(400))));
            }
            let (progress, _received) = mpsc::channel(16);
            assert!(matches!(
                provider
                    .stream(
                        ModelRequest {
                            system: String::new(),
                            messages: vec![],
                            tools: vec![]
                        },
                        progress,
                        CancellationToken::new(),
                    )
                    .await,
                Err(ProviderError::Stream(_))
            ));
        }
        let seen = seen.lock().await;
        assert_eq!(seen.len(), 4);
        for (index, (key, value)) in seen.iter().enumerate() {
            let session = if index % 2 == 0 { "parent" } else { "child" };
            assert_eq!(key, &crate::permission::digest(session.as_bytes()));
            assert_eq!(value, "kept");
        }
        assert_ne!(seen[0].0, seen[1].0);
        server.abort();
    }
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
    /// The identity that actually produced this successful reply. Unknown
    /// custom providers retain None rather than borrowing a configured route.
    fn reply_identity(&self, _reply: &Reply) -> Option<Identity> {
        self.identity()
    }
    /// Select another model on this exact route without changing endpoint or
    /// credential ownership. Custom/composite providers opt in explicitly.
    fn for_model(&self, _model: &str) -> Option<Arc<dyn Provider>> {
        None
    }
    /// Exact host-registered routes only; controller input cannot retarget them.
    fn for_route(&self, _route_id: &str) -> Option<Arc<dyn Provider>> {
        None
    }
    fn for_route_variant(
        &self,
        _route_id: Option<&str>,
        _variant: &str,
    ) -> Option<Arc<dyn Provider>> {
        None
    }
    fn with_route_auth(
        &self,
        _auth: &crate::model_routes::Auth,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        Err(ProviderError::Stream(
            "provider does not support host route authentication".into(),
        ))
    }
    fn with_input_modalities(
        &self,
        _input: Vec<String>,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        Err(ProviderError::Stream(
            "provider does not support host input modalities".into(),
        ))
    }
    fn with_request_options(
        &self,
        _options: crate::request_options::Options,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        Err(ProviderError::Stream(
            "provider does not support generation overrides".into(),
        ))
    }
    /// Resolve a credential only against the host's registered model family.
    /// This private lookup never makes credential metadata part of the catalog.
    fn route_account(&self, _route: &str) -> Option<crate::model_catalog::Account> {
        None
    }

    fn account_route(
        &self,
        _credential: Option<&str>,
        _current: Option<&crate::session_model::Binding>,
        _identity: &Identity,
    ) -> Result<Option<crate::model_catalog::Info>, ProviderError> {
        Ok(None)
    }
    fn model_catalog(&self) -> Vec<crate::model_catalog::Info> {
        self.identity()
            .into_iter()
            .map(|identity| crate::model_catalog::Info {
                route_id: None,
                protocol: identity.protocol,
                model: identity.model,
                variants: vec![],
            })
            .collect()
    }
    fn protected_resources(&self) -> Vec<std::path::PathBuf> {
        vec![]
    }
    /// Provider-native token counting for context management (§2.13 gate ②).
    async fn count_tokens(&self, _request: &ModelRequest) -> CountTokens {
        CountTokens::Unsupported
    }

    /// Auxiliary requests can retain the exact tool schema prefix while the
    /// wire protocol forbids tool invocation. Unknown adapters opt out rather
    /// than treating a prompt instruction as an execution guarantee.
    fn supports_tool_free_stream(&self) -> bool {
        false
    }

    async fn stream_without_tools(
        &self,
        _request: ModelRequest,
        _progress: mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Err(ProviderError::Stream(
            "tool-free stream is unsupported".into(),
        ))
    }

    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError>;
}

/// Provider-native token counting for context management (§2.13 gate ②).
/// A refused or failed count must never fail the turn; every non-`Counted`
/// case falls back to the char estimate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CountTokens {
    /// The provider has no count endpoint; use the estimate.
    Unsupported,
    /// The provider reported the prompt's input tokens.
    Counted(u64),
    /// The endpoint refused, was unreadable, or the transport failed.
    Failed(String),
}

#[derive(Clone)]
pub struct Anthropic {
    client: reqwest::Client,
    endpoint: String,
    source: Source,
    model: String,
    request_options: crate::request_options::Options,
    input_modalities: Vec<String>,
    max_tokens: u32,
    prompt_cache: bool,
    /// Vertex AI authenticates with an OAuth bearer and a `:rawPredict`
    /// endpoint instead of the `x-api-key` header.
    bearer: bool,
    copilot: bool,
    extra_headers: BTreeMap<String, String>,
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
            request_options: Default::default(),
            input_modalities: vec![],
            max_tokens: 4096,
            prompt_cache: false,
            bearer: false,
            copilot: false,
            extra_headers: BTreeMap::new(),
        })
    }

    /// Vertex AI carries the Anthropic codec over an OAuth bearer credential.
    pub fn with_bearer_source(
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
            request_options: Default::default(),
            input_modalities: vec![],
            max_tokens: 4096,
            prompt_cache: false,
            bearer: true,
            copilot: false,
            extra_headers: BTreeMap::new(),
        })
    }

    /// Anthropic requires an explicit output cap; 4096 is only the pre-existing
    /// default, so a caller that knows the model's limit should set it.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    pub fn with_headers(mut self, headers: BTreeMap<String, String>) -> Self {
        self.extra_headers = headers;
        self
    }

    /// Marks the stable prefix — system prompt and the tool catalog — as a
    /// cacheable breakpoint. Anthropic caches up to the marked block, so both
    /// belong to the same prefix and adding another one later invalidates it.
    pub fn with_prompt_cache(mut self, enabled: bool) -> Self {
        self.prompt_cache = enabled;
        self
    }
}

impl Anthropic {
    async fn stream_mode(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
        without_tools: bool,
    ) -> Result<Reply, ProviderError> {
        let request = crate::media::normalize(request, "anthropic", &self.input_modalities)?;
        let copilot = self.copilot.then(|| crate::copilot::turn(&request));
        let credential = self.source.load().await?;
        if credential.kind() != Kind::Key && !self.copilot {
            return Err(ProviderError::AuthProfile);
        }
        let mut messages = request.messages;
        for message in &mut messages {
            let blocks = message
                .content
                .as_array_mut()
                .ok_or_else(|| ProviderError::Stream("unsupported Anthropic history".into()))?;
            for block in blocks {
                if block["type"] == "image" || block["type"] == "file" {
                    *block = crate::media::anthropic_part(block, &message.role)?;
                    continue;
                }
                if message.role == "assistant" && block["type"] == "reasoning" {
                    let text = block["text"].as_str().ok_or_else(|| {
                        ProviderError::Stream("invalid Anthropic reasoning part".into())
                    })?;
                    let mut thinking = json!({"type":"thinking","thinking":text});
                    if let Some(signature) = block
                        .get("signature")
                        .and_then(Value::as_str)
                        .filter(|signature| !signature.is_empty())
                    {
                        thinking["signature"] = Value::String(signature.into());
                    }
                    *block = thinking;
                    continue;
                }
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
        // Internal commit metadata is not part of the provider message schema.
        let messages: Vec<Value> = messages
            .into_iter()
            .map(|message| json!({"role":message.role,"content":message.content}))
            .collect();
        // The default stays the plain string system prompt and a plain tool
        // catalog; the block form is only needed to carry a cache breakpoint.
        let tools = if self.prompt_cache {
            let mut tools =
                serde_json::to_value(&request.tools).map_err(|_| ProviderError::Transport)?;
            if let Some(last) = tools.as_array_mut().and_then(|tools| tools.last_mut()) {
                last["cache_control"] = json!({"type":"ephemeral"});
            }
            tools
        } else {
            json!(request.tools)
        };
        let system = if self.prompt_cache {
            json!([{"type":"text","text":request.system,"cache_control":{"type":"ephemeral"}}])
        } else {
            json!(request.system)
        };
        let mut body = json!({"model":self.model,"max_tokens":self.max_tokens,"stream":true,"messages":messages,"system":system,"tools":tools});
        if without_tools {
            body["tool_choice"] = json!({"type":"none"});
        }
        self.request_options.apply(&mut body);
        let mut request = self.client.post(&self.endpoint).json(&body);
        request = if self.bearer {
            request.header("Authorization", format!("Bearer {}", credential.secret()))
        } else {
            request.header("x-api-key", credential.header()?)
        };
        let mut request = route_headers(
            self.request_options
                .headers(request.header("anthropic-version", "2023-06-01"))?,
            &self.extra_headers,
        )?
        .build()
        .map_err(|_| ProviderError::Transport)?;
        if let Some(headers) = copilot {
            crate::copilot::apply(&mut request, &headers, true)?;
        }
        let response =
            request_with_retry("anthropic", &self.client, request, &progress, &cancel).await?;
        read_stream(response, progress, cancel, StreamState::default()).await
    }
}

#[async_trait]
impl Provider for Anthropic {
    fn with_route_auth(
        &self,
        auth: &crate::model_routes::Auth,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        auth.validate()?;
        if !auth.query.is_empty() {
            return Err(ProviderError::Stream(
                "Anthropic does not support host route query parameters".into(),
            ));
        }
        let mut selected = self.clone();
        match auth.style.as_deref() {
            None => {}
            Some("bearer") => {
                selected.bearer = true;
                selected.copilot = false;
            }
            Some("api-key") => {
                selected.bearer = false;
                selected.copilot = false;
            }
            Some("copilot") => {
                selected.bearer = true;
                selected.copilot = true;
            }
            _ => {
                return Err(ProviderError::Stream(
                    "unsupported Anthropic route auth style".into(),
                ))
            }
        }
        auth.apply_headers(&mut selected.extra_headers);
        Ok(Arc::new(selected))
    }
    fn with_input_modalities(
        &self,
        input: Vec<String>,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        crate::media::validate_modalities(&input)?;
        let mut selected = self.clone();
        selected.input_modalities = input;
        Ok(Arc::new(selected))
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
        selected.request_options = options;
        Ok(std::sync::Arc::new(selected))
    }
    fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        if !valid_model(model) {
            return None;
        }
        let mut selected = self.clone();
        selected.model = model.to_owned();
        Some(Arc::new(selected))
    }
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

    /// Advisory pre-send count against the provider's own endpoint. No retry
    /// and a short timeout: any refusal degrades to the estimate.
    async fn count_tokens(&self, request: &ModelRequest) -> CountTokens {
        let request =
            match crate::media::normalize(request.clone(), "anthropic", &self.input_modalities) {
                Ok(request) => request,
                Err(_) => return CountTokens::Failed("unsupported Anthropic media".into()),
            };
        let credential = match self.source.load().await {
            Ok(credential) if credential.kind() == Kind::Key => credential,
            _ => return CountTokens::Failed("credential unavailable".into()),
        };
        let header = match credential.header() {
            Ok(header) => header,
            Err(_) => return CountTokens::Failed("credential header unavailable".into()),
        };
        let messages = request
            .messages
            .iter()
            .map(|message| {
                let parts = message
                    .content
                    .as_array()
                    .ok_or_else(|| ProviderError::Stream("invalid Anthropic history".into()))?;
                let content = parts
                    .iter()
                    .map(|part| crate::media::anthropic_part(part, &message.role))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({"role":message.role,"content":content}))
            })
            .collect::<Result<Vec<_>, ProviderError>>();
        let messages = match messages {
            Ok(messages) => messages,
            Err(_) => return CountTokens::Failed("unsupported Anthropic media".into()),
        };
        if self.bearer {
            return CountTokens::Failed("bearer route has no count endpoint".into());
        }
        let builder = self
            .client
            .post(format!("{}/count_tokens", self.endpoint))
            .header("x-api-key", header)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({"model": self.model, "messages": messages}));
        let builder = match route_headers(builder, &self.extra_headers) {
            Ok(builder) => builder,
            Err(_) => return CountTokens::Failed("invalid route headers".into()),
        };
        let request = builder.build();
        let request = match request {
            Ok(request) => request,
            Err(_) => return CountTokens::Failed("count request build failed".into()),
        };
        match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            self.client.execute(request),
        )
        .await
        {
            Ok(Ok(response)) if response.status().is_success() => {
                let counted = response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|body| body["input_tokens"].as_u64());
                counted
                    .map(CountTokens::Counted)
                    .unwrap_or_else(|| CountTokens::Failed("count response unreadable".into()))
            }
            Ok(Ok(response)) => {
                CountTokens::Failed(format!("count refused: {}", response.status()))
            }
            Ok(Err(_)) | Err(_) => CountTokens::Failed("count transport failed".into()),
        }
    }
}

/// One frame can normalize into several fragments; a receiver that went away
/// stops the stream exactly like a single failed send would.
async fn send_all(progress: &mpsc::Sender<Value>, notices: &[Value]) -> Result<(), ()> {
    for notice in notices {
        if progress.send(notice.clone()).await.is_err() {
            return Err(());
        }
    }
    Ok(())
}

/// The provider's error body is the only diagnostic for an opaque HTTP status.
/// Keep it bounded, and never let a slow or endless body block the failure.
async fn failure_detail(response: &mut reqwest::Response) -> Option<String> {
    let mut detail = Vec::new();
    while detail.len() < 1024 {
        match tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk()).await {
            Ok(Ok(Some(chunk))) => detail.extend_from_slice(&chunk),
            _ => break,
        }
    }
    detail.truncate(1024);
    (!detail.is_empty()).then(|| String::from_utf8_lossy(&detail).into_owned())
}

/// Publish one attempt's fate beside the profile record it writes to the store.
/// The store is durable but a sweep cannot read it, so the same fact travels as
/// progress, where the evaluation runner's evidence can. Best effort: a full
/// channel drops the notice rather than holding the request that produced it.
fn announce(
    progress: &mpsc::Sender<Value>,
    protocol: &str,
    attempt: usize,
    status: Option<u16>,
    outcome: &str,
    detail: Option<&str>,
) {
    let _ = progress.try_send(json!({
        "kind": "provider.attempt",
        "protocol": protocol,
        "attempt": attempt,
        "status": status,
        "outcome": outcome,
        "detail": detail,
    }));
}

pub(crate) async fn request_with_retry(
    protocol: &str,
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
        let request_seq =
            crate::runtime_profile::record(protocol, &request, scope.budget.used()).await?;
        let first_event = crate::first_event::FirstEventDeadline::default();
        let request_deadline = first_event.0.map_or(deadline, |first| deadline.min(first));
        let response = tokio::select! {
            _=cancel.cancelled()=>Err(ProviderError::Interrupted),
            result=tokio::time::timeout_at(request_deadline,client.execute(request))=>match result {
                Ok(Ok(mut response))=>{ response.extensions_mut().insert(first_event); Ok(response) },
                _=>Err(ProviderError::Transport),
            },
        };
        let (status, outcome) = match &response {
            Ok(response) => (Some(response.status().as_u16()), "headers_received"),
            Err(ProviderError::Interrupted) => (None, "interrupted_unknown"),
            Err(_) => (None, "transport_unknown"),
        };
        let error = match response {
            Ok(response) if response.status().is_success() => {
                crate::runtime_profile::result(request_seq, status, outcome, None).await?;
                announce(progress, protocol, attempt, status, outcome, None);
                return Ok(response);
            }
            Ok(mut response) => {
                let status = response.status().as_u16();
                let detail = failure_detail(&mut response).await;
                crate::runtime_profile::result(
                    request_seq,
                    Some(status),
                    outcome,
                    detail.as_deref(),
                )
                .await?;
                announce(
                    progress,
                    protocol,
                    attempt,
                    Some(status),
                    outcome,
                    detail.as_deref(),
                );
                ProviderError::Http(status)
            }
            Err(error) => {
                crate::runtime_profile::result(request_seq, status, outcome, None).await?;
                announce(progress, protocol, attempt, status, outcome, None);
                error
            }
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
        // Carry the reason so a client can show why the attempt was retried.
        // Only retryable errors reach here, so `is_retryable` is true by
        // construction; the status code is the HTTP one when there was one.
        let (reason, status) = match &error {
            ProviderError::Http(status) => (error.to_string(), Some(*status)),
            other => (other.to_string(), None),
        };
        tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            result=progress.send(json!({"kind":"provider.retry","attempt":attempt+1,"reason":reason,"status":status}))=>if result.is_err(){return Err(ProviderError::Interrupted);},
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

pub(crate) trait Parser: Sized {
    fn frame(&mut self, frame: &Frame) -> Result<(), ProviderError>;
    fn terminal(&self) -> bool;
    fn interrupted(self) -> ProviderError {
        ProviderError::ResponseTransport
    }
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

/// Anthropic reports thinking natively; the canonical part is `reasoning`, so
/// the opaque signature travels with it and the lowering step restores the
/// block shape the provider expects.
fn reasoning_part(block: Value) -> Value {
    if block["type"] != "thinking" {
        return block;
    }
    let text = block["thinking"].as_str().unwrap_or("").to_owned();
    let mut part = json!({"type":"reasoning","text":text});
    if let Some(signature) = block["signature"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        part["signature"] = Value::String(signature.into());
    }
    part
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
                if !matches!(
                    block["type"].as_str(),
                    Some("text" | "tool_use" | "thinking")
                ) || self.blocks.contains_key(&index)
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
                    Some("thinking_delta") if block["type"] == "thinking" => {
                        let text = event["delta"]["thinking"].as_str().ok_or_else(|| {
                            ProviderError::Stream("invalid thinking delta".into())
                        })?;
                        let mut value = block["thinking"].as_str().unwrap_or("").to_owned();
                        value.push_str(text);
                        block["thinking"] = Value::String(value);
                    }
                    // The signature is opaque to us and must return verbatim
                    // with the reasoning it authenticated.
                    Some("signature_delta") if block["type"] == "thinking" => {
                        let signature = event["delta"]["signature"].as_str().ok_or_else(|| {
                            ProviderError::Stream("invalid signature delta".into())
                        })?;
                        let mut value = block["signature"].as_str().unwrap_or("").to_owned();
                        value.push_str(signature);
                        block["signature"] = Value::String(value);
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
                    let block = self.blocks.get_mut(&index).expect("block exists");
                    *block = decode_tool_call(
                        block["id"]
                            .as_str()
                            .ok_or_else(|| ProviderError::Stream("missing tool id".into()))?,
                        block["name"]
                            .as_str()
                            .ok_or_else(|| ProviderError::Stream("missing tool name".into()))?,
                        &text,
                    )?;
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
        let visible = |key: &str| {
            self.blocks
                .values()
                .any(|b| b[key].as_str().is_some_and(|value| !value.is_empty()))
        };
        if self.blocks.is_empty() || (!needs_tools && !visible("text") && !visible("thinking")) {
            return Err(ProviderError::Stream("empty completed message".into()));
        }
        Ok(Reply {
            content: Value::Array(self.blocks.into_values().map(reasoning_part).collect()),
            usage: crate::usage::anthropic(&Value::Object(self.usage)),
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
    fn interrupted(self) -> ProviderError {
        if self.blocks.is_empty() {
            return ProviderError::ResponseTransport;
        }
        let unexecuted_calls = self
            .blocks
            .values()
            .filter(|block| block["type"] == "tool_use")
            .count();
        let content = self
            .blocks
            .into_values()
            .map(reasoning_part)
            .filter(|block| {
                matches!(block["type"].as_str(), Some("text" | "reasoning"))
                    && block["text"]
                        .as_str()
                        .or(block["thinking"].as_str())
                        .is_some_and(|text| !text.is_empty())
            })
            .collect::<Vec<_>>();
        ProviderError::ContinuableTransport {
            partial: Reply {
                content: Value::Array(content),
                usage: if self.usage.is_empty() {
                    Value::Null
                } else {
                    Value::Object(self.usage)
                },
                needs_tools: false,
            },
            unexecuted_calls,
        }
    }
    fn finish(self) -> Result<Reply, ProviderError> {
        StreamState::finish(self)
    }
}

pub(crate) async fn read_stream<P: Parser>(
    response: reqwest::Response,
    progress: mpsc::Sender<Value>,
    cancel: CancellationToken,
    parser: P,
) -> Result<Reply, ProviderError> {
    read_stream_with_budget(
        response,
        progress,
        cancel,
        parser,
        crate::tool_input::ToolInputBudget::default(),
    )
    .await
}

async fn read_stream_with_budget<P: Parser>(
    response: reqwest::Response,
    progress: mpsc::Sender<Value>,
    cancel: CancellationToken,
    mut parser: P,
    mut input_budget: crate::tool_input::ToolInputBudget,
) -> Result<Reply, ProviderError> {
    let mut first_event = response
        .extensions()
        .get::<crate::first_event::FirstEventDeadline>()
        .copied()
        .unwrap_or_default()
        .0;
    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut total = 0;
    loop {
        let deadline = input_budget
            .deadline()
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(120));
        let first_deadline =
            first_event.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(60));
        let chunk = tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            _=tokio::time::sleep_until(first_deadline), if first_event.is_some()=>return Err(ProviderError::Transport),
            _=tokio::time::sleep_until(deadline), if input_budget.deadline().is_some()=>return Err(input_budget.timeout_error()),
            result=tokio::time::timeout(Duration::from_secs(120),bytes.next())=>result.map_err(|_|ProviderError::Stream("provider idle timeout".into()))?,
        };
        let Some(chunk) = chunk else {
            return parser.finish();
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => return Err(parser.interrupted()),
        };
        total += chunk.len();
        if total > 8 * 1024 * 1024 {
            return Err(ProviderError::Stream("message exceeds 8 MiB".into()));
        }
        for frame in decoder.push(&chunk)? {
            input_budget.frame(&frame)?;
            parser.frame(&frame)?;
            if match &frame {
                Frame::Done => true,
                Frame::Json(event) => crate::first_event::semantic_event(event),
            } {
                first_event = None;
            }
            // Publish a normalized delta alongside the raw frame. The engine's
            // own first-event and retry logic reads `raw` through `semantic_event`,
            // so the provider wire format stays untouched there.
            let notices = match &frame {
                Frame::Json(event) => {
                    let normalized = crate::delta::normalize(event);
                    if normalized.is_empty() {
                        vec![event.clone()]
                    } else {
                        normalized
                            .into_iter()
                            .map(|delta| json!({"kind":"delta","delta":delta,"raw":event}))
                            .collect()
                    }
                }
                Frame::Done => vec![json!({"kind":"stream.done"})],
            };
            let deadline = input_budget
                .deadline()
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(120));
            tokio::select! {
                _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
                _=tokio::time::sleep_until(deadline), if input_budget.deadline().is_some()=>return Err(input_budget.timeout_error()),
                result=send_all(&progress, &notices)=>if result.is_err(){return Err(ProviderError::Interrupted);},
            }
            if parser.terminal() {
                return parser.finish();
            }
        }
    }
}

#[cfg(test)]
mod input_watchdog_tests {
    use super::{read_stream_with_budget, ProviderError, StreamState};
    use crate::tool_input::ToolInputBudget;
    use serde_json::json;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::mpsc,
    };
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn tool_deadline_interrupts_silence_pings_and_progress_backpressure() {
        for mode in 0..3 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(stream.read_u8().await.unwrap());
                }
                let start = json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"write_file","input":{}}});
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {{\"type\":\"message_start\",\"message\":{{}}}}\n\ndata: {start}\n\n").as_bytes()).await.unwrap();
                loop {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    if mode == 1
                        && stream
                            .write_all(b"data: {\"type\":\"ping\"}\n\n")
                            .await
                            .is_err()
                    {
                        return;
                    }
                }
            });
            let response = reqwest::get(format!("http://{address}/")).await.unwrap();
            let (progress, _receive) = mpsc::channel(if mode == 2 { 1 } else { 64 });
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                read_stream_with_budget(
                    response,
                    progress,
                    CancellationToken::new(),
                    StreamState::default(),
                    ToolInputBudget::testing(1024, Duration::from_millis(30)),
                ),
            )
            .await
            .unwrap();
            assert!(
                matches!(result, Err(ProviderError::Stream(message)) if message.contains("tool input idle timeout"))
            );
            server.abort();
        }
    }
}
