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
    #[serde(default)]
    pub definition: bool,
}

impl Marker {
    pub fn marked(&self, kind: &str) -> bool {
        match kind {
            "before" => self.before,
            "after" => self.after,
            "definition" => self.definition,
            _ => false,
        }
    }
}

/// The calling tool-call identity a product-tool dispatch carries, so the host
/// can name a real permission source (`message_seq` + `call_id`) instead of a
/// standing-policy guess. `message_seq` is the assistant message's durable seq;
/// the host derives its product message id from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallContext {
    pub message_seq: u64,
    pub call_id: String,
}

/// Host path spelling and working directory used by its edit classifier.
/// The Runtime validates directory identity before accepting this startup data.
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostContext {
    pub directory: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

pub(crate) struct Pending {
    session: String,
    method: String,
    reply: oneshot::Sender<Value>,
    permission: Option<crate::product_permission::Authority>,
}

/// Host-provided product tool set plus the reverse bridge. Held behind an
/// `Arc<RwLock<…>>` so a shared runtime handle can register it at startup.
#[derive(Default)]
pub struct State {
    pub tools: Vec<ToolDefinition>,
    pub bridge: Option<Bridge>,
    pub marker: Option<Marker>,
    pub host_context: Option<HostContext>,
}
impl State {
    pub fn has(&self, name: &str) -> bool {
        self.tools.iter().any(|tool| tool.name == name)
    }
}

#[derive(Clone)]
pub struct Bridge {
    tx: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
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

    pub(crate) fn pending(&self) -> &Mutex<HashMap<u64, Pending>> {
        &self.pending
    }

    /// Send a product-tool call and wait for the host's result.
    pub async fn call(
        &self,
        session: &str,
        name: &str,
        input: Value,
        context: CallContext,
    ) -> Result<Value, crate::tools::ToolError> {
        self.call_with_authority(session, name, input, context, None)
            .await
    }

    pub(crate) async fn call_authorized(
        &self,
        session: &str,
        name: &str,
        input: Value,
        authority: crate::product_permission::Authority,
    ) -> Result<Value, crate::tools::ToolError> {
        self.call_with_authority(
            session,
            name,
            input,
            authority.context.clone(),
            Some(authority),
        )
        .await
    }

    async fn call_with_authority(
        &self,
        session: &str,
        name: &str,
        input: Value,
        context: CallContext,
        authority: Option<crate::product_permission::Authority>,
    ) -> Result<Value, crate::tools::ToolError> {
        self.settle(
            session,
            "product_tool",
            json!({
                "session_id": session,
                "name": name,
                "input": input,
                "message_seq": context.message_seq,
                "call_id": context.call_id,
            }),
            "product bridge",
            "product tool",
            authority,
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
        self.settle(
            session,
            "hook_tool",
            params,
            "hook bridge",
            "tool hook",
            None,
        )
        .await
    }

    async fn settle(
        &self,
        session: &str,
        method: &str,
        params: Value,
        closed: &str,
        failed: &str,
        permission: Option<crate::product_permission::Authority>,
    ) -> Result<Value, crate::tools::ToolError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (reply, reply_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id,
            Pending {
                session: session.to_owned(),
                method: method.to_owned(),
                reply,
                permission,
            },
        );
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

    pub(crate) fn permission_authority(
        &self,
        source: &crate::product_permission::Source,
    ) -> Option<crate::product_permission::Authority> {
        self.with_permission_authority(source, |authority| Ok(authority.clone()))
            .ok()
    }

    /// Serialize a durable authorization commit with reply-slot removal. The
    /// callback is synchronous and must never await another bridge operation.
    pub(crate) fn with_permission_authority<T>(
        &self,
        source: &crate::product_permission::Source,
        execute: impl FnOnce(&crate::product_permission::Authority) -> Result<T, crate::protocol::Error>,
    ) -> Result<T, crate::protocol::Error> {
        let pending = self.pending.lock().unwrap();
        let authority = permission_authority(&pending, source)?;
        execute(authority)
    }

    /// Keep every candidate source slot stable while one standing-policy reply
    /// reevaluates its peers. Borrow authorities instead of cloning all rules.
    pub(crate) fn with_permission_sources<T>(
        &self,
        source: &crate::product_permission::Source,
        execute: impl FnOnce(
            &[(
                crate::product_permission::Source,
                &crate::product_permission::Authority,
            )],
        ) -> Result<T, crate::protocol::Error>,
    ) -> Result<T, crate::protocol::Error> {
        let pending = self.pending.lock().unwrap();
        permission_authority(&pending, source)?;
        let sources = pending
            .iter()
            .filter_map(|(id, pending)| {
                if pending.method != "product_tool" {
                    return None;
                }
                let authority = pending.permission.as_ref()?;
                if authority.cancel.is_cancelled() {
                    return None;
                }
                Some((
                    crate::product_permission::Source {
                        session_id: pending.session.clone(),
                        bridge_id: *id,
                        call_id: authority.context.call_id.clone(),
                        message_seq: authority.context.message_seq,
                    },
                    authority,
                ))
            })
            .collect::<Vec<_>>();
        execute(&sources)
    }

    pub(crate) fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.pending, &other.pending)
    }

    /// Cancel every pending reverse call for one Session. Notify the host with
    /// the matching method so its callback can release its own scoped work.
    pub async fn cancel_session(&self, session: &str) -> Vec<u64> {
        let calls: Vec<(u64, String)> = {
            let mut pending = self.pending.lock().unwrap();
            let mut calls = Vec::new();
            pending.retain(|id, call| {
                if call.session != session {
                    return true;
                }
                calls.push((*id, call.method.clone()));
                false
            });
            calls
        };
        for (id, method) in &calls {
            let notice = serde_json::json!({
                "bridge_id": id,
                "method": format!("{method}.cancel"),
                "params": {"session_id": session, "bridge_id": id},
            });
            if self.tx.send(notice).await.is_err() {
                break;
            }
        }
        calls.into_iter().map(|(id, _)| id).collect()
    }
}

/// Deliver a host reply to the pending call, if any. Unknown ids are dropped
/// (the host restarted its bookkeeping); never fabricate a result.
pub(crate) fn deliver(
    pending: &Mutex<HashMap<u64, Pending>>,
    bridge_id: u64,
    value: Value,
) -> bool {
    pending
        .lock()
        .unwrap()
        .remove(&bridge_id)
        .is_some_and(|call| call.reply.send(value).is_ok())
}

fn permission_authority<'a>(
    pending: &'a HashMap<u64, Pending>,
    source: &crate::product_permission::Source,
) -> Result<&'a crate::product_permission::Authority, crate::protocol::Error> {
    pending
        .get(&source.bridge_id)
        .filter(|pending| pending.session == source.session_id && pending.method == "product_tool")
        .and_then(|pending| pending.permission.as_ref())
        .filter(|authority| {
            authority.context.call_id == source.call_id
                && authority.context.message_seq == source.message_seq
                && !authority.cancel.is_cancelled()
        })
        .ok_or_else(|| crate::protocol::Error::Invalid("inactive product permission source".into()))
}
