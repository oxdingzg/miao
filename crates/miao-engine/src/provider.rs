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
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The transport an SDK package name stands for, shared by the route plan
/// and the agent manifest resolution.
pub(crate) fn transport_for_package(package: &str) -> Option<&'static str> {
    match package {
        "@ai-sdk/anthropic" => Some("anthropic"),
        "@ai-sdk/google" | "@ai-sdk/google-vertex" => Some("gemini"),
        "@ai-sdk/openai" | "@ai-sdk/openai-compatible" => Some("openai-chat"),
        _ => None,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("interrupted")]
    Interrupted,
    #[error("provider transport failed: {0}")]
    Transport(String),
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
    /// A provider status code plus the provider's own words about it: the
    /// bounded body excerpt and `Retry-After` when the response carried them.
    /// A bare code cannot tell a rate limit from an upstream fault.
    #[error("provider HTTP {0}{1}")]
    Http(u16, String),
    #[error("invalid provider stream: {0}")]
    Stream(String),
    #[error("provider request rejected: {0}")]
    Rejected(String),
    /// The repetitive-output guard stopped the stream. Never retried: the same
    /// request would loop again, and earlier tool changes may already have
    /// completed. `partial` keeps what the user already saw durable.
    #[error("stopped repetitive {channel} output; this turn was not retried and earlier tool changes may already have completed")]
    Repetitive {
        channel: &'static str,
        partial: Reply,
    },
}

impl ProviderError {
    pub(crate) fn can_fallback(&self) -> bool {
        matches!(self, Self::Transport(_))
            || matches!(self, Self::Http(status, _) if retryable_status(*status))
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
    /// The guard's channel and the reply the stopped stream had produced.
    pub(crate) fn repetition(&self) -> Option<(&'static str, &Reply)> {
        match self {
            Self::Repetitive { channel, partial } => Some((channel, partial)),
            Self::Routed { source, .. } => source.repetition(),
            _ => None,
        }
    }

    pub fn routing(&self) -> Option<&Value> {
        match self {
            Self::Routed { selection, .. } => Some(selection),
            _ => None,
        }
    }
    /// The endpoint could not be reached or would not serve this turn. A routed
    /// turn wraps the failing route's error, and that route was still about
    /// availability: reporting it as a malformed request sends the operator
    /// debugging their own input while the provider is down.
    pub(crate) fn unavailable(&self) -> bool {
        match self {
            Self::Routed { source, .. } => source.unavailable(),
            Self::Transport(_) | Self::ResponseTransport | Self::ContinuableTransport { .. } => {
                true
            }
            Self::Http(status, _) => retryable_status(*status),
            _ => false,
        }
    }
    /// Statuses that blame the request itself, so the promoted input is the
    /// thing to quarantine. A routed rejection has the same cause as a direct
    /// one.
    pub(crate) fn input_rejected(&self) -> bool {
        match self {
            Self::Routed { source, .. } => source.input_rejected(),
            Self::Http(status, _) => matches!(status, 400 | 404 | 413 | 422),
            _ => false,
        }
    }
    /// The turn stopped instead of retrying, and the sentence says why. It
    /// travels on the failure itself because the refusal is the last thing the
    /// turn produces: an error that only repeated the provider's own words left
    /// the operator unable to tell "no attempt fitted what was left" from "the
    /// attempts ran out".
    fn refused_by_window(self, note: &str) -> Self {
        match self {
            Self::Http(status, detail) => Self::Http(status, format!("{detail} · {note}")),
            Self::Transport(reason) => Self::Transport(format!("{reason} · {note}")),
            other => other,
        }
    }
}

impl From<reqwest::Error> for ProviderError {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(transport_reason(&error))
    }
}

