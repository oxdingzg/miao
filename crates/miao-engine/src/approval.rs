use crate::permission::Decision;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub request_id: String,
    pub session_id: String,
    pub run_id: String,
    pub call_id: String,
    pub location: String,
    pub tool: String,
    pub resource: String,
    pub input: Value,
    pub input_hash: String,
    pub policy_revision: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub request_id: String,
    pub input_hash: String,
    pub policy_revision: String,
    pub decision: Decision,
}

/// Wall-clock deadlines survive restart. Runtime cancellation and its
/// monotonic timer are independent checks; a pending request never authorizes.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
