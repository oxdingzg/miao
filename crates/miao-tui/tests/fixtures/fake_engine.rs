//! A scripted stand-in for `miao-engine serve`, driven by `tests/transport.rs`.
//!
//! It speaks the same newline-delimited JSON envelope as the real engine, so
//! the transport can be exercised without a database, a provider, or a model.
//! Each session holds five durable events (seq 1..=5) unless `--fixture <path>`
//! supplies a recorded transcript; `ping` appends one live event, which is how
//! a test tells replay from the live stream.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let durable = durable_events();
    let mut session_id = "s".to_string();
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
                json!({"method":"progress","params":{"session_id":session_id,"refusal":frame}}),
            );
            continue;
        };
        let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "subscribe" => {
                let after = frame["params"]["after"].as_u64().unwrap_or(0);
                session_id = frame["params"]["session_id"]
                    .as_str()
                    .unwrap_or("s")
                    .to_string();
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
                // The cursor the transport asked for, so a reconnect can be
                // checked without inspecting the child's arguments.
                send(
                    &mut out,
                    json!({"method":"progress","params":{"session_id":session_id,"after":after}}),
                );
                for event in durable.iter().filter(|event| seq(event) > after) {
                    send(&mut out, json!({"method":"event","params":event}));
                }
                subscribed = true;
                next = durable.iter().map(seq).max().unwrap_or(0).max(after) + 1;
            }
            "ping" => {
                send(&mut out, json!({"id":id,"result":{"ok":true}}));
                if subscribed {
                    let live = event(&session_id, next, "live");
                    send(&mut out, json!({"method":"event","params":live}));
                    next += 1;
                }
            }
            "product_tool" => {
                send(&mut out, json!({"id":id,"result":{"ok":true}}));
                send(
                    &mut out,
                    json!({"method":"product_tool","bridge_id":7,"params":{"session_id":session_id,"name":"write_file","input":{}}}),
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

/// The session's committed events: a recorded transcript when the test passes
/// `--fixture <path>`, otherwise five synthetic ones.
fn durable_events() -> Vec<Value> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--fixture") {
        return (1..=5).map(|seq| event("s", seq, "replay")).collect();
    }
    let path = args.next().expect("--fixture <path>");
    let json = std::fs::read_to_string(&path).expect("fixture file");
    serde_json::from_str(&json).expect("fixture json")
}

fn event(session_id: &str, seq: u64, kind: &str) -> Value {
    json!({"session_id":session_id,"seq":seq,"kind":kind,"data":{},"recorded_at_ms":null})
}

fn seq(event: &Value) -> u64 {
    event["seq"].as_u64().unwrap_or(0)
}

fn send(out: &mut std::io::Stdout, frame: Value) {
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}