/// Why a request never produced a response, without `reqwest`'s own sentence:
/// that one appends the request URL, and a route's query string can carry a
/// credential. The innermost cause is the part an operator can act on, such as
/// `Connection refused (os error 61)` or an invalid peer certificate.
fn transport_reason(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "connect failed"
    } else if error.is_body() {
        "body failed"
    } else if error.is_decode() {
        "decode failed"
    } else if error.is_redirect() {
        "redirect failed"
    } else if error.is_builder() {
        "request could not be built"
    } else {
        "request failed"
    };
    let cause = std::error::Error::source(error).map(|source| {
        let mut cause = source;
        while let Some(inner) = cause.source() {
            cause = inner;
        }
        cause.to_string()
    });
    match cause {
        Some(cause) if !cause.is_empty() => format!("{kind}: {cause}"),
        _ => kind.to_string(),
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
        // A body that parses but is not an object is the same correctable
        // mistake as garbled JSON, so it settles the same way instead of
        // tearing down the stream and ending the whole run.
        _ => Ok(
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

/// Ceiling for a pause the provider itself asked for. The endpoint is telling
/// us when it will be ready; honouring anything longer would hold the turn for
/// most of an hour, so a hostile or buggy `Retry-After` is treated as this.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(15 * 60);

/// How many pauses the endpoint itself named may be paid outside the window, and
/// how much wall clock they may add up to. Two of the most common
/// `Retry-After: 30s` fit; a rate limit that keeps saying thirty seconds forever
/// still ends the turn with the refusal naming what it asked for.
const VENDOR_WAITS_PER_TURN: usize = 2;
const VENDOR_WAIT_TOTAL: Duration = Duration::from_secs(90);

/// Why a pause that does not fit the window produced no further attempt.
enum WaitRefused {
    /// The pause was this runner's own backoff, so the window still owns it.
    Backoff { remaining: Duration },
    /// The turn already spent its vendor-named waits.
    AlreadyExtended { waits: usize },
    /// The endpoint asked for more time than the extra wait had left.
    Allowance { left: Duration },
}

/// A runaway guard only: the turn's retry window ends the attempts first.
const MAX_REQUEST_ATTEMPTS: usize = 25;

/// A routed turn shares this many HTTP attempts across its routes, so a failing
/// primary cannot spend the whole window before the fallback is tried.
const ROUTED_ATTEMPTS: usize = 3;

pub(crate) struct Budget {
    /// How long the turn may keep retrying once an attempt has failed.
    window: Duration,
    /// When the retry window was armed. Unarmed until the first failure: a first
    /// attempt that is slow on its own is bounded by the watchdogs, not by the
    /// retry window, or one slow response spends the whole budget and leaves no
    /// room for the retry the window exists to grant.
    armed_at: OnceLock<tokio::time::Instant>,
    /// Wall clock a vendor-named pause bought beyond the window. See `grant`.
    granted: Mutex<Granted>,
    attempts: AtomicUsize,
    /// The last failure this turn saw, kept so a window that expires before
    /// another request can still report why the turn failed.
    failure: Mutex<Option<String>>,
}

#[derive(Default)]
struct Granted {
    waits: usize,
    total: Duration,
}

impl Budget {
    pub fn new() -> Arc<Self> {
        Self::with_deadline(Duration::from_secs(60))
    }
    /// One provider turn's retry window. Tests build a shorter one so the
    /// schedule can be observed without waiting out the real budget.
    fn with_deadline(window: Duration) -> Arc<Self> {
        Arc::new(Self {
            window,
            armed_at: OnceLock::new(),
            granted: Mutex::new(Granted::default()),
            attempts: AtomicUsize::new(0),
            failure: Mutex::new(None),
        })
    }
    /// Ends any attempt that is itself a retry; idempotent, so the first
    /// failure of the turn fixes the window's end.
    fn arm(&self) -> tokio::time::Instant {
        let armed = *self.armed_at.get_or_init(tokio::time::Instant::now);
        armed + self.window + self.granted()
    }
    fn deadline(&self) -> Option<tokio::time::Instant> {
        self.armed_at.get().map(|_| self.arm())
    }
    fn expired(&self) -> bool {
        self.deadline()
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
    }
    /// What is left of the armed window, or `None` while it is unarmed.
    fn remaining(&self) -> Option<Duration> {
        self.deadline()
            .map(|deadline| deadline.saturating_duration_since(tokio::time::Instant::now()))
    }
    fn granted(&self) -> Duration {
        self.granted
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .total
    }
    /// Pay one pause the endpoint itself named outside the window, or say why
    /// it cannot be paid. A `Retry-After` is the provider's statement about when
    /// it will answer, while the window is this runner's guess about how long to
    /// keep failing; a window that happens to have 30 s left must not refuse a
    /// 30 s pause the endpoint asked for. The allowance is bounded twice — by
    /// count and by total wall clock — because a wrong or hostile header must
    /// not hold the turn for most of an hour.
    fn grant(&self, pause: Duration) -> Result<(), WaitRefused> {
        let mut granted = self.granted.lock().unwrap_or_else(|held| held.into_inner());
        if granted.waits >= VENDOR_WAITS_PER_TURN {
            return Err(WaitRefused::AlreadyExtended {
                waits: granted.waits,
            });
        }
        let left = VENDOR_WAIT_TOTAL.saturating_sub(granted.total);
        if pause > left {
            return Err(WaitRefused::Allowance { left });
        }
        granted.waits += 1;
        granted.total += pause;
        Ok(())
    }
    fn note_failure(&self, reason: &str) {
        *self.failure.lock().unwrap_or_else(|held| held.into_inner()) = Some(reason.to_owned());
    }
    fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .clone()
    }
    /// The error a spent window reports: the generic fact plus the failure
    /// that left it no room, which is the only part an operator can act on.
    fn spent(&self) -> ProviderError {
        let spent = "the turn's retry window was spent before another request";
        match self.failure() {
            Some(reason) => ProviderError::Transport(format!("{spent} (last attempt: {reason})")),
            None => ProviderError::Transport(spent.into()),
        }
    }
    pub fn used(&self) -> usize {
        self.attempts.load(Ordering::Relaxed)
    }
    fn take(&self, limit: usize) -> bool {
        // Keep the declared MSRV across newer atomics API renames.
        loop {
            let used = self.used();
            if used >= limit {
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
    /// Stream reconnects one attempt may spend through `transport_attempt`.
    limit: usize,
    /// HTTP attempts this turn may spend in total. A routed turn shares one
    /// cap across its routes; a plain turn follows the retry window, so its cap
    /// is only a runaway guard.
    cap: usize,
    /// HTTP requests this scope may send.
    requests: usize,
}
tokio::task_local! {static RETRY_SCOPE:RetryScope;}
pub(crate) fn transport_retry_limit() -> usize {
    RETRY_SCOPE.try_with(|scope| scope.limit).unwrap_or(3)
}
pub(crate) fn transport_attempt() -> Result<(tokio::time::Instant, usize), ProviderError> {
    let scope = RETRY_SCOPE
        .try_with(Clone::clone)
        .unwrap_or_else(|_| RetryScope {
            budget: Budget::new(),
            limit: 3,
            cap: ROUTED_ATTEMPTS,
            requests: 3,
        });
    // A reconnect is itself a retry, so it opens the window when the stream's
    // first attempt did not need to.
    let deadline = scope.budget.arm();
    if scope.limit == 0 || scope.budget.expired() || !scope.budget.take(scope.limit) {
        return Err(ProviderError::Transport(
            "the turn's retry window was spent before another stream attempt".into(),
        ));
    }
    Ok((deadline, scope.budget.used()))
}
pub(crate) async fn scoped<F: std::future::Future<Output = Result<Reply, ProviderError>>>(
    budget: Arc<Budget>,
    limit: usize,
    future: F,
) -> Result<Reply, ProviderError> {
    RETRY_SCOPE
        .scope(
            RetryScope {
                budget,
                limit,
                cap: MAX_REQUEST_ATTEMPTS,
                requests: MAX_REQUEST_ATTEMPTS,
            },
            future,
        )
        .await
}

/// A routed turn: every route draws from one `limit`-request budget instead of
/// letting each route spend the turn's whole retry window.
pub(crate) async fn scoped_shared<F: std::future::Future<Output = Result<Reply, ProviderError>>>(
    budget: Arc<Budget>,
    limit: usize,
    future: F,
) -> Result<Reply, ProviderError> {
    RETRY_SCOPE
        .scope(
            RetryScope {
                budget,
                limit,
                cap: ROUTED_ATTEMPTS,
                requests: limit,
            },
            future,
        )
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
                        // Neither retryable nor self-healable, so each stream
                        // sends exactly one request and `seen` stays one entry
                        // per stream.
                        axum::http::StatusCode::UNPROCESSABLE_ENTITY
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
                assert!(matches!(result, Err(ProviderError::Http(422, _))));
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
                model_key: None,
                credential_id: None,
                account: None,
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
    /// Vertex AI rejects a `model` body field (the model names the URL) and
    /// requires the API version in the body instead.
    vertex: bool,
    copilot: bool,
    extra_headers: BTreeMap<String, String>,
}

/// The provider HTTP client honours the operator's proxy environment for
/// external endpoints but always reaches loopback directly: the embedded
/// engine talks to local gateways and test fixtures, and a global
/// `HTTP_PROXY` that cannot see into the operator's machine turns every
/// provider call into a proxy connect loop. reqwest's own env support has
/// no loopback escape, so proxy resolution is owned here; the operator's
/// `NO_PROXY` entries apply beside an always-on loopback set.
pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    let no_proxy = reqwest::NoProxy::from_string(&no_proxy_entries(|name| std::env::var(name).ok()));
    let mut builder = reqwest::Client::builder();
    for scheme in ["https", "http"] {
        if let Some(url) = proxy_url(scheme, |name| std::env::var(name).ok()) {
            let addressed = match scheme {
                "https" => reqwest::Proxy::https(&url),
                _ => reqwest::Proxy::http(&url),
            };
            if let Ok(proxy) = addressed {
                builder = builder.proxy(proxy.no_proxy(no_proxy.clone()));
            }
        }
    }
    builder
}

fn proxy_url(scheme: &str, env: impl Fn(&str) -> Option<String>) -> Option<String> {
    let (specific, common): (&[&str], &[&str]) = match scheme {
        "https" => (&["HTTPS_PROXY", "https_proxy"], &["ALL_PROXY", "all_proxy"]),
        _ => (&["HTTP_PROXY", "http_proxy"], &["ALL_PROXY", "all_proxy"]),
    };
    specific
        .iter()
        .chain(common)
        .find_map(|name| env(name).filter(|value| !value.trim().is_empty()))
}

fn no_proxy_entries(env: impl Fn(&str) -> Option<String>) -> String {
    let mut entries = vec![
        "localhost".to_string(),
        "127.0.0.1/8".to_string(),
        "::1".to_string(),
    ];
    if let Some(user) = env("NO_PROXY").or_else(|| env("no_proxy")) {
        let mut owned: Vec<String> = user
            .split(',')
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        owned.append(&mut entries);
        entries = owned;
    }
    entries.join(",")
}

#[cfg(test)]
mod proxy_resolution_tests {
    use super::{no_proxy_entries, proxy_url};

    /// `HTTPS_PROXY`/`HTTP_PROXY` win for their own scheme; `ALL_PROXY` is the
    /// common fallback; an empty value means unset, the way operators leave a
    /// variable defined but blank.
    #[test]
    fn scheme_specific_variables_precede_the_common_one() {
        let https = |name: &str| match name {
            "HTTPS_PROXY" => Some("http://specific:3128".to_string()),
            "ALL_PROXY" => Some("socks5://common:1080".to_string()),
            _ => None,
        };
        assert_eq!(
            proxy_url("https", https),
            Some("http://specific:3128".to_string())
        );
        let common_only = |name: &str| match name {
            "ALL_PROXY" => Some("socks5://common:1080".to_string()),
            _ => None,
        };
        assert_eq!(
            proxy_url("https", common_only),
            Some("socks5://common:1080".to_string())
        );
        // ALL_PROXY is the common fallback for both schemes.
        assert_eq!(
            proxy_url("http", common_only),
            Some("socks5://common:1080".to_string())
        );
        let https_specific = |name: &str| match name {
            "HTTPS_PROXY" => Some("http://specific:3128".to_string()),
            _ => None,
        };
        assert_eq!(proxy_url("http", https_specific), None);
        let blank = |name: &str| match name {
            "HTTP_PROXY" => Some("   ".to_string()),
            _ => None,
        };
        assert_eq!(proxy_url("http", blank), None);
    }

    /// The operator's entries lead, and the loopback set is always present:
    /// the engine's fixtures and local gateways must be reachable with a
    /// global `HTTP_PROXY` that cannot see into the operator's machine.
    #[test]
    fn no_proxy_always_carries_the_loopback_set() {
        let none = |name: &str| None::<String>;
        assert_eq!(
            no_proxy_entries(none),
            "localhost,127.0.0.1/8,::1".to_string()
        );
        let user = |name: &str| match name {
            "NO_PROXY" => Some("corp.internal, 10.0.0.0/8, ".to_string()),
            _ => None,
        };
        assert_eq!(
            no_proxy_entries(user),
            "corp.internal,10.0.0.0/8,localhost,127.0.0.1/8,::1".to_string()
        );
    }
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
            client: http_client_builder()
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
            vertex: false,
            copilot: false,
            extra_headers: BTreeMap::new(),
        })
    }

    /// Vertex AI carries the Anthropic codec over an OAuth bearer credential,
    /// with the wire differences `rawPredict` imposes.
    pub fn with_vertex_source(
        endpoint: String,
        source: Source,
        model: String,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http_client_builder()
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
            vertex: true,
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
            let mut tools = serde_json::to_value(&request.tools).map_err(|error| {
                ProviderError::Transport(format!("the tool catalog could not be encoded: {error}"))
            })?;
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
        if self.vertex {
            // `rawPredict` names the model in the URL, rejects a `model` field,
            // and takes the API version in the body.
            body.as_object_mut().map(|object| object.remove("model"));
            body["anthropic_version"] = json!("vertex-2023-10-16");
        }
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
        .build()?;
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
        selected.request_options = self.request_options.merged(&options)?;
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
/// The provider's own words about a failed response, on one line and bounded:
/// ` · retry-after: 12s · {"error":…}`. A bare status code cannot tell a rate
/// limit from an upstream fault, which is the first question an operator asks.
/// Statuses the retry budget covers: a rate limit, and every server-side
/// failure. That is the class the provider SDKs retry — Anthropic's retries
/// "connection errors, rate limits, and 5xx server errors" and honours
/// `retry-after` — while an enumerated list stops covering the gateway: a
/// Cloudflare front end answers 520, 521, 522 or 524 when the origin is
/// unreachable or times out, and those ended a turn on the first attempt.
fn retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

fn http_failure_detail(status: u16, pause: Option<Duration>, body: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if retryable_status(status) {
        if let Some(pause) = pause {
            parts.push(format!("retry-after: {}s", pause.as_secs()));
        }
    }
    if let Some(body) = body {
        let single = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut clipped: String = single.chars().take(240).collect();
        if single.chars().count() > 240 {
            clipped.push('…');
        }
        if !clipped.is_empty() {
            parts.push(clipped);
        }
    }
    match parts.is_empty() {
        true => String::new(),
        false => format!(" · {}", parts.join(" · ")),
    }
}

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
            cap: MAX_REQUEST_ATTEMPTS,
            requests: MAX_REQUEST_ATTEMPTS,
        });
    // A rejected request earns one extra attempt outside the schedule; every
    // other decision below is bounded by the turn's retry window, so the
    // attempt cap is only a runaway guard that the window normally wins.
    let mut self_healed = false;
    for attempt in 0..scope.requests {
        if scope.budget.expired() || !scope.budget.take(scope.cap) {
            return Err(scope.budget.spent());
        }
        let request = request
            .try_clone()
            .ok_or_else(|| ProviderError::Stream("request cannot be replayed".into()))?;
        let request_seq = crate::runtime_profile::record(protocol, &request, attempt + 1).await?;
        let request_bytes = request
            .body()
            .and_then(|body| body.as_bytes())
            .map_or(0, <[u8]>::len);
        let watchdogs = crate::first_event::Watchdogs::at(request_bytes);
        // Both bounds can be absent — a turn whose first attempt has not yet
        // armed the window, with the first-byte watchdog disabled — and then
        // only the caller's cancellation ends the wait.
        let request_deadline = scope
            .budget
            .deadline()
            .into_iter()
            .chain(watchdogs.header_deadline())
            .min();
        let response = tokio::select! {
            _=cancel.cancelled()=>Err(ProviderError::Interrupted),
            result=dispatch(client, request, request_deadline)=>result.map(|mut response|{
                response.extensions_mut().insert(watchdogs);
                response
            }),
        };
        let (status, outcome) = match &response {
            Ok(response) => (Some(response.status().as_u16()), "headers_received"),
            Err(ProviderError::Interrupted) => (None, "interrupted_unknown"),
            Err(_) => (None, "transport_unknown"),
        };
        let mut last_failure_detail: Option<String> = None;
        let mut requested: Option<Duration> = None;
        let error = match response {
            Ok(response) if response.status().is_success() => {
                crate::runtime_profile::result(request_seq, status, outcome, None).await?;
                announce(progress, protocol, attempt, status, outcome, None);
                return Ok(response);
            }
            Ok(mut response) => {
                let status = response.status().as_u16();
                // Only a rate limit or a server-side failure names a pause the
                // runner trusts; any other status' header is ignored.
                requested = retryable_status(status)
                    .then(|| retry_after(response.headers()))
                    .flatten();
                let detail = failure_detail(&mut response).await;
                let explained = http_failure_detail(status, requested, detail.as_deref());
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
                last_failure_detail = detail;
                ProviderError::Http(status, explained)
            }
            Err(error) => {
                // `transport_reason` keeps the request URL out, so the cause is
                // safe to record and is the only way to tell a header that never
                // arrived from a connection the peer reset.
                let detail = match &error {
                    ProviderError::Transport(reason) => Some(reason.as_str()),
                    _ => None,
                };
                crate::runtime_profile::result(request_seq, status, outcome, detail).await?;
                announce(progress, protocol, attempt, status, outcome, detail);
                error
            }
        };
        let transient_image_parse = matches!(error, ProviderError::Http(400, _))
            && last_failure_detail
                .as_deref()
                .is_some_and(image_parse_transient);
        let retryable = matches!(error, ProviderError::Transport(_))
            || matches!(error, ProviderError::Http(status, _) if retryable_status(status))
            || transient_image_parse;
        // Carry the reason so a client can show why the attempt was retried.
        // The status code is the HTTP one when there was one.
        let (reason, status) = match &error {
            ProviderError::Http(status, _) => (error.to_string(), Some(*status)),
            other => (other.to_string(), None),
        };
        // The window starts at the first failure, so a slow first attempt is
        // charged to the watchdogs rather than to the retries that follow.
        if retryable || matches!(error, ProviderError::Http(400, _)) {
            scope.budget.note_failure(&reason);
            scope.budget.arm();
        }
        let cause = retry_cause(status, last_failure_detail.as_deref());
        if !retryable {
            // A request the endpoint rejected (HTTP 400) is normally
            // deterministic, but a gateway also wraps a transient upstream
            // hiccup in one. Grant exactly one immediate replay so that class
            // recovers on its own; a real defect still fails, one request
            // later. Mirrors the TS runner's `selfHealable`.
            if matches!(error, ProviderError::Http(400, _)) && !self_healed {
                self_healed = true;
                announce_retry(
                    progress,
                    cancel,
                    RetryNotice {
                        attempt: attempt + 1,
                        reason,
                        status,
                        cause,
                        source: "immediate",
                        pause: Duration::ZERO,
                        extended: false,
                    },
                )
                .await?;
                continue;
            }
            return Err(error);
        }
        if scope.budget.expired()
            || attempt + 1 >= scope.requests
            || scope.budget.used() >= scope.cap
        {
            return Err(error);
        }
        let pause = retry_pause(attempt, requested);
        // The loop re-checks the window before dispatching, so a pause the window
        // cannot outlast never produces another attempt: sleeping through it only
        // delays this failure, and a 15-minute `Retry-After` used to be waited out
        // in full before the turn admitted its budget was spent. The refusal is its
        // own event, so it is never mistaken for a retry that will happen.
        if let Some(remaining) = scope
            .budget
            .remaining()
            .filter(|remaining| *remaining <= pause)
        {
            // A pause the endpoint named is its own schedule and is paid
            // outside the window; a backoff is this runner's guess and stays
            // inside it.
            let refused = match requested {
                Some(_) => scope.budget.grant(pause).err(),
                None => Some(WaitRefused::Backoff { remaining }),
            };
            let Some(refused) = refused else {
                announce_retry(
                    progress,
                    cancel,
                    RetryNotice {
                        attempt: attempt + 1,
                        reason,
                        status,
                        cause,
                        source: pause_source(requested),
                        pause,
                        extended: true,
                    },
                )
                .await?;
                continue;
            };
            let note = window_refusal_note(pause, refused);
            let _ = progress
                .send(json!({
                    "kind": "provider.window",
                    "attempt": attempt + 1,
                    "reason": reason,
                    "status": status,
                    "cause": cause,
                    "requested_ms": pause.as_millis() as u64,
                    "remaining_ms": remaining.as_millis() as u64,
                    "note": note.clone(),
                }))
                .await;
            return Err(error.refused_by_window(&note));
        }
        announce_retry(
            progress,
            cancel,
            RetryNotice {
                attempt: attempt + 1,
                reason,
                status,
                cause,
                source: pause_source(requested),
                pause,
                extended: false,
            },
        )
        .await?;
    }
    Err(match scope.budget.failure() {
        Some(reason) => ProviderError::Transport(format!(
            "no attempt produced a response within the turn's request budget (last attempt: {reason})"
        )),
        None => ProviderError::Transport(
            "no attempt produced a response within the turn's request budget".into(),
        ),
    })
}

