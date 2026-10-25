use miao_engine::{
    protocol::{Delivery, Error, Input},
    store::Store,
};
use serde_json::json;

fn input(id: &str, delivery: Delivery) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery,
    }
}

#[tokio::test]
async fn lost_ack_is_exact_retry_and_conflicts_do_not_change_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let first = store.admit(input("one", Delivery::Steer)).await.unwrap();
    let retry = store.admit(input("one", Delivery::Steer)).await.unwrap();
    assert!(retry.duplicate);
    assert_eq!(first.admitted_seq, retry.admitted_seq);
    for conflict in [
        Input {
            prompt: "other".into(),
            ..input("one", Delivery::Steer)
        },
        Input {
            session_id: "other".into(),
            ..input("one", Delivery::Steer)
        },
        input("one", Delivery::Queue),
    ] {
        assert!(matches!(store.admit(conflict).await, Err(Error::Conflict)));
    }
    assert!(store.history("s").await.unwrap().is_empty());
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
}

#[tokio::test]
async fn cancelling_a_pending_input_keeps_it_from_being_promoted_or_resurrected() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("drop", Delivery::Queue)).await.unwrap();
    store.admit(input("keep", Delivery::Steer)).await.unwrap();
    assert_eq!(
        store.cancel_input("s", "drop").await.unwrap(),
        json!({"accepted": true, "duplicate": false})
    );
    // An exact retry reports the same accepted outcome and appends no event.
    assert_eq!(
        store.cancel_input("s", "drop").await.unwrap(),
        json!({"accepted": true, "duplicate": true})
    );
    // An exact retry of the cancelled admission conflicts: the identity is
    // dead, so it can neither resurrect the prompt nor report a receipt.
    assert!(matches!(
        store.admit(input("drop", Delivery::Queue)).await,
        Err(Error::Conflict)
    ));
    assert_eq!(store.promote("s", false).await.unwrap().len(), 1);
    assert!(store.promote("s", true).await.unwrap().is_empty());
    assert_eq!(store.history("s").await.unwrap().len(), 1);
    assert_eq!(
        store.cancel_input("s", "missing").await.unwrap(),
        json!({"accepted": false, "reason": "unknown"})
    );
    assert_eq!(
        store.cancel_input("other", "keep").await.unwrap(),
        json!({"accepted": false, "reason": "unknown"})
    );
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        vec![
            "input.admitted",
            "input.admitted",
            "input.cancelled",
            "input.promoted"
        ],
        "the cancel retry appends no second event"
    );
}

#[tokio::test]
async fn cancelling_a_promoted_input_defers_to_the_turn_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("live", Delivery::Steer)).await.unwrap();
    store.promote("s", false).await.unwrap();
    assert_eq!(
        store.cancel_input("s", "live").await.unwrap(),
        json!({"accepted": false, "reason": "promoted"})
    );
    assert_eq!(store.history("s").await.unwrap().len(), 1);
}

#[tokio::test]
async fn an_operator_compaction_request_is_durable_idempotent_and_settled_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert!(matches!(
        store.request_compaction("s").await,
        Err(Error::Invalid(_))
    ));
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    assert_eq!(
        store.request_compaction("s").await.unwrap(),
        json!({"accepted": true, "duplicate": false, "pending": true})
    );
    let request = store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .unwrap();
    // A retried command neither queues a second request nor loses the intent.
    assert_eq!(
        store.request_compaction("s").await.unwrap(),
        json!({"accepted": true, "duplicate": true, "pending": true})
    );
    assert_eq!(
        store.pending_compaction_request("s").await.unwrap(),
        Some(request)
    );
    // One attempt answers it, either way, and a second settle is a no-op.
    assert!(store
        .settle_compaction_request("s", request, false)
        .await
        .unwrap()
        .is_some());
    assert_eq!(store.pending_compaction_request("s").await.unwrap(), None);
    assert!(store
        .settle_compaction_request("s", request, true)
        .await
        .unwrap()
        .is_none());
    // Asking again is what asks for another try.
    assert_eq!(
        store.request_compaction("s").await.unwrap(),
        json!({"accepted": true, "duplicate": false, "pending": true})
    );
    assert!(store
        .pending_compaction_request("s")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn archiving_is_reversible_and_never_invents_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    assert!(matches!(
        store.set_archived("s", true).await,
        Err(Error::Invalid(_))
    ));
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    assert!(store.snapshot("s").await.unwrap()["archived_at_ms"].is_null());
    assert_eq!(
        store.set_archived("s", true).await.unwrap(),
        json!({"accepted": true, "archived": true})
    );
    assert!(store.snapshot("s").await.unwrap()["archived_at_ms"].is_number());
    // Archiving is a catalog fact: the admitted input is untouched.
    assert_eq!(store.promote("s", false).await.unwrap().len(), 1);
    assert_eq!(
        store.set_archived("s", false).await.unwrap(),
        json!({"accepted": true, "archived": false})
    );
    assert!(store.snapshot("s").await.unwrap()["archived_at_ms"].is_null());
}

