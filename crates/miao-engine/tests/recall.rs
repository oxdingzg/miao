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
        tool_use_id: None,
        offset: 0,
    }
}
fn handle(tool_use_id: &str, offset: usize) -> Query {
    Query {
        query: String::new(),
        limit: 10,
        before_message_seq: None,
        tool_use_id: Some(tool_use_id.into()),
        offset,
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
        json!({"tool_use_id":""}),
        json!({"tool_use_id":"h","query":"needle"}),
        json!({"tool_use_id":"h","before_message_seq":3}),
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

#[tokio::test]
async fn an_archived_tool_output_comes_back_by_handle_across_bounded_windows() {
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
    // The stored payload is what pruning later elides from the wire.
    let payload =
        json!({"stdout": format!("{}MARKER-MIDDLE{}", "h".repeat(40000), "t".repeat(40000))})
            .to_string();
    let recorded = store
        .message(
            "s",
            "assistant",
            json!([{"type":"tool_result","tool_use_id":"call-1","content":payload,"is_error":true}]),
        )
        .await
        .unwrap();
    let first = store.recall("s", handle("call-1", 0)).await.unwrap();
    assert_eq!(first["message_seq"], recorded.seq);
    assert_eq!(first["is_error"], true);
    assert_eq!(first["offset"], 0);
    assert_eq!(first["total_bytes"].as_u64().unwrap(), payload.len() as u64);
    assert_eq!(first["truncated"], true);
    let window = first["text"].as_str().unwrap();
    assert_eq!(window.len(), 32768);
    assert!(window.is_char_boundary(window.len()));
    let next = store
        .recall(
            "s",
            handle("call-1", first["next_offset"].as_u64().unwrap() as usize),
        )
        .await
        .unwrap();
    assert_eq!(next["offset"], first["next_offset"]);
    assert_eq!(next["truncated"], false);
    assert_eq!(next["next_offset"], Value::Null);
    // Both windows together restore the whole stored output, including the
    // middle a single search preview never returns.
    let restored = format!("{}{}", window, next["text"].as_str().unwrap());
    assert_eq!(restored.len(), payload.len());
    assert!(restored.contains("MARKER-MIDDLE"));

    let missing = store.recall("s", handle("call-missing", 0)).await.unwrap();
    assert_eq!(missing["message_seq"], Value::Null);
    assert_eq!(missing["text"], Value::Null);
    assert_eq!(missing["exhausted"], true);
    assert!(store.recall("other", handle("call-1", 0)).await.unwrap()["text"].is_null());
}
