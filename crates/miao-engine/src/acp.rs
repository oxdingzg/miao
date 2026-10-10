//! ACP (Agent Client Protocol) transport over newline-delimited JSON-RPC 2.0.
//!
//! An editor speaks ACP to the agent over stdio. This slice covers the core
//! lifecycle — `initialize`, `authenticate`, `session/new`, `session/prompt`
//! (a text turn streamed as `agent_message_chunk`) and the `session/cancel`
//! notification. Tool calls, permission requests, plan/config updates and
//! `session/load|fork|list|close` are later slices (ADR-07); the adapter reuses
//! the same domain model over [`Runtime`] and never widens its own authority.

use crate::{
    protocol::{Delivery, Input, Message},
    runtime::Runtime,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
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

    let conn = Arc::new(Conn { runtime, out });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(message) = serde_json::from_slice::<Value>(line.as_bytes()) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let conn = conn.clone();
        match (id, method) {
            (Some(id), Some(method)) => {
                tokio::spawn(async move { request(&conn, id, &method, params).await });
            }
            (None, Some(method)) => {
                tokio::spawn(async move { notification(&conn, &method, params).await });
            }
            // Responses to agent-initiated requests arrive here once a later
            // slice adds them (permissions); none are sent yet.
            _ => {}
        }
    }
    Ok(())
}

struct Conn {
    runtime: Runtime,
    out: mpsc::Sender<Value>,
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
                if event.kind == "run.finished" {
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
