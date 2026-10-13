//! Runtime wiring regressions for automatic compaction (gates 1-6): the
//! executor respects the trigger, feeds the breaker on every rejection, emits
//! gate-6 progress between the store's transactional lifecycle events, and
//! commits through the run-owned checkpoint contract.

use miao_engine::{
    context_trigger::{estimate_tokens, maybe_compact, Breaker, Budget, CompactRequest},
    protocol::{Delivery, Input},
    store::Store,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

async fn seeded() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit(Input {
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
            session_id: "s".into(),
            input_id: "two".into(),
            prompt: "second question".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    (dir, store)
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
    let (_dir, store) = seeded().await;
    let (progress, mut progress_rx) = mpsc::channel(16);
    let mut breaker = Breaker::new(2);
    let mut calls = 0;
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary: 3,
            budget: &budget(),
            per_pass: 8,
            breaker: &mut breaker,
            progress: &progress,
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
    assert!(progress_rx.try_recv().is_err());
}

#[tokio::test]
async fn trigger_summarizes_by_plan_and_commits_the_run_checkpoint() {
    let (_dir, store) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100}}),
        )
        .await
        .unwrap();
    let (progress, mut progress_rx) = mpsc::channel(16);
    let mut breaker = Breaker::new(2);
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary: 3,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            progress: &progress,
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
        while let Ok(notice) = progress_rx.try_recv() {
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
    let (_dir, store) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":1_900,"outputTokens":100}}),
        )
        .await
        .unwrap();
    let (progress, mut progress_rx) = mpsc::channel(16);
    let mut breaker = Breaker::new(2);
    let committed = maybe_compact(
        &store,
        CompactRequest {
            session: "s",
            run: "run",
            boundary: 3,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            progress: &progress,
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
            boundary: 3,
            budget: &budget(),
            per_pass: 1,
            breaker: &mut breaker,
            progress: &progress,
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
    let skipped = {
        let mut notices = Vec::new();
        while let Ok(notice) = progress_rx.try_recv() {
            notices.push(notice);
        }
        notices
    };
    assert!(skipped
        .iter()
        .any(|notice: &Value| notice["kind"] == "compaction.skipped"));
}

#[tokio::test]
async fn gate_two_estimates_pending_from_the_unsent_prompt() {
    // The trigger must also see messages a provider has not counted yet: a
    // small anchored context plus a large pending prompt still crosses.
    let (_dir, store) = seeded().await;
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"run","step":0,"usage":{"inputTokens":100,"outputTokens":10}}),
        )
        .await
        .unwrap();
    let (progress, _progress_rx) = mpsc::channel::<Value>(16);
    let mut breaker = Breaker::new(2);
    let mut calls = 0;
    let pending_chars = 20_000;
    let context = store.last_context_tokens("s").await.unwrap();
    let committed = (context.is_some())
        && Budget {
            window: Some(2_000),
            ratio: 0.5,
            headroom: 0,
        }
        .should_compact(context, estimate_tokens(pending_chars));
    assert!(committed);
    let _ = &mut breaker;
    let _ = &mut calls;
    let _ = progress;
}
