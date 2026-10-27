//! A scripted stand-in for `miao-engine serve`, driven by `tests/transport.rs`.
//!
//! It speaks the same newline-delimited JSON envelope as the real engine, so
//! the transport can be exercised without a database, a provider, or a model.
//! Every session holds five durable events (seq 1..=5); `ping` appends one live
//! event, which is how a test tells replay from the live stream.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut subscribed = false;
    let mut next = 1;

    for line in stdin.lock().lines() {
        let Ok(line) = line else { return };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = frame.get("id").and_then(Value::as_u64) else {
            // The transport's refusal of a reverse tool call. Report it back on
            // the ephemeral channel so the test can observe what was sent.
            send(
                &mut out,
                json!({"method":"progress","params":{"session_id":"s","refusal":frame}}),
            );
            continue;
        };
        let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "subscribe" => {
                let after = frame["params"]["after"].as_u64().unwrap_or(0);
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
                // The cursor the transport asked for, so a reconnect can be
                // checked without inspecting the child's arguments.
                send(
                    &mut out,
                    json!({"method":"progress","params":{"session_id":"s","after":after}}),
                );
                for seq in after + 1..=5 {
                    send(&mut out, event(seq, "replay"));
                }
                subscribed = true;
                next = 5.max(after) + 1;
            }
            "ping" => {
                send(&mut out, json!({"id":id,"result":{"ok":true}}));
                if subscribed {
                    send(&mut out, event(next, "live"));
                    next += 1;
                }
            }
            "product_tool" => {
                send(&mut out, json!({"id":id,"result":{"ok":true}}));
                send(
                    &mut out,
                    json!({"method":"product_tool","bridge_id":7,"params":{"session_id":"s","name":"write_file","input":{}}}),
                );
            }
            // Silent methods: only the request timeout can settle these.
            "snapshot" | "hang" => {}
            "exit" => return,
            "shutdown" => {
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
                return;
            }
            _ => send(
                &mut out,
                json!({"id":id,"error":{"code":"invalid_request","message":format!("unknown method {method}")}}),
            ),
        }
    }
}

fn event(seq: u64, kind: &str) -> Value {
    json!({"method":"event","params":{"session_id":"s","seq":seq,"kind":kind,"data":{},"recorded_at_ms":null}})
}

fn send(out: &mut std::io::Stdout, frame: Value) {
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}
