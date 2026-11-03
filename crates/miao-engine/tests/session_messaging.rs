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

/// The runtime places a Session at its canonical tool root, so a fixture that
/// places Sessions itself must use the same string. A raw tempdir path differs
/// on macOS (`/var` → `/private/var`) and on Windows (8.3 short names), and the
/// mismatch is a placement conflict rather than a missing directory.
async fn root(dir: &tempfile::TempDir) -> String {
    tokio::fs::canonicalize(dir.path())
        .await
        .unwrap()
        .to_string_lossy()
        .to_string()
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
    let root = root(&dir).await;
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

/// A reply names the message it answers, and the receipt has to be real: the
/// id lives in the recipient's inbox, so a fabricated one would read as a
/// thread that never happened.
#[tokio::test]
async fn a_reply_to_a_real_receipt_names_it_in_the_delivered_prompt() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_reply",
        "name": "send_message",
        "input": {
            "to": "b",
            "message": "follow-up on the migration",
            "wake": "never",
            "in_reply_to": "msg_first"
        }
    }))
    .await;
    // Seed the receipt the sender is answering, as target `b` received it.
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "b".into(),
            input_id: "msg_first".into(),
            prompt: "Message from Session a:\nthe original question".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();

    runtime.admit(prompt("a", "reply"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let mail = pending(&store, "b").await;
    let reply = mail
        .iter()
        .find(|row| {
            row["prompt"]
                .as_str()
                .is_some_and(|text| text.contains("follow-up on the migration"))
        })
        .unwrap_or_else(|| panic!("the reply was admitted: {mail:?}"));
    let delivered = reply["prompt"].as_str().unwrap_or_default();
    assert!(
        delivered.contains("(reply to msg_first)"),
        "the recipient sees which message it answers: {delivered}"
    );
    runtime.shutdown().await;
}

/// An id this Session never received is refused rather than written into the
/// prompt. A fabricated receipt would read as a thread that never happened.
#[tokio::test]
async fn a_reply_to_an_unknown_receipt_is_refused() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_bad_reply",
        "name": "send_message",
        "input": {
            "to": "b",
            "message": "answering nothing",
            "wake": "never",
            "in_reply_to": "msg_never_sent"
        }
    }))
    .await;
    runtime.admit(prompt("a", "bad reply"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let mail = pending(&store, "b").await;
    assert!(
        mail.is_empty(),
        "nothing may be delivered for an unverifiable receipt: {mail:?}"
    );
    let events = store.events("a", 0, 1000).await.unwrap();
    let trace = events
        .iter()
        .map(|event| format!("{} {}", event.kind, event.data))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        trace.contains("a reply must answer a real receipt"),
        "the refusal is explained: {trace}"
    );
    runtime.shutdown().await;
}

/// Authorisation is per target, so a rule can allow one neighbour and deny
/// another. The denial must keep the mail out of the peer's inbox rather than
/// admit it and hope the caller behaves.
#[tokio::test]
async fn a_denied_target_receives_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let root = root(&dir).await;
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
