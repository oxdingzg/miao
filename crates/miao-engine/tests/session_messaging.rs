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
    miao_engine::placement::canonical(dir.path())
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

/// Two Sessions answering each other forever is the loop this bounds. One
/// request is answered once; a second reply to the same receipt is refused
/// with the reason, so the pair stops instead of ping-ponging until a token
/// budget runs out.
#[tokio::test]
async fn a_second_reply_to_the_same_message_is_refused() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_loop",
        "name": "send_message",
        "input": {
            "to": "b",
            "message": "second answer",
            "wake": "never",
            "in_reply_to": "msg_q"
        }
    }))
    .await;
    // The receipt `a` is answering, and the one reply the budget allows.
    for (id, prompt) in [
        ("msg_q", "Message from Session a:\nthe original question"),
        (
            "msg_r1",
            "Message from Session a (reply to msg_q):\nfirst answer",
        ),
    ] {
        store
            .admit(Input {
                agent_references: Default::default(),
                command: None,
                session_id: "b".into(),
                input_id: id.into(),
                prompt: prompt.into(),
                delivery: Delivery::Steer,
            })
            .await
            .unwrap();
    }

    runtime.admit(prompt("a", "second"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let events = store.events("a", 0, 1000).await.unwrap();
    let trace = events
        .iter()
        .map(|event| format!("{} {}", event.kind, event.data))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        trace.contains("is how two Sessions loop"),
        "the second reply is refused with the reason: {trace}"
    );
    // The stop reason is durable evidence on the sender's ledger, not only a
    // tool-result string: why the thread ended survives the turn.
    let refusals: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "peer.message.refused")
        .collect();
    assert_eq!(refusals.len(), 1, "one recorded refusal: {trace}");
    assert_eq!(refusals[0].data["stop_reason"], "reply_budget_exhausted");
    assert_eq!(refusals[0].data["receipt"], "msg_q");
    assert_eq!(refusals[0].data["target"], "b");
    let mail = pending(&store, "b").await;
    assert!(
        !mail.iter().any(|row| row["prompt"]
            .as_str()
            .is_some_and(|text| text.contains("second answer"))),
        "nothing was delivered for the refused reply: {mail:?}"
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

/// Same-project identity is the shared location root: a Session anchored to
/// another project is not addressable, and the store refuses the send even
/// when a caller skips the tool's own resolution.
#[tokio::test]
async fn a_peer_outside_the_project_is_not_addressable() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_far",
        "name": "send_message",
        "input": {"to": "c", "message": "across the fence", "wake": "never"}
    }))
    .await;
    let other = tempfile::tempdir().unwrap();
    store
        .initialize("c", "Other project", &other.path().to_string_lossy())
        .await
        .unwrap();

    runtime.admit(prompt("a", "far"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let trace = store
        .events("a", 0, 1000)
        .await
        .unwrap()
        .iter()
        .map(|event| format!("{} {}", event.kind, event.data))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        trace.contains("no Session in this project matches"),
        "a foreign project is not a peer: {trace}"
    );
    assert!(
        pending(&store, "c").await.is_empty(),
        "nothing crossed the project boundary"
    );
    // The store is the backstop: a caller that bypasses resolution cannot
    // deliver across roots, and the misspelled id creates no Session row.
    let refused = store
        .admit_peer_message(
            "a",
            None,
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "c".into(),
                input_id: "msg_far".into(),
                prompt: "Message from Session a:\nacross the fence".into(),
                delivery: Delivery::Steer,
            },
        )
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("does not share this Session's project"),
        "{refused}"
    );
    let ghost = store
        .admit_peer_message(
            "a",
            None,
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "never-initialized".into(),
                input_id: "msg_ghost".into(),
                prompt: "Message from Session a:\nhello".into(),
                delivery: Delivery::Steer,
            },
        )
        .await
        .unwrap_err();
    assert!(
        ghost
            .to_string()
            .contains("does not share this Session's project"),
        "{ghost}"
    );
    assert!(
        !store
            .session_catalog()
            .await
            .unwrap()
            .iter()
            .any(|row| row["session_id"] == "never-initialized"),
        "a refused send must not create the recipient"
    );
    runtime.shutdown().await;
}