/// Sends one request bounded by `deadline` when the turn has one. Both a header
/// watchdog and the retry window supply that bound, so an unarmed window on a
/// turn that disabled the watchdog reaches here with none.
async fn dispatch(
    client: &reqwest::Client,
    request: reqwest::Request,
    deadline: Option<tokio::time::Instant>,
) -> Result<reqwest::Response, ProviderError> {
    let Some(deadline) = deadline else {
        return client.execute(request).await.map_err(ProviderError::from);
    };
    match tokio::time::timeout_at(deadline, client.execute(request)).await {
        Ok(result) => result.map_err(ProviderError::from),
        Err(_) => Err(ProviderError::Transport(
            "no response headers before the request deadline".into(),
        )),
    }
}

/// One retry's announcement: everything the operator needs to name the wait.
/// Grouped so the announce call stays readable instead of growing one argument
/// per fact.
struct RetryNotice {
    attempt: usize,
    reason: String,
    status: Option<u16>,
    cause: &'static str,
    source: &'static str,
    pause: Duration,
    /// The pause was paid outside the window by `Budget::grant`, so the wait the
    /// operator sees is longer than this runner would have chosen on its own.
    extended: bool,
}

/// Announce the next attempt, then wait for it. A cancelled wait reports the
/// interrupt instead of retrying, and a closed receiver means the turn is gone.
async fn announce_retry(
    progress: &mpsc::Sender<Value>,
    cancel: &CancellationToken,
    notice: RetryNotice,
) -> Result<(), ProviderError> {
    tokio::select! {
        _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
        result=progress.send(json!({"kind":"provider.retry","attempt":notice.attempt,"reason":notice.reason,"status":notice.status,"cause":notice.cause,"source":notice.source,"delay_ms":notice.pause.as_millis() as u64,"extended_ms":notice.extended.then_some(notice.pause.as_millis() as u64)}))=>if result.is_err(){return Err(ProviderError::Interrupted);},
    }
    tokio::select! {
        _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
        _=tokio::time::sleep(notice.pause)=>{},
    }
    Ok(())
}

