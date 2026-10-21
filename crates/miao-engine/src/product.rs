//! Product-owned tools: definitions supplied by the host at spawn, executed
//! by reverse-dispatching a `product_tool` request over the control channel.
//! The host runs them against Location services and replies; a failed or
//! dropped reply surfaces as a tool error, never as silence.
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

use crate::protocol::ToolDefinition;

/// Which plugin hook families the host resolves in-process. The marker only
/// advertises presence; the callbacks themselves never cross the boundary.
#[derive(Deserialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
pub struct Marker {
    #[serde(default)]
    pub before: bool,
    #[serde(default)]
    pub after: bool,
}

impl Marker {
    pub fn marked(&self, kind: &str) -> bool {
        match kind {
            "before" => self.before,
            "after" => self.after,
            _ => false,
        }
    }
}

/// Host-provided product tool set plus the reverse bridge. Held behind an
/// `Arc<RwLock<…>>` so a shared runtime handle can register it at startup.
#[derive(Default)]
pub struct State {
    pub tools: Vec<ToolDefinition>,
    pub bridge: Option<Bridge>,
    pub marker: Option<Marker>,
}
impl State {
    pub fn has(&self, name: &str) -> bool {
        self.tools.iter().any(|tool| tool.name == name)
    }
}

#[derive(Clone)]
pub struct Bridge {
    tx: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next: Arc<AtomicU64>,
}

impl Bridge {
    pub fn new(tx: mpsc::Sender<Value>) -> Self {
        Self {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU64::new(1)),
        }
    }

    pub(crate) fn pending(&self) -> &Mutex<HashMap<u64, oneshot::Sender<Value>>> {
        &self.pending
    }

    /// Send a product-tool call and wait for the host's result.
    pub async fn call(
        &self,
        session: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, crate::tools::ToolError> {
        self.settle(
            "product_tool",
            json!({"session_id": session, "name": name, "input": input}),
            "product bridge",
            "product tool",
        )
        .await
    }

    /// Send a reverse hook dispatch and wait for the host's verdict. The
    /// payload carries `args` (and the settled `output` for the after family).
    pub async fn call_hook(
        &self,
        session: &str,
        kind: &str,
        tool: &str,
        call: &str,
        payload: Value,
    ) -> Result<Value, crate::tools::ToolError> {
        let mut params =
            json!({"session_id": session, "kind": kind, "tool": tool, "call_id": call});
        if let (Some(object), Some(extra)) = (params.as_object_mut(), payload.as_object()) {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        self.settle("hook_tool", params, "hook bridge", "tool hook")
            .await
    }

    async fn settle(
        &self,
        method: &str,
        params: Value,
        closed: &str,
        failed: &str,
    ) -> Result<Value, crate::tools::ToolError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (reply, reply_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let request = serde_json::json!({"bridge_id": id, "method": method, "params": params});
        if self.tx.send(request).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(crate::tools::ToolError::External(format!(
                "{closed} closed"
            )));
        }
        let response = match reply_rx.await {
            Ok(response) => response,
            Err(_) => {
                return Err(crate::tools::ToolError::External(format!(
                    "{closed} dropped the call"
                )));
            }
        };
        if let Some(error) = response.get("error") {
            return Err(crate::tools::ToolError::External(format!(
                "{failed} failed: {error}"
            )));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Deliver a host reply to the pending call, if any. Unknown ids are dropped
/// (the host restarted its bookkeeping); never fabricate a result.
pub fn deliver(
    pending: &Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    bridge_id: u64,
    value: Value,
) -> bool {
    pending
        .lock()
        .unwrap()
        .remove(&bridge_id)
        .is_some_and(|sender| sender.send(value).is_ok())
}
