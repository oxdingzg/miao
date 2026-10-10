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
//! authoritative ledger and a private broadcast receiver, so a slow client lags
//! its own stream (getting a `resync` frame) and can never apply backpressure to
//! the provider or the run loop.
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
use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex},
};

/// Wire revision for this transport: echoed in the `miao-engine-protocol`
/// response header and accepted from clients in the same header.
pub const PROTOCOL_VERSION: &str = "engine-http-0";

const PROTOCOL_HEADER: &str = "miao-engine-protocol";

/// Provider requests may carry base64 image attachments; match the engine's
/// 8 MiB attachment bound plus envelope headroom.
const MAX_BODY: usize = 9 * 1024 * 1024;

struct Shared {
    host: Mutex<Host>,
    runtime: Runtime,
    token: String,
}

/// Serve the command table over HTTP until the listener fails. The caller binds
/// the listener and supplies the bearer token; this never binds on its own.
pub async fn serve(runtime: Runtime, listener: TcpListener, token: String) -> std::io::Result<()> {
    let state = Arc::new(Shared {
        host: Mutex::new(Host::new(runtime.clone())),
        runtime,
        token,
    });
    let router = Router::new()
        .route("/rpc", post(rpc))
        .route("/events", get(events))
        .route("/version", get(version))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state);
    axum::serve(listener, router).await
}

async fn version() -> Response {
    ok(json!({ "protocol": PROTOCOL_VERSION }))
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
    progress: broadcast::Receiver<Value>,
}

async fn next_event(mut stream: Stream) -> Option<(Result<Event, Infallible>, Stream)> {
    loop {
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
            Ok(Ok(notice)) if notice["session_id"].as_str() == Some(stream.session.as_str()) => {
                if let Ok(frame) = Event::default().event("progress").json_data(&notice) {
                    return Some((Ok(frame), stream));
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                let frame = Event::default()
                    .event("resync")
                    .json_data(json!({ "reason": "ephemeral_progress_lagged" }));
                return Some((Ok(frame.ok()?), stream));
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => return None,
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