/// Which wait this is, in the words an operator asks with. A 429 covers three
/// different situations — a vendor rate limit, a spent account balance and a
/// gateway's own throttle — and only the body tells them apart, so the body
/// decides the class before the status does. Naming it is what lets a client
/// offer waiting, switching account or stopping instead of one unspecified
/// retry; the engine still never switches identity on its own.
fn retry_cause(status: Option<u16>, detail: Option<&str>) -> &'static str {
    let body = detail.unwrap_or_default().to_ascii_lowercase();
    let spent = [
        "quota",
        "billing",
        "credit",
        "insufficient",
        "payment",
        "余额",
        "额度",
        "欠费",
    ]
    .iter()
    .any(|needle| body.contains(needle));
    match status {
        None => "transport",
        Some(_) if spent => "account_quota",
        Some(429) => "vendor_rate_limit",
        Some(status) if (500..=599).contains(&status) => "upstream",
        Some(_) => "unknown",
    }
}

/// Where the pause the operator is sitting through came from: a delay the
/// provider named in `Retry-After` is its own statement about when it will
/// answer again, while a backoff is this runner's guess. The two read the same
/// on a status line and mean different things.
fn pause_source(requested: Option<Duration>) -> &'static str {
    match requested {
        Some(_) => "provider",
        None => "backoff",
    }
}

/// Why the next attempt was refused, in the numbers the decision used. The three
/// cases read the same on a bare error line and mean different things: a backoff
/// this runner chose that the window cannot hold, a vendor pause the turn had no
/// extra wait left for, and one it had already extended as far as it goes.
fn window_refusal_note(pause: Duration, refused: WaitRefused) -> String {
    match refused {
        WaitRefused::Backoff { remaining } => format!(
            "no retry: the next backoff was {} but the turn's retry window had only {} left",
            pause_words(pause),
            pause_words(remaining)
        ),
        WaitRefused::AlreadyExtended { waits } => format!(
            "no retry: the provider asked for {} but this turn already extended its retry window {waits} times",
            pause_words(pause)
        ),
        WaitRefused::Allowance { left } => format!(
            "no retry: the provider asked for {} and only {} of extra wait was left",
            pause_words(pause),
            pause_words(left)
        ),
    }
}