#[tokio::test]
async fn removing_a_session_deletes_its_rows_and_orphans_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(input("parent-input", Delivery::Steer))
        .await
        .unwrap();
    store.promote("s", false).await.unwrap();
    store.fork("s", "child", None).await.unwrap();
    assert_eq!(store.sessions().await.unwrap().len(), 2);
    assert_eq!(
        store.remove_session("s").await.unwrap(),
        json!({"accepted": true})
    );
    // The child keeps its own rows and becomes a root instead of failing on the
    // lineage foreign key.
    assert_eq!(store.sessions().await.unwrap(), vec!["child".to_owned()]);
    let snapshot = store.snapshot("child").await.unwrap();
    assert!(snapshot["parent_session_id"].is_null(), "{snapshot}");
    assert_eq!(store.history("child").await.unwrap().len(), 1);
    assert!(
        !store.events("child", 0, 100).await.unwrap().is_empty(),
        "the child keeps its own ledger"
    );
    // Nothing of the parent survives, and a retry reports rather than refuses.
    assert!(matches!(store.snapshot("s").await, Err(Error::Invalid(_))));
    assert!(store.events("s", 0, 100).await.unwrap().is_empty());
    assert!(store.history("s").await.unwrap().is_empty());
    assert!(store.wakeups("s").await.unwrap().is_empty());
    assert_eq!(
        store.remove_session("s").await.unwrap(),
        json!({"accepted": false, "reason": "unknown"})
    );
}

#[tokio::test]
async fn an_agent_selection_is_derived_from_the_ledger_and_idempotent() {
    use miao_engine::session_agent::{AgentManifest, AgentTools};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let manifest = AgentManifest {
        name: "reviewer".into(),
        semantics: Some("product-agent-v1".into()),
        instructions: Some("Review the diff before answering.".into()),
        tools: Some(AgentTools {
            allow: vec!["read_file".into()],
            deny: vec!["run_command".into()],
        }),
        permission_mode: None,
        permissions: None,
        ordered_permissions: None,
        model: None,
        mode: None,
        request: None,
        steps: None,
        budget: None,
    };
    assert!(matches!(
        store.set_agent("s", manifest.clone()).await,
        Err(Error::Invalid(_))
    ));
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    assert!(store.agent("s").await.unwrap().is_none());
    assert!(store.snapshot("s").await.unwrap()["agent"].is_null());
    let applied = store.set_agent("s", manifest.clone()).await.unwrap();
    assert_eq!(applied["changed"], true);
    let hash = applied["agent_hash"].as_str().unwrap().to_owned();
    let (recorded, recorded_hash) = store.agent("s").await.unwrap().unwrap();
    assert_eq!(recorded.name, "reviewer");
    assert_eq!(recorded_hash, hash);
    assert_eq!(
        store.snapshot("s").await.unwrap()["agent"]["name"],
        "reviewer"
    );
    // The same manifest is the same selection: no second event, no new hash.
    assert_eq!(
        store.set_agent("s", manifest.clone()).await.unwrap(),
        json!({"agent_hash": hash, "changed": false})
    );
    let mut changed = manifest.clone();
    changed.instructions = Some("Answer with a diff summary.".into());
    let next = store.set_agent("s", changed).await.unwrap();
    assert_eq!(next["changed"], true);
    assert_ne!(next["agent_hash"].as_str().unwrap(), hash);
    assert_eq!(
        store
            .events("s", 0, 500)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "session.agent.selected")
            .count(),
        2
    );
}

