//! Runtime wiring regressions for automatic compaction (gates 1-6): the
//! executor respects the trigger, feeds the breaker on every rejection, emits
//! gate-6 progress between the store's transactional lifecycle events, and
//! commits through the run-owned checkpoint contract.

use miao_engine::{
    context_trigger::{maybe_compact, Breaker, Budget, CompactRequest},
    protocol::{Delivery, Input},
    provider::CountTokens,
    store::Store,
};
use serde_json::{json, Value};

async fn seeded() -> (tempfile::TempDir, Store, u64, u64) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "first question".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "two".into(),
            prompt: "second question".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store.start_run("s", "run").await.unwrap();
    let started = store
        .record("s", "provider.started", json!({"run_id":"run","step":0}))
        .await
        .unwrap();
    // A usage report lands before the reply it describes is committed, so the
    // marker is the highest message seq at that moment and the reply is the one
    // message the report did not count.
    let counted_through = store.max_message_seq("s").await.unwrap();
    let boundary = store
        .assistant_reply_profiled(
            "s",
            "run",
            0,
            Some(started.seq),
            json!([{"type":"text","text":"answer one"}]),
            None,
            None,
        )
        .await
        .unwrap()
        .seq;
    (dir, store, boundary, counted_through)
}

fn budget() -> Budget {
    Budget {
        window: Some(2_000),
        ratio: 0.5,
        headroom: 0,
    }
}

#[tokio::test]
async fn below_threshold_leaves_the_session_untouched() {
    let (_dir, store, boundary, _counted) = seeded().await;
    let mut notices: Vec<Value> = Vec::new();
    let mut breaker = Breaker::new(2);
    let mut calls = 0;
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 8,
            breaker: &mut breaker,
            notify: &mut |notice: Value| notices.push(notice),
            count: &mut |_messages| Box::pin(async { CountTokens::Unsupported }),
        },
        |body| {
            calls += 1;
            let _ = body;
            async { Ok("summary".into()) }
        },
    )
    .await
    .unwrap();
    assert!(!committed);
    assert_eq!(calls, 0);
    assert!(notices.is_empty());
}

#[tokio::test]
async fn trigger_summarizes_by_plan_and_commits_the_run_checkpoint() {
    let (_dir, store, boundary, counted) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100},"context_message_seq":counted}),
        )
        .await
        .unwrap();
    let mut notices: Vec<Value> = Vec::new();
    let mut breaker = Breaker::new(2);
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |notice: Value| notices.push(notice),
            count: &mut |_messages| Box::pin(async { CountTokens::Unsupported }),
        },
        |body| async move { Ok(format!("part<{}>", body.len())) },
    )
    .await
    .unwrap();
    assert!(committed);
    // Two messages planned at one per pass: two summarizer calls, two progress
    // notices, one finished notice.
    let kinds: Vec<String> = {
        let mut kinds = Vec::new();
        for notice in &notices {
            kinds.push(notice["kind"].as_str().unwrap().to_owned());
        }
        kinds
    };
    assert_eq!(
        kinds,
        vec![
            "compaction.started",
            "compaction.progress",
            "compaction.progress",
            "compaction.progress",
            "compaction.finished"
        ]
    );
    let selected = store.selected_history("s").await.unwrap();
    assert_eq!(selected.len(), 1);
    assert!(selected[0]
        .content
        .to_string()
        .contains("<history-summary>"));
    let lifecycle: Vec<_> = store
        .events("s", 0, 200)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| {
            matches!(
                event.kind.as_str(),
                "pre_compact" | "history.compacted" | "post_compact"
            )
        })
        .map(|event| event.kind)
        .collect();
    assert_eq!(
        lifecycle,
        vec!["pre_compact", "history.compacted", "post_compact"]
    );
}

