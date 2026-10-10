//! ACP (Agent Client Protocol) transport over newline-delimited JSON-RPC 2.0.
//!
//! An editor speaks ACP to the agent over stdio. This slice covers the core
//! lifecycle — `initialize`, `authenticate`, `session/new`, `session/prompt`
//! (a text turn streamed as `agent_message_chunk`) — the `session/cancel`
//! notification, and the `session/request_permission` round-trip that maps an
//! engine approval to a client permission decision. Tool-call notifications,
//! plan/config updates and `session/load|fork|list|close` are later slices
//! (ADR-07); the adapter reuses the same domain model over [`Runtime`] and never
//! widens its own authority.

use crate::{
    approval::{Approval, Response},
    permission::Decision,
    protocol::{Delivery, Input, Message},
    runtime::{Controller, Runtime},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, Mutex},
};

const AUTH_METHOD: &str = "miao-login";
const JSONRPC: &str = "2.0";
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// Serve one ACP connection on stdio until the client closes its input.
pub async fn serve(runtime: Runtime) -> std::io::Result<()> {
    let (out, mut outgoing) = mpsc::channel::<Value>(256);
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = outgoing.recv().await {
            let Ok(mut line) = serde_json::to_vec(&value) else {
                continue;
            };
            line.push(b'\n');
            if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let conn = Arc::new(Conn {
        controller: runtime.controller(),
        runtime,
        out,
        next: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(message) = serde_json::from_slice::<Value>(line.as_bytes()) else {
            continue;
        };
        let id = message.get("id").cloned();
        let Some(method) = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            // A response to an agent-initiated request (a permission decision).
            if let Some(id) = id.as_ref().and_then(Value::as_i64) {
                if let Some(sender) = conn.pending.lock().await.remove(&id) {
                    let _ = sender.send(message);
                }
            }
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let conn = conn.clone();
        match id {
            Some(id) => tokio::spawn(async move { request(&conn, id, &method, params).await }),
            None => tokio::spawn(async move { notification(&conn, &method, params).await }),
        };
    }
    Ok(())
}

struct Conn {
    runtime: Runtime,
    controller: Controller,
    out: mpsc::Sender<Value>,
    next: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
}

impl Conn {
    async fn reply(&self, id: Value, result: Value) {
        let _ = self
            .out
            .send(json!({ "jsonrpc": JSONRPC, "id": id, "result": result }))
            .await;
    }

    async fn fail(&self, id: Value, code: i64, message: &str) {
        let _ = self
            .out
            .send(json!({ "jsonrpc": JSONRPC, "id": id, "error": { "code": code, "message": message } }))
            .await;
    }

    async fn notify(&self, method: &str, params: Value) {
        let _ = self
            .out
            .send(json!({ "jsonrpc": JSONRPC, "method": method, "params": params }))
            .await;
    }

    /// Send an agent-initiated request (for example `session/request_permission`)
    /// and await the client's response. `None` means the client never answered.
    async fn call(&self, method: &str, params: Value) -> Option<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let sent = self
            .out
            .send(json!({ "jsonrpc": JSONRPC, "id": id, "method": method, "params": params }))
            .await;
        if sent.is_err() {
            self.pending.lock().await.remove(&id);
            return None;
        }
        match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(value)) => Some(value),
            _ => {
                self.pending.lock().await.remove(&id);
                None
            }
        }
    }
}

async fn request(conn: &Arc<Conn>, id: Value, method: &str, params: Value) {
    match method {
        "initialize" => {
            conn.reply(
                id,
                json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {},
                    "authMethods": [{ "id": AUTH_METHOD, "name": "Login with miao" }],
                    "agentInfo": { "name": "miao-engine", "version": env!("MIAO_ENGINE_VERSION") },
                }),
            )
            .await;
        }
        "authenticate" => conn.reply(id, json!({})).await,
        "session/new" => {
            let session = format!("ses_{}", uuid::Uuid::new_v4().simple());
            conn.reply(id, json!({ "sessionId": session })).await;
        }
        "session/prompt" => prompt(conn, id, params).await,
        other => {
            conn.fail(id, METHOD_NOT_FOUND, &format!("method not found: {other}"))
                .await
        }
    }
}

