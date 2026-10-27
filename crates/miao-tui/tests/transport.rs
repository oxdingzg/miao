//! T2 acceptance: the stdio transport against a scripted engine.
//!
//! The fake engine (`tests/fixtures/fake_engine.rs`) holds five durable events
//! per session and appends one live event per `ping`, so each test can tell
//! what was replayed from a cursor apart from what arrived afterwards.

use std::time::Duration;

use miao_tui::transport::{Connection, EngineSpawn, EventRx, TransportError, TransportEvent};
use serde_json::json;

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
