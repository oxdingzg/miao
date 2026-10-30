//! T2 acceptance: the stdio transport against a scripted engine.
//!
//! The fake engine (`tests/fixtures/fake_engine.rs`) holds five durable events
//! per session and appends one live event per `ping`, so each test can tell
//! what was replayed from a cursor apart from what arrived afterwards.

use std::time::Duration;

use miao_tui::transport::{Connection, EngineSpawn, EventRx, TransportError, TransportEvent};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(10);

fn fake() -> EngineSpawn {
    EngineSpawn {
        program: env!("CARGO_BIN_EXE_miao-tui-fake-engine").into(),
        args: Vec::new(),
        env: Vec::new(),
    }
}

async fn next(events: &mut EventRx) -> TransportEvent {
    tokio::time::timeout(TIMEOUT, events.recv())
        .await
        .expect("transport event")
        .expect("transport closed")
}

async fn durable_seqs(events: &mut EventRx, count: usize) -> Vec<u64> {
    let mut seen = Vec::new();
    while seen.len() < count {
        if let TransportEvent::Event(event) = next(events).await {
            seen.push(event.seq);
        }
    }
    seen
}

#[tokio::test]
async fn a_subscription_replays_from_its_cursor_and_then_streams_live() {
    let (mut connection, mut events) = Connection::start(fake(), TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    client.subscribe("s", 2).await.expect("subscribe");
    client.request("ping", json!({})).await.expect("ping");
    assert_eq!(durable_seqs(&mut events, 4).await, vec![3, 4, 5, 6]);
    assert_eq!(client.cursors()["s"], 6);
}

#[tokio::test]
async fn a_config_notice_reaches_the_host_even_with_no_session_open() {
    let (mut connection, mut events) = Connection::start(fake(), TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    client.request("reload", json!({})).await.expect("reload");
    let report = match next(&mut events).await {
        TransportEvent::Config(report) => report,
        other => panic!("expected a config notice, got {other:?}"),
    };
    assert_eq!(report["changed"], json!(["policy", "context"]));
    assert_eq!(report["generation"], json!(2));
}

#[tokio::test]
async fn an_engine_error_settles_one_request_without_retiring_the_transport() {
    let (mut connection, _events) = Connection::start(fake(), TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    let error = client.request("nope", json!({})).await.unwrap_err();
    assert!(
        matches!(&error, TransportError::Rejected(failure) if failure.code == "invalid_request"),
        "unexpected error: {error:?}"
    );
    assert!(client.available());
    client
        .request("ping", json!({}))
        .await
        .expect("still served");
}

#[tokio::test]
async fn a_timed_out_catalog_read_keeps_the_transport_and_a_mutation_retires_it() {
    let (mut connection, mut events) =
        Connection::start(fake(), Duration::from_millis(500)).expect("start");
    let client = connection.connect().await.expect("connect");
    assert!(matches!(
        client.request("snapshot", json!({"session_id":"s"})).await,
        Err(TransportError::Timeout { .. })
    ));
    assert!(client.available());
    assert!(matches!(
        client.request("hang", json!({"session_id":"s"})).await,
        Err(TransportError::Timeout { .. })
    ));
    assert!(!client.available());
    assert!(matches!(
        next(&mut events).await,
        TransportEvent::Failure(failure) if failure.code == "engine_request_timeout"
    ));
}

#[tokio::test]
async fn a_respawned_connection_replays_every_subscription_from_its_last_cursor() {
    let (mut connection, mut events) = Connection::start(fake(), TIMEOUT).expect("start");
    {
        let client = connection.connect().await.expect("connect");
        client.subscribe("s", 0).await.expect("subscribe");
        assert_eq!(durable_seqs(&mut events, 5).await, vec![1, 2, 3, 4, 5]);
        // The fake exits without answering, so this call settles closed.
        assert!(client.request("exit", json!({})).await.is_err());
    }
    assert!(matches!(
        next(&mut events).await,
        TransportEvent::Failure(_)
    ));

    let client = connection.connect().await.expect("reconnect");
    let after = loop {
        if let TransportEvent::Progress(progress) = next(&mut events).await {
            if let Some(after) = progress.get("after").and_then(|value| value.as_u64()) {
                break after;
            }
        }
    };
    assert_eq!(
        after, 5,
        "the respawn replays from the last committed cursor"
    );
    client.request("ping", json!({})).await.expect("ping");
    assert_eq!(durable_seqs(&mut events, 1).await, vec![6]);
}

#[tokio::test]
async fn a_reverse_tool_call_is_refused_instead_of_left_pending() {
    let (mut connection, mut events) = Connection::start(fake(), TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    client.subscribe("s", 5).await.expect("subscribe");
    client
        .request("product_tool", json!({}))
        .await
        .expect("call");
    loop {
        if let TransportEvent::Progress(progress) = next(&mut events).await {
            let Some(refusal) = progress.get("refusal") else {
                continue;
            };
            assert_eq!(refusal["bridge_id"], 7);
            assert!(refusal["error"]
                .as_str()
                .expect("error text")
                .contains("not available"));
            return;
        }
    }
}

#[tokio::test]
async fn closing_shuts_the_engine_down_without_reporting_a_failure() {
    let (mut connection, mut events) = Connection::start(fake(), TIMEOUT).expect("start");
    connection.connect().await.expect("connect");
    connection.close().await;
    let quiet = tokio::time::timeout(Duration::from_millis(300), events.recv()).await;
    assert!(
        !matches!(quiet, Ok(Some(TransportEvent::Failure(_)))),
        "an explicit close is not a transport fault"
    );
}

/// The recorded transcript is the vocabulary contract shared with the TS host
/// client (`packages/miao/src/engine/bridge.ts`): every committed event the
/// bridge translates must reach the TUI bit-for-bit, in seq order, with the
/// cursor landing on the last one.
#[tokio::test]
async fn the_recorded_transcript_reaches_the_tui_unchanged() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/events.json");
    let expected: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
    let spawn = EngineSpawn {
        args: vec!["--fixture".into(), path.into()],
        ..fake()
    };
    let (mut connection, mut events) = Connection::start(spawn, TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    client.subscribe("ses_fixture", 0).await.expect("subscribe");
    let mut seen = Vec::new();
    while seen.len() < expected.len() {
        if let TransportEvent::Event(event) = next(&mut events).await {
            seen.push(event);
        }
    }
    for (event, want) in seen.iter().zip(&expected) {
        assert_eq!(event.session_id, want["session_id"].as_str().unwrap());
        assert_eq!(event.seq, want["seq"].as_u64().unwrap());
        assert_eq!(event.kind, want["kind"].as_str().unwrap());
        assert_eq!(event.data, want["data"]);
        assert_eq!(event.recorded_at_ms, want["recorded_at_ms"].as_u64());
    }
    assert_eq!(
        client.cursors()["ses_fixture"],
        expected.len() as u64,
        "the cursor lands on the last committed event"
    );
}

/// The engine's `Command` enum is adjacently tagged, so a unit command takes no
/// `params` key; the fake answers the engine's `invalid_request` when one is
/// present, which is what a TUI that sent `params: {}` used to collect.
#[tokio::test]
async fn a_unit_command_is_sent_without_a_params_key() {
    let spawn = EngineSpawn {
        env: vec![("MIAO_TUI_FAKE_SESSIONS".into(), "1".into())],
        ..fake()
    };
    let (mut connection, _events) = Connection::start(spawn, TIMEOUT).expect("start");
    let client = connection.connect().await.expect("connect");
    let sessions = client.command("sessions").await.expect("sessions");
    assert_eq!(sessions, json!(["ses_a", "ses_b"]));
    let catalog = client
        .command("model_catalog")
        .await
        .expect("model_catalog");
    assert_eq!(catalog.as_array().map(Vec::len), Some(2));
}

/// A startup refusal has to reach the user. The engine says why on stderr and
/// nowhere else, so the terminal failure quotes it instead of reporting a bare
/// stream closure.
#[cfg(unix)]
#[tokio::test]
async fn a_startup_refusal_reports_the_engines_own_stderr() {
    let spawn = EngineSpawn {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "printf 'Error: \"unknown or duplicate option\"\\n' >&2; exit 7".into(),
        ],
        env: Vec::new(),
    };
    let (_connection, mut events) = Connection::start(spawn, TIMEOUT).expect("start");
    let failure = match next(&mut events).await {
        TransportEvent::Failure(failure) => failure,
        other => panic!("expected a failure, got {other:?}"),
    };
    assert_eq!(failure.code, "engine_closed");
    assert!(
        failure.message.contains("unknown or duplicate option"),
        "the engine's own stderr is missing: {}",
        failure.message
    );
    assert!(
        failure.message.contains("exit status"),
        "the exit status is missing: {}",
        failure.message
    );
}

#[tokio::test]
async fn a_shim_startup_refusal_preserves_the_reason_before_its_stack() {
    let spawn = EngineSpawn {
        env: vec![(
            "MIAO_TUI_FAKE_STARTUP_ERROR".into(),
            "miao engine-shim: could not prepare the product engine plan: Native TUI requires default-agent capture support\n    at ProductTuiAgent.prepare (C:\\source\\product-tui-agent.ts:36:11)\n    at Engine.tuiEnginePlan (C:\\source\\tui-engine-host.ts:107:40)\n    at Engine.tuiEnginePlan (definition)\n    at runEngineShim (C:\\source\\tui-engine-host.ts:157:5)".into(),
        )],
        ..fake()
    };
    let (_connection, mut events) = Connection::start(spawn, TIMEOUT).unwrap();
    let failure = match next(&mut events).await {
        TransportEvent::Failure(failure) => failure,
        other => panic!("expected startup failure, got {other:?}"),
    };
    assert_eq!(failure.code, "engine_closed");
    assert!(
        failure
            .message
            .contains("Native TUI requires default-agent capture support"),
        "{}",
        failure.message
    );
    assert!(!failure.message.contains("product-tui-agent.ts"));
}

#[tokio::test]
async fn a_long_unicode_startup_error_keeps_its_leading_reason_and_a_bound() {
    let spawn = EngineSpawn {
        env: vec![(
            "MIAO_TUI_FAKE_STARTUP_ERROR".into(),
            format!(
                "Error: workspace storage is protected: {}",
                "路径".repeat(200)
            ),
        )],
        ..fake()
    };
    let (_connection, mut events) = Connection::start(spawn, TIMEOUT).unwrap();
    let failure = match next(&mut events).await {
        TransportEvent::Failure(failure) => failure,
        other => panic!("expected startup failure, got {other:?}"),
    };
    assert!(
        failure
            .message
            .contains("Error: workspace storage is protected:"),
        "{}",
        failure.message
    );
    assert!(failure.message.chars().count() <= 360);
}

#[tokio::test]
async fn an_oversized_unicode_diagnostic_keeps_the_reason_without_poisoning_the_reader() {
    let spawn = EngineSpawn {
        env: vec![(
            "MIAO_TUI_FAKE_STARTUP_ERROR".into(),
            format!("Error: storage is protected: {}", "路".repeat(3000)),
        )],
        ..fake()
    };
    let (_connection, mut events) = Connection::start(spawn, TIMEOUT).unwrap();
    let failure = match next(&mut events).await {
        TransportEvent::Failure(failure) => failure,
        other => panic!("expected startup failure, got {other:?}"),
    };
    assert!(
        failure.message.contains("Error: storage is protected:"),
        "{}",
        failure.message
    );
    assert!(failure.message.chars().count() <= 360);
}
