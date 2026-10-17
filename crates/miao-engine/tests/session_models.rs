use async_trait::async_trait;
use miao_engine::{
    host::Host,
    protocol::{Command, Delivery, Error, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    session_model::Binding,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

struct Selectable {
    model: String,
    turns: mpsc::Sender<(String, oneshot::Sender<()>)>,
}
#[async_trait]
impl Provider for Selectable {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "fixture".into(),
            model: self.model.clone(),
        })
    }
    fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        (model != "unsupported").then(|| {
            Arc::new(Self {
                model: model.into(),
                turns: self.turns.clone(),
            }) as Arc<dyn Provider>
        })
    }
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let (send, receive) = oneshot::channel();
        self.turns.send((self.model.clone(), send)).await.unwrap();
        tokio::select! {
            _=cancel.cancelled()=>return Err(ProviderError::Interrupted),
            _=receive=>{},
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn binding(model: &str) -> Binding {
    Binding {
        protocol: "fixture".into(),
        model: model.into(),
    }
}
fn input(session: &str, id: &str) -> Input {
    Input {
        session_id: session.into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}
async fn next(
    turns: &mut mpsc::Receiver<(String, oneshot::Sender<()>)>,
) -> (String, oneshot::Sender<()>) {
    tokio::time::timeout(std::time::Duration::from_secs(5), turns.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn model_change_waits_for_turn_boundary_and_does_not_affect_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (send, mut turns) = mpsc::channel(8);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Selectable {
            model: "base".into(),
            turns: send,
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    let mut host = Host::new(runtime.clone());
    runtime.admit(input("s", "one"), true).await.unwrap();
    let (model, finish) = next(&mut turns).await;
    assert_eq!(model, "base");
    host.dispatch(Command::SelectModel {
        session_id: "s".into(),
        binding: Some(binding("chosen")),
    })
    .await
    .unwrap();
    runtime.admit(input("s", "two"), true).await.unwrap();
    assert!(turns.try_recv().is_err());
    finish.send(()).unwrap();
    let (model, finish) = next(&mut turns).await;
    assert_eq!(model, "chosen");
    assert_eq!(
        store.snapshot("s").await.unwrap()["model_selection"]["model"],
        "chosen"
    );
    let watermark = store.snapshot("s").await.unwrap()["cursor"]
        .as_u64()
        .unwrap();
    finish.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", watermark, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    runtime.admit(input("other", "three"), true).await.unwrap();
    let (model, finish) = next(&mut turns).await;
    assert_eq!(model, "base");
    finish.send(()).unwrap();
    let events = store.events("s", 0, 100).await.unwrap();
    let identities: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "provider.started")
        .map(|event| event.data["identity"]["model"].as_str().unwrap())
        .collect();
    assert_eq!(identities, vec!["base", "chosen"]);
    let actual: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "assistant.identity")
        .map(|event| event.data.to_string())
        .collect();
    assert!(actual.iter().any(|profile| profile.contains("chosen")));
    // Reset does not restart work and selects the process default next turn.
    host.dispatch(Command::SelectModel {
        session_id: "s".into(),
        binding: None,
    })
    .await
    .unwrap();
    runtime.admit(input("s", "four"), true).await.unwrap();
    let (model, finish) = next(&mut turns).await;
    assert_eq!(model, "base");
    finish.send(()).unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn invalid_or_unsupported_models_do_not_replace_the_committed_selection() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (turns, _) = mpsc::channel(1);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Selectable {
            model: "base".into(),
            turns,
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("s", "one"), false).await.unwrap();
    runtime
        .select_model("s", Some(binding("chosen")))
        .await
        .unwrap();
    let cursor = store.snapshot("s").await.unwrap()["cursor"].clone();
    assert_eq!(
        runtime
            .select_model("s", Some(binding("chosen")))
            .await
            .unwrap()["changed"],
        false
    );
    for binding in [
        binding("unsupported"),
        binding("bad\nmodel"),
        Binding {
            protocol: "other-route".into(),
            model: "chosen".into(),
        },
    ] {
        assert!(runtime.select_model("s", Some(binding)).await.is_err());
    }
    assert!(matches!(
        runtime
            .select_model("missing", Some(binding("chosen")))
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(store.snapshot("s").await.unwrap()["cursor"], cursor);
    assert_eq!(
        store.model_selection("s").await.unwrap(),
        Some(binding("chosen"))
    );
    store.promote("s", true).await.unwrap();
    store.message("s","assistant",json!([{"type":"provider_opaque","provider":"fixture","model":"chosen","item":{"type":"reasoning","encrypted_content":"opaque"}}])).await.unwrap();
    let cursor = store.snapshot("s").await.unwrap()["cursor"].clone();
    assert!(runtime.select_model("s", None).await.is_err());
    assert_eq!(store.snapshot("s").await.unwrap()["cursor"], cursor);
    assert_eq!(
        store.model_selection("s").await.unwrap(),
        Some(binding("chosen"))
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn fork_inherits_the_model_at_its_declared_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("s", "one")).await.unwrap();
    store.promote("s", true).await.unwrap();
    store
        .select_model("s", Some(binding("earlier")))
        .await
        .unwrap();
    let boundary = store
        .message("s", "assistant", json!([{"type":"text","text":"done"}]))
        .await
        .unwrap()
        .seq;
    store
        .select_model("s", Some(binding("later")))
        .await
        .unwrap();
    store.fork("s", "cut", Some(boundary)).await.unwrap();
    store.fork("s", "latest", None).await.unwrap();
    assert_eq!(
        store.model_selection("cut").await.unwrap(),
        Some(binding("earlier"))
    );
    assert_eq!(
        store.model_selection("latest").await.unwrap(),
        Some(binding("later"))
    );
}
