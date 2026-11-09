//! Loopback HTTP transport for the host command table (revision `engine-http-0`).
//!
//! A thin, versioned mapping of the same method table as stdio: one JSON
//! [`Request`] per `POST /rpc`, the same `{id, result|error}` envelope, and the
//! wire revision echoed in the `miao-engine-protocol` header. The transport owns
//! no domain state; it locks a [`Host`] for the duration of one command, so
//! approvals, questions and cancellation reuse the exact stdio code path.
//!
//! `GET /events?session_id=..&after=..` is the streaming half: Server-Sent
//! Events for the same committed `event` notifications and ephemeral `progress`
//! frames as stdio, keyed by the durable `seq` cursor. Each connection reads the
//! authoritative ledger and a private lossless queue, so a slow client can
//! never apply backpressure to the provider or the run loop, and never loses a
//! delta it would have no way to replay.
//!
//! `GET /api/health` is the one endpoint without a token: a supervisor that has
//! not attached yet still needs to know the engine is up and which build it is,
//! so the probe names the version and reads no runtime state.
//!
//! Authority: the caller binds a loopback listener and supplies a bearer token.
//! Only an authenticated request reaches the controller capability inside
//! [`Host`]; an unauthenticated or wrong-token request is rejected before the
//! runtime is touched.

use crate::{host::Host, protocol::Request, runtime::Runtime};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::Mutex};

/// Wire revision for this transport: echoed in the `miao-engine-protocol`
/// response header and accepted from clients in the same header.
pub const PROTOCOL_VERSION: &str = "engine-http-0";

const PROTOCOL_HEADER: &str = "miao-engine-protocol";

/// Origins a window may use against this plane: the desktop shell's custom
/// scheme, and any loopback HTTP origin (a dev server or a web build pointed at a
/// local engine). A foreign origin gets no permission at all rather than a
/// wildcard, because the plane answers authenticated commands.
fn allowed_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.split('/').next().unwrap_or(rest);
    // A bracketed IPv6 host contains colons of its own, so the port separator is
    // only meaningful outside the brackets.
    let host = match host.strip_prefix('[') {
        Some(inner) => match inner.split(']').next() {
            Some(address) => format!("[{address}]"),
            None => return false,
        },
        None => host.split(':').next().unwrap_or(host).to_string(),
    };
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

fn apply_cors(response: &mut Response, origin: Option<&str>) {
    let Some(origin) = origin.and_then(|value| HeaderValue::from_str(value).ok()) else {
        return;
    };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, miao-engine-protocol"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(PROTOCOL_HEADER),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    headers.append(header::VARY, HeaderValue::from_static("origin"));
}

/// Answer the preflight locally: a window never sends its bearer token on one,
/// so an authenticated `OPTIONS` would be rejected and the real request would
/// never follow.
async fn cors(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let requested = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let allowed = requested
        .as_deref()
        .filter(|origin| allowed_origin(origin))
        .map(str::to_owned);
    if request.method() == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors(&mut response, allowed.as_deref());
        return response;
    }
    let mut response = next.run(request).await;
    apply_cors(&mut response, allowed.as_deref());
    response
}

#[cfg(test)]
mod cors_tests {
    use super::{allowed_origin, apply_cors};
    use axum::http::{HeaderValue, StatusCode};
    use axum::response::IntoResponse;

    #[test]
    fn admits_the_shell_scheme_and_loopback_web_origins() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:4319",
            "https://[::1]:8443",
        ] {
            assert!(allowed_origin(origin), "{origin} should be admitted");
        }
    }

    #[test]
    fn refuses_every_other_origin() {
        for origin in [
            "https://example.org",
            "http://localhost.example.org",
            "http://127.0.0.1.example.org:1420",
            "file://",
            "null",
        ] {
            assert!(!allowed_origin(origin), "{origin} should be refused");
        }
    }

    #[test]
    fn writes_the_permission_only_for_an_admitted_origin() {
        let mut refused = StatusCode::NO_CONTENT.into_response();
        apply_cors(&mut refused, None);
        assert!(refused
            .headers()
            .get("access-control-allow-origin")
            .is_none());

        let mut allowed = StatusCode::NO_CONTENT.into_response();
        apply_cors(&mut allowed, Some("tauri://localhost"));
        assert_eq!(
            allowed.headers().get("access-control-allow-origin"),
            Some(&HeaderValue::from_static("tauri://localhost"))
        );
        assert_eq!(
            allowed.headers().get("access-control-expose-headers"),
            Some(&HeaderValue::from_static("miao-engine-protocol"))
        );
    }
}