/// The recipient's safety boundary: one sender cannot flood a peer. The
/// sixteenth pending message is the last the inbox accepts, and the refusal
/// names itself durably on the sender's ledger.
#[tokio::test]
async fn a_full_inbox_refuses_mail_at_the_recipient_boundary() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_flood",
        "name": "send_message",
        "input": {"to": "b", "message": "one too many", "wake": "never"}
    }))
    .await;
    for step in 0..16 {
        store
            .admit(prompt("b", &format!("backlog-{step}")))
            .await
            .unwrap();
    }

    runtime.admit(prompt("a", "flood"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let trace = store
        .events("a", 0, 1000)
        .await
        .unwrap()
        .iter()
        .map(|event| format!("{} {}", event.kind, event.data))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        trace.contains("already has 16 messages waiting"),
        "the boundary is the inbox count: {trace}"
    );
    let refusals: Vec<_> = store
        .events("a", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "peer.message.refused")
        .collect();
    assert_eq!(refusals.len(), 1, "the refusal is recorded once: {trace}");
    assert_eq!(refusals[0].data["stop_reason"], "inbound_queue_full");
    assert_eq!(refusals[0].data["target"], "b");
    assert_eq!(
        store.pending_inputs("b", None, 100).await.unwrap()["inputs"]
            .as_array()
            .map(Vec::len),
        Some(16),
        "the refused message never landed"
    );
    runtime.shutdown().await;
}

/// A restart is not a re-delivery: the durable inbox row is the only truth,
/// so admitted mail survives close/reopen exactly once, a promoted message
/// never projects twice, and the reply budget still counts what it counted.
#[tokio::test]
async fn mail_survives_a_restart_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store.initialize("a", "Sender", "/proj").await.unwrap();
    store.initialize("b", "Peer", "/proj").await.unwrap();
    store
        .admit_peer_message(
            "a",
            None,
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "b".into(),
                input_id: "msg_x".into(),
                prompt: "Message from Session a:\nthe original".into(),
                delivery: Delivery::Steer,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store.pending_inputs("b", None, 100).await.unwrap()["inputs"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    store.close().await.unwrap();

    // Reopened: the same mail, still pending, still attributed — not a copy.
    let store = Store::open(&path).await.unwrap();
    let mail = store.pending_inputs("b", None, 100).await.unwrap()["inputs"].clone();
    assert_eq!(mail.as_array().map(Vec::len), Some(1), "{mail}");
    assert_eq!(mail[0]["id"], "msg_x");
    assert_eq!(mail[0]["sender"], "a");
    store.promote("b", false).await.unwrap();
    store.close().await.unwrap();

    // Promoted mail does not re-deliver: the transcript carries it once.
    let store = Store::open(&path).await.unwrap();
    assert!(
        pending(&store, "b").await.is_empty(),
        "a promoted message is not pending again"
    );
    let copies = store
        .history("b")
        .await
        .unwrap()
        .iter()
        .filter(|message| {
            message.role == "user"
                && message
                    .content
                    .to_string()
                    .contains("Message from Session a")
        })
        .count();
    assert_eq!(copies, 1, "exactly one delivery in the transcript");

    // The budget is a counted query over durable rows, so the one follow-up
    // this message allows is spent across restarts, not per turn.
    store
        .admit_peer_message(
            "a",
            Some("msg_x"),
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "b".into(),
                input_id: "msg_reply".into(),
                prompt: "Message from Session a (reply to msg_x):\nthe answer".into(),
                delivery: Delivery::Steer,
            },
        )
        .await
        .unwrap();
    assert_eq!(store.peer_reply_count("b", "msg_x").await.unwrap(), 1);
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.peer_reply_count("b", "msg_x").await.unwrap(),
        1,
        "the budget is durable state, not a per-turn observation"
    );
    store.close().await.unwrap();
}

