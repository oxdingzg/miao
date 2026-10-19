use miao_engine::{
    protocol::{Error, Input},
    store::Store,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn bundle(session: &str) -> String {
    json!({
        "format":"miao.session.transfer.v1", "source":{"engine":"ts","storage":"/source.db","sequence":5},
        "session":{"id":session,"title":"Original title","location":{"directory":"/project"},
            "time":{"created":1700000000000_u64,"updated":1700000000100_u64}},
        "timeline":[{"id":"canonical-user","type":"user","text":"original"}],
        "context_ids":["canonical-user"],
        "events":[{"id":"original-event","seq":5,"type":"session.next.prompted.1","data":{}}],
        "artifacts":[], "operational":{"todos":[],"notifications":[],"delegations":[],"tool_dispatches":[]},
        "source_state":{"credential_id":"original-account"}
    }).to_string()
}
fn digest(bundle: &str) -> String {
    format!("{:x}", Sha256::digest(bundle.as_bytes()))
}
fn input(session: &str) -> Input {
    serde_json::from_value(json!({"session_id":session,"input_id":"forbidden","prompt":"must not run","delivery":"steer"})).unwrap()
}

#[tokio::test]
async fn canonical_timeline_paging_and_context_selection_preserve_original_json() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path().join("engine.db")).await.unwrap();
    let mut source: serde_json::Value = serde_json::from_str(&bundle("s")).unwrap();
    source["timeline"] = json!((0..205).map(|i| json!({"id":format!("msg_original_{i}"),"type":"user","text":format!("message {i}"),"time":{"created":123+i},"metadata":{"original":true}})).collect::<Vec<_>>());
    source["context_ids"] = json!(["msg_original_100", "msg_original_204"]);
    let encoded = source.to_string();
    store
        .stage_session_transfer("transfer", encoded.clone(), &digest(&encoded))
        .await
        .unwrap();
    assert_eq!(
        store.snapshot("s").await.unwrap()["transfer_import"],
        "transfer"
    );
    let first = store
        .transfer_messages("s", 0, false, u64::MAX)
        .await
        .unwrap();
    assert_eq!(first["messages"].as_array().unwrap().len(), 100);
    assert_eq!(first["next"], 100);
    let second = store
        .transfer_messages("s", 100, false, u64::MAX)
        .await
        .unwrap();
    assert_eq!(second["next"], 200);
    let third = store
        .transfer_messages("s", 200, false, u64::MAX)
        .await
        .unwrap();
    assert!(third["next"].is_null());
    assert_eq!(third["messages"][4], source["timeline"][204]);
    let context = store
        .transfer_messages("s", 0, true, u64::MAX)
        .await
        .unwrap();
    assert_eq!(
        context["messages"],
        json!([source["timeline"][100], source["timeline"][204]])
    );
    assert!(context["next"].is_null());
    assert_eq!(context["bundle_sha256"], digest(&encoded));
    store.close().await.unwrap();
}

#[tokio::test]
async fn inactive_import_preserves_exact_bundle_and_survives_close_reopen_abort() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    let source = bundle("s");
    let staged = store
        .stage_session_transfer("transfer", source.clone(), &digest(&source))
        .await
        .unwrap();
    assert_eq!(staged.bundle, source);
    assert_eq!(staged.state, "staged");
    assert!(store.migration_active("s").await.unwrap());
    assert!(store.admit(input("s")).await.is_err());
    assert!(store.start_run("s", "forbidden-run").await.is_err());
    assert!(store.snapshot("s").await.unwrap()["active_run"].is_null());
    assert!(store.record("s", "legacy.write", json!({})).await.is_err());
    assert!(store.history("s").await.unwrap().is_empty());
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    let retry = store
        .stage_session_transfer("transfer", source.clone(), &digest(&source))
        .await
        .unwrap();
    assert_eq!(retry.created_ms, staged.created_ms);
    assert_eq!(retry.bundle, source);
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
    assert!(store
        .stage_session_transfer("other", source.clone(), &digest(&source))
        .await
        .is_err());
    store
        .abort_session_transfer_import("transfer")
        .await
        .unwrap();
    store
        .abort_session_transfer_import("transfer")
        .await
        .unwrap();
    assert!(store.migration_active("s").await.unwrap());
    assert!(matches!(
        store
            .stage_session_transfer("transfer", source.clone(), &digest(&source))
            .await,
        Err(Error::Conflict)
    ));
    assert!(store.admit(input("s")).await.is_err());
    assert_eq!(
        store
            .session_transfer_import("transfer")
            .await
            .unwrap()
            .unwrap()
            .bundle,
        source
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn malformed_or_conflicting_import_never_changes_existing_destination() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path().join("engine.db")).await.unwrap();
    let source = bundle("s");
    assert!(matches!(
        store
            .stage_session_transfer("bad-hash", source.clone(), &"0".repeat(64))
            .await,
        Err(Error::Conflict)
    ));
    assert!(store
        .session_transfer_import("bad-hash")
        .await
        .unwrap()
        .is_none());
    let malformed = source.replace(
        "\"context_ids\":[\"canonical-user\"]",
        "\"context_ids\":[\"missing\"]",
    );
    assert_ne!(malformed, source);
    assert!(store
        .stage_session_transfer("bad-context", malformed.clone(), &digest(&malformed))
        .await
        .is_err());
    store
        .initialize("s", "Existing destination", "/existing")
        .await
        .unwrap();
    let before = store.events("s", 0, 100).await.unwrap();
    assert!(store
        .stage_session_transfer("collision", source.clone(), &digest(&source))
        .await
        .is_err());
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), before.len());
    assert!(store
        .session_transfer_import("collision")
        .await
        .unwrap()
        .is_none());
    assert!(!store.migration_active("s").await.unwrap());
    store.admit(input("s")).await.unwrap();
    store.close().await.unwrap();
}