/// Provider requests may carry base64 image attachments; match the engine's
/// 8 MiB attachment bound plus envelope headroom.
const MAX_BODY: usize = 9 * 1024 * 1024;

struct Shared {
    host: Mutex<Host>,
    runtime: Runtime,
    token: String,
    leases: Mutex<HashMap<String, tokio::time::Instant>>,
    stop: tokio_util::sync::CancellationToken,
}

/// Serve the command table over HTTP until the listener fails. The caller binds
/// the listener and supplies the bearer token; this never binds on its own.
pub async fn serve(runtime: Runtime, listener: TcpListener, token: String) -> std::io::Result<()> {
    serve_with_idle_timeout(runtime, listener, token, None).await
}

/// Shared-engine attachments renew leases independently. An optional idle
/// timeout lets the engine outlive one window without becoming an orphan.
pub async fn serve_with_idle_timeout(
    runtime: Runtime,
    listener: TcpListener,
    token: String,
    idle: Option<Duration>,
) -> std::io::Result<()> {
    let state = Arc::new(Shared {
        host: Mutex::new(Host::new(runtime.clone())),
        runtime,
        token,
        leases: Mutex::new(HashMap::new()),
        stop: tokio_util::sync::CancellationToken::new(),
    });
    let router = Router::new()
        .route("/rpc", post(rpc))
        .route("/events", get(events))
        .route("/version", get(version))
        .route("/api/health", get(health))
        .route("/lease", post(lease))
        // A window loads its bundle from a custom scheme (`tauri://localhost`) or,
        // in development, a local web server. Both are cross-origin relative to
        // this loopback plane, so without an explicit permission the renderer's
        // own `fetch` is rejected before the bearer token is even read.
        .layer(axum::middleware::from_fn(cors))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state.clone());
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let Some(idle) = idle else {
                std::future::pending::<()>().await;
                return;
            };
            let mut occupied = tokio::time::Instant::now();
            loop {
                tokio::time::sleep(idle.min(Duration::from_millis(250))).await;
                let now = tokio::time::Instant::now();
                let attached = {
                    let mut leases = state.leases.lock().await;
                    leases.retain(|_, renewed| now.duration_since(*renewed) < idle);
                    !leases.is_empty()
                };
                // A scheduled wake, running turn, or background job is still
                // useful work even after every window has detached.
                if attached || state.runtime.has_live_work().await.unwrap_or(true) {
                    occupied = now;
                    continue;
                }
                if now.duration_since(occupied) >= idle {
                    let leases = state.leases.lock().await;
                    if !leases.is_empty() {
                        occupied = now;
                        continue;
                    }
                    state.stop.cancel();
                    return;
                }
            }
        })
        .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    client_id: String,
    #[serde(default)]
    release: bool,
}

async fn lease(State(state): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers, &state.token) {
        return fail(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        );
    }
    let value: Lease = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "expected a client lease",
            )
        }
    };
    if value.client_id.is_empty()
        || value.client_id.len() > 128
        || !value
            .client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "invalid client identity",
        );
    }
    let mut leases = state.leases.lock().await;
    if state.stop.is_cancelled() {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_closing",
            "native engine is shutting down",
        );
    }
    if value.release {
        leases.remove(&value.client_id);
        return ok(json!({"accepted":true}));
    }
    if leases.len() >= 128 && !leases.contains_key(&value.client_id) {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "lease_limit",
            "too many engine attachments",
        );
    }
    leases.insert(value.client_id, tokio::time::Instant::now());
    ok(json!({"accepted":true}))
}

