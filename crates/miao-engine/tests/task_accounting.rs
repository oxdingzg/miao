//! VAL-02: per-task accounting — submit-to-completion wall clock, human
//! intervention waits, spend across runs and delegated child Sessions, and
//! budget comparisons. Missing figures stay unknown instead of zero, and a
//! cheap-but-wrong run is charged to the completions beside it.

use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

async fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    (dir, store)
}

#[tokio::test]
async fn every_run_is_charged_to_the_completed_task_beside_it() {
    let (_dir, store) = store().await;
    // Task one: two priced turns, run completes, inside its token budget.
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t1","prompt":"fix"}),
            0,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r1"}), 10)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r1","input_id":"t1"}),
            11,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r1","step":0,"usage":{"inputTokens":100,"outputTokens":10},"cost":{"amount":0.01,"currency":"USD"}}),
            20,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r1","step":1,"usage":{"inputTokens":50,"outputTokens":5},"cost":{"amount":0.02,"currency":"USD"}}),
            30,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.usage",
            json!({"run_id":"r1","steps":2,"usage":null,"billedTokens":165,"budgetTokens":1000}),
            40,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.finished",
            json!({"run_id":"r1","reason":"completed"}),
            50,
        )
        .await
        .unwrap();
    // Task two: one priced turn, run fails. The failure is charged to the
    // completed task beside it, not hidden.
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t2","prompt":"break"}),
            60,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r2"}), 70)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r2","input_id":"t2"}),
            71,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r2","step":0,"usage":{"inputTokens":10,"outputTokens":1},"cost":{"amount":0.04,"currency":"USD"}}),
            80,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.usage",
            json!({"run_id":"r2","steps":1,"usage":null,"billedTokens":11}),
            90,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.finished",
            json!({"run_id":"r2","reason":"failed"}),
            100,
        )
        .await
        .unwrap();
    // An engine-internal continuation is work, never a task.
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"goal:r1:1","prompt":"continue"}),
            105,
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    let tasks = &report["tasks"];
    assert_eq!(tasks["total"], 2);
    assert_eq!(tasks["passed"], 1);
    assert_eq!(tasks["failed"], 1);
    assert_eq!(tasks["unverified"], 0);
    assert_eq!(tasks["successRate"], json!(0.5));
    // (0.01 + 0.02 + 0.04) / 1 completed task.
    assert_eq!(
        tasks["perCompletedTask"]["costByCurrency"],
        json!([{"currency":"USD","amount":0.07}])
    );
    assert_eq!(tasks["perCompletedTask"]["billedTokens"], json!(176));
    // Newest task first in the detail.
    assert_eq!(tasks["detail"][0]["inputId"], "t2");
    assert_eq!(tasks["detail"][0]["outcome"], "failed");
    assert_eq!(tasks["detail"][1]["inputId"], "t1");
    assert_eq!(tasks["detail"][1]["outcome"], "passed");
    assert_eq!(
        tasks["detail"][1]["cost"]["byCurrency"],
        json!([{"currency":"USD","amount":0.03}])
    );
    assert_eq!(tasks["underBudget"], json!({"withBudget":1,"within":1}));
}

#[tokio::test]
async fn an_unpriced_turn_leaves_the_task_cost_unknown_instead_of_zero() {
    let (_dir, store) = store().await;
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t1","prompt":"fix"}),
            0,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r1"}), 10)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r1","input_id":"t1"}),
            11,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r1","step":0,"usage":{"inputTokens":10,"outputTokens":1},"cost":{"amount":0.01,"currency":"USD"}}),
            20,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r1","step":1,"usage":{"inputTokens":5,"outputTokens":1}}),
            30,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.finished",
            json!({"run_id":"r1","reason":"completed"}),
            40,
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    let tasks = &report["tasks"];
    // The Session-level rollup keeps the priced share and counts the gap.
    assert_eq!(report["cost"]["pricedTurns"], 1);
    assert_eq!(report["cost"]["unpricedTurns"], 1);
    // A task nobody fully priced has no per-completed cost.
    assert_eq!(tasks["detail"][0]["cost"]["known"], false);
    assert_eq!(tasks["perCompletedTask"]["costByCurrency"], Value::Null);
}

#[tokio::test]
async fn wall_clock_covers_submit_to_completion_and_human_waits() {
    let (_dir, store) = store().await;
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t1","prompt":"fix"}),
            0,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r1"}), 5)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r1","input_id":"t1"}),
            6,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "permission_request",
            json!({"run_id":"r1","call_id":"c1","tool":"edit"}),
            100,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "permission.approved",
            json!({"run_id":"r1","call_id":"c1"}),
            250,
        )
        .await
        .unwrap();
    store
        .record_at("s", "question.requested", json!({"question_id":"q1"}), 300)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "question.resolved",
            json!({"question_id":"q1","state":"answered"}),
            900,
        )
        .await
        .unwrap();
    // An ask nobody answered is counted as open, never timed as zero wait.
    store
        .record_at("s", "question.requested", json!({"question_id":"q2"}), 950)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "usage",
            json!({"run_id":"r1","step":0,"usage":{"inputTokens":10,"outputTokens":1},"cost":{"amount":0.01,"currency":"USD"}}),
            960,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.finished",
            json!({"run_id":"r1","reason":"completed"}),
            1000,
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    let wall = &report["wallClock"];
    assert_eq!(wall["firstSubmitAtMs"], json!(0));
    assert_eq!(wall["lastFinishAtMs"], json!(1000));
    assert_eq!(wall["spanMs"], json!(1000));
    assert_eq!(wall["interventionWaitMs"], json!(750));
    assert_eq!(wall["openInterventions"], 1);
    // Newest span first; the open ask carries no wait.
    assert_eq!(wall["interventionSpans"][0]["outcome"], Value::Null);
    assert_eq!(wall["interventionSpans"][0]["waitMs"], Value::Null);
    assert_eq!(wall["interventionSpans"][1]["outcome"], "answered");
    assert_eq!(wall["interventionSpans"][1]["waitMs"], json!(600));
    assert_eq!(wall["interventionSpans"][2]["outcome"], "approved");
    assert_eq!(wall["interventionSpans"][2]["waitMs"], json!(150));
    let task = &report["tasks"]["detail"][0];
    assert_eq!(task["wallClockMs"], json!(1000));
    assert_eq!(task["interventions"], json!({"count":3,"waitMs":750}));
    assert_eq!(
        report["tasks"]["perCompletedTask"]["wallClockMs"],
        json!(1000)
    );
}

