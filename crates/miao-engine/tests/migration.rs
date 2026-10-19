use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    protocol::{Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Echo;
#[async_trait]
impl Provider for Echo {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<serde_json::Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

const BUNDLE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn store(path: &std::path::Path) -> Store {
    Store::open(path.join("engine.db")).await.unwrap()
}

async fn runtime(store: &Store, root: &std::path::Path) -> Runtime {
    Runtime::with_policy(
        store.clone(),
        Arc::new(Echo),
        Tools::new(root).await.unwrap(),
        Policy::new(Config {
            mode: miao_engine::permission::Mode::Workspace,
            allow_process: false,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap()
}

fn input(session: &str, id: &str) -> Input {
    serde_json::from_value(json!({
        "session_id": session, "input_id": id, "prompt": "migrate probe", "delivery": "steer",
    }))
    .unwrap()
}

#[tokio::test]
async fn migration_stage_cutover_complete_freezes_and_reopens_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let database = store(dir.path()).await;
    database
        .initialize("s", "migrate", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let before = database
        .events("s", 0, 100)
        .await
        .unwrap()
        .last()
        .map(|event| event.seq)
        .unwrap_or(0);

    // Stage adopts an exact retry and rejects a different shape.
    let staged = database
        .migration_stage("mig1", "s", "ts_to_rust", BUNDLE, before)
        .await
        .unwrap();
    assert_eq!(staged.state, "staged");
    assert_eq!(staged.source_high_seq, before + 1);
    // The recorded watermark includes the transition's own staged event, so
    // the exact retry asserts the recorded value, not the pre-stage counter.
    let retry = database
        .migration_stage("mig1", "s", "ts_to_rust", BUNDLE, before + 1)
        .await
        .unwrap();
    assert_eq!(retry.id, "mig1");
    assert_eq!(retry.source_high_seq, before + 1);
    assert!(matches!(
        database
            .migration_stage(
                "mig1",
                "s",
                "ts_to_rust",
                "f".repeat(64).as_str(),
                before + 1
            )
            .await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        database
            .migration_stage("mig2", "s", "ts_to_rust", BUNDLE, before + 1)
            .await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        database
            .migration_stage("mig3", "missing", "ts_to_rust", BUNDLE, 0)
            .await,
        Err(Error::Conflict)
    ));

    // Staged freezes admission and resume on the native side.
    let (runtime, tools_root) = {
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let runtime = runtime(&database, &workspace).await;
        assert!(matches!(
            runtime.admit(input("s", "frozen"), false).await,
            Err(Error::Conflict)
        ));
        assert!(matches!(runtime.resume("s").await, Err(Error::Conflict)));
        (runtime, workspace)
    };

    // Advancing the source between stage and cutover invalidates the frozen
    // watermark: the transition cannot cut over over a changed history.
    database
        .record("s", "late.append", json!({}))
        .await
        .unwrap();
    assert!(matches!(
        database.migration_cutover("mig1").await,
        Err(Error::Conflict)
    ));
    // A stale transition is aborted, and a fresh id re-stages against the
    // live watermark; the aborted row can never be revived or reused.
    database.migration_abort("mig1").await.unwrap();
    assert!(!database.migration_active("s").await.unwrap());
    let live = database
        .events("s", 0, 500)
        .await
        .unwrap()
        .last()
        .map(|event| event.seq)
        .unwrap_or(0);
    assert!(matches!(
        database
            .migration_stage("mig1", "s", "ts_to_rust", BUNDLE, live)
            .await,
        Err(Error::Conflict)
    ));
    let re_staged = database
        .migration_stage("mig1b", "s", "ts_to_rust", BUNDLE, live)
        .await
        .unwrap();
    assert_eq!(re_staged.state, "staged");
    assert_eq!(re_staged.source_high_seq, live + 1);

    let cut = database.migration_cutover("mig1b").await.unwrap();
    assert_eq!(cut.state, "cutover");
    assert!(database.migration_active("s").await.unwrap());
    database.migration_complete("mig1b").await.unwrap();
    assert!(!database.migration_active("s").await.unwrap());
    // The runtime's actor pool can outlive the transition row; the tempdir
    // reclaims the file, so no explicit Store close is attempted here.
    let _ = (runtime, tools_root);
}

#[tokio::test]
async fn migration_abort_from_stage_or_cutover_releases_the_freeze() {
    let dir = tempfile::tempdir().unwrap();
    let database = store(dir.path()).await;
    database
        .initialize("s", "rollback", dir.path().to_str().unwrap())
        .await
        .unwrap();
    // A fresh stage asserts the live watermark.
    let live = async |database: &Store| {
        database
            .events("s", 0, 500)
            .await
            .unwrap()
            .last()
            .map(|event| event.seq)
            .unwrap_or(0)
    };
    database
        .migration_stage("migA", "s", "rust_to_ts", BUNDLE, live(&database).await)
        .await
        .unwrap();
    database.migration_abort("migA").await.unwrap();
    assert!(!database.migration_active("s").await.unwrap());
    // Terminal rows keep exact-retry adoption closed.
    assert!(matches!(
        database
            .migration_stage("migA", "s", "rust_to_ts", BUNDLE, live(&database).await)
            .await,
        Err(Error::Conflict)
    ));
    database
        .migration_stage("migB", "s", "rust_to_ts", BUNDLE, live(&database).await)
        .await
        .unwrap();
    database.migration_cutover("migB").await.unwrap();
    database.migration_abort("migB").await.unwrap();
    assert!(!database.migration_active("s").await.unwrap());
    database.close().await.unwrap();
}

use std::sync::Arc;
