//! Wire protocol: one JSON object per line over the unix socket.
//!
//! Requests carry an opaque `id` echoed by the response. `get` returns the
//! stored credential value (refreshing it first when it sits inside the
//! refresh margin), `refresh` forces a refresh and returns only the new
//! expiry, and `discover` lists the daemon's rows without secret material.

use crate::Error;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Get {
        credential_id: String,
        integration: String,
    },
    Refresh {
        credential_id: String,
        integration: String,
    },
    Discover,
}

#[derive(Debug, Deserialize)]
pub struct Frame {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

/// Parses one request line. Oversized or non-object lines are protocol
/// violations, not `invalid` credentials, so the connection can be closed.
pub fn parse(line: &str) -> Result<Frame, Error> {
    if line.len() > 64 * 1024 {
        return Err(Error::Protocol);
    }
    let value: Value = serde_json::from_str(line).map_err(|_| Error::Protocol)?;
    if !value.is_object() {
        return Err(Error::Protocol);
    }
    serde_json::from_value(value).map_err(|_| Error::Protocol)
}

pub fn ok(id: u64, payload: Value) -> String {
    format!("{{\"id\":{id},\"ok\":{}}}\n", payload)
}

pub fn err(id: u64, error: &Error) -> String {
    format!(
        "{{\"id\":{id},\"error\":{{\"code\":\"{}\"}}}}\n",
        error.code()
    )
}
