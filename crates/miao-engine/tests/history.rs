use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};
use serde_json::json;

async fn seed(store: &Store) -> u64 {
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "old task".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"completed task"}]),
        )
        .await
        .unwrap()
        .seq
}

#[tokio::test]
async fn checkpoint_changes_selected_history_without_deleting_raw_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let boundary = seed(&store).await;
    store
        .message("s", "user", json!([{"type":"text","text":"next task"}]))
        .await
        .unwrap();
    let before = store.history("s").await.unwrap();
    assert_eq!(
        store
            .compact(
                "s",
                "cut",
                boundary,
                "Finished old task; preserve next task.".into()
            )
            .await
            .unwrap()["duplicate"],
        false
    );
    let selected = store.selected_history("s").await.unwrap();
    assert_eq!(selected.len(), 2);
    assert!(selected[0].content[0]["text"]
        .as_str()
        .unwrap()
        .contains("Finished old task"));
    assert_eq!(selected[1].content[0]["text"], "next task");
    assert_eq!(
        serde_json::to_value(store.history("s").await.unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(
        store
            .compact(
                "s",
                "cut",
                boundary,
                "Finished old task; preserve next task.".into()
            )
            .await
            .unwrap()["duplicate"],
        true
    );
    assert!(matches!(
        store
            .compact("s", "cut", boundary, "different".into())
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "history.compacted")
            .count(),
        1
    );
}

#[tokio::test]
async fn active_or_open_tool_boundaries_cannot_be_compacted() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let boundary = seed(&store).await;
    store.start_run("s", "run").await.unwrap();
    assert!(store
        .compact("s", "active", boundary, "summary".into())
        .await
        .is_err());
    let call=store.assistant_reply("s","run",json!([{"type":"text","text":"calling"},{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}])).await.unwrap();
    store.finish_run("s", "run", "interrupted").await.unwrap();
    assert!(store
        .compact("s", "open", call.seq, "summary".into())
        .await
        .is_err());
    let final_reply = store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"settled interrupted tool"}]),
        )
        .await
        .unwrap();
    store
        .compact(
            "s",
            "closed",
            final_reply.seq,
            "The tool did not execute.".into(),
        )
        .await
        .unwrap();
    assert_eq!(store.selected_history("s").await.unwrap().len(), 1);
}

#[tokio::test]
async fn oversized_history_can_be_checkpointed_by_streaming_validation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    seed(&store).await;
    let large = store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"x".repeat(2*1024*1024)}]),
        )
        .await
        .unwrap();
    assert!(store.selected_history("s").await.is_err());
    store
        .compact(
            "s",
            "large",
            large.seq,
            "Long completed output omitted; task succeeded.".into(),
        )
        .await
        .unwrap();
    assert_eq!(store.selected_history("s").await.unwrap().len(), 1);
    assert_eq!(store.history("s").await.unwrap().len(), 3);
}

#[tokio::test]
async fn default_fork_inherits_effective_checkpoint_and_old_explicit_fork_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let boundary = seed(&store).await;
    store
        .compact("s", "cut", boundary, "Old task completed.".into())
        .await
        .unwrap();
    store.fork("s", "default", None).await.unwrap();
    assert_eq!(store.selected_history("default").await.unwrap().len(), 1);
    assert_eq!(store.history("default").await.unwrap().len(), 2);
    store.fork("s", "historical", Some(boundary)).await.unwrap();
    assert_eq!(store.selected_history("historical").await.unwrap().len(), 2);
    assert!(store
        .compact("s", "backwards", boundary - 1, "invalid".into())
        .await
        .is_err());
}
