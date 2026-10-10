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
    protocol::{CollaborationMode, Delivery, Input, Message},
    runtime::{Controller, Runtime},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
                    "agentCapabilities": { "loadSession": true },
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
        "session/load" => load(conn, id, params).await,
        "session/resume" => conn.reply(id, json!({})).await,
        "session/fork" => fork(conn, id, params).await,
        "session/close" => conn.reply(id, json!({})).await,
        "session/set_mode" => mode(conn, id, params).await,
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

/// Admit the prompt, then stream committed assistant text (`agent_message_chunk`)
/// and tool calls (`tool_call` plus `tool_call_update`) until the run finishes.
async fn prompt(conn: &Arc<Conn>, id: Value, params: Value) {
    let Some(session) = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        conn.fail(id, INVALID_PARAMS, "sessionId is required").await;
        return;
    };
    // Baseline the turn so a later prompt never replays an earlier one: text is
    // indexed by assistant message, events by the committed cursor.
    let mut seen = 0usize;
    if let Ok(history) = conn.runtime.store().selected_history(&session).await {
        seen = history
            .iter()
            .filter(|message| message.role == "assistant")
            .count();
    }
    let mut cursor = conn
        .runtime
        .store()
        .snapshot(&session)
        .await
        .ok()
        .and_then(|snapshot| snapshot["cursor"].as_u64())
        .unwrap_or(0);
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

    let mut calls = HashSet::new();
    let mut planned: HashMap<String, String> = HashMap::new();
    let mut finished = false;
    loop {
        emit_history(conn, &session, &mut seen, &mut calls).await;
        if finished {
            break;
        }
        if let Ok(events) = conn.runtime.store().events(&session, cursor, 64).await {
            for event in events {
                cursor = event.seq;
                match event.kind.as_str() {
                    "approval.requested" => {
                        if let Ok(approval) = serde_json::from_value::<Approval>(event.data.clone())
                        {
                            decide(conn, &approval).await;
                        }
                    }
                    // `call_id` is the run-scoped engine key; `provider_id` is the
                    // id the model used, which is what history carries.
                    "tool.planned" | "tool.dispatched" => {
                        if let (Some(call), Some(provider)) = (
                            event.data.get("call_id").and_then(Value::as_str),
                            event.data.get("provider_id").and_then(Value::as_str),
                        ) {
                            planned.insert(call.to_string(), provider.to_string());
                            if event.kind == "tool.dispatched" && calls.contains(provider) {
                                tool_update(conn, &session, provider, "in_progress", None).await;
                            }
                        }
                    }
                    "tool.completed" => {
                        if let Some(call) = event.data.get("call_id").and_then(Value::as_str) {
                            let provider = planned.get(call).map(String::as_str).unwrap_or(call);
                            if calls.contains(provider) {
                                let failed = event
                                    .data
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                let status = if failed { "failed" } else { "completed" };
                                tool_update(
                                    conn,
                                    &session,
                                    provider,
                                    status,
                                    event.data.get("result"),
                                )
                                .await;
                            }
                        }
                    }
                    "session.state.updated"
                        if event.data.get("kind").and_then(Value::as_str) == Some("todos") =>
                    {
                        if let Some(todos) = event.data.get("value").and_then(Value::as_array) {
                            let entries: Vec<Value> = todos.iter().map(plan_entry).collect();
                            conn.notify(
                                "session/update",
                                json!({
                                    "sessionId": session,
                                    "update": { "sessionUpdate": "plan", "entries": entries },
                                }),
                            )
                            .await;
                        }
                    }
                    "run.finished" => finished = true,
                    _ => {}
                }
            }
        }
        if !finished {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    conn.reply(id, json!({ "stopReason": "end_turn" })).await;
}

/// Replay a Session's committed conversation as `session/update` chunks, then
/// acknowledge the load.
async fn load(conn: &Arc<Conn>, id: Value, params: Value) {
    let Some(session) = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        conn.fail(id, INVALID_PARAMS, "sessionId is required").await;
        return;
    };
    replay(conn, &session).await;
    conn.reply(id, json!({})).await;
}

async fn replay(conn: &Arc<Conn>, session: &str) {
    let Ok(history) = conn.runtime.store().selected_history(session).await else {
        return;
    };
    for message in &history {
        let update = if message.role == "user" {
            "user_message_chunk"
        } else {
            "agent_message_chunk"
        };
        for block in message.content.as_array().into_iter().flatten() {
            let Some(text) = block["text"].as_str() else {
                continue;
            };
            if block["type"] != "text" {
                continue;
            }
            conn.notify(
                "session/update",
                json!({
                    "sessionId": session,
                    "update": { "sessionUpdate": update, "content": { "type": "text", "text": text } },
                }),
            )
            .await;
        }
    }
}