#[tokio::test]
async fn an_agent_manifest_is_bounded() {
    use miao_engine::session_agent::{AgentManifest, AgentTools};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    let manifest =
        |name: String, instructions: Option<String>, tools: Option<AgentTools>| AgentManifest {
            name,
            semantics: None,
            instructions,
            tools,
            permission_mode: None,
            permissions: None,
            ordered_permissions: None,
            model: None,
            mode: None,
            request: None,
            steps: None,
            budget: None,
        };
    assert!(matches!(
        store.set_agent("s", manifest("".into(), None, None)).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .set_agent("s", manifest("x".repeat(129), None, None))
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .set_agent(
                "s",
                manifest("ok".into(), Some("x".repeat(64 * 1024 + 1)), None)
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .set_agent(
                "s",
                manifest(
                    "ok".into(),
                    None,
                    Some(AgentTools {
                        allow: vec!["".into()],
                        deny: vec![],
                    }),
                ),
            )
            .await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn promotion_serializes_admissions_and_queues_only_at_idle() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("queued", Delivery::Queue)).await.unwrap();
    assert!(store.promote("s", false).await.unwrap().is_empty());
    store.admit(input("steer1", Delivery::Steer)).await.unwrap();
    store.admit(input("steer2", Delivery::Steer)).await.unwrap();
    assert_eq!(store.promote("s", false).await.unwrap().len(), 2);
    assert_eq!(store.history("s").await.unwrap().len(), 2);
    assert!(store.promote("s", false).await.unwrap().is_empty());
    assert_eq!(store.promote("s", true).await.unwrap().len(), 1);
    assert!(store.promote("s", true).await.unwrap().is_empty());
    let events = store.events("s", 3, 100).await.unwrap();
    assert_eq!(
        events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![4, 5, 6]
    );
}

#[tokio::test]
async fn lease_rejects_second_runtime_and_recovery_never_repeats_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    assert!(matches!(Store::open(&path).await, Err(Error::Busy)));
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    store
        .tool_dispatch("s", "run", "call", "write", json!({"path":"file"}))
        .await
        .unwrap();
    let events = store.recover().await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data["reason"], "interrupted");
    assert!(store.recover().await.unwrap().is_empty());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let state: String = conn
        .query_row("SELECT state FROM engine_tool WHERE id='call'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "unknown");
    assert!(store.tool_settle("s", "call", json!({})).await.is_err());
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "tool.dispatched")
            .count(),
        1
    );
}

#[tokio::test]
async fn message_projection_and_event_have_one_committed_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    let event = store
        .message("s", "assistant", json!([{"type":"text","text":"answer"}]))
        .await
        .unwrap();
    assert_eq!(event.seq, 2);
    assert_eq!(
        store.history("s").await.unwrap()[0].content[0]["text"],
        "answer"
    );
    assert_eq!(
        store.events("s", 1, 100).await.unwrap()[0].data["content"][0]["text"],
        "answer"
    );
}

/// A subscriber replays from a cursor to a captured high-watermark and then
/// hands off to live events after it. The durable ledger is the single source
/// both sides read, so the handoff has no gap and no duplicate: paging from the
/// watermark resumes exactly at the next committed event, and re-reading the
/// whole ledger reproduces the same ordered sequence.
#[tokio::test]
async fn replay_to_watermark_then_live_has_no_gap_or_duplicate() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store
        .message("s", "assistant", json!([{"type":"text","text":"a"}]))
        .await
        .unwrap();

    let mut replayed = Vec::new();
    let mut cursor = 0u64;
    loop {
        let page = store.events("s", cursor, 1).await.unwrap();
        if page.is_empty() {
            break;
        }
        replayed.extend(page.iter().map(|event| event.seq));
        cursor = page.last().unwrap().seq;
    }
    let watermark = cursor;
    assert_eq!(replayed, (1..=watermark).collect::<Vec<_>>());

    store
        .message("s", "assistant", json!([{"type":"text","text":"b"}]))
        .await
        .unwrap();
    let live: Vec<u64> = store
        .events("s", watermark, 100)
        .await
        .unwrap()
        .iter()
        .map(|event| event.seq)
        .collect();
    assert_eq!(live, vec![watermark + 1]);

    let full: Vec<u64> = store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .map(|event| event.seq)
        .collect();
    let mut combined = replayed;
    combined.extend(live);
    assert_eq!(combined, full);
}