#[tokio::test]
async fn a_failing_summarizer_trips_the_breaker_and_keeps_history() {
    let (_dir, store, boundary, counted) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100},"context_message_seq":counted}),
        )
        .await
        .unwrap();
    let mut notices: Vec<Value> = Vec::new();
    let mut breaker = Breaker::new(1);
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |notice: Value| notices.push(notice),
            count: &mut |_messages| Box::pin(async { CountTokens::Unsupported }),
        },
        |_body| async { Err("summarizer refused".into()) },
    )
    .await
    .unwrap();
    assert!(!committed);
    assert!(!store
        .events("s", 0, 200)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "history.compacted"));
    // The breaker tripped: the next attempt is skipped without calling the
    // summarizer again.
    let mut calls = 0;
    let second = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |notice: Value| notices.push(notice),
            count: &mut |_messages| Box::pin(async { CountTokens::Unsupported }),
        },
        |_body| {
            calls += 1;
            async { Ok("summary".into()) }
        },
    )
    .await
    .unwrap();
    assert!(!second);
    assert_eq!(calls, 0);
    let skipped = &notices;
    assert!(skipped
        .iter()
        .any(|notice: &Value| notice["kind"] == "compaction.skipped"));
}

#[tokio::test]
async fn gate_two_counts_the_delta_since_the_anchor() {
    // The anchor covers everything the last usage report counted; only the reply
    // that landed after it is uncounted, and the provider's own endpoint prices
    // it (gate ②). Anchor 110 + counted 950 crosses the 1000 limit, which the
    // old whole-history estimate would not have.
    let (_dir, store, boundary, counted) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":100,"outputTokens":10},"context_message_seq":counted}),
        )
        .await
        .unwrap();
    let mut notices: Vec<Value> = Vec::new();
    let mut breaker = Breaker::new(2);
    let mut seen: Vec<usize> = Vec::new();
    let mut calls = 0;
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |notice: Value| notices.push(notice),
            count: &mut |messages| {
                seen.push(messages.len());
                Box::pin(async { CountTokens::Counted(950) })
            },
        },
        |_body| {
            calls += 1;
            async { Ok("summary".into()) }
        },
    )
    .await
    .unwrap();
    assert!(committed, "110 + 950 crosses the limit");
    assert_eq!(
        seen,
        vec![1],
        "counted={counted} selected={} calls={calls}",
        store.selected_history("s").await.unwrap().len()
    );
    assert!(calls > 0, "the summary ran");
}

#[tokio::test]
async fn a_report_without_the_anchor_marker_leaves_the_trigger_off() {
    // A usage event recorded before the anchor existed reports no marker, so
    // nothing is invented: no count is requested and no checkpoint is written.
    let (_dir, store, boundary, _) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100}}),
        )
        .await
        .unwrap();
    let mut breaker = Breaker::new(2);
    let mut counted = 0;
    let mut calls = 0;
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |_: Value| {},
            count: &mut |_messages| {
                counted += 1;
                Box::pin(async { CountTokens::Unsupported })
            },
        },
        |_body| {
            calls += 1;
            async { Ok("summary".into()) }
        },
    )
    .await
    .unwrap();
    assert!(!committed);
    assert_eq!(counted, 0);
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn an_unsupported_count_falls_back_to_the_delta_estimate() {
    // Gate ②'s fallback: a provider without a count endpoint still triggers from
    // the estimate of the uncounted delta when the anchor is already high.
    let (_dir, store, boundary, counted) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100},"context_message_seq":counted}),
        )
        .await
        .unwrap();
    let mut breaker = Breaker::new(2);
    let mut calls = 0;
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary,
            forced: false,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            notify: &mut |_: Value| {},
            count: &mut |_messages| Box::pin(async { CountTokens::Failed("refused".into()) }),
        },
        |_body| {
            calls += 1;
            async { Ok("summary".into()) }
        },
    )
    .await
    .unwrap();
    assert!(committed, "the anchored 2000 already crosses the limit");
    assert!(calls > 0, "the summary ran");
}