/// A pause written the way the status line spells one: whole seconds, and
/// milliseconds below a second so a local backoff never reads as `0s`.
fn pause_words(pause: Duration) -> String {
    match pause.subsec_millis() {
        0 => format!("{}s", pause.as_secs()),
        _ => format!("{}ms", pause.as_millis()),
    }
}

/// The pause before the next attempt: the backoff schedule, raised to the pause
/// the provider asked for. Mirrors the TS runner's `providerSchedule` —
/// exponential from 500 ms at 1.7, capped at 5 s, jittered by ±20 %, and never
/// shorter than an honoured `Retry-After`.
fn retry_pause(attempt: usize, requested: Option<Duration>) -> Duration {
    retry_pause_at(attempt, requested, entropy_sample())
}

/// The same pause for a given entropy sample: the sample lands in `[0, 999]`
/// and scales the backoff by `[0.8, 1.2]`, so the delay is testable exactly.
fn retry_pause_at(attempt: usize, requested: Option<Duration>, sample: u32) -> Duration {
    let backoff = Duration::from_millis(500)
        .mul_f64(1.7_f64.powi(attempt as i32))
        .min(Duration::from_secs(5));
    let jittered = backoff.mul_f64(0.8 + f64::from(sample % 1_000) / 1_000.0 * 0.4);
    match requested {
        Some(requested) => jittered.max(requested.min(RETRY_AFTER_MAX)),
        None => jittered,
    }
}

/// Nanosecond time is entropy enough for backoff jitter: the point is to keep
/// concurrently waiting turns from retrying in lockstep, not secrecy.
fn entropy_sample() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or_default()
}

/// The pause a rejection named, in either form the header allows. A millisecond
/// header wins when both are present: it is the precise value a gateway that
/// understands sub-second pauses sends.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    if let Some(milliseconds) = headers
        .get("retry-after-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Some(Duration::from_millis(milliseconds));
    }
    let value = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let wait = at.timestamp_millis() - chrono::Utc::now().timestamp_millis();
    (wait > 0).then(|| Duration::from_millis(wait as u64))
}

#[cfg(test)]
mod tool_call_decode_tests {
    use super::*;

    /// Every provider adapter funnels arguments through this decode, so the
    /// matrix pins what each malformed shape settles as: an object keeps its
    /// input, and anything else — garbled JSON included — becomes a correctable
    /// input error instead of an error that ends the stream.
    #[test]
    fn malformed_tool_arguments_settle_as_input_errors() {
        let decode = |arguments: &str| decode_tool_call("call_1", "read_file", arguments).unwrap();
        assert_eq!(
            decode(r#"{"path":"src/main.rs"}"#),
            json!({"type":"tool_use","id":"call_1","name":"read_file","input":{"path":"src/main.rs"}}),
        );
        for arguments in [
            r#"{"path":"src/ma"#,
            "",
            "null",
            "42",
            "[1,2]",
            r#""a string""#,
            "true",
        ] {
            let decoded = decode(arguments);
            assert_eq!(
                decoded["input_error"], "invalid_json",
                "arguments {arguments:?} must settle as a correctable input error"
            );
            assert_eq!(decoded["input"], json!(null));
            assert_eq!(decoded["id"], "call_1");
            assert_eq!(decoded["name"], "read_file");
        }
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{HeaderValue, StatusCode},
        response::Response,
        routing::post,
        Router,
    };
    use std::sync::Mutex;

    /// One scripted reply. A single remaining entry repeats, so a script can
    /// describe "reject every time".
    #[derive(Clone)]
    struct Scripted {
        status: u16,
        retry_after: Option<&'static str>,
    }

    type Script = Arc<Mutex<(Vec<Scripted>, usize)>>;

    async fn serve(script: Vec<Scripted>) -> (String, Script, tokio::task::JoinHandle<()>) {
        let state: Script = Arc::new(Mutex::new((script, 0)));
        let router = Router::new()
            .route(
                "/fixture",
                post(|State(state): State<Script>| async move {
                    let reply = {
                        let mut guard = state.lock().unwrap();
                        guard.1 += 1;
                        if guard.0.len() > 1 {
                            guard.0.remove(0)
                        } else {
                            guard.0[0].clone()
                        }
                    };
                    let mut response = Response::new(Body::from("{}"));
                    *response.status_mut() = StatusCode::from_u16(reply.status).unwrap();
                    if let Some(value) = reply.retry_after {
                        response
                            .headers_mut()
                            .insert("retry-after", HeaderValue::from_static(value));
                    }
                    response
                }),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (endpoint, state, server)
    }

    /// Drive one provider turn's request path and collect the retry notices the
    /// runtime would have recorded.
    async fn drive(endpoint: &str, window: Duration) -> (Result<(), ProviderError>, Vec<Value>) {
        let client = reqwest::Client::new();
        let request = client.post(endpoint).body("{}").build().unwrap();
        let cancel = CancellationToken::new();
        let (progress, mut received) = mpsc::channel(32);
        let outcome = RETRY_SCOPE
            .scope(
                RetryScope {
                    budget: Budget::with_deadline(window),
                    limit: 3,
                    cap: MAX_REQUEST_ATTEMPTS,
                    requests: MAX_REQUEST_ATTEMPTS,
                },
                async {
                    request_with_retry("fixture", &client, request, &progress, &cancel)
                        .await
                        .map(|_| ())
                },
            )
            .await;
        let mut notices = Vec::new();
        while let Ok(notice) = received.try_recv() {
            notices.push(notice);
        }
        (outcome, notices)
    }

    /// The pauses the schedule asked for, in milliseconds. Attempt notices
    /// share the channel and carry no pause.
    fn delays(notices: &[Value]) -> Vec<u64> {
        notices
            .iter()
            .filter(|notice| notice["kind"] == "provider.retry")
            .map(|notice| notice["delay_ms"].as_u64().unwrap())
            .collect()
    }

    /// A granted vendor wait honours the declared `Retry-After`: the delay is at
    /// least what the endpoint asked for, and at most that plus the window's own
    /// arithmetic. Asserting the exact millisecond turned a granted wait into a
    /// race against the runner's clock (CI saw 1005 ms for a declared 1 s).
    fn honoured_vendor_wait(delays: &[u64], declared_ms: u64) -> bool {
        !delays.is_empty()
            && delays
                .iter()
                .all(|delay| *delay >= declared_ms && *delay <= declared_ms + 100)
    }

    /// The backoff window a jittered delay must fall in.
    fn backoff_window(attempt: usize) -> (u64, u64) {
        let base = (500.0 * 1.7_f64.powi(attempt as i32)).min(5_000.0);
        ((base * 0.8) as u64, (base * 1.2) as u64)
    }

    #[test]
    fn the_pause_is_exponential_capped_jittered_and_raised_by_retry_after() {
        assert_eq!(retry_pause_at(0, None, 0).as_millis(), 400);
        assert_eq!(retry_pause_at(0, None, 999).as_millis(), 599);
        assert_eq!(retry_pause_at(1, None, 500).as_millis(), 850);
        // The schedule caps at 5 s, so later attempts stay useful inside the
        // turn's 60 s window.
        assert_eq!(retry_pause_at(8, None, 500).as_millis(), 5_000);
        // A pause the provider named raises the delay but never shortens it.
        assert_eq!(
            retry_pause_at(0, Some(Duration::from_secs(2)), 500),
            Duration::from_secs(2)
        );
        assert_eq!(
            retry_pause_at(8, Some(Duration::from_millis(100)), 500).as_millis(),
            5_000
        );
        // A hostile or buggy header is capped rather than holding the turn.
        assert_eq!(
            retry_pause_at(0, Some(Duration::from_secs(86_400)), 500),
            RETRY_AFTER_MAX
        );
    }

    #[test]
    fn retry_after_accepts_both_header_forms_and_prefers_milliseconds() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(retry_after(&headers).is_none());
        headers.insert("retry-after", HeaderValue::from_static("3"));
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(3)));
        headers.insert("retry-after-ms", HeaderValue::from_static("250"));
        assert_eq!(retry_after(&headers), Some(Duration::from_millis(250)));
        headers.remove("retry-after-ms");
        headers.insert("retry-after", HeaderValue::from_static("not a delay"));
        assert!(retry_after(&headers).is_none());
        let date = (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc2822();
        headers.insert("retry-after", HeaderValue::from_str(&date).unwrap());
        let parsed = retry_after(&headers).unwrap();
        assert!(
            parsed >= Duration::from_secs(110) && parsed <= Duration::from_secs(120),
            "unexpected http-date pause: {parsed:?}"
        );
    }

