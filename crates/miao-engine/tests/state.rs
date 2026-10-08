use miao_engine::{
    permission::{Access, Config, Decision, Policy, Rule},
    protocol::{Delivery, Input},
    state::Mutation,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
fn todos(content: &str, revision: u64) -> Mutation {
    Mutation::parse("todowrite",json!({"todos":[{"content":content,"status":"in_progress","priority":"high"}],"expected_revision":revision})).unwrap()
}
async fn setup(path: &std::path::Path) -> Store {
    let store = Store::open(path).await.unwrap();
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "one".into(),
            prompt: "work".into(),
            delivery: Delivery::Steer,
        })
        .await
        .unwrap();
    store.promote("s", true).await.unwrap();
    store
}
#[tokio::test]
async fn state_updates_reconcile_exact_retry_and_optimistic_conflicts_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = setup(&path).await;
    let first = store
        .update_state("s", "op1", todos("first", 0))
        .await
        .unwrap();
    let revision = first["revision"].as_u64().unwrap();
    assert_eq!(
        store
            .update_state("s", "op1", todos("first", 0))
            .await
            .unwrap()["duplicate"],
        true
    );
    assert!(store
        .update_state("s", "op1", todos("different", 0))
        .await
        .is_err());
    assert!(store
        .update_state("s", "op2", todos("stale", 0))
        .await
        .is_err());
    let second = store
        .update_state("s", "op2", todos("second", revision))
        .await
        .unwrap();
    assert_eq!(
        store
            .update_state("s", "op1", todos("first", 0))
            .await
            .unwrap()["revision"],
        revision
    );
    assert_eq!(
        store.state("s").await.unwrap()["todos"]["value"]["todos"][0]["content"],
        "second"
    );
    assert!(store.state("other").await.unwrap()["todos"].is_null());
    drop(store);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.state("s").await.unwrap()["todos"]["revision"],
        second["revision"]
    );
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "session.state.updated")
            .count(),
        2
    );
}
#[tokio::test]
async fn snapshot_and_fork_inherit_only_state_at_the_selected_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir.path().join("engine.db")).await;
    let first = store
        .update_state("s", "first", todos("old", 0))
        .await
        .unwrap();
    let boundary = store
        .message("s", "assistant", json!([{"type":"text","text":"finished"}]))
        .await
        .unwrap();
    store
        .update_state(
            "s",
            "second",
            todos("new", first["revision"].as_u64().unwrap()),
        )
        .await
        .unwrap();
    store.update_state("s","goal",Mutation::parse("goal",json!({"objective":"objective","status":"done","evidence":"test passed","expected_revision":0})).unwrap()).await.unwrap();
    assert_eq!(
        store.snapshot("s").await.unwrap()["state"]["goal"]["value"]["status"],
        "done"
    );
    store
        .fork("s", "historical", Some(boundary.seq))
        .await
        .unwrap();
    let historical = store.state("historical").await.unwrap();
    assert_eq!(historical["todos"]["value"]["todos"][0]["content"], "old");
    assert!(historical["goal"].is_null());
    store.fork("s", "current", None).await.unwrap();
    let current = store.state("current").await.unwrap();
    assert_eq!(current["todos"]["value"]["todos"][0]["content"], "new");
    assert_eq!(current["goal"]["value"]["status"], "done");
    store
        .compact("s", "compact", boundary.seq, "summary".into())
        .await
        .unwrap();
    assert_eq!(
        store.state("s").await.unwrap()["todos"]["value"],
        current["todos"]["value"]
    );
}
#[tokio::test]
async fn state_validation_and_policy_do_not_confer_filesystem_authority() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let prepared = tools
        .prepare("todowrite", json!({"todos":[]}))
        .await
        .unwrap();
    assert_eq!(prepared.access(), Access::SessionState);
    let policy = Policy::new(Config::default()).unwrap();
    assert_eq!(
        policy.evaluate(prepared.name(), prepared.resource(), prepared.access()),
        Decision::Allow
    );
    assert_eq!(
        policy.evaluate("write_file", "file", Access::Write),
        Decision::Deny
    );
    let deny = Policy::new(Config {
        rules: vec![Rule {
            tool: "*".into(),
            path: "@session/state/**".into(),
            decision: Decision::Deny,
        }],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        deny.evaluate(prepared.name(), prepared.resource(), prepared.access()),
        Decision::Deny
    );
    for (name, value) in [
        ("goal", json!({"objective":"work","status":"done"})),
        (
            "goal",
            json!({"objective":"work","status":"blocked","evidence":" "}),
        ),
        (
            "todowrite",
            json!({"todos":[{"content":"task","status":"unknown","priority":"high"}]}),
        ),
        ("session_state", json!({"session_id":"other"})),
    ] {
        assert!(tools.prepare(name, value).await.is_err());
    }
    let value: Value = json!({"objective":"work","status":"active"});
    assert!(Mutation::parse("goal", value).is_ok());
}