/// An exact retry of a peer send reconciles to the same receipt and one row;
/// the same identity answering with a different sender or linkage conflicts
/// instead of silently rewriting attributed mail.
#[tokio::test]
async fn an_exact_retry_of_a_peer_send_duplicates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("a", "Sender", "/proj").await.unwrap();
    store.initialize("b", "Peer", "/proj").await.unwrap();
    let send = Input {
        agent_references: Default::default(),
        command: None,
        session_id: "b".into(),
        input_id: "msg_x".into(),
        prompt: "Message from Session a:\nhello".into(),
        delivery: Delivery::Steer,
    };
    let first = store
        .admit_peer_message("a", None, send.clone())
        .await
        .unwrap();
    assert!(!first.duplicate);
    let retry = store
        .admit_peer_message("a", None, send.clone())
        .await
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.admitted_seq, first.admitted_seq);
    assert_eq!(
        store.pending_inputs("b", None, 100).await.unwrap()["inputs"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "a lost ack cannot duplicate mail"
    );

    let rewritten = store
        .admit_peer_message("a", Some("msg_other"), send.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(rewritten, miao_engine::protocol::Error::Conflict),
        "{rewritten}"
    );
    let hijacked = store.admit_peer_message("b", None, send).await.unwrap_err();
    assert!(
        matches!(hijacked, miao_engine::protocol::Error::Conflict),
        "{hijacked}"
    );
    store.close().await.unwrap();
}

/// A wake is addressed: only the named peer may drain. An unrelated Session
/// neither runs nor loses its place in its own inbox while the addressed peer
/// works.
#[tokio::test]
async fn a_wake_reaches_only_the_addressed_peer() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let root = root(&dir).await;
    store.initialize("a", "Sender", &root).await.unwrap();
    store.initialize("b", "Peer", &root).await.unwrap();
    store.initialize("c", "Bystander", &root).await.unwrap();
    // The bystander has unread mail nobody may promote for it.
    store.admit(prompt("c", "c-task")).await.unwrap();
    let (turns, _receive) = mpsc::channel(10);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Calls {
            tool: json!({
                "type": "tool_use",
                "id": "call_wake",
                "name": "send_message",
                "input": {
                    "to": "b",
                    "message": "please start now",
                    "wake": "always",
                    "reason": "the operator asked for this work to begin"
                }
            }),
            turns,
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(prompt("a", "first"), true).await.unwrap();

    // The addressed peer starts and settles.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let finished = store
                .events("b", 0, 1000)
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
    .expect("the addressed peer ran");

    let bystander = store.events("c", 0, 1000).await.unwrap();
    assert!(
        !bystander.iter().any(|event| event.kind == "run.started"),
        "an unrelated Session is never woken: {bystander:?}"
    );
    assert_eq!(
        store.pending_inputs("c", None, 10).await.unwrap()["inputs"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "the bystander's mail is untouched"
    );
    runtime.shutdown().await;
}

/// The receipt is the product surface a reply names, so the tool result
/// carries the typed wire shape — resolved recipient, the spec's wake
/// vocabulary, the linkage — and the receipt names a real, attributed inbox
/// row in the recipient.
#[tokio::test]
async fn the_receipt_names_the_recipient_and_the_thread() {
    let (_dir, store, runtime, _turns) = setup(json!({
        "type": "tool_use",
        "id": "call_receipt",
        "name": "send_message",
        "input": {
            "to": "b",
            "message": "carrying a receipt",
            "wake": "never",
            "in_reply_to": "msg_seed"
        }
    }))
    .await;
    // Seed the message being answered, as `b` received it.
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "b".into(),
            input_id: "msg_seed".into(),
            prompt: "Message from Session a:\nthe original question".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();

    runtime.admit(prompt("a", "receipted"), true).await.unwrap();
    wait_for_turn(&store, "a").await;

    let history = store.history("a").await.unwrap();
    let result = history
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == "call_receipt")
        .expect("the send_message result is in the transcript");
    assert_eq!(result["is_error"], false, "{result}");
    let receipt: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["sessionID"], "b");
    assert_eq!(receipt["wake"], "not_requested");
    assert_eq!(receipt["duplicate"], false);
    assert_eq!(receipt["reply_to"], "msg_seed");
    assert!(
        receipt.get("reason").is_none(),
        "an unstated reason is omitted, not null: {receipt}"
    );

    let mail = pending(&store, "b").await;
    let delivered = mail
        .iter()
        .find(|row| row["id"] == receipt["receipt"])
        .unwrap_or_else(|| panic!("the receipt names a real inbox row: {mail:?}"));
    assert_eq!(delivered["sender"], "a");
    assert_eq!(delivered["reply_to"], "msg_seed");
    runtime.shutdown().await;
}
