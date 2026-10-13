use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Waiting;
#[async_trait]
impl Provider for Waiting {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        cancel.cancelled().await;
        Ok(Reply {
            content: json!([]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn active(store: &Store, running: bool) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let run = store.active_run("s").await.unwrap();
            if run.is_some() == running {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("execution transition")
}

fn input(id: &str) -> Input {
    Input {
        session_id: "s".into(),
        input_id: id.into(),
        prompt: "wait".into(),
        delivery: Delivery::Steer,
    }
}

#[tokio::test]
async fn stale_execution_ids_cannot_interrupt_the_new_run() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Waiting),
        Tools::new(directory.path()).await.unwrap(),
    )
    .await
    .unwrap();
    assert!(!runtime.cancel_if("missing", "stale").await.unwrap());
    runtime.admit(input("first"), true).await.unwrap();
    let first = active(&store, true).await.unwrap();
    assert!(!runtime.cancel_if("s", "wrong-run").await.unwrap());
    assert_eq!(store.active_run("s").await.unwrap(), Some(first.clone()));
    assert!(runtime.cancel_if("s", &first).await.unwrap());
    active(&store, false).await;
    assert!(!runtime.cancel_if("s", &first).await.unwrap());
    runtime.admit(input("second"), true).await.unwrap();
    let second = active(&store, true).await.unwrap();
    assert_ne!(first, second);
    assert!(!runtime.cancel_if("s", &first).await.unwrap());
    assert_eq!(store.active_run("s").await.unwrap(), Some(second.clone()));
    assert!(runtime.cancel_if("s", &second).await.unwrap());
    active(&store, false).await;
    runtime.shutdown().await;
}
