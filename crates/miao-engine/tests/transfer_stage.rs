use miao_engine::{
    host::Host,
    protocol::{Command, Error, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

struct Never;
#[async_trait::async_trait]
impl Provider for Never {
    fn identity(&self) -> Option<Identity> {
        Some(identity())
    }
    async fn stream(
        &self,
        _: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<Reply, ProviderError> {
        panic!("Inactive transfer must not invoke a provider")
    }
}

fn identity() -> Identity {
    Identity {
        protocol: "openai-chat".into(),
        model: "fixture".into(),
    }
}
fn bundle(root: &Path) -> String {
    json!({"format":"miao.session.transfer.v1","source":{"engine":"ts","storage":"/source.db","sequence":1},
        "session":{"id":"s","title":"original","location":{"directory":root},"time":{"created":123,"updated":456}},
        "timeline":[{"id":"msg_original","type":"user","text":"x".repeat(1024*1024+1),"time":{"created":123}}],
        "context_ids":["msg_original"],"artifacts":[],"source_state":{},"operational":{}}).to_string()
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn runtime(store: &Store, root: &Path) -> Runtime {
    Runtime::new(
        store.clone(),
        Arc::new(Never),
        Tools::new(root).await.unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn host_preflight_and_atomic_prepared_stage_use_small_file_control_frames() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("engine.db");
    let file = tmp.path().join("bundle.json");
    let encoded = bundle(tmp.path());
    std::fs::write(&file, &encoded).unwrap();
    let hash = digest(&encoded);
    let database = Store::open(&path).await.unwrap();
    let runtime = runtime(&database, tmp.path()).await;
    let mut host = Host::new(runtime.clone());
    let frame = json!({"method":"transfer_validate","params":{"path":file,"bundle_sha256":hash,"identity":identity()}});
    assert!(serde_json::to_vec(&frame).unwrap().len() < 1024);
    let validated = host
        .dispatch(serde_json::from_value(frame).unwrap())
        .await
        .unwrap();
    assert_eq!(validated["message_count"], 1);
    assert!(database.snapshot("s").await.is_err());
    assert!(database
        .session_transfer_import("transfer")
        .await
        .unwrap()
        .is_none());
    let stage = || Command::TransferStage {
        import_id: "transfer".into(),
        path: file.clone(),
        bundle_sha256: hash.clone(),
        identity: identity(),
        route_id: None,
        agent: None,
    };
    let staged = host.dispatch(stage()).await.unwrap();
    assert_eq!(staged["state"], "staged");
    assert!(staged.get("bundle").is_none());
    assert_eq!(host.dispatch(stage()).await.unwrap(), staged);
    let prepared = database
        .session_transfer_preparation("transfer")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prepared["messages"][0]["source_message_id"], "msg_original");
    assert_eq!(
        prepared["messages"][0]["message"]["content"][0]["text"],
        "x".repeat(1024 * 1024 + 1)
    );
    assert!(database.migration_active("s").await.unwrap());
    assert!(host
        .dispatch(Command::TransferStage {
            import_id: "transfer".into(),
            path: file.clone(),
            bundle_sha256: hash.clone(),
            identity: Identity {
                model: "other".into(),
                ..identity()
            },
            route_id: None,
            agent: None,
        })
        .await
        .is_err());
    runtime.shutdown().await;
    drop(host);
    drop(runtime);
    database.close().await.unwrap();
    let database = Store::open(&path).await.unwrap();
    assert_eq!(
        database
            .session_transfer_preparation("transfer")
            .await
            .unwrap()
            .unwrap(),
        prepared
    );
    database
        .abort_session_transfer_import("transfer")
        .await
        .unwrap();
    assert!(database.migration_active("s").await.unwrap());
    database.close().await.unwrap();
}

#[tokio::test]
async fn failed_preparation_insert_rolls_back_target_bundle_and_catalog() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("engine.db");
    let database = Store::open(&path).await.unwrap();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_transfer_preparation BEFORE INSERT ON engine_transfer_preparation BEGIN SELECT RAISE(ABORT,'injected preparation failure'); END;").unwrap();
    }
    let encoded = bundle(tmp.path());
    assert!(database
        .stage_prepared_session_transfer(
            "transfer",
            encoded.clone(),
            &digest(&encoded),
            identity(),
            None
        )
        .await
        .is_err());
    assert!(database.snapshot("s").await.is_err());
    assert!(database
        .session_transfer_import("transfer")
        .await
        .unwrap()
        .is_none());
    assert!(database
        .session_transfer_preparation("transfer")
        .await
        .unwrap()
        .is_none());
    database.close().await.unwrap();
}

#[tokio::test]
async fn corrupt_or_unsupported_file_fails_before_any_target_mutation() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("engine.db");
    let file = tmp.path().join("bundle.json");
    let encoded = bundle(tmp.path());
    std::fs::write(&file, &encoded).unwrap();
    assert!(matches!(
        miao_engine::transfer::read_bundle_file(file.clone(), &"0".repeat(64)).await,
        Err(Error::Conflict)
    ));
    let database = Store::open(&path).await.unwrap();
    let mut invalid: Value = serde_json::from_str(&encoded).unwrap();
    invalid["context_ids"] = json!(["missing"]);
    let encoded = invalid.to_string();
    assert!(database
        .stage_prepared_session_transfer(
            "invalid",
            encoded.clone(),
            &digest(&encoded),
            identity(),
            None
        )
        .await
        .is_err());
    assert!(database.snapshot("s").await.is_err());
    assert!(database
        .session_transfer_import("invalid")
        .await
        .unwrap()
        .is_none());
    database.close().await.unwrap();
}
