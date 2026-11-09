use async_trait::async_trait;
use chrono::{Datelike, Local, TimeZone, Timelike, Utc};
use miao_engine::{
    cron,
    permission::{Access, Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;
struct Scheduler {
    ready: Arc<Notify>,
    fired: Arc<Notify>,
    calls: AtomicUsize,
    hold: bool,
    recurring: bool,
    mixed: bool,
    pattern: String,
}
#[async_trait]
impl Provider for Scheduler {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            assert!(request.tools.iter().any(|tool| tool.name == "cron_create"));
            let count = if self.mixed { 8 } else { 1 };
            let mut calls=(0..count).map(|index|json!({"type":"tool_use","id":format!("cron-{index}"),"name":"cron_create","input":{"prompt":if self.mixed { format!("cron-fire-{index}") } else { "cron-fire".to_owned() },"cron":self.pattern,"recurring":self.recurring}})).collect::<Vec<_>>();
            if self.mixed {
                calls.push(json!({"type":"tool_use","id":"wakeup","name":"schedule_wakeup","input":{"prompt":"extra","delaySeconds":60}}));
            }
            return Ok(Reply {
                content: Value::Array(calls),
                usage: json!({}),
                needs_tools: true,
            });
        }
        if request.messages.last().is_some_and(|message| {
            message.content.as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["type"] == "text" && part["text"] == "cron-fire")
            })
        }) {
            self.fired.notify_one();
            return Ok(Reply {
                content: json!([{"type":"text","text":"tick"}]),
                usage: json!({}),
                needs_tools: false,
            });
        }
        self.ready.notify_one();
        if self.hold {
            cancel.cancelled().await;
            return Err(ProviderError::Interrupted);
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"scheduled"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
async fn setup(
    path: &std::path::Path,
    hold: bool,
    recurring: bool,
    mixed: bool,
) -> (Runtime, Store, Arc<Scheduler>) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    // Put the first tick at least one real minute away; tests then advance only
    // the process-local clock, without mutating the machine's date or timezone.
    let provider = Arc::new(Scheduler {
        ready: Arc::new(Notify::new()),
        fired: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
        hold,
        recurring,
        mixed,
        pattern: format!("{} * * * *", (Local::now().minute() + 2) % 60),
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        miao_engine::tools::Tools::new(path).await.unwrap(),
        Policy::new(Config {
            allow_cron: true,
            allow_wakeup: mixed,
            rules: vec![Rule {
                tool: "*".into(),
                path: "@session/**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "cron-start".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // Real time, not the virtual clock `advance` moves: a loaded runner needs
    // the same patience here that every other engine test grants a durable
    // wait (30s), and Windows runners are the slowest of them.
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.ready.notified(),
    )
    .await
    .unwrap();
    (runtime, store, provider)
}
async fn advance(seconds: u64) {
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(seconds)).await;
    tokio::time::resume();
}
async fn next_ready(store: &Store, after: u64) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let cron = store.crons("s").await.unwrap().remove(0);
            if cron["next_occurrence_ms"]
                .as_u64()
                .is_some_and(|next| next > after)
            {
                return cron;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
#[test]
fn standard_numeric_fields_or_semantics_and_dst_are_preserved() {
    let input = cron::Input::parse(json!({"prompt":"work","cron":"0 0 13 * 5"})).unwrap();
    let next = input
        .pattern()
        .unwrap()
        .find_next_occurrence(&Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap(), false)
        .unwrap();
    assert_eq!(next, Utc.with_ymd_and_hms(2026, 11, 6, 0, 0, 0).unwrap());
    let zone = chrono_tz::Europe::Berlin;
    let pattern = cron::Input::parse(json!({"prompt":"work","cron":"30 2 * * *"}))
        .unwrap()
        .pattern()
        .unwrap();
    let spring = pattern
        .find_next_occurrence(
            &zone.with_ymd_and_hms(2026, 3, 28, 23, 0, 0).unwrap(),
            false,
        )
        .unwrap();
    assert_eq!(spring, zone.with_ymd_and_hms(2026, 3, 29, 3, 0, 0).unwrap());
    let first = zone
        .with_ymd_and_hms(2026, 10, 25, 2, 30, 0)
        .earliest()
        .unwrap();
    let fall = pattern.find_next_occurrence(&first, false).unwrap();
    assert_eq!(fall.day(), 26);
    assert_eq!(fall.hour(), 2);
    assert_eq!(fall.minute(), 30);
    for expression in [
        "@daily",
        "0 * * * * *",
        "*/0 * * * *",
        "0 0 * * 8",
        "0 0 * 13 *",
        "0 0 L * *",
    ] {
        assert!(cron::Input::parse(json!({"prompt":"work","cron":expression})).is_err());
    }
    let default = Policy::new(Config::default()).unwrap();
    assert_eq!(
        default.evaluate("cron_create", "@session/cron", Access::Cron),
        Decision::Deny
    );
    let one_shot = Policy::new(Config {
        allow_wakeup: true,
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        one_shot.evaluate("cron_create", "@session/cron", Access::Cron),
        Decision::Deny
    );
}
#[tokio::test]
async fn recurring_occurrences_admit_distinct_inputs_without_catch_up_bursts() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), false, true, false).await;
    let original = store.crons("s").await.unwrap().remove(0);
    let id = original["cron_id"].as_str().unwrap();
    let first = original["first_occurrence_ms"].as_u64().unwrap();
    advance(121).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.fired.notified(),
    )
    .await
    .unwrap();
    next_ready(&store, first).await;
    // Several missed hours produce one late occurrence, not a replay burst.
    advance(4 * 3600).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.fired.notified(),
    )
    .await
    .unwrap();
    let cron = next_ready(&store, first + 3600 * 1000).await;
    assert_eq!(cron["fired_count"], 2);
    assert!(!runtime.cancel_cron("other", id).await.unwrap());
    assert!(runtime.cancel_cron("s", id).await.unwrap());
    runtime.shutdown().await;
    let events = store.events("s", 0, 100).await.unwrap();
    let ids = events
        .iter()
        .filter(|event| event.kind == "cron.fired")
        .map(|event| event.data["input_id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 2);
}
#[tokio::test]
async fn queued_backlog_coalesces_and_timer_survives_turn_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), true, true, false).await;
    let first = store.crons("s").await.unwrap()[0]["first_occurrence_ms"]
        .as_u64()
        .unwrap();
    advance(121).await;
    next_ready(&store, first).await;
    advance(3601).await;
    let cron = next_ready(&store, first + 3600 * 1000).await;
    assert_eq!(cron["fired_count"], 1);
    assert_eq!(cron["skipped_count"], 1);
    let id = cron["cron_id"].as_str().unwrap();
    runtime.cancel("s").await.unwrap();
    assert_eq!(store.crons("s").await.unwrap()[0]["state"], "scheduled");
    // Explicitly resume the one already-admitted input, not the missed tick.
    runtime.resume("s").await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.fired.notified(),
    )
    .await
    .unwrap();
    assert!(runtime.cancel_cron("s", id).await.unwrap());
    runtime.shutdown().await;
}
#[tokio::test]
async fn nonrecurring_expiry_recovery_and_fork_have_no_hidden_replay() {
    for recurring in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, store, provider) = setup(dir.path(), false, recurring, false).await;
        let original = store.crons("s").await.unwrap().remove(0);
        let messages = store.snapshot("s").await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .clone();
        let boundary = messages
            .iter()
            .rfind(|message| message["role"] == "user")
            .unwrap()["seq"]
            .as_u64()
            .unwrap();
        runtime.fork("s", "child", Some(boundary)).await.unwrap();
        assert!(store.crons("child").await.unwrap().is_empty());
        if recurring {
            advance(8 * 24 * 3600).await;
        } else {
            advance(121).await;
            tokio::time::timeout(
                std::time::Duration::from_secs(30),
                provider.fired.notified(),
            )
            .await
            .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if store.crons("s").await.unwrap()[0]["state"] != "scheduled" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            store.crons("s").await.unwrap()[0]["state"],
            if recurring { "expired" } else { "completed" }
        );
        runtime.shutdown().await;
        let before = store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "input.admitted")
            .count();
        let mut orphan = original;
        orphan["cron_id"] = json!(uuid::Uuid::new_v4().to_string());
        store.record("s", "cron.scheduled", orphan).await.unwrap();
        store.recover_crons().await.unwrap();
        store.recover_crons().await.unwrap();
        // Adoption is non-terminal; the re-armed loop still owns occurrence firing.
        assert_eq!(store.crons("s").await.unwrap()[0]["state"], "scheduled");
        assert_eq!(
            store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "input.admitted")
                .count(),
            before
        );
    }
}
#[tokio::test]
async fn cron_and_wakeup_share_one_capacity_budget() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), false, true, true).await;
    assert_eq!(store.crons("s").await.unwrap().len(), 8);
    assert!(store.wakeups("s").await.unwrap().is_empty());
    assert_eq!(
        store.snapshot("s").await.unwrap()["crons"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    runtime.shutdown().await;
    assert!(store
        .crons("s")
        .await
        .unwrap()
        .iter()
        .all(|cron| cron["state"] == "cancelled"));
}
#[tokio::test]
async fn edit_retargets_the_armed_pattern_and_keeps_identity() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), false, true, false).await;
    let original = store.crons("s").await.unwrap().remove(0);
    let id = original["cron_id"].as_str().unwrap().to_owned();
    // Move the tick past the original one; the pattern edit is the only
    // thing that may move the next occurrence, so a fire here proves the swap.
    let edited = format!("{} * * * *", (Local::now().minute() + 5) % 60);
    let change = cron::Change::parse(json!({"id": id, "cron": edited})).unwrap();
    let data = runtime.edit_cron("s", change).await.unwrap();
    assert_eq!(data["cron_id"].as_str(), Some(id.as_str()));
    assert_eq!(data["input"]["prompt"], json!("cron-fire"));
    let listed = store.crons("s").await.unwrap().remove(0);
    assert_eq!(listed["input"]["cron"], json!(edited));
    assert_eq!(listed["cron"], json!(edited));
    assert_eq!(listed["pattern"], json!(edited));
    assert_eq!(listed["session_id"], json!("s"));
    assert!(listed["timezone"].is_string());
    assert_eq!(listed["first_occurrence_ms"], data["first_occurrence_ms"]);
    assert_eq!(listed["next_occurrence_ms"], data["first_occurrence_ms"]);
    assert_eq!(listed["state"], "scheduled");
    // The wait follows the edited window instead of assuming it sits a fixed
    // few minutes out: a wrapped minute would otherwise flake once an hour.
    let first = data["first_occurrence_ms"].as_u64().unwrap();
    let wait = (first.saturating_sub(Local::now().timestamp_millis() as u64) / 1000) + 10;
    advance(wait).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.fired.notified(),
    )
    .await
    .unwrap();
    runtime.shutdown().await;
    let events = store.events("s", 0, 100).await.unwrap();
    let fired = events
        .iter()
        .filter(|event| event.kind == "cron.fired")
        .collect::<Vec<_>>();
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].data["occurrence_ms"], data["first_occurrence_ms"]);
    assert!(events.iter().any(|event| event.kind == "cron.updated"));
}
#[tokio::test]
async fn edit_refuses_fieldless_resolved_and_invalid_changes() {
    for (input, ok) in [
        (json!({"id": "ok-1", "prompt": "next"}), true),
        (json!({"id": "ok-1"}), false),
        (json!({"id": "a b", "prompt": "x"}), false),
        (json!({"id": "ok-1", "unknown": 1}), false),
        (json!({"id": "ok-1", "prompt": " "}), false),
        (json!({"id": "ok-1", "prompt": ""}), false),
    ] {
        assert_eq!(cron::Change::parse(input).is_ok(), ok);
    }
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _provider) = setup(dir.path(), false, true, false).await;
    let id = store.crons("s").await.unwrap().remove(0)["cron_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(runtime
        .edit_cron(
            "s",
            cron::Change::parse(json!({"id": "missing", "prompt": "x"})).unwrap()
        )
        .await
        .is_err());
    assert!(runtime
        .edit_cron(
            "s",
            cron::Change::parse(json!({"id": id, "cron": "@daily"})).unwrap()
        )
        .await
        .is_err());
    assert!(runtime.cancel_cron("s", &id).await.unwrap());
    assert!(runtime
        .edit_cron(
            "s",
            cron::Change::parse(json!({"id": id, "prompt": "late"})).unwrap()
        )
        .await
        .is_err());
    runtime.shutdown().await;
}
#[tokio::test]
async fn restart_adoption_rearms_the_edited_definition() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _provider) = setup(dir.path(), false, true, false).await;
    let original = store.crons("s").await.unwrap().remove(0);
    let id = original["cron_id"].as_str().unwrap().to_owned();
    let edited = format!("{} * * * *", (Local::now().minute() + 7) % 60);
    runtime
        .edit_cron(
            "s",
            cron::Change::parse(json!({"id": id, "cron": edited})).unwrap(),
        )
        .await
        .unwrap();
    let listed = store.crons("s").await.unwrap().remove(0);
    // Adoption reads scheduled + latest update, never the original window.
    let rearmed = store.recover_crons().await.unwrap();
    let entry = rearmed.iter().find(|entry| entry.0 == "s").unwrap();
    assert_eq!(entry.1, id);
    assert_eq!(entry.2, edited);
    assert_eq!(entry.4, listed["first_occurrence_ms"].as_u64().unwrap());
    runtime.shutdown().await;
}