async fn notification(conn: &Arc<Conn>, method: &str, params: Value) {
    if method == "session/cancel" {
        if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
            let _ = conn.runtime.cancel(session).await;
        }
    }
}

/// Admit the prompt, then stream the committed assistant text as
/// `agent_message_chunk` notifications until the run finishes. The Text and
/// ResourceLink content blocks are the ACP baseline; only text is mapped here.
async fn prompt(conn: &Arc<Conn>, id: Value, params: Value) {
    let Some(session) = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        conn.fail(id, INVALID_PARAMS, "sessionId is required").await;
        return;
    };
    let input = Input {
        session_id: session.clone(),
        input_id: format!("acp_{}", uuid::Uuid::new_v4().simple()),
        prompt: prompt_text(params.get("prompt")),
        delivery: Delivery::Steer,
    };
    if let Err(error) = conn.runtime.admit_with(input, Vec::new(), true).await {
        conn.fail(id, INTERNAL_ERROR, &error.to_string()).await;
        return;
    }

    let mut cursor = 0u64;
    let mut emitted = 0usize;
    let mut finished = false;
    loop {
        emit_new_text(conn, &session, &mut emitted).await;
        if finished {
            break;
        }
        if let Ok(events) = conn.runtime.store().events(&session, cursor, 64).await {
            for event in events {
                cursor = event.seq;
                if event.kind == "approval.requested" {
                    if let Ok(approval) = serde_json::from_value::<Approval>(event.data.clone()) {
                        decide(conn, &approval).await;
                    }
                } else if event.kind == "run.finished" {
                    finished = true;
                }
            }
        }
        if !finished {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    conn.reply(id, json!({ "stopReason": "end_turn" })).await;
}

/// Ask the client for a permission decision and resolve the engine approval to
/// match. A client that never answers, or cancels, is a deny.
async fn decide(conn: &Arc<Conn>, approval: &Approval) {
    let decision = request_permission(conn, approval).await;
    let response = Response {
        request_id: approval.request_id.clone(),
        input_hash: approval.input_hash.clone(),
        policy_revision: approval.policy_revision.clone(),
        decision,
        matcher: Some(approval.matcher.clone()),
    };
    let _ = conn
        .runtime
        .approve(&conn.controller, &approval.session_id, response)
        .await;
}

async fn request_permission(conn: &Arc<Conn>, approval: &Approval) -> Decision {
    let response = conn
        .call(
            "session/request_permission",
            json!({
                "sessionId": approval.session_id,
                "toolCall": {
                    "toolCallId": approval.call_id,
                    "title": format!("{} {}", approval.tool, approval.resource),
                    "kind": "other",
                    "rawInput": approval.input,
                },
                "options": [
                    { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" },
                ],
            }),
        )
        .await;
    match response
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(|result| result.get("outcome"))
        .and_then(|outcome| outcome.get("optionId"))
        .and_then(Value::as_str)
    {
        Some("allow_once") => Decision::Allow,
        _ => Decision::Deny,
    }
}

/// Emit each assistant message's text once, in order, as it is committed.
async fn emit_new_text(conn: &Arc<Conn>, session: &str, emitted: &mut usize) {
    let Ok(history) = conn.runtime.store().selected_history(session).await else {
        return;
    };
    let texts = assistant_texts(&history);
    for text in texts.iter().skip(*emitted) {
        conn.notify(
            "session/update",
            json!({
                "sessionId": session,
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } },
            }),
        )
        .await;
    }
    *emitted = texts.len();
}

fn prompt_text(prompt: Option<&Value>) -> String {
    prompt
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn assistant_texts(history: &[Message]) -> Vec<String> {
    history
        .iter()
        .filter(|message| message.role == "assistant")
        .map(|message| {
            message
                .content
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block["type"] == "text")
                        .filter_map(|block| block["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default()
        })
        .filter(|text| !text.is_empty())
        .collect()
}
