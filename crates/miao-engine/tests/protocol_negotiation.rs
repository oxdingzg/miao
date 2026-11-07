//! The engine refuses a client whose wire protocol it does not speak.
//!
//! One binary normally spawns its own engine, so the two sides always agree;
//! an overridden engine binary (`MIAO_ENGINE_BIN`) or a hand-launched `serve`
//! is where a mismatch can happen, and there the safe answer is a clear
//! refusal rather than serving a session against a wire the engine would
//! misread. A frame without the field at all is a client too old to
//! negotiate, and refuses the same way.

use miao_engine::{
    permission::{Config, Policy},
    protocol::{Command, Error},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct Base;

#[async_trait::async_trait]
impl Provider for Base {
    fn identity(&self) -> Option<miao_engine::provider::Identity> {
        Some(miao_engine::provider::Identity {
            protocol: "openai-chat".into(),
            model: "base".into(),
        })
    }

    async fn stream(
        &self,
        _: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type": "text", "text": "ok"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn host() -> (miao_engine::host::Host, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::with_policy(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(Base),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    (
        miao_engine::host::Host::new(runtime),
        dir.path().to_path_buf(),
    )
}

fn initialize(protocol: u32) -> Command {
    Command::Initialize {
        session_id: "s".into(),
        title: "t".into(),
        protocol,
    }
}

/// The field is `#[serde(default)]`, so a legacy frame decodes — with the
/// zero that the engine then refuses. Negotiation happens at dispatch, not by
/// breaking the wire format itself.
#[test]
fn a_frame_without_the_field_still_decodes() {
    let frame = json!({"id": 1, "method": "initialize",
                       "params": {"session_id": "s", "title": "t"}});
    match miao_engine::embed::decode(&frame).unwrap() {
        Command::Initialize { protocol, .. } => assert_eq!(protocol, 0),
        _ => panic!("decoded something other than Initialize"),
    }
}

#[tokio::test]
async fn an_unannounced_protocol_is_refused_without_creating_the_session() {
    let (mut host, _dir) = host().await;
    let error = host
        .dispatch(initialize(0))
        .await
        .expect_err("a client that never announced a protocol is refused");
    let Error::Invalid(message) = error else {
        panic!("expected Invalid, got {error:?}");
    };
    assert!(message.contains("protocol mismatch"), "{message}");
    assert!(message.contains("client 0"), "{message}");
    // The same runtime answers the lookup: the refused session was never
    // created, so a state read for it is a clear error, not empty data.
    let error = host
        .dispatch(Command::Snapshot {
            session_id: "s".into(),
            metadata_only: false,
        })
        .await
        .expect_err("the refused session does not exist");
    assert!(
        format!("{error:?}").contains("Session does not exist"),
        "{error:?}"
    );
}

#[tokio::test]
async fn an_older_protocol_is_refused_and_names_both_sides() {
    let (mut host, _) = host().await;
    let error = host
        .dispatch(initialize(1))
        .await
        .expect_err("an old client is refused");
    let Error::Invalid(message) = error else {
        panic!("expected Invalid, got {error:?}");
    };
    assert!(
        message.contains("client 1, engine 2"),
        "the refusal names both sides: {message}"
    );
}

#[tokio::test]
async fn the_current_protocol_is_served() {
    let (mut host, _) = host().await;
    host.dispatch(initialize(miao_engine::PROTOCOL))
        .await
        .expect("the engine's own protocol negotiates");
}
