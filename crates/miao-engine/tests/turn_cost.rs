//! Native-currency pricing: a turn's spend is reported in the currency its
//! provider charges, and a turn nobody priced is reported as unpriced rather
//! than as free.
//!
//! There is no conversion anywhere in this path on purpose. Summing CNY and USD
//! would produce a total whose unit is a guess, so the report keeps one bucket
//! per currency and lets the reader add them up the way their own books do.

use miao_engine::store::Store;
use serde_json::json;

fn priced(run: &str, step: u64, amount: f64, currency: &str, route: &str) -> serde_json::Value {
    json!({
        "run_id": run,
        "step": step,
        "usage": {"inputTokens": 100, "outputTokens": 10},
        "route": route,
        "cost": {"amount": amount, "currency": currency},
    })
}

#[tokio::test]
async fn spend_is_bucketed_per_currency_and_never_summed_across_them() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    for (step, amount, currency, route) in [
        (0, 0.25, "CNY", "deepseek/deepseek-chat"),
        (1, 0.5, "CNY", "deepseek/deepseek-chat"),
        (2, 1.5, "USD", "openai/gpt-5"),
    ] {
        store
            .record("s", "usage", priced("r", step, amount, currency, route))
            .await
            .unwrap();
    }

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["cost"]["pricedTurns"], 3);
    assert_eq!(report["cost"]["unpricedTurns"], 0);
    assert_eq!(
        report["cost"]["byCurrency"],
        json!([
            {"currency": "CNY", "amount": 0.75},
            {"currency": "USD", "amount": 1.5},
        ]),
        "each currency keeps its own total"
    );
}

#[tokio::test]
async fn a_turn_without_a_rate_is_counted_as_unpriced_not_as_zero() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("s").await.unwrap();
    // A route the configuration declares no complete price for: the engine
    // records the route and no cost, so the report can name what is missing.
    store
        .record(
            "s",
            "usage",
            json!({
                "run_id": "r",
                "step": 0,
                "usage": {"inputTokens": 10, "outputTokens": 1},
                "route": "deepseek/unpriced",
                "cost": null,
            }),
        )
        .await
        .unwrap();
    // A turn recorded before any rate existed carries neither field at all.
    store
        .record(
            "s",
            "usage",
            json!({"run_id":"r","step":1,"usage":{"inputTokens":10,"outputTokens":1}}),
        )
        .await
        .unwrap();

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["cost"]["pricedTurns"], 0);
    assert_eq!(report["cost"]["unpricedTurns"], 2);
    assert_eq!(report["cost"]["byCurrency"], json!([]));
    assert_eq!(
        report["cost"]["unpricedRoutes"],
        json!([{"route": "deepseek/unpriced", "turns": 1}])
    );
}

#[tokio::test]
async fn a_parent_report_carries_its_children_spend_in_the_child_currency() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.ensure("parent").await.unwrap();
    store.fork("parent", "child", None).await.unwrap();
    store
        .record(
            "parent",
            "usage",
            priced("p", 0, 0.1, "CNY", "deepseek/deepseek-chat"),
        )
        .await
        .unwrap();
    store
        .record("child", "usage", priced("c", 0, 2.0, "USD", "openai/gpt-5"))
        .await
        .unwrap();

    let report = store.usage_report("parent").await.unwrap();
    assert_eq!(
        report["cost"]["byCurrency"],
        json!([{"currency": "CNY", "amount": 0.1}])
    );
    assert_eq!(
        report["subagents"]["cost"]["byCurrency"],
        json!([{"currency": "USD", "amount": 2.0}]),
        "delegated spend is attributable instead of invisible"
    );
}
