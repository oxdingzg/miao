//! AGT-01 slice 1: a parent can list its delegated Sessions and tell which one
//! is still working, straight from the engine store.
use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::Value;

async fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("parent", "parent", "/tmp").await.unwrap();
    (dir, store)
}

fn prompt(session: &str, input_id: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.to_owned(),
        input_id: input_id.to_owned(),
        prompt: input_id.to_owned(),
        delivery: Delivery::Steer,
    }
}

/// Admit and promote one user prompt, returning the seq it occupies.
async fn say(store: &Store, session: &str, input_id: &str) -> u64 {
    store.admit(prompt(session, input_id)).await.unwrap();
    store
        .promote(session, true)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "input.promoted")
        .map(|event| event.seq)
        .unwrap()
}

#[tokio::test]
async fn a_session_without_children_answers_an_empty_list() {
    let (_dir, store) = store().await;
    let children = store.children("parent", 10).await.unwrap();
    assert_eq!(children["session_id"], "parent");
    assert_eq!(children["children"].as_array().unwrap().len(), 0);
    assert_eq!(children["truncated"], false);
    // An identity that does not exist is not the same answer as "no children".
    assert!(store.children("missing", 10).await.is_err());
}

#[tokio::test]
async fn forked_children_keep_their_boundary_and_archived_ones_stay_visible() {
    let (_dir, store) = store().await;
    let seq = say(&store, "parent", "first ask").await;

    store.fork("parent", "first", Some(seq)).await.unwrap();
    store.fork("parent", "second", Some(seq)).await.unwrap();
    store.rename("second", "second child").await.unwrap();
    store.set_archived("second", true).await.unwrap();

    let children = store.children("parent", 10).await.unwrap();
    let list = children["children"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{children}");
    assert_eq!(list[0]["session_id"], "first");
    assert_eq!(list[0]["parent_message_seq"], seq);
    // A fork starts with no title of its own; the parent shows what it has
    // rather than inventing one.
    assert_eq!(list[0]["title"], "");
    // A fork copies the parent's history up to the boundary.
    assert_eq!(list[0]["message_count"], 1);
    assert_eq!(list[1]["session_id"], "second");
    assert_eq!(list[1]["title"], "second child");
    // Archiving hides a Session from the catalog, not from its parent.
    assert!(list[1]["archived_at_ms"].is_u64(), "{children}");
    // A fork that never ran has no run to report.
    assert_eq!(list[0]["run"], Value::Null);
    assert_eq!(list[0]["status"], "idle");
}

#[tokio::test]
async fn a_running_child_is_busy_and_a_finished_one_names_its_outcome() {
    let (_dir, store) = store().await;
    store.fork("parent", "worker", None).await.unwrap();
    say(&store, "worker", "work").await;
    store.start_run("worker", "run-1").await.unwrap();

    let busy = store.children("parent", 10).await.unwrap();
    assert_eq!(busy["children"][0]["status"], "busy", "{busy}");
    assert_eq!(busy["children"][0]["run"]["id"], "run-1");
    assert_eq!(busy["children"][0]["run"]["state"], "running");
    assert!(
        busy["children"][0]["run"]["started_at_ms"].is_u64(),
        "{busy}"
    );
    assert_eq!(busy["children"][0]["message_count"], 1);

    store
        .finish_run("worker", "run-1", "completed")
        .await
        .unwrap();
    let idle = store.children("parent", 10).await.unwrap();
    assert_eq!(idle["children"][0]["status"], "idle", "{idle}");
    assert_eq!(idle["children"][0]["run"]["state"], "completed");

    // A later run is the one that speaks for the child.
    store.start_run("worker", "run-2").await.unwrap();
    let again = store.children("parent", 10).await.unwrap();
    assert_eq!(again["children"][0]["run"]["id"], "run-2");
    assert_eq!(again["children"][0]["status"], "busy");
}

#[tokio::test]
async fn a_bounded_answer_says_how_many_children_it_left_out() {
    let (_dir, store) = store().await;
    for name in ["a", "b", "c"] {
        store.fork("parent", name, None).await.unwrap();
    }
    let bounded = store.children("parent", 2).await.unwrap();
    assert_eq!(bounded["children"].as_array().unwrap().len(), 2);
    assert_eq!(bounded["truncated"], true);
    let exact = store.children("parent", 3).await.unwrap();
    assert_eq!(exact["children"].as_array().unwrap().len(), 3);
    assert_eq!(exact["truncated"], false);
}
