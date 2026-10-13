//! Client half of the protocol: what the engine (or any local process) uses
//! to talk to the daemon. Kept in this crate so the wire format has exactly
//! one implementation on each side.

use crate::Error;
use serde_json::Value;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// One request, one reply. The daemon handles a connection frame by frame,
/// but a client per request keeps callers simple and stateless.
pub async fn request(socket: &Path, line: String) -> Result<Value, Error> {
    let stream = UnixStream::connect(socket).await.map_err(|_| Error::Io)?;
    let (reader, mut writer) = stream.into_split();
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|_| Error::Io)?;
    writer.write_all(b"\n").await.map_err(|_| Error::Io)?;
    writer.flush().await.map_err(|_| Error::Io)?;
    let mut lines = BufReader::new(reader).lines();
    let reply = lines.next_line().await.map_err(|_| Error::Io)?;
    let reply = reply.ok_or(Error::Io)?;
    parse_reply(&reply)
}

/// Asks for a credential, letting the daemon refresh it first when due.
/// Returns the stored credential value with fresh `access`/`expires`.
pub async fn get(socket: &Path, credential_id: &str, integration: &str) -> Result<Value, Error> {
    let line = serde_json::json!({
        "id": 1,
        "op": "get",
        "credential_id": credential_id,
        "integration": integration,
    });
    let reply = request(socket, line.to_string()).await?;
    let credential = reply
        .get("ok")
        .and_then(|ok| ok.get("credential"))
        .cloned()
        .ok_or_else(|| error_from_reply(&reply))?;
    Ok(credential)
}

/// Forces a refresh. Returns the new stored expiry in ms.
pub async fn refresh(socket: &Path, credential_id: &str, integration: &str) -> Result<u64, Error> {
    let line = serde_json::json!({
        "id": 1,
        "op": "refresh",
        "credential_id": credential_id,
        "integration": integration,
    });
    let reply = request(socket, line.to_string()).await?;
    reply
        .get("ok")
        .and_then(|ok| ok.get("expires"))
        .and_then(Value::as_u64)
        .ok_or_else(|| error_from_reply(&reply))
}

/// Lists the daemon's rows as discovery metadata (no secret material).
pub async fn discover(socket: &Path) -> Result<Value, Error> {
    let reply = request(
        socket,
        serde_json::json!({"id": 1, "op": "discover"}).to_string(),
    )
    .await?;
    reply
        .get("ok")
        .cloned()
        .ok_or_else(|| error_from_reply(&reply))
}

fn error_from_reply(reply: &Value) -> Error {
    let code = reply
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("invalid");
    match code {
        "missing" => Error::Missing,
        "integration" => Error::Integration,
        "not_refreshable" => Error::NotRefreshable,
        "refresh_rejected" => Error::RefreshRejected,
        "refresh_unavailable" => Error::RefreshUnavailable,
        "io" => Error::Io,
        "database" => Error::Database,
        "protocol" => Error::Protocol,
        _ => Error::Invalid,
    }
}

fn parse_reply(reply: &str) -> Result<Value, Error> {
    let value: Value = serde_json::from_str(reply).map_err(|_| Error::Protocol)?;
    if !value.is_object() {
        return Err(Error::Protocol);
    }
    Ok(value)
}
