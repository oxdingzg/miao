//! A scripted stand-in for `miao-engine serve`, driven by `tests/transport.rs`.
//!
//! It speaks the same newline-delimited JSON envelope as the real engine, so
//! the transport can be exercised without a database, a provider, or a model.
//! Each session holds five durable events (seq 1..=5) unless `--fixture <path>`
//! supplies a recorded transcript; `ping` appends one live event, which is how
//! a test tells replay from the live stream.

use std::io::{BufRead, Write};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use serde_json::{json, Value};

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let durable = durable_events();
    let mut session_id = "s".to_string();
    let mut subscribed = false;
    let mut next = 1;
    // `MIAO_TUI_FAKE_SESSIONS` turns this into a catalog view for the pty
    // smoke test. Without it `snapshot` stays silent, which is the transport
    // suite's request-timeout case.
    let sessions = std::env::var_os("MIAO_TUI_FAKE_SESSIONS").is_some();
    // The approval scenario keeps one request outstanding until the client
    // resolves it, so the panel has something to show on the first snapshot.
    let mut approval_pending = std::env::var_os("MIAO_TUI_FAKE_APPROVAL").is_some();
    let streaming = std::env::var_os("MIAO_TUI_FAKE_STREAM").is_some();
    let stream_updates = Arc::new(AtomicU64::new(0));
    let mut stream_started = false;
    let mut permission_saved = true;

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
            "permission_pattern_list" => {
                let rules = if permission_saved {
                    json!([{
                        "id": format!("prule_{}", "a".repeat(64)),
                        "workspace": std::env::current_dir().unwrap().canonicalize().unwrap().to_string_lossy(),
                        "source": "native", "created_at_ms": 0,
                        "rule": { "action": "read", "resource": "public/**", "effect": "allow" }
                    }])
                } else {
                    json!([])
                };
                unit_command(&mut out, id, &frame, rules);
            }
            "permission_pattern_remove" => {
                log_action(&frame["params"], method);
                permission_saved = false;
                send(&mut out, json!({"id":id,"result":{"removed":true}}));
            }

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
                if streaming && !stream_started {
                    stream_started = true;
                    let updates = stream_updates.clone();
                    let session = session_id.clone();
                    std::thread::spawn(move || {
                        let mut out = std::io::stdout();
                        // Sustained activity deliberately has no debounce-sized
                        // quiet gap; tests synchronize on projected snapshots.
                        for tick in 1..=1000 {
                            updates.store(tick, Ordering::SeqCst);
                            send(
                                &mut out,
                                json!({"method":"event","params":{
                                    "session_id":session,"seq":5+tick,
                                    "kind":"message.committed","data":{}
                                }}),
                            );
                            std::thread::sleep(Duration::from_millis(10));
                        }
                    });
                }
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
            "snapshot" if sessions => {
                let target = frame["params"]["session_id"].as_str().unwrap_or("ses_a");
                let metadata_only = frame["params"]["metadata_only"].as_bool().unwrap_or(false);
                let (title, updated) = if target == "ses_a" {
                    ("Project A", 2_000)
                } else {
                    ("Project B", 1_000)
                };
                let mut snapshot = json!({
                    "session_id": target,
                    "title": title,
                    "cursor": 2,
                    "updated_at_ms": updated,
                    "archived_at_ms": null,
                    "parent_session_id": null,
                    "location": "/tmp",
                    "model_selection": {"protocol": "chat", "model": "fake/glm"},
                    "account_selection": {"credential_id": "cred_a"},
                });
                if !metadata_only {
                    // ses_b is the renderer fixture: markdown structure plus a
                    // completed tool call, so the smoke test can assert what a
                    // person sees rather than the transport bytes.
                    snapshot["messages"] = if target == "ses_b" {
                        json!([
                            {"seq":1,"role":"user","content":"show the renderer","checkpoint":null,"recorded_at_ms":null},
                            {"seq":2,"role":"assistant","content":[
                                {"type":"text","text":"## Fixture Notes\n\n- **bold** and `code`\n\n| name | value |\n| --- | --- |\n| a | 1 |"},
                                {"type":"tool_use","id":"call_1","name":"read_file","input":{"path":"src/lib.rs"}}
                            ],"identity":{"agent":"build","provider":{"model":"fake/model"}},"checkpoint":null,"recorded_at_ms":null},
                            {"seq":3,"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"{\"text\":\"one\\ntwo\",\"sha256\":\"0\"}","is_error":false}],"checkpoint":null,"recorded_at_ms":null}
                        ])
                    } else {
                        json!([
                            {"seq":1,"role":"user","content":"hello from the fixture","checkpoint":null,"recorded_at_ms":null},
                            {"seq":2,"role":"assistant","content":[{"type":"text","text":"fixture answer"}],"identity":{"agent":"build","provider":{"model":"fake/model"}},"checkpoint":null,"recorded_at_ms":null}
                        ])
                    };
                }
                snapshot["pending"] = json!([]);
                snapshot["active_run"] = json!(null);
                snapshot["approvals"] = json!([]);
                snapshot["questions"] = json!([]);
                if approval_pending {
                    snapshot["active_run"] = json!("run-1");
                    snapshot["approvals"] = json!([{
                        "request_id": "run-1/call_1",
                        "session_id": target,
                        "run_id": "run-1",
                        "call_id": "call_1",
                        "location": "/tmp",
                        "tool": "bash",
                        "resource": "ls -la",
                        "input": {"command": "ls -la"},
                        "input_hash": "a".repeat(64),
                        "policy_revision": "rev-1",
                        "matcher": {"kind": "builtin"},
                        "expires_at_ms": 0
                    }]);
                }

                if streaming {
                    let tick = stream_updates.load(Ordering::SeqCst);
                    snapshot["cursor"] = json!(5 + tick);
                    if !metadata_only {
                        snapshot["messages"][1]["content"][0]["text"] =
                            json!(format!("stream tick {tick}"));
                    }
                    if tick > 0 && tick < 1000 {
                        snapshot["active_run"] = json!("run-stream");
                    }
                }
                send(&mut out, json!({"id":id,"result":snapshot}));
            }
            "events" if sessions => send(&mut out, json!({"id":id,"result":[]})),
            "unsubscribe" if sessions => {
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "sessions" if sessions => unit_command(&mut out, id, &frame, json!(["ses_a", "ses_b"])),
            // Accepted writes are logged verbatim so the smoke test can assert
            // exactly what the composer sent.
            "initialize" if sessions => {
                send(
                    &mut out,
                    json!({"id":id,"result":{"session_id":frame["params"]["session_id"]}}),
                );
            }
            "approve" if sessions => {
                log_action(&frame["params"], "approve");
                approval_pending = false;
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "cancel" if sessions => {
                log_action(&frame["params"], "cancel");
                approval_pending = false;
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "admit" if sessions => {
                log_action(&frame["params"], "admit");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            // Two catalog entries with two credentials, so both the model
            // dialog and the account dialog have something to pick from.
            "model_catalog" if sessions => unit_command(
                &mut out,
                id,
                &frame,
                json!([
                    {"route_id":"r1","protocol":"chat","model":"fake/glm","credential_id":"cred_a"},
                    {"protocol":"responses","model":"fake/gpt","variants":["low","high"],"credential_id":"cred_b"}
                ]),
            ),
            "usage" if sessions => send(
                &mut out,
                json!({"id":id,"result":{
                    "providerUsage": {},
                    "providerDetail": {},
                    "auxiliary": {},
                    "turns": 3,
                    "partialTurns": 1,
                    "tokens": {"input": 1200, "output": 300, "cacheRead": 900, "cacheWrite": 0, "nonCached": 300},
                    "cacheDiagnostics": {},
                    "ttftMs": {"count": 3, "avg": 812, "min": 400, "max": 1200},
                    "lineage": [{"protocol": "chat", "model": "fake/glm", "turns": 3}],
                    "tools": {"calls": 5, "failures": 1},
                    "turnsDetail": []
                }}),
            ),
            "select_account" if sessions => {
                log_action(&frame["params"], "select_account");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "select_model" if sessions => {
                log_action(&frame["params"], "select_model");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "rename" if sessions => {
                log_action(&frame["params"], "rename");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "archive" if sessions => {
                log_action(&frame["params"], "archive");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
            "remove" if sessions => {
                log_action(&frame["params"], "remove");
                send(&mut out, json!({"id":id,"result":{"accepted":true}}));
            }
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

/// Append one accepted write to `MIAO_TUI_FAKE_ADMIT_LOG` so the smoke test
/// can assert exactly what the TUI sent.
fn log_action(params: &Value, method: &str) {
    let Some(path) = std::env::var_os("MIAO_TUI_FAKE_ADMIT_LOG") else {
        return;
    };
    if let Ok(line) = serde_json::to_string(&json!({"method": method, "params": params})) {
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| writeln!(file, "{line}"));
    }
}

/// A command the engine declares as a unit variant. Its envelope is adjacently
/// tagged, so the `params` key must be absent: a client that sends `params: {}`
/// gets the same `invalid_request` the engine answers instead of a result.
fn unit_command(out: &mut std::io::Stdout, id: u64, frame: &Value, result: Value) {
    if frame.get("params").is_some() {
        send(
            out,
            json!({"id":id,"error":{"code":"invalid_request","message":"expected an id and a typed method/params request"}}),
        );
        return;
    }
    send(out, json!({"id":id,"result":result}));
}

fn send(out: &mut std::io::Stdout, frame: Value) {
    let mut out = out.lock();
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}
