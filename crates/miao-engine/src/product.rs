//! Product-owned tools: definitions supplied by the host at spawn, executed
//! by reverse-dispatching a `product_tool` request over the control channel.
//! The host runs them against Location services and replies; a failed or
//! dropped reply surfaces as a tool error, never as silence.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

use crate::protocol::ToolDefinition;

/// Host-provided product tool set plus the reverse bridge. Held behind an
/// `Arc<RwLock<…>>` so a shared runtime handle can register it at startup.
#[derive(Default)]
pub struct State {
    pub tools: Vec<ToolDefinition>,
    pub bridge: Option<Bridge>,
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
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (reply, reply_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let request = serde_json::json!({
            "bridge_id": id,
            "method": "product_tool",
            "params": {"session_id": session, "name": name, "input": input},
        });
        if self.tx.send(request).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(crate::tools::ToolError::External(
                "product bridge closed".into(),
            ));
        }
        let response = match reply_rx.await {
            Ok(response) => response,
            Err(_) => {
                return Err(crate::tools::ToolError::External(
                    "product bridge dropped the call".into(),
                ));
            }
        };
        if let Some(error) = response.get("error") {
            return Err(crate::tools::ToolError::External(format!(
                "product tool failed: {error}"
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