#[tokio::test]
async fn an_interrupted_run_has_no_wall_clock_until_it_finishes() {
    let (_dir, store) = store().await;
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t1","prompt":"fix"}),
            0,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r1"}), 10)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r1","input_id":"t1"}),
            11,
        )
        .await
        .unwrap();
    // No run.finished: the task is open, so its wall clock is unknown.
    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["tasks"]["unverified"], 1);
    assert_eq!(report["tasks"]["detail"][0]["outcome"], "unverified");
    assert_eq!(report["tasks"]["detail"][0]["wallClockMs"], Value::Null);
    assert_eq!(report["wallClock"]["spanMs"], Value::Null);
    assert_eq!(report["tasks"]["successRate"], json!(0.0));
}

#[tokio::test]
async fn delegated_child_spend_is_attributed_to_the_task_window_it_served() {
    let (_dir, store) = store().await;
    store.fork("s", "child", None).await.unwrap();
    store
        .record_at(
            "s",
            "input.admitted",
            json!({"input_id":"t1","prompt":"fix"}),
            0,
        )
        .await
        .unwrap();
    store
        .record_at("s", "run.started", json!({"run_id":"r1"}), 5)
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "user_prompt_submit",
            json!({"run_id":"r1","input_id":"t1"}),
            6,
        )
        .await
        .unwrap();
    // Child turn inside the task window, priced.
    store
        .record_at(
            "child",
            "usage",
            json!({"run_id":"c1","step":0,"usage":{"inputTokens":70,"outputTokens":7},"cost":{"amount":0.05,"currency":"CNY"}}),
            500,
        )
        .await
        .unwrap();
    // Child turn after the task finished: Session-level only.
    store
        .record_at(
            "child",
            "usage",
            json!({"run_id":"c2","step":0,"usage":{"inputTokens":1,"outputTokens":1},"cost":{"amount":0.5,"currency":"CNY"}}),
            5000,
        )
        .await
        .unwrap();
    store
        .record_at(
            "s",
            "run.finished",
            json!({"run_id":"r1","reason":"completed"}),
            1000,
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    let task = &report["tasks"]["detail"][0];
    assert_eq!(
        task["cost"]["byCurrency"],
        json!([{"currency":"CNY","amount":0.05}])
    );
    // The Session-level rollup still counts every child turn once.
    assert_eq!(report["subagents"]["sessions"], 1);
    assert_eq!(report["subagents"]["turns"], 2);
}

/// A provider whose catalogue names a priced model family, but which reports
/// no money itself, so the runtime prices the turn from its own table.
struct Estimator;

#[async_trait]
impl Provider for Estimator {
    async fn stream(
        &self,
        _request: ModelRequest,
        _progress: tokio::sync::mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: miao_engine::usage::chat(&json!({
                "prompt_tokens": 1_000_000,
                "completion_tokens": 100,
                "total_tokens": 1_000_100,
            })),
            needs_tools: false,
        })
    }

    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: "est-model".into(),
        })
    }

    fn model_catalog(&self) -> Vec<miao_engine::model_catalog::Info> {
        vec![miao_engine::model_catalog::Info {
            route_id: None,
            protocol: "openai-chat".into(),
            model: "est-model".into(),
            variants: Vec::new(),
            model_key: Some("est/gateway".into()),
            credential_id: None,
            account: None,
        }]
    }
}

/// An estimate keeps the rates it was computed from, so the stored figure
/// stays attributable when the price table changes later. Nothing here is a
/// gateway measurement: `reported` stays false.
#[tokio::test]
async fn an_estimate_records_the_rates_it_was_computed_from() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Estimator),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .set_prices(miao_engine::pricing::Table::from_config(&json!({
            "providers": {"est": {"models": {"gateway": {"currency": "USD", "cost": {"input": 1.0, "output": 2.0}}}}}
        })))
        .await;
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "first".into(),
                prompt: "first".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the turn finishes");
    runtime.shutdown().await;

    let usage = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "usage")
        .expect("a usage event")
        .data;
    let cost = &usage["cost"];
    assert_eq!(cost["amount"], json!(1.0002));
    assert_eq!(cost["currency"], json!("USD"));
    assert_eq!(cost["reported"], json!(false));
    assert_eq!(
        cost["rates"],
        json!({"input":1.0,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0,"perMillion":true})
    );
}