/// Fork the Session into a fresh id and return it.
async fn fork(conn: &Arc<Conn>, id: Value, params: Value) {
    let Some(session) = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        conn.fail(id, INVALID_PARAMS, "sessionId is required").await;
        return;
    };
    let target = format!("ses_{}", uuid::Uuid::new_v4().simple());
    match conn.runtime.fork(&session, &target, None).await {
        Ok(_) => conn.reply(id, json!({ "sessionId": target })).await,
        Err(error) => conn.fail(id, INTERNAL_ERROR, &error.to_string()).await,
    }
}

/// Switch the Session's collaboration mode and confirm it back to the client.
async fn mode(conn: &Arc<Conn>, id: Value, params: Value) {
    let Some(session) = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        conn.fail(id, INVALID_PARAMS, "sessionId is required").await;
        return;
    };
    let mode_id = params
        .get("modeId")
        .and_then(Value::as_str)
        .unwrap_or("build");
    let collaboration = if mode_id == "plan" {
        CollaborationMode::Plan
    } else {
        CollaborationMode::Build
    };
    match conn.runtime.set_mode(&session, collaboration).await {
        Ok(()) => {
            conn.notify(
                "session/update",
                json!({
                    "sessionId": session,
                    "update": { "sessionUpdate": "current_mode_update", "currentModeId": mode_id },
                }),
            )
            .await;
            conn.reply(id, json!({})).await;
        }
        Err(error) => conn.fail(id, INTERNAL_ERROR, &error.to_string()).await,
    }
}

/// Map one engine todo onto an ACP plan entry.
fn plan_entry(todo: &Value) -> Value {
    let status = match todo["status"].as_str() {
        Some("pending") => "pending",
        Some("in_progress") => "in_progress",
        _ => "completed",
    };
    let priority = match todo["priority"].as_str() {
        Some("high") => "high",
        Some("low") => "low",
        _ => "medium",
    };
    json!({
        "content": todo["content"].as_str().unwrap_or(""),
        "status": status,
        "priority": priority,
    })
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

/// Emit each new assistant message's text blocks (`agent_message_chunk`) and
/// `tool_use` blocks (`tool_call`) once, in order, as they are committed.
async fn emit_history(
    conn: &Arc<Conn>,
    session: &str,
    seen: &mut usize,
    calls: &mut HashSet<String>,
) {
    let Ok(history) = conn.runtime.store().selected_history(session).await else {
        return;
    };
    let root = conn
        .runtime
        .store()
        .location(session)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let assistants: Vec<&Message> = history
        .iter()
        .filter(|message| message.role == "assistant")
        .collect();
    for message in assistants.iter().skip(*seen) {
        for block in message.content.as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(text) = block["text"].as_str() {
                        conn.notify(
                            "session/update",
                            json!({
                                "sessionId": session,
                                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } },
                            }),
                        )
                        .await;
                    }
                }
                Some("tool_use") => {
                    let Some(call) = block["id"].as_str() else {
                        continue;
                    };
                    if !calls.insert(call.to_string()) {
                        continue;
                    }
                    let name = block["name"].as_str().unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    conn.notify(
                        "session/update",
                        json!({
                            "sessionId": session,
                            "update": {
                                "sessionUpdate": "tool_call",
                                "toolCallId": call,
                                "title": tool_title(name, &input),
                                "kind": tool_kind(name),
                                "status": "pending",
                                "rawInput": input,
                                "locations": tool_locations(name, &input, &root),
                            },
                        }),
                    )
                    .await;
                }
                _ => {}
            }
        }
    }
    *seen = assistants.len();
}

async fn tool_update(
    conn: &Arc<Conn>,
    session: &str,
    call: &str,
    status: &str,
    output: Option<&Value>,
) {
    conn.notify(
        "session/update",
        json!({
            "sessionId": session,
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": call, "status": status, "rawOutput": output },
        }),
    )
    .await;
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "bash" | "run_command" => "execute",
        "write_file" | "edit_file" | "apply_patch" => "edit",
        "grep" | "glob" | "list_files" => "search",
        "read_file" => "read",
        "task" => "think",
        _ => "other",
    }
}

fn tool_title(name: &str, input: &Value) -> String {
    let text = match name {
        "bash" | "run_command" => input["command"].as_str(),
        "read_file" | "write_file" | "edit_file" => input["path"].as_str(),
        "grep" | "glob" => input["pattern"].as_str().or(input["path"].as_str()),
        _ => None,
    };
    text.unwrap_or(name).to_string()
}

fn tool_locations(name: &str, input: &Value, root: &str) -> Value {
    let path = match name {
        "read_file" | "write_file" | "edit_file" | "grep" | "glob" => input["path"].as_str(),
        _ => None,
    };
    match path {
        Some(path) if !root.is_empty() => json!([{ "path": format!("{root}/{path}") }]),
        _ => json!([]),
    }
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