struct Capture {
    send: tokio::sync::mpsc::Sender<miao_engine::protocol::ModelRequest>,
}
#[async_trait::async_trait]
impl miao_engine::provider::Provider for Capture {
    async fn stream(
        &self,
        request: miao_engine::protocol::ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<miao_engine::provider::Reply, miao_engine::provider::ProviderError> {
        self.send.send(request).await.unwrap();
        Ok(miao_engine::provider::Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
async fn finished(store: &Store, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= count
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn dynamic_state_survives_compaction_and_reloads_without_changing_system_epoch() {
    for decision in [Decision::Allow, Decision::Ask, Decision::Deny] {
        let dir = tempfile::tempdir().unwrap();
        let store = setup(&dir.path().join("engine.db")).await;
        let revision = store
            .update_state("s", "state1", todos("current-task", 0))
            .await
            .unwrap()["revision"]
            .as_u64()
            .unwrap();
        let boundary = store
            .message("s", "assistant", json!([{"type":"text","text":"old work"}]))
            .await
            .unwrap();
        store
            .compact("s", "compact", boundary.seq, "old summary".into())
            .await
            .unwrap();
        let (send, mut receive) = tokio::sync::mpsc::channel(4);
        let runtime = miao_engine::runtime::Runtime::with_policy(
            store.clone(),
            std::sync::Arc::new(Capture { send }),
            Tools::new(dir.path()).await.unwrap(),
            Policy::new(Config {
                rules: vec![Rule {
                    tool: "session_state".into(),
                    path: "@session/state/**".into(),
                    decision,
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
                    session_id: "s".into(),
                    input_id: "two".into(),
                    prompt: "continue".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let first = receive.recv().await.unwrap();
        finished(&store, 1).await;
        let first_text = serde_json::to_string(&first.messages).unwrap();
        assert_eq!(
            first_text.contains("current-task"),
            decision == Decision::Allow
        );
        store
            .update_state("s", "state2", todos("changed-task", revision))
            .await
            .unwrap();
        runtime
            .admit(
                Input {
                    session_id: "s".into(),
                    input_id: "three".into(),
                    prompt: "continue again".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        let second = receive.recv().await.unwrap();
        finished(&store, 2).await;
        assert_eq!(first.system, second.system);
        let second_text = serde_json::to_string(&second.messages).unwrap();
        assert_eq!(
            second_text.contains("changed-task"),
            decision == Decision::Allow
        );
        assert!(!second_text.contains("current-task"));
        assert_eq!(store.context("s", None).await.unwrap().unwrap()["epoch"], 1);
        assert!(!serde_json::to_string(&store.history("s").await.unwrap())
            .unwrap()
            .contains("<session-state>"));
        let events = store
            .events("s", 0, 100)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "provider.started")
            .collect::<Vec<_>>();
        if decision == Decision::Allow {
            assert_ne!(
                events[0].data["state_selection"]["fingerprint"],
                events[1].data["state_selection"]["fingerprint"]
            );
        } else {
            assert_eq!(events[0].data["state_selection"]["status"], "skipped");
        }
        runtime.shutdown().await;
    }
}
