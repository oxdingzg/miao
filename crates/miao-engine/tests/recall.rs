use miao_engine::{
    protocol::{Delivery, Input},
    recall::Query,
    store::Store,
    tools::Tools,
};
use serde_json::json;
fn query(text: &str, limit: usize, before: Option<u64>) -> Query {
    Query {
        query: text.into(),
        limit,
        before_message_seq: before,
    }
}

#[tokio::test]
async fn recall_searches_raw_compacted_history_without_cross_session_or_opaque_data() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    for session in ["s", "other"] {
        store
            .admit(Input {
                session_id: session.into(),
                input_id: session.into(),
                prompt: "original中文线索".into(),
                delivery: Delivery::Steer,
            })
            .await
            .unwrap();
        store.promote(session, true).await.unwrap();
    }
    let end=store.message("s","assistant",json!([{"type":"text","text":"completed中文线索"},{"type":"provider_opaque","payload":"opaque-only-token"}])).await.unwrap();
    store
        .compact("s", "checkpoint", end.seq, "summary-only-token".into())
        .await
        .unwrap();
    let recalled = store
        .recall("s", query("中文线索", 10, None))
        .await
        .unwrap();
    assert_eq!(recalled["matches"].as_array().unwrap().len(), 2);
    assert_eq!(recalled["matches"][0]["message_seq"], end.seq);
    assert_eq!(recalled["exhausted"], true);
    assert!(store
        .recall("s", query("summary-only-token", 10, None))
        .await
        .unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(store
        .recall("s", query("opaque-only-token", 10, None))
        .await
        .unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
    store
        .message(
            "other",
            "assistant",
            json!([{"type":"text","text":"other-private"}]),
        )
        .await
        .unwrap();
    assert!(store
        .recall("s", query("other-private", 10, None))
        .await
        .unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(store.selected_history("s").await.unwrap().len(), 1);
}

#[tokio::test]
async fn recall_literal_queries_have_stable_cursor_and_unicode_previews() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "start".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    for _ in 0..3 {
        store.message("s","assistant",json!([{"type":"text","text":format!("{}literal %_' 中文标记{}","前".repeat(500),"后".repeat(600))}])).await.unwrap();
    }
    let first = store
        .recall("s", query("%_' 中文标记", 1, None))
        .await
        .unwrap();
    assert_eq!(first["matches"].as_array().unwrap().len(), 1);
    assert_eq!(first["exhausted"], false);
    assert!(first["matches"][0]["preview"]
        .as_str()
        .unwrap()
        .contains("%_' 中文标记"));
    assert_eq!(first["matches"][0]["preview_truncated"], true);
    let second = store
        .recall(
            "s",
            query("%_' 中文标记", 1, first["next_before_message_seq"].as_u64()),
        )
        .await
        .unwrap();
    assert!(
        second["matches"][0]["message_seq"].as_u64().unwrap()
            < first["matches"][0]["message_seq"].as_u64().unwrap()
    );
    assert!(store
        .recall("s", query("literal %_' 中文标记", 1, Some(0)))
        .await
        .unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn recall_input_is_session_local_and_permission_resource_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let prepared = tools
        .prepare("recall", json!({"query":"needle"}))
        .await
        .unwrap();
    assert_eq!(prepared.resource(), "@session/history");
    for value in [
        json!({"query":""}),
        json!({"query":"needle","session_id":"other"}),
        json!({"query":"needle","limit":21}),
        json!({"query":"needle","before_message_seq":-1}),
    ] {
        assert!(tools.prepare("recall", value).await.is_err());
    }
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert!(store.recall("missing", query("", 10, None)).await.is_err());
}

#[tokio::test]
async fn bounded_scan_pages_can_be_empty_and_oversized_rows_do_not_stall_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "needle-old".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    for _ in 0..3 {
        store
            .message(
                "s",
                "assistant",
                json!([{"type":"text","text":"x".repeat(800000)}]),
            )
            .await
            .unwrap();
    }
    let oversized = store
        .message(
            "s",
            "assistant",
            json!([{"type":"text","text":"y".repeat(2097153)}]),
        )
        .await
        .unwrap();
    let first = store
        .recall("s", query("needle-old", 10, None))
        .await
        .unwrap();
    assert!(first["matches"].as_array().unwrap().is_empty());
    assert_eq!(first["exhausted"], false);
    assert_eq!(first["skipped_oversized_message_seqs"][0], oversized.seq);
    let next = store
        .recall(
            "s",
            query("needle-old", 10, first["next_before_message_seq"].as_u64()),
        )
        .await
        .unwrap();
    assert_eq!(next["matches"].as_array().unwrap().len(), 1);
    assert_eq!(next["exhausted"], true);
}