    #[tokio::test]
    async fn a_cancel_during_the_retry_pause_returns_without_waiting_it_out() {
        // A 429 with a long Retry-After sets a pause a person can feel. The
        // operator must be able to stop the turn inside that pause instead of
        // watching a spinner until the provider is willing to answer again.
        let (endpoint, _state, _server) = serve(vec![
            Scripted {
                status: 429,
                retry_after: Some("5"),
            },
            Scripted {
                status: 200,
                retry_after: None,
            },
        ])
        .await;
        let client = reqwest::Client::new();
        let request = client.post(&endpoint).body("{}").build().unwrap();
        let cancel = CancellationToken::new();
        let (progress, mut received) = mpsc::channel::<Value>(32);
        let stop = cancel.clone();
        let watcher = tokio::spawn(async move {
            while let Some(notice) = received.recv().await {
                if notice["kind"] == "provider.retry" && notice["delay_ms"] == 5_000 {
                    break;
                }
            }
            stop.cancel();
        });
        let started = std::time::Instant::now();
        let outcome = RETRY_SCOPE
            .scope(
                RetryScope {
                    budget: Budget::with_deadline(Duration::from_secs(30)),
                    limit: 3,
                    cap: MAX_REQUEST_ATTEMPTS,
                    requests: MAX_REQUEST_ATTEMPTS,
                },
                async {
                    request_with_retry("fixture", &client, request, &progress, &cancel)
                        .await
                        .map(|_| ())
                },
            )
            .await;
        watcher.await.unwrap();
        assert!(
            matches!(outcome, Err(ProviderError::Interrupted)),
            "a cancelled pause reports the interrupt: {outcome:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the cancel waited out the pause: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_rate_limit_pause_is_honoured_instead_of_the_short_backoff() {
        let (endpoint, state, server) = serve(vec![
            Scripted {
                status: 429,
                retry_after: Some("1"),
            },
            Scripted {
                status: 200,
                retry_after: None,
            },
        ])
        .await;
        let started = std::time::Instant::now();
        let (outcome, notices) = drive(&endpoint, Duration::from_secs(10)).await;
        assert!(outcome.is_ok());
        assert_eq!(state.lock().unwrap().1, 2, "one retry, then the answer");
        assert_eq!(delays(&notices), vec![1_000]);
        let retry = notices
            .iter()
            .find(|notice| notice["kind"] == "provider.retry")
            .unwrap();
        assert_eq!(retry["status"], 429);
        // The operator's first question about this wait is which of the three
        // 429s it is, and the second is who chose the delay.
        assert_eq!(retry["cause"], "vendor_rate_limit");
        assert_eq!(retry["source"], "provider");
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "the attempt waited for the pause the endpoint named"
        );
        server.abort();
    }

    #[test]
    fn a_wait_is_named_from_the_body_before_the_status() {
        // A spent balance and a vendor throttle arrive as the same 429; only
        // the body separates them, and only the class lets a client offer
        // "switch account" instead of "wait".
        assert_eq!(
            retry_cause(
                Some(429),
                Some("{\"error\":{\"code\":\"insufficient_quota\"}}")
            ),
            "account_quota"
        );
        assert_eq!(
            retry_cause(Some(403), Some("{\"message\":\"余额不足或无可用资源包\"}")),
            "account_quota"
        );
        assert_eq!(
            retry_cause(
                Some(429),
                Some("{\"error\":{\"type\":\"rate_limit_error\"}}")
            ),
            "vendor_rate_limit"
        );
        assert_eq!(retry_cause(Some(529), Some("overloaded")), "upstream");
        assert_eq!(retry_cause(Some(503), None), "upstream");
        assert_eq!(retry_cause(None, None), "transport");
        assert_eq!(retry_cause(Some(400), Some("bad model id")), "unknown");
    }

    #[test]
    fn a_pause_names_whether_the_provider_or_the_backoff_chose_it() {
        assert_eq!(pause_source(Some(Duration::from_secs(2))), "provider");
        assert_eq!(pause_source(None), "backoff");
    }

    #[tokio::test]
    async fn a_rejected_request_gets_exactly_one_immediate_replay() {
        let (endpoint, state, server) = serve(vec![
            Scripted {
                status: 400,
                retry_after: None,
            },
            Scripted {
                status: 200,
                retry_after: None,
            },
        ])
        .await;
        let (outcome, notices) = drive(&endpoint, Duration::from_secs(10)).await;
        assert!(outcome.is_ok(), "the immediate replay recovered the turn");
        assert_eq!(state.lock().unwrap().1, 2);
        assert_eq!(delays(&notices), vec![0]);
        server.abort();

        let (endpoint, state, server) = serve(vec![Scripted {
            status: 400,
            retry_after: None,
        }])
        .await;
        let (outcome, _) = drive(&endpoint, Duration::from_secs(10)).await;
        assert!(matches!(outcome, Err(ProviderError::Http(400, _))));
        assert_eq!(
            state.lock().unwrap().1,
            2,
            "a deterministic rejection still fails after one replay"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_persistent_failure_retries_on_the_schedule_until_the_window_ends() {
        let (endpoint, state, server) = serve(vec![Scripted {
            status: 503,
            retry_after: None,
        }])
        .await;
        let started = std::time::Instant::now();
        let (outcome, notices) = drive(&endpoint, Duration::from_millis(1_500)).await;
        // Whichever end of the loop notices the spent window reports the last
        // rejection: the loop top knows only the deadline, so it reads the
        // failure that spent it.
        match &outcome {
            Err(ProviderError::Transport(message)) => assert!(
                message.contains("last attempt: provider HTTP 503"),
                "the spent window lost the rejection that spent it: {message}"
            ),
            Err(ProviderError::Http(503, _)) => {}
            other => panic!("unexpected outcome: {other:?}"),
        }
        for (attempt, delay) in delays(&notices).into_iter().enumerate() {
            let (low, high) = backoff_window(attempt);
            assert!(
                (low..=high).contains(&delay),
                "attempt {attempt} waited {delay} ms, outside {low}..={high}"
            );
        }
        assert!(!notices.is_empty(), "the schedule was used at all");
        let attempts = state.lock().unwrap().1;
        assert!(attempts >= 2, "the first failure earned a retry");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the window, not the schedule, ended the retries"
        );
        server.abort();
    }

    /// A first attempt that is slow on its own must not spend the retry window:
    /// the window exists to grant a retry, and a turn whose endpoint took most
    /// of it to fail used to be reported as having spent it before retrying.
    #[tokio::test]
    async fn the_retry_window_starts_at_the_first_failure() {
        let budget = Budget::with_deadline(Duration::from_millis(50));
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !budget.expired(),
            "an unarmed window must not end the first attempt"
        );
        budget.arm();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(budget.expired(), "the armed window must end the retries");
    }

