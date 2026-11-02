//! Inter-Session messaging, driven through a real runtime.
//!
//! The policy is unit-tested beside the handler; what these tests add is the
//! seam: a turn really calls `send_message`, and the mail really lands in the
//! peer's durable inbox without starting that peer.

use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, Message, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Answers the first turn with the tool call under test and later turns with
/// plain text, so one admission completes.
struct Calls {
    tool: Value,
    turns: mpsc::Sender<Vec<Message>>,
}

#[async_trait]
impl Provider for Calls {
    async fn stream(
        &self,
        request: ModelRequest,
        _progress: mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.turns.send(request.messages.clone()).await.unwrap();
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([self.tool.clone()]),
                usage: json!({"input_tokens": 1}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({"output_tokens": 1}),
            needs_tools: false,
        })
    }
}

fn prompt(session: &str, id: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}

async fn wait_for_turn(store: &Store, session: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let finished = store
                .events(session, 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished");
            if finished {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the turn finished");
}

/// Reading the inbox is how the TUI and the runner both see mail, so a test
/// that finds it here is following the durable path rather than a cache.
async fn pending(store: &Store, session: &str) -> Vec<Value> {
    store.pending_inputs(session, None, 10).await.unwrap()["inputs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

async fn setup(
    tool: Value,
) -> (
    tempfile::TempDir,
    Store,
    Runtime,
    mpsc::Receiver<Vec<Message>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let root = dir.path().to_string_lossy().to_string();
    store.initialize("a", "Sender", &root).await.unwrap();
    store.initialize("b", "Peer", &root).await.unwrap();
    let (turns, receive) = mpsc::channel(10);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Calls { tool, turns }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    (dir, store, runtime, receive)
}

#[tokio::test]
async fn a_message_lands_in_the_peer_inbox_without_waking_it() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_msg",
        "name": "send_message",
        "input": {"to": "b", "message": "please verify the migration", "wake": "never"}
    }))
    .await;
    runtime.admit(prompt("a", "first"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let mail = pending(&store, "b").await;
    let events = store.events("a", 0, 1000).await.unwrap();
    let trace = events
        .iter()
        .map(|event| format!("{} {}", event.kind, event.data))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(mail.len(), 1, "one message was admitted: {mail:?}\n{trace}");
    let delivered = mail[0]["prompt"].as_str().unwrap_or_default();
    assert!(
        delivered.contains("please verify the migration"),
        "the message reached the inbox: {delivered}"
    );
    // Attribution is part of the delivered prompt, so the peer can tell a
    // neighbour's request from its operator's instruction.
    assert!(
        delivered.contains("Message from Session a"),
        "the mail says who sent it: {delivered}"
    );
    // `wake: never` leaves mail and starts nothing.
    let peer = store.snapshot("b").await.unwrap();
    assert!(peer["active_run"].is_null(), "the peer was not woken");
    runtime.shutdown().await;
}

/// Authorisation is per target, so a rule can allow one neighbour and deny
/// another. The denial must keep the mail out of the peer's inbox rather than
/// admit it and hope the caller behaves.
#[tokio::test]
async fn a_denied_target_receives_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let root = dir.path().to_string_lossy().to_string();
    store.initialize("a", "Sender", &root).await.unwrap();
    store.initialize("b", "Peer", &root).await.unwrap();
    let (turns, _receive) = mpsc::channel(10);
    let policy = Policy::new(Config {
        rules: vec![Rule {
            tool: "send_message".into(),
            path: "b".into(),
            decision: Decision::Deny,
        }],
        ..Config::default()
    })
    .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Calls {
            tool: json!({
                "type": "tool_use",
                "id": "call_msg",
                "name": "send_message",
                "input": {"to": "b", "message": "do the thing", "wake": "never"}
            }),
            turns,
        }),
        Tools::new(dir.path()).await.unwrap(),
        policy,
    )
    .await
    .unwrap();
    runtime.admit(prompt("a", "first"), true).await.unwrap();
    wait_for_turn(&store, "a").await;
    assert!(
        pending(&store, "b").await.is_empty(),
        "a denied target received mail"
    );
    runtime.shutdown().await;
}