async fn version() -> Response {
    ok(json!({ "protocol": PROTOCOL_VERSION }))
}

/// Liveness probe for a supervisor that has no token yet: the desktop polls a
/// sidecar before it claims a window is attached, so the Rust engine answers the
/// same shape (`{healthy, version, pid}`) the TypeScript server did.
async fn health() -> Response {
    ok(json!({
        "healthy": true,
        "version": env!("MIAO_ENGINE_VERSION"),
        "pid": std::process::id(),
    }))
}

#[derive(Deserialize)]
struct EventsParams {
    session_id: String,
    #[serde(default)]
    after: u64,
}

/// Server-Sent Events of the committed ledger for one Session, then live
/// committed events and ephemeral progress. The cursor is authoritative: a
/// dropped or lagged progress frame becomes a `resync`, never a lost committed
/// event.
async fn events(
    State(state): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(params): Query<EventsParams>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return fail(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        );
    }
    if let Some(version) = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        if version != PROTOCOL_VERSION {
            return fail(
                StatusCode::BAD_REQUEST,
                "unsupported_protocol",
                "unknown engine-http revision",
            );
        }
    }
    // A reconnecting EventSource resends its last id; honor it over the query.
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(params.after);
    let start = Stream {
        store: state.runtime.store().clone(),
        session: params.session_id,
        cursor: after,
        pending: VecDeque::new(),
        progress: state.runtime.progress(),
        stop: state.stop.clone(),
    };
    tagged(
        Sse::new(stream::unfold(start, next_event))
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response(),
    )
}

struct Stream {
    store: crate::store::Store,
    session: String,
    cursor: u64,
    pending: VecDeque<Event>,
    progress: crate::progress::Subscriber,
    stop: tokio_util::sync::CancellationToken,
}

async fn next_event(mut stream: Stream) -> Option<(Result<Event, Infallible>, Stream)> {
    loop {
        if stream.stop.is_cancelled() {
            return None;
        }
        if let Some(frame) = stream.pending.pop_front() {
            return Some((Ok(frame), stream));
        }
        // The ledger is the authority; a page is bounded so memory stays flat.
        let committed = stream
            .store
            .events(&stream.session, stream.cursor, 64)
            .await
            .ok()?;
        if !committed.is_empty() {
            stream.cursor = committed.last()?.seq;
            for event in committed {
                if let Ok(frame) = Event::default()
                    .id(event.seq.to_string())
                    .event("event")
                    .json_data(&event)
                {
                    stream.pending.push_back(frame);
                }
            }
            continue;
        }
        match tokio::time::timeout(Duration::from_millis(500), stream.progress.recv()).await {
            Ok(Some(notice)) if notice["session_id"].as_str() == Some(stream.session.as_str()) => {
                if let Ok(frame) = Event::default().event("progress").json_data(&notice) {
                    return Some((Ok(frame), stream));
                }
            }
            Ok(None) => return None,
            // Timeout or another Session's frame: loop to re-poll the ledger.
            _ => {}
        }
    }
}

async fn rpc(State(state): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers, &state.token) {
        return fail(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        );
    }
    if let Some(version) = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        if version != PROTOCOL_VERSION {
            return fail(
                StatusCode::BAD_REQUEST,
                "unsupported_protocol",
                "unknown engine-http revision",
            );
        }
    }
    let request: Request = match serde_json::from_slice::<Request>(&body) {
        Ok(request) if request.id.is_string() || request.id.is_number() => request,
        _ => {
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "expected an id and a typed method/params request",
            )
        }
    };
    let id = request.id.clone();
    let mut host = state.host.lock().await;
    let result = host.dispatch(request.command).await;
    ok(match result {
        Ok(value) => json!({ "id": id, "result": value }),
        Err(error) => json!({
            "id": id,
            "error": { "code": error.code(), "message": error.to_string() },
        }),
    })
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == token)
}

fn ok(value: Value) -> Response {
    tagged(Json(value).into_response())
}

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    tagged(
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response(),
    )
}

fn tagged(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(PROTOCOL_HEADER, HeaderValue::from_static(PROTOCOL_VERSION));
    response
}
