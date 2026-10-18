use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;
use std::{io::Write, process::Command};

async fn plan(store: &Store, run: &str, input: &str) {
    store
        .admit(Input {
            session_id: "session".into(),
            input_id: input.into(),
            prompt: "append one line".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("session", true).await.unwrap();
    store.start_run("session", run).await.unwrap();
    store
        .assistant_reply(
            "session",
            run,
            None,
            json!([{"type":"tool_use","id":"provider-call","name":"bash","input":{"command":"append"}}]),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn crash_after_external_effect() {
    let Some(directory) = std::env::var_os("MIAO_DISPATCH_CRASH_FIXTURE") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let store = Store::open(directory.join("engine.db")).await.unwrap();
    plan(&store, "first-attempt", "first-input").await;
    store
        .mark_dispatched("session", "first-attempt", "provider-call")
        .await
        .unwrap();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(directory.join("effects"))
        .unwrap();
    writeln!(file, "external-effect").unwrap();
    file.sync_all().unwrap();
    // Exit before settlement without dropping the Store or draining its actor.
    std::process::exit(71);
}

#[tokio::test]
async fn consumed_dispatch_survives_a_process_crash_without_swallowing_a_new_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_after_external_effect", "--nocapture"])
        .env("MIAO_DISPATCH_CRASH_FIXTURE", directory.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(71));
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    store.recover_session(Some("session")).await.unwrap();
    assert!(store
        .mark_dispatched("session", "first-attempt", "provider-call")
        .await
        .is_err());
    let recovery = store.recoveries("session", "").await.unwrap();
    assert_eq!(
        recovery["calls"][0]["call_id"],
        "first-attempt/provider-call"
    );
    assert_eq!(recovery["calls"][0]["outcome"], "unknown");
    assert_eq!(
        std::fs::read_to_string(directory.path().join("effects")).unwrap(),
        "external-effect\n"
    );

    // A different user turn is a new attempt, even for identical provider IDs,
    // tool names and inputs. A global Session-wide dedupe would lose this call.
    plan(&store, "second-attempt", "second-input").await;
    store
        .mark_dispatched("session", "second-attempt", "provider-call")
        .await
        .unwrap();
    assert!(store
        .mark_dispatched("session", "second-attempt", "provider-call")
        .await
        .is_err());
    store
        .tool_result(
            "session",
            "second-attempt",
            "provider-call",
            json!({"written":true}),
            false,
        )
        .await
        .unwrap();
    assert!(store
        .mark_dispatched("session", "second-attempt", "provider-call")
        .await
        .is_err());
}
