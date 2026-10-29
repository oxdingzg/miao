//! Paging the stored transcript without serializing the whole Session: the
//! recent tail a preview or a bottom-anchored transcript needs.
use miao_engine::{
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::json;

async fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.initialize("s", "session", "/tmp").await.unwrap();
    (dir, store)
}

fn prompt(text: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".to_owned(),
        input_id: text.to_owned(),
        prompt: text.to_owned(),
        delivery: Delivery::Steer,
    }
}

/// Admit and promote one prompt, returning the seq of its message.
async fn say(store: &Store, text: &str) -> u64 {
    store.admit(prompt(text)).await.unwrap();
    store
        .promote("s", true)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "input.promoted")
        .map(|event| event.seq)
        .unwrap()
}

#[tokio::test]
async fn an_empty_session_has_no_page_and_no_cursor() {
    let (_dir, store) = store().await;
    let page = store.history_page("s", None, 10).await.unwrap();
    assert_eq!(page["messages"], json!([]));
    assert_eq!(page["has_more"], false);
    assert_eq!(page["next_before"], serde_json::Value::Null);
    // An identity that does not exist is not an empty transcript.
    assert!(store.history_page("missing", None, 10).await.is_err());
}

#[tokio::test]
async fn a_page_is_the_recent_tail_and_its_cursor_walks_backwards() {
    let (_dir, store) = store().await;
    let mut seqs = Vec::new();
    for text in ["first", "second", "third"] {
        seqs.push(say(&store, text).await);
    }

    let newest = store.history_page("s", None, 2).await.unwrap();
    let messages = newest["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "{newest}");
    // Oldest-to-newest inside the page, even though the read walks backwards.
    assert_eq!(messages[0]["seq"], seqs[1]);
    assert_eq!(messages[1]["seq"], seqs[2]);
    assert_eq!(messages[1]["content"][0]["text"], "third");
    assert_eq!(newest["has_more"], true);
    assert_eq!(newest["next_before"], seqs[1]);

    let older = store
        .history_page("s", newest["next_before"].as_u64(), 2)
        .await
        .unwrap();
    let messages = older["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{older}");
    assert_eq!(messages[0]["seq"], seqs[0]);
    assert_eq!(older["has_more"], false);
    assert_eq!(older["next_before"], serde_json::Value::Null);

    // A limit past the end is the whole transcript, not an error.
    let all = store.history_page("s", None, 500).await.unwrap();
    assert_eq!(all["messages"].as_array().unwrap().len(), 3);
    assert_eq!(all["has_more"], false);
}

#[tokio::test]
async fn reverted_messages_leave_the_page_and_injected_context_is_marked() {
    let (_dir, store) = store().await;
    let first = say(&store, "keep me").await;
    let injected = store
        .inject("s", "ctx", "observed state", "compaction")
        .await
        .unwrap();
    let reverted = say(&store, "drop me").await;
    let page = store.history_page("s", None, 10).await.unwrap();
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3, "{page}");
    // The injected context is a user-row message with an explicit flag.
    let synthetic = messages
        .iter()
        .find(|message| message["synthetic"] == true)
        .expect("synthetic message");
    assert_eq!(synthetic["seq"], injected["seq"]);
    assert!(synthetic["seq"].as_u64().unwrap() > first);
    assert!(synthetic["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("compaction"));

    let checkpoint = store
        .history("s")
        .await
        .unwrap()
        .last()
        .and_then(|message| message.checkpoint.clone())
        .unwrap();
    store.revert("s", &checkpoint).await.unwrap();
    let page = store.history_page("s", None, 10).await.unwrap();
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "{page}");
    assert_eq!(messages[0]["seq"], first);
    // Revert hides the boundary message onwards; earlier context stays.
    assert!(messages.iter().all(|message| message["seq"] != reverted));
    assert_eq!(messages[1]["seq"], synthetic["seq"]);
}
