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
    assert_eq!(staged.source_high_seq, before);
    // Retrying the exact original request must not need a new watermark.
    let retry = database
        .migration_stage("mig1", "s", "ts_to_rust", BUNDLE, before)
        .await
        .unwrap();
    assert_eq!(retry.id, "mig1");
    assert_eq!(retry.source_high_seq, before);
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

    // Old low-level writers must hit the SQLite fence too, with no partial
    // admission or event sequence advance after the failed transaction.
    assert!(database
        .record("s", "late.append", json!({}))
        .await
        .is_err());
    assert!(database.admit(input("s", "legacy-writer")).await.is_err());
    assert_eq!(
        database
            .events("s", 0, 100)
            .await
            .unwrap()
            .last()
            .unwrap()
            .seq,
        before + 1
    );
    // Pre-cutover abort is allowed; terminal tokens cannot be reused.
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
    assert_eq!(re_staged.source_high_seq, live);

    let cut = database.migration_cutover("mig1b").await.unwrap();
    assert_eq!(cut.state, "cutover");
    assert!(database.migration_active("s").await.unwrap());
    database.migration_complete("mig1b").await.unwrap();
    assert!(!database.migration_active("s").await.unwrap());
    runtime.shutdown().await;
    drop(runtime);
    let _ = tools_root;
    database.close().await.unwrap();
    let reopened = store(dir.path()).await;
    assert!(!reopened.migration_active("s").await.unwrap());
    assert_eq!(
        reopened
            .migration_find("mig1b")
            .await
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn migration_abort_is_pre_cutover_only_and_exported_sources_remain_fenced() {
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
    assert!(matches!(
        database.migration_abort("migB").await,
        Err(Error::Conflict)
    ));
    assert!(database.migration_active("s").await.unwrap());
    database.migration_complete("migB").await.unwrap();
    assert!(database.migration_active("s").await.unwrap());
    assert!(database.admit(input("s", "old-source")).await.is_err());
    assert!(database
        .record("s", "old-source.write", json!({}))
        .await
        .is_err());
    database.close().await.unwrap();
    let reopened = store(dir.path()).await;
    assert!(reopened.migration_active("s").await.unwrap());
    assert!(reopened.admit(input("s", "after-restart")).await.is_err());
    reopened.close().await.unwrap();
}

use std::sync::Arc;

#[tokio::test]
async fn shutdown_joins_the_heartbeat_before_releasing_the_last_store_handle() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    for _ in 0..20 {
        let database = store(dir.path()).await;
        let runtime = runtime(&database, &workspace).await;
        runtime.shutdown().await;
        drop(runtime);
        database.close().await.unwrap();
    }
}

#[tokio::test]
async fn migration_refuses_pending_inputs_and_upgrades_original_retry_identity() {
    let dir = tempfile::tempdir().unwrap();
    let database = store(dir.path()).await;
    database
        .initialize("busy", "busy", dir.path().to_str().unwrap())
        .await
        .unwrap();
    database.admit(input("busy", "pending")).await.unwrap();
    let high = database
        .events("busy", 0, 100)
        .await
        .unwrap()
        .last()
        .unwrap()
        .seq;
    assert!(matches!(
        database
            .migration_stage("busy-token", "busy", "rust_to_ts", BUNDLE, high)
            .await,
        Err(Error::Conflict)
    ));
    assert!(database
        .migration_find("busy-token")
        .await
        .unwrap()
        .is_none());
    database
        .initialize("s", "idle", dir.path().to_str().unwrap())
        .await
        .unwrap();
    let high = database
        .events("s", 0, 100)
        .await
        .unwrap()
        .last()
        .unwrap()
        .seq;
    database
        .migration_stage("legacy-token", "s", "ts_to_rust", BUNDLE, high)
        .await
        .unwrap();
    database.close().await.unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("engine.db")).unwrap();
        conn.execute(
            "UPDATE engine_migration SET source_high_seq=source_high_seq+1 WHERE id='legacy-token'",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 17).unwrap();
    }
    let reopened = store(dir.path()).await;
    let retry = reopened
        .migration_stage("legacy-token", "s", "ts_to_rust", BUNDLE, high)
        .await
        .unwrap();
    assert_eq!(retry.source_high_seq, high);
    reopened.migration_cutover("legacy-token").await.unwrap();
    assert!(matches!(
        reopened.migration_abort("legacy-token").await,
        Err(Error::Conflict)
    ));
    reopened.migration_complete("legacy-token").await.unwrap();
    assert!(!reopened.migration_active("s").await.unwrap());
    reopened.admit(input("s", "new-authority")).await.unwrap();
    reopened.close().await.unwrap();
}