#[tokio::test]
async fn reply_identity_is_atomic_replayable_and_preserved_when_forked() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("engine.db");
    let store = Store::open(&db).await.unwrap();
    store.admit(input("one", Delivery::Steer)).await.unwrap();
    store.promote("s", false).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    let started = store
        .record("s", "provider.started", json!({"run_id":"run","step":2}))
        .await
        .unwrap();
    let content = json!([{"type":"text","text":"answer"}]);
    let committed = store
        .assistant_reply_profiled(
            "s",
            "run",
            2,
            Some(started.seq),
            content.clone(),
            Some(miao_engine::provider::Identity {
                protocol: "openai-chat".into(),
                model: "actual-secondary".into(),
            }),
        )
        .await
        .unwrap();
    let events = store.events("s", committed.seq, 100).await.unwrap();
    assert_eq!(committed.data["anchor_seq"], started.seq);
    assert_eq!(events[0].data["anchor_seq"], started.seq);
    assert_eq!(events[0].kind, "assistant.identity");
    assert_eq!(events[0].data["assistant_seq"], committed.seq);
    assert_eq!(events[0].data["run_id"], "run");
    assert_eq!(events[0].data["step"], 2);
    assert_eq!(events[0].recorded_at_ms, committed.recorded_at_ms);
    assert!(events[0].data["agent"].is_null());
    store.fork("s", "copy", Some(committed.seq)).await.unwrap();
    let snapshot = store.snapshot("copy").await.unwrap();
    let assistant = snapshot["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(
        assistant["identity"]["provider"]["model"],
        "actual-secondary"
    );
    assert_eq!(assistant["identity"]["assistant_seq"], assistant["seq"]);
    assert!(assistant["identity"].get("anchor_seq").is_none());
    assert_eq!(
        assistant["identity"]["origin"]["assistant_seq"],
        committed.seq
    );
    assert_eq!(
        store.history("copy").await.unwrap().last().unwrap().content,
        content
    );
    store.close().await.unwrap();
    let reopened = Store::open(&db).await.unwrap();
    assert_eq!(
        reopened.events("s", committed.seq, 100).await.unwrap()[0].data,
        events[0].data
    );
    let unknown = reopened
        .assistant_reply_profiled(
            "s",
            "run",
            3,
            None,
            json!([{"type":"text","text":"unknown"}]),
            None,
        )
        .await
        .unwrap();
    assert!(reopened.events("s", unknown.seq, 10).await.unwrap()[0].data["provider"].is_null());
    assert!(reopened
        .assistant_reply_profiled("s", "missing-run", 4, None, json!([]), None)
        .await
        .is_err());
    assert_eq!(
        reopened.events("s", unknown.seq, 10).await.unwrap().len(),
        1
    );
    let mut jsonl = Vec::new();
    miao_engine::export::committed_events(&db, "s", committed.seq, &mut jsonl).unwrap();
    let exported: Vec<serde_json::Value> = String::from_utf8(jsonl)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(exported[0]["kind"], "assistant.identity");
    assert_eq!(exported[0]["data"], events[0].data);
}

#[tokio::test]
async fn explicit_close_releases_the_lease_before_immediate_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("close.db");
    let store = Store::open(&path).await.unwrap();
    let clone = store.clone();
    assert!(matches!(
        clone.close().await,
        Err(miao_engine::protocol::Error::Busy)
    ));
    assert!(matches!(
        Store::open(&path).await,
        Err(miao_engine::protocol::Error::Busy)
    ));
    store.close().await.unwrap();
    for _ in 0..20 {
        let reopened = Store::open(&path).await.unwrap();
        reopened.close().await.unwrap();
    }
}
