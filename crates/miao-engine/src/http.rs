//! Loopback HTTP transport for the host command table (revision `engine-http-0`).
//!
//! A thin, versioned mapping of the same method table as stdio: one JSON
//! [`Request`] per `POST /rpc`, the same `{id, result|error}` envelope, and the
//! wire revision echoed in the `miao-engine-protocol` header. The transport owns
//! no domain state; it locks a [`Host`] for the duration of one command, so
//! approvals, questions and cancellation reuse the exact stdio code path.
//!
//! Authority: the caller binds a loopback listener and supplies a bearer token.
//! Only an authenticated request reaches the controller capability inside
//! [`Host`]; an unauthenticated or wrong-token request is rejected before the
//! runtime is touched.

use crate::{host::Host, protocol::Request, runtime::Runtime};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{net::TcpListener, sync::Mutex};

/// Wire revision for this transport: echoed in the `miao-engine-protocol`
/// response header and accepted from clients in the same header.
pub const PROTOCOL_VERSION: &str = "engine-http-0";

const PROTOCOL_HEADER: &str = "miao-engine-protocol";

/// Provider requests may carry base64 image attachments; match the engine's
/// 8 MiB attachment bound plus envelope headroom.
const MAX_BODY: usize = 9 * 1024 * 1024;

struct Shared {
    host: Mutex<Host>,
    token: String,
}

/// Serve the command table over HTTP until the listener fails. The caller binds
/// the listener and supplies the bearer token; this never binds on its own.
pub async fn serve(runtime: Runtime, listener: TcpListener, token: String) -> std::io::Result<()> {
    let state = Arc::new(Shared {
        host: Mutex::new(Host::new(runtime)),
        token,
    });
    let router = Router::new()
        .route("/rpc", post(rpc))
        .route("/version", get(version))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state);
    axum::serve(listener, router).await
}

async fn version() -> Response {
    ok(json!({ "protocol": PROTOCOL_VERSION }))
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
