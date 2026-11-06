//! A gateway that bills the turn itself reports the money in its usage payload.
//! That figure is what lands in the ledger, so the sidebar's price line is a
//! measurement rather than our own rate applied to someone else's invoice.

use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One provider turn, billed the way OpenCode's gateway bills it: `cost` beside
/// an `opencode` object naming the list price and who paid.
struct Gateway {
    reported: bool,
}

#[async_trait]
impl Provider for Gateway {
    async fn stream(
        &self,
        _request: ModelRequest,
        _progress: mpsc::Sender<Value>,
        _cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let mut raw = json!({
            "prompt_tokens": 16187,
            "completion_tokens": 4,
            "total_tokens": 16191,
        });
        if self.reported {
            raw["cost"] = json!(0.00202528);
            raw["opencode"] = json!({
                "billing_source": "balance",
                "list_cost": 0.00202528,
                "tokens": {"input": 4, "output": 4, "cache_read": 0},
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: miao_engine::usage::chat(&raw),
            needs_tools: false,
        })
    }
}

fn input(id: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: "s".into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}

async fn run_one_turn(reported: bool) -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Gateway { reported }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("first"), true).await.unwrap();
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
    (store, dir)
}

async fn recorded_cost(store: &Store) -> Value {
    store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "usage")
        .expect("a usage event")
        .data["cost"]
        .clone()
}

#[tokio::test]
async fn the_charged_amount_the_gateway_reported_is_what_the_ledger_records() {
    let (store, _dir) = run_one_turn(true).await;
    let cost = recorded_cost(&store).await;
    assert_eq!(cost["amount"], json!(0.00202528));
    assert_eq!(cost["currency"], json!("USD"));
    assert_eq!(cost["source"], json!("balance"));
    assert_eq!(cost["list"], json!(0.00202528));
    assert_eq!(cost["reported"], json!(true));

    // The reported figure reaches the 24-hour strip as measured money, not as a
    // turn counted and left unpriced.
    let hourly = store.usage_hourly(24).await.unwrap();
    assert_eq!(hourly["totals"]["cost_micros"], json!(2025));
    assert_eq!(hourly["totals"]["cost_turns"], 1);
    assert_eq!(hourly["totals"]["turns"], 1);
    assert_eq!(hourly["totals"]["input"], json!(16187));

    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["cost"]["pricedTurns"], 1);
    assert_eq!(report["cost"]["unpricedTurns"], 0);
    // The report sums each currency at six decimals, the rounding the price
    // table already applied per turn, so an invoice's extra digits do not
    // become float dust in a total.
    assert_eq!(
        report["cost"]["byCurrency"],
        json!([{"currency": "USD", "amount": 0.002025}])
    );
}

/// A provider that reports no money, on a route the configuration does not
/// price, still records no cost: nothing may read as free.
#[tokio::test]
async fn an_unreported_charge_stays_unpriced_instead_of_becoming_zero() {
    let (store, _dir) = run_one_turn(false).await;
    assert_eq!(recorded_cost(&store).await, json!(null));
    assert_eq!(
        store.usage_hourly(24).await.unwrap()["totals"]["cost_turns"],
        0
    );
    let report = store.usage_report("s").await.unwrap();
    assert_eq!(report["cost"]["pricedTurns"], 0);
    assert_eq!(report["cost"]["unpricedTurns"], 1);
}