    /// A pause the endpoint named is its own schedule, not this runner's guess,
    /// so it is paid outside a window that could not hold it. A 30 s
    /// `Retry-After` arriving with 30 s of window left used to end the turn
    /// after one attempt; the endpoint had done nothing wrong.
    #[tokio::test]
    async fn a_vendor_pause_beyond_the_window_is_paid_outside_it() {
        let (endpoint, state, server) = serve(vec![
            Scripted {
                status: 429,
                retry_after: Some("1"),
            },
            Scripted {
                status: 200,
                retry_after: None,
            },
        ])
        .await;
        let (outcome, notices) = drive(&endpoint, Duration::from_millis(300)).await;
        server.abort();
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(
            state.lock().unwrap().1,
            2,
            "the vendor's pause earned the second attempt"
        );
        assert_eq!(delays(&notices), vec![1_000], "{notices:?}");
        let retried = notices
            .iter()
            .find(|notice| notice["kind"] == "provider.retry")
            .expect("the wait is announced");
        let extended = retried["extended_ms"].as_u64().unwrap();
        assert!(
            honoured_vendor_wait(&[extended], 1_000),
            "the wait is longer than the window, so it was granted outside it: {extended} ms"
        );
    }

    /// The allowance is bounded, and a spent one still refuses: the turn ends
    /// with the endpoint's own words plus the fact that the window had already
    /// been extended as far as it goes.
    #[tokio::test]
    async fn the_vendor_wait_allowance_ends_and_names_itself() {
        let (endpoint, state, server) = serve(vec![Scripted {
            status: 429,
            retry_after: Some("1"),
        }])
        .await;
        let (outcome, notices) = drive(&endpoint, Duration::from_millis(200)).await;
        server.abort();
        assert!(
            matches!(outcome, Err(ProviderError::Http(429, _))),
            "{outcome:?}"
        );
        assert_eq!(
            state.lock().unwrap().1,
            3,
            "two granted waits, then the refusal"
        );
        let granted = delays(&notices);
        assert!(
            honoured_vendor_wait(&granted, 1_000),
            "each granted wait honours the declared second: {granted:?} {notices:?}"
        );
        let refused: Vec<&Value> = notices
            .iter()
            .filter(|notice| notice["kind"] == "provider.window")
            .collect();
        assert_eq!(refused.len(), 1, "{notices:?}");
        let note = refused[0]["note"]
            .as_str()
            .expect("the refusal names the numbers it used");
        assert!(
            note.contains("already extended its retry window 2 times"),
            "{note}"
        );
        let message = outcome
            .expect_err("the refusal is the turn's failure")
            .to_string();
        assert!(message.contains(note), "{message}");
    }

    /// A backoff is this runner's guess, so the window still owns it. A short
    /// window refuses a backoff that does not fit and never sleeps through it.
    #[tokio::test]
    async fn a_backoff_beyond_the_window_still_refuses() {
        let (endpoint, state, server) = serve(vec![Scripted {
            status: 500,
            retry_after: None,
        }])
        .await;
        let started = std::time::Instant::now();
        let (outcome, notices) = drive(&endpoint, Duration::from_millis(100)).await;
        let elapsed = started.elapsed();
        server.abort();
        assert!(
            matches!(outcome, Err(ProviderError::Http(500, _))),
            "{outcome:?}"
        );
        assert_eq!(
            state.lock().unwrap().1,
            1,
            "no attempt followed the refusal"
        );
        assert!(
            elapsed < Duration::from_millis(100),
            "the turn slept through a backoff it had no room for: {elapsed:?}"
        );
        assert!(delays(&notices).is_empty(), "{notices:?}");
        let note = notices
            .iter()
            .find(|notice| notice["kind"] == "provider.window")
            .and_then(|notice| notice["note"].as_str())
            .expect("the refusal names what it refused");
        assert!(
            note.starts_with("no retry: the next backoff was "),
            "{note}"
        );
    }

    /// A pause the window can outlast still retries, and can still succeed.
    #[tokio::test]
    async fn a_pause_within_the_window_can_still_end_in_success() {
        let (endpoint, state, server) = serve(vec![
            Scripted {
                status: 429,
                retry_after: Some("1"),
            },
            Scripted {
                status: 200,
                retry_after: None,
            },
        ])
        .await;
        let (outcome, _) = drive(&endpoint, Duration::from_secs(3)).await;
        server.abort();
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(
            state.lock().unwrap().1,
            2,
            "the retry did happen after the pause"
        );
    }

    #[tokio::test]
    async fn a_spent_window_names_the_failure_that_spent_it() {
        let budget = Budget::with_deadline(Duration::ZERO);
        assert!(
            !budget.spent().to_string().contains("last attempt"),
            "a window that no attempt failed has no last attempt to name"
        );
        budget.note_failure("provider HTTP 503");
        budget.arm();
        let message = budget.spent().to_string();
        assert!(
            message.contains("last attempt: provider HTTP 503"),
            "unexpected spent-window message: {message}"
        );
    }

    /// JOB-04 asks the watchdogs to fire *without refilling retry budgets*. A
    /// header deadline and a stream silence limit both land here as transport
    /// failures, and the first one arms the window. A later watchdog failure
    /// must not move the window's end: once it is spent, the turn reports the
    /// newest failure instead of quietly buying another full window.
    #[tokio::test]
    async fn a_deadline_failure_does_not_refill_the_retry_window() {
        let budget = Budget::with_deadline(Duration::from_millis(50));
        budget.note_failure("no response headers before the request deadline");
        let armed = budget.arm();
        tokio::time::sleep(Duration::from_millis(80)).await;
        // A silence limit, then a second deadline: neither may reopen the
        // window the first failure opened.
        budget.note_failure("provider produced no stream event for 300000ms");
        assert_eq!(
            budget.arm(),
            armed,
            "a watchdog failure must not move the window's end"
        );
        assert!(budget.expired(), "the window stays spent");
        let message = budget.spent().to_string();
        assert!(
            message.contains("last attempt: provider produced no stream event"),
            "the newest failure is the one an operator can act on: {message}"
        );
    }

    /// A stream reconnect is a retry too: the silence limit's own replay path
    /// draws from the same window through `transport_attempt`, so a spent
    /// window refuses it rather than granting a fresh budget.
    #[tokio::test]
    async fn a_spent_window_refuses_a_stream_reconnect_without_a_new_budget() {
        let outcome = RETRY_SCOPE
            .scope(
                RetryScope {
                    budget: Budget::with_deadline(Duration::from_millis(30)),
                    limit: 3,
                    cap: MAX_REQUEST_ATTEMPTS,
                    requests: MAX_REQUEST_ATTEMPTS,
                },
                async {
                    // The first attempt opens the window, as any failure does.
                    let _ = transport_attempt();
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    transport_attempt()
                },
            )
            .await;
        assert!(
            matches!(outcome, Err(ProviderError::Transport(ref message)) if message.contains("retry window was spent before another stream attempt")),
            "a spent window must refuse the reconnect: {outcome:?}"
        );
    }

