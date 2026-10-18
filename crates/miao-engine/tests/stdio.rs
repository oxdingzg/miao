use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn stdio_ack_export_and_exact_retry_use_committed_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let admission =
        json!({"input":{"session_id":"s","input_id":"one","prompt":"hello"},"resume":false});
    let requests = [
        json!({"id":1,"method":"admit","params":admission}),
        json!({"id":2,"method":"admit","params":admission}),
        json!({"id":3,"method":"events","params":{"session_id":"s","after":0}}),
        json!({"id":4,"method":"cancel","params":{"session_id":"s"}}),
        json!({"id":5,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let result = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap()["result"].clone();
    assert_eq!(result(1)["duplicate"], false, "{replies:?}");
    assert_eq!(result(2)["duplicate"], true);
    assert_eq!(result(3).as_array().unwrap().len(), 1);
    assert_eq!(result(3)[0]["kind"], "input.admitted");
    assert_eq!(result(4)["accepted"], false);
}

#[test]
fn pending_input_cancel_is_a_wire_command_with_a_durable_audit_trail() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"drop","prompt":"drop","delivery":"queue"},"resume":false}}),
        json!({"id":2,"method":"admit","params":{"input":{"session_id":"s","input_id":"keep","prompt":"keep","delivery":"steer"},"resume":false}}),
        json!({"id":3,"method":"cancel_input","params":{"session_id":"s","input_id":"drop"}}),
        json!({"id":4,"method":"cancel_input","params":{"session_id":"s","input_id":"drop"}}),
        json!({"id":5,"method":"cancel_input","params":{"session_id":"s","input_id":"missing"}}),
        json!({"id":6,"method":"snapshot","params":{"session_id":"s"}}),
        json!({"id":7,"method":"events","params":{"session_id":"s","after":0}}),
        json!({"id":8,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let result = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap()["result"].clone();
    assert_eq!(result(3), json!({"accepted": true, "duplicate": false}));
    assert_eq!(result(4), json!({"accepted": true, "duplicate": true}));
    assert_eq!(result(5), json!({"accepted": false, "reason": "unknown"}));
    let pending = result(6)["pending"].clone();
    assert_eq!(pending.as_array().unwrap().len(), 1, "{pending}");
    assert_eq!(pending[0]["input_id"], "keep");
    assert!(result(6)["messages"].as_array().unwrap().is_empty());
    let events = result(7).clone();
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["input.admitted", "input.admitted", "input.cancelled"]
    );
    assert_eq!(events[2]["data"]["input_id"], "drop");
}

#[test]
fn archive_and_remove_are_wire_commands_with_a_durable_effect() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"hello"},"resume":false}}),
        json!({"id":2,"method":"archive","params":{"session_id":"s","archived":true}}),
        json!({"id":3,"method":"snapshot","params":{"session_id":"s"}}),
        json!({"id":4,"method":"archive","params":{"session_id":"s","archived":false}}),
        json!({"id":5,"method":"snapshot","params":{"session_id":"s"}}),
        json!({"id":6,"method":"archive","params":{"session_id":"missing","archived":true}}),
        json!({"id":7,"method":"remove","params":{"session_id":"s"}}),
        json!({"id":8,"method":"sessions"}),
        json!({"id":9,"method":"remove","params":{"session_id":"s"}}),
        json!({"id":10,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let reply = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap().clone();
    let result = |id: u64| reply(id)["result"].clone();
    assert_eq!(result(2), json!({"accepted": true, "archived": true}));
    assert!(result(3)["archived_at_ms"].is_number(), "{replies:?}");
    assert_eq!(result(4), json!({"accepted": true, "archived": false}));
    assert!(result(5)["archived_at_ms"].is_null());
    // Archiving never invents a Session, so the wire reports a refusal instead.
    assert!(reply(6)["error"].is_object(), "{replies:?}");
    assert_eq!(result(7), json!({"accepted": true}));
    assert_eq!(result(8), json!([]));
    assert_eq!(result(9), json!({"accepted": false, "reason": "unknown"}));
}

#[test]
fn compaction_requests_are_a_wire_command_with_a_durable_audit_trail() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"hello"},"resume":false}}),
        json!({"id":2,"method":"request_compact","params":{"session_id":"missing"}}),
        json!({"id":3,"method":"request_compact","params":{"session_id":"s"}}),
        json!({"id":4,"method":"request_compact","params":{"session_id":"s"}}),
        json!({"id":5,"method":"events","params":{"session_id":"s","after":0}}),
        json!({"id":6,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let reply = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap().clone();
    let result = |id: u64| reply(id)["result"].clone();
    // A Session nobody created cannot be compacted.
    assert!(reply(2)["error"].is_object(), "{replies:?}");
    assert_eq!(
        result(3),
        json!({"accepted": true, "duplicate": false, "pending": true})
    );
    // A retried request neither queues a second compaction nor loses the intent.
    assert_eq!(
        result(4),
        json!({"accepted": true, "duplicate": true, "pending": true})
    );
    let events = result(5);
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "compaction.requested")
            .count(),
        1,
        "{events}"
    );
}

#[test]
fn agent_selection_is_a_wire_command_that_reports_its_derived_hash() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            dir.path().join("engine.db").to_str().unwrap(),
            "--workspace",
            dir.path().to_str().unwrap(),
            "--model",
            "fixture",
        ])
        .env("ANTHROPIC_API_KEY", "fixture-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let agent = json!({"name":"reviewer","semantics":"product-agent-v1","instructions":"Review the diff.","tools":{"allow":["read_file"]}});
    let requests = [
        json!({"id":1,"method":"admit","params":{"input":{"session_id":"s","input_id":"one","prompt":"hello"},"resume":false}}),
        json!({"id":2,"method":"select_agent","params":{"session_id":"missing","agent":agent}}),
        json!({"id":3,"method":"select_agent","params":{"session_id":"s","agent":agent}}),
        json!({"id":4,"method":"select_agent","params":{"session_id":"s","agent":agent}}),
        json!({"id":5,"method":"select_agent","params":{"session_id":"s","agent":{"name":""}}}),
        json!({"id":6,"method":"snapshot","params":{"session_id":"s"}}),
        json!({"id":7,"method":"shutdown"}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let reply = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap().clone();
    let result = |id: u64| reply(id)["result"].clone();
    assert!(reply(2)["error"].is_object(), "{replies:?}");
    let applied = result(3);
    assert_eq!(applied["changed"], true);
    let hash = applied["agent_hash"].as_str().unwrap().to_owned();
    assert_eq!(hash.len(), 64);
    // The same manifest is the same selection.
    assert_eq!(result(4), json!({"agent_hash":hash,"changed":false}));
    assert!(reply(5)["error"].is_object(), "{replies:?}");
    let snapshot = result(6);
    assert_eq!(snapshot["agent"]["name"], "reviewer");
    assert_eq!(snapshot["agent"]["agent_hash"], hash.as_str());
    assert_eq!(snapshot["agent"]["semantics"], "product-agent-v1");
}

#[test]
fn version_uses_root_manifest_and_no_provider_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .arg("--version")
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("miao-engine {}", env!("MIAO_ENGINE_VERSION"))
    );
}
