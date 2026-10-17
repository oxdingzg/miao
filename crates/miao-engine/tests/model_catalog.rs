use async_trait::async_trait;
use axum::{http::HeaderMap, routing::post, Json, Router};
use miao_engine::{
    credential::{Credential, Source},
    model_catalog::Catalog,
    openai_chat::OpenAIChat,
    protocol::{Delivery, Input, ModelRequest},
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

fn input(id: &str) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}
async fn finished(store: &Store, after: u64) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("s", after, 1000).await.unwrap();
            if let Some(event) = events.iter().find(|event| event.kind == "run.finished") {
                break event.data["reason"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
async fn endpoint(key: &str) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let (send, receive) = mpsc::channel(8);
    let expected = format!("Bearer {key}");
    let router=Router::new().route("/chat",post(move |headers:HeaderMap,Json(body):Json<Value>| {
        let send=send.clone();let expected=expected.clone();async move {
            assert_eq!(headers["authorization"],expected);
            send.send(body).await.unwrap();
            ([("content-type","text/event-stream")],format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/chat", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, receive, task)
}
fn provider(endpoint: String, key: &str) -> Arc<dyn Provider> {
    Arc::new(
        OpenAIChat::with_source(
            endpoint,
            Source::Static(Credential::key(key.into())),
            "same-model".into(),
        )
        .unwrap(),
    )
}
fn binding(route: &str) -> Binding {
    Binding {
        protocol: "openai-chat".into(),
        model: "same-model".into(),
        route_id: Some(route.into()),
    }
}

#[tokio::test]
async fn registered_routes_bind_real_endpoints_and_credentials_even_for_identical_model_names() {
    let (first_url, mut first_requests, first_server) = endpoint("first-fixture-key").await;
    let (second_url, mut second_requests, second_server) = endpoint("second-fixture-key").await;
    let catalog = Arc::new(
        Catalog::new(
            provider(first_url, "first-fixture-key"),
            vec![("second".into(), provider(second_url, "second-fixture-key"))],
        )
        .unwrap(),
    );
    let info = serde_json::to_string(&catalog.model_catalog()).unwrap();
    assert!(!info.contains("fixture-key"));
    assert!(!info.contains("127.0.0.1"));
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        catalog,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("first"), false).await.unwrap();
    runtime
        .select_model("s", Some(binding("second")))
        .await
        .unwrap();
    runtime.resume("s").await.unwrap();
    assert_eq!(finished(&store, 0).await, "completed");
    assert_eq!(second_requests.recv().await.unwrap()["model"], "same-model");
    assert!(first_requests.try_recv().is_err());
    store.fork("s", "child", None).await.unwrap();
    assert_eq!(
        store.model_selection("child").await.unwrap(),
        Some(binding("second"))
    );
    runtime.select_model("s", None).await.unwrap();
    let cursor = store.snapshot("s").await.unwrap()["cursor"]
        .as_u64()
        .unwrap();
    runtime.admit(input("default"), true).await.unwrap();
    assert_eq!(finished(&store, cursor).await, "completed");
    assert_eq!(first_requests.recv().await.unwrap()["model"], "same-model");
    assert!(second_requests.try_recv().is_err());
    for bad in [
        binding("missing"),
        Binding {
            model: "forged-model".into(),
            ..binding("second")
        },
        Binding {
            protocol: "anthropic".into(),
            ..binding("second")
        },
    ] {
        assert!(runtime.select_model("s", Some(bad)).await.is_err());
        assert_eq!(store.model_selection("s").await.unwrap(), None);
    }
    assert_eq!(
        store.model_selection("child").await.unwrap(),
        Some(binding("second"))
    );
    runtime.shutdown().await;
    first_server.abort();
    second_server.abort();
}

struct Gated {
    turns: mpsc::Sender<oneshot::Sender<()>>,
    opaque: bool,
}
#[async_trait]
impl Provider for Gated {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "fixture".into(),
            model: "same-model".into(),
        })
    }
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let (send, receive) = oneshot::channel();
        self.turns.send(send).await.unwrap();
        tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),_=receive=>{}}
        Ok(Reply {
            content: if self.opaque {
                json!([{"type":"provider_opaque","provider":"fixture","model":"same-model","item":{"id":"private-route-item"},"_miao_route_id":"forged"},{"type":"text","text":"done"}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools: false,
        })
    }
}
#[tokio::test]
async fn an_inflight_opaque_reply_cannot_cross_a_later_selected_route() {
    let (first_send, mut first) = mpsc::channel(4);
    let (second_send, mut second) = mpsc::channel(4);
    let primary: Arc<dyn Provider> = Arc::new(Gated {
        turns: first_send,
        opaque: true,
    });
    let target: Arc<dyn Provider> = Arc::new(Gated {
        turns: second_send,
        opaque: false,
    });
    let catalog = Arc::new(Catalog::new(primary, vec![("other".into(), target)]).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        catalog,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("one"), true).await.unwrap();
    let finish = tokio::time::timeout(std::time::Duration::from_secs(5), first.recv())
        .await
        .unwrap()
        .unwrap();
    let selected = Binding {
        protocol: "fixture".into(),
        model: "same-model".into(),
        route_id: Some("other".into()),
    };
    runtime
        .select_model("s", Some(selected.clone()))
        .await
        .unwrap();
    runtime.admit(input("two"), true).await.unwrap();
    finish.send(()).unwrap();
    assert_eq!(finished(&store, 0).await, "failed");
    assert!(
        second.try_recv().is_err(),
        "no request may reach the new route with old opaque data"
    );
    let history = store.history("s").await.unwrap();
    let opaque = history
        .iter()
        .flat_map(|message| message.content.as_array().unwrap())
        .find(|block| block["type"] == "provider_opaque")
        .unwrap();
    assert!(
        opaque["_miao_route_id"].is_null(),
        "host provenance overwrites provider supplied metadata"
    );
    assert_eq!(opaque["item"]["id"], "private-route-item");
    assert!(runtime.select_model("s", Some(selected)).await.is_err());
    runtime.select_model("s", None).await.unwrap();
    runtime.shutdown().await;
}

#[test]
fn catalogs_reject_ambiguous_ids_and_protect_all_registered_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let make = |name: &str| -> Arc<dyn Provider> {
        Arc::new(
            OpenAIChat::with_source(
                "http://127.0.0.1:1/chat".into(),
                Source::Legacy {
                    path: dir.path().join(name),
                    integration: "openai".into(),
                },
                "same-model".into(),
            )
            .unwrap(),
        )
    };
    assert!(Catalog::new(
        make("default"),
        vec![
            ("duplicate".into(), make("one")),
            ("duplicate".into(), make("two"))
        ]
    )
    .is_err());
    assert!(Catalog::new(make("default"), vec![("bad\nroute".into(), make("one"))]).is_err());
    let catalog = Catalog::new(make("default"), vec![("second".into(), make("second"))]).unwrap();
    let paths = catalog.protected_resources();
    assert!(paths.contains(&dir.path().join("default")));
    assert!(paths.contains(&dir.path().join("second")));
    let legacy: Binding =
        serde_json::from_value(json!({"protocol":"openai-chat","model":"same-model"})).unwrap();
    assert!(legacy.route_id.is_none());
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        json!({"protocol":"openai-chat","model":"same-model"})
    );
}