    /// A transport failure has no status and no body, so the cause the socket
    /// gave is the only thing an operator can act on — and it must reach the
    /// attempt notice without the request URL, which can carry a credential.
    #[tokio::test]
    async fn a_transport_failure_announces_its_cause() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (outcome, notices) = drive(
            &format!("http://127.0.0.1:{port}/?api-key=sk-secret"),
            Duration::from_secs(1),
        )
        .await;
        assert!(matches!(outcome, Err(ProviderError::Transport(_))));
        let attempt = notices
            .iter()
            .find(|notice| notice["kind"] == "provider.attempt")
            .expect("the attempt was not announced");
        assert_eq!(attempt["outcome"], "transport_unknown");
        let detail = attempt["detail"].as_str().unwrap_or_default();
        assert!(
            detail.contains("connect failed"),
            "the socket's reason is missing: {detail}"
        );
        assert!(
            !detail.contains("sk-secret"),
            "the URL's query reached the notice: {detail}"
        );
    }
}

/// Some gateways report their own transient image-decode failures as HTTP 400:
/// the zhipuai coding endpoint answers `{"error":{"code":"1210"}}` for a
/// request the same model accepts unchanged seconds later. Replay that response
/// class within the existing retry budget; every other 400 stays terminal.
fn image_parse_transient(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value["error"]["code"].as_str().map(str::to_owned))
        .is_some_and(|code| code == "1210")
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
    let watchdogs = response
        .extensions()
        .get::<crate::first_event::Watchdogs>()
        .copied()
        .unwrap_or_default();
    let mut event = watchdogs.event;
    let mut received_event = false;
    let byte_idle = watchdogs.byte_idle;
    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut guard = crate::output_guard::Guard::new();
    let mut total = 0;
    loop {
        let deadline = input_budget
            .deadline()
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(120));
        // select! evaluates every branch expression even when its `if`
        // precondition disables it, so this fallback must never panic.
        let event_deadline =
            event.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600));
        let chunk = tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            _=tokio::time::sleep_until(event_deadline), if event.is_some()=>return Err(watchdogs.event_timeout(received_event)),
            _=tokio::time::sleep_until(deadline), if input_budget.deadline().is_some()=>return Err(input_budget.timeout_error()),
            result=async {
                let chunk = match byte_idle.is_zero() {
                    true => bytes.next().await,
                    false => tokio::time::timeout(byte_idle, bytes.next())
                        .await
                        .map_err(|_| match received_event {
                            // Silence before any semantic event is the same
                            // retryable failure the old single deadline produced;
                            // after one, a stalled stream stays terminal.
                            false => ProviderError::Transport(format!(
                                "provider sent no response bytes for {}ms (set MIAO_LLM_STREAM_IDLE_TIMEOUT_MS to adjust, 0 disables)",
                                byte_idle.as_millis(),
                            )),
                            true => ProviderError::Stream(format!(
                                "provider sent no response bytes for {}ms (set MIAO_LLM_STREAM_IDLE_TIMEOUT_MS to adjust, 0 disables)",
                                byte_idle.as_millis(),
                            )),
                        })?,
                };
                Ok::<_, ProviderError>(chunk)
            }=>result?,
        };
        let Some(chunk) = chunk else {
            return parser.finish();
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => return Err(parser.interrupted()),
        };
        total += chunk.len();
        if total > 64 * 1024 * 1024 {
            // The runaway guard: truncate the stream at 64 MiB of raw wire
            // bytes and keep the partial reply instead of discarding it. The
            // repetitive-delta guard catches degenerate loops; this bound only
            // stops genuinely huge streams from hanging the turn.
            return parser.finish();
        }
        for frame in decoder.push(&chunk)? {
            input_budget.frame(&frame)?;
            parser.frame(&frame)?;
            if match &frame {
                Frame::Done => true,
                Frame::Json(event) => crate::first_event::semantic_event(event),
            } {
                received_event = true;
                event = watchdogs.next_event_deadline();
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
                        // The detecting delta is deliberately not published: the
                        // stream stops where the loop was recognized, and the
                        // turn fails instead of continuing into a late tool call.
                        if let Some(channel) =
                            normalized.iter().find_map(|delta| guard.observe(delta))
                        {
                            return Err(ProviderError::Repetitive {
                                channel: channel.as_str(),
                                partial: guard.partial(),
                            });
                        }
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
            let event_deadline =
                event.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600));
            tokio::select! {
                _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
                _=tokio::time::sleep_until(event_deadline), if event.is_some()=>return Err(watchdogs.event_timeout(received_event)),
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
mod image_parse_retry_tests {
    use super::request_with_retry;
    use crate::provider::ProviderError;
    use axum::{
        extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router,
    };
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    async fn serve(responses: Arc<AtomicUsize>, first: serde_json::Value) -> String {
        let router = Router::new()
            .route(
                "/fixture",
                get(move |State(state): State<Arc<AtomicUsize>>| async move {
                    if state.fetch_add(1, Ordering::SeqCst) == 0 {
                        (StatusCode::BAD_REQUEST, Json(first)).into_response()
                    } else {
                        (StatusCode::OK, "ok").into_response()
                    }
                }),
            )
            .with_state(responses);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        endpoint
    }

    #[tokio::test]
    async fn transient_image_parse_400_replays_the_request() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let endpoint = serve(
            attempts.clone(),
            json!({"error":{"code":"1210","message":"图片输入格式/解析错误"}}),
        )
        .await;
        let client = reqwest::Client::new();
        let (progress, mut received) = mpsc::channel(16);
        let request = client.get(&endpoint).build().unwrap();
        let response = request_with_retry(
            "openai-chat",
            &client,
            request,
            &progress,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let frames: Vec<serde_json::Value> =
            std::iter::from_fn(|| received.try_recv().ok()).collect();
        assert!(frames
            .iter()
            .any(|frame| frame["kind"] == "provider.retry" && frame["status"] == 400));
    }

    /// A 400 that keeps recurring is still terminal: the runner's single
    /// immediate replay runs once, and the second rejection ends the turn
    /// instead of looping.
    #[tokio::test]
    async fn a_recurring_400_stays_terminal_after_its_single_replay() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route(
                "/fixture",
                get(|State(state): State<Arc<AtomicUsize>>| async move {
                    state.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":{"code":"1211","message":"other"}})),
                    )
                        .into_response()
                }),
            )
            .with_state(attempts.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let (progress, _received) = mpsc::channel(16);
        let request = client.get(&endpoint).build().unwrap();
        let result = request_with_retry(
            "openai-chat",
            &client,
            request,
            &progress,
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Err(ProviderError::Http(400, _))));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
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

#[cfg(test)]
mod retry_status_tests {
    use super::*;

    /// A gateway timeout is a server-side failure like any other. Cloudflare
    /// answers 520, 521, 522 or 524 when the origin is unreachable or too slow,
    /// and an enumerated list turned those into an `invalid request` that ended
    /// the turn after one attempt.
    #[test]
    fn every_server_side_status_is_retried_and_a_client_error_is_not() {
        for status in [429, 500, 502, 503, 504, 520, 521, 522, 524, 529, 599] {
            assert!(retryable_status(status), "{status} must be retried");
            let error = ProviderError::Http(status, String::new());
            assert!(error.can_fallback(), "{status} can fall back");
            assert!(error.unavailable(), "{status} is unavailable");
        }
        for status in [400, 401, 402, 403, 404, 409, 413, 422] {
            assert!(!retryable_status(status), "{status} must not be retried");
            assert!(!ProviderError::Http(status, String::new()).can_fallback());
        }
    }
}
