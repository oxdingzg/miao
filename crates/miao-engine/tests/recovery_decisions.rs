use async_trait::async_trait;
use miao_engine::{
    host::Host,
    permission::{Config, Policy},
    protocol::{Command, Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    recovery::Decision,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Observer(Arc<AtomicUsize>);
#[async_trait]
impl Provider for Observer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        assert!(serde_json::to_string(&request.messages)
            .unwrap()
            .contains("operator explicitly requests a retry"));
        Ok(Reply {
            content: json!([{"type":"text","text":"inspected; no repeat needed"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn seed(store: &Store, root: &std::path::Path) {
    store
        .admit_at(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "initial".into(),
                prompt: "do the work".into(),
                delivery: Delivery::Steer,
            },
            Some(root.canonicalize().unwrap().to_string_lossy().into()),
        )
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "interrupted").await.unwrap();
    store
        .tool_dispatch(
            "s",
            "interrupted",
            "call",
            "bash",
            json!({"provider_id":"wire-call","command":"external-operation"}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn controller_retry_is_durable_admission_only_and_never_replays_the_old_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed(&store, &workspace).await;
    let count = Arc::new(AtomicUsize::new(0));
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Observer(count.clone())),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    let mut host = Host::new(runtime.clone());
    let listed = host
        .dispatch(Command::Recoveries {
            session_id: "s".into(),
            after: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(listed["calls"][0]["call_id"], "call");
    assert!(listed["calls"][0]["resolution"].is_null());
    let resolve = || Command::ResolveRecovery {
        session_id: "s".into(),
        call_id: "call".into(),
        operation_id: "decision-one".into(),
        decision: Decision::Retry,
        resume: false,
    };
    let receipt = host.dispatch(resolve()).await.unwrap();
    assert_eq!(receipt["outcome"], "unknown");
    assert_eq!(receipt, host.dispatch(resolve()).await.unwrap());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["pending"].as_array().unwrap().len(), 1);
    assert_eq!(
        receipt,
        host.dispatch(Command::ResolveRecovery {
            session_id: "s".into(),
            call_id: "call".into(),
            operation_id: "decision-one".into(),
            decision: Decision::Retry,
            resume: true,
        })
        .await
        .unwrap()
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let events = store.events("s", 0, 100).await.unwrap();
            if events
                .iter()
                .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(receipt, host.dispatch(resolve()).await.unwrap());
    assert_eq!(
        receipt,
        host.dispatch(Command::ResolveRecovery {
            session_id: "s".into(),
            call_id: "call".into(),
            operation_id: "decision-one".into(),
            decision: Decision::Retry,
            resume: true,
        })
        .await
        .unwrap()
    );
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(store.snapshot("s").await.unwrap()["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    let events = store.events("s", 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.dispatched")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.recovery.resolved")
            .count(),
        1
    );
    assert!(matches!(
        host.dispatch(Command::ResolveRecovery {
            session_id: "s".into(),
            call_id: "call".into(),
            operation_id: "decision-one".into(),
            decision: Decision::Abandon,
            resume: false,
        })
        .await,
        Err(Error::Conflict)
    ));
    runtime.shutdown().await;
}

#[tokio::test]
async fn decisions_are_session_scoped_first_wins_and_preserve_unknown_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    seed(&store, dir.path()).await;
    assert!(store
        .resolve_recovery("s", "call", "op", Decision::Abandon)
        .await
        .is_err());
    store.recover().await.unwrap();
    assert!(store
        .resolve_recovery("other", "call", "op", Decision::Abandon)
        .await
        .is_err());
    let (one, two) = tokio::join!(
        store.resolve_recovery("s", "call", "op-a", Decision::Abandon),
        store.resolve_recovery("s", "call", "op-b", Decision::Retry)
    );
    assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
    assert!(matches!(
        one.as_ref().err().or(two.as_ref().err()),
        Some(Error::Conflict)
    ));
    let row = store.recoveries("s", "").await.unwrap()["calls"][0].clone();
    assert_eq!(row["outcome"], "unknown");
    assert!(!row["resolution"].is_null());
    assert!(store.recoveries("s", "call").await.unwrap()["calls"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(store.recover().await.unwrap().is_empty());
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT state FROM engine_tool WHERE id='call'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "unknown"
    );
}

#[tokio::test]
async fn committed_decision_survives_store_reopen_without_admitting_twice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let receipt = {
        let store = Store::open(&path).await.unwrap();
        seed(&store, dir.path()).await;
        store.recover().await.unwrap();
        store
            .resolve_recovery("s", "call", "persistent", Decision::Abandon)
            .await
            .unwrap()
    };
    let store = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match Store::open(&path).await {
                Ok(store) => break store,
                Err(Error::Busy) => tokio::task::yield_now().await,
                Err(error) => panic!("unexpected reopen failure: {error}"),
            }
        }
    })
    .await
    .unwrap();
    assert!(store.recover().await.unwrap().is_empty());
    assert_eq!(
        receipt,
        store
            .resolve_recovery("s", "call", "persistent", Decision::Abandon)
            .await
            .unwrap()
    );
    assert_eq!(
        store.snapshot("s").await.unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let listed = store.recoveries("s", "").await.unwrap();
    assert_eq!(listed["calls"][0]["resolution"]["decision"], "abandon");
    // The operator decision has not been promoted behind the client's back.
    assert!(!serde_json::to_string(&store.history("s").await.unwrap())
        .unwrap()
        .contains("Abandon this operation"));
}

#[tokio::test]
async fn admission_conflict_rolls_back_the_decision_and_leaves_unknown_unresolved() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed(&store, dir.path()).await;
    store.recover().await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "recovery_collision".into(),
            prompt: "different prompt".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    assert!(matches!(
        store
            .resolve_recovery("s", "call", "collision", Decision::Retry)
            .await,
        Err(Error::Conflict)
    ));
    assert!(store.recoveries("s", "").await.unwrap()["calls"][0]["resolution"].is_null());
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "tool.recovery.resolved"));
}
