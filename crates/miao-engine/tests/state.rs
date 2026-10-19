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
            agent_references: Default::default(),
            command: None,
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
                    agent_references: Default::default(),
                    command: None,
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
                    agent_references: Default::default(),
                    command: None,
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

#[tokio::test]
async fn task_dependencies_survive_restart_and_unlock_only_completed_prerequisites() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = setup(&path).await;
    let tasks = json!([
        {"id":"4","content":"CI","status":"waiting","priority":"high"},
        {"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]},
        {"id":"6","content":"Verify","status":"pending","priority":"high","depends_on":["5"]},
        {"id":"7","content":"Audit","status":"pending","priority":"medium"},
        {"id":"8","content":"Baseline","status":"pending","priority":"medium"},
        {"id":"9","content":"Docs","status":"pending","priority":"low"}
    ]);
    store
        .update_state(
            "s",
            "graph",
            Mutation::parse("todowrite", json!({"todos": tasks})).unwrap(),
        )
        .await
        .unwrap();
    let state = store.state("s").await.unwrap();
    assert_eq!(state["todos"]["value"]["todos"], tasks);
    assert_eq!(
        miao_engine::state::runnable_state(&state).unwrap(),
        ["7", "8", "9"]
    );
    drop(store);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let store = Store::open(&path).await.unwrap();
    let state = store.state("s").await.unwrap();
    assert_eq!(
        miao_engine::state::runnable_state(&state).unwrap(),
        ["7", "8", "9"]
    );
    let mut tasks = tasks;
    tasks[0]["status"] = json!("completed");
    store
        .update_state(
            "s",
            "finish-4",
            Mutation::parse("todowrite", json!({"todos":tasks})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        miao_engine::state::runnable_state(&store.state("s").await.unwrap()).unwrap(),
        ["5", "7", "8", "9"]
    );
    tasks[1]["status"] = json!("completed");
    store
        .update_state(
            "s",
            "finish-5",
            Mutation::parse("todowrite", json!({"todos":tasks})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        miao_engine::state::runnable_state(&store.state("s").await.unwrap()).unwrap(),
        ["6", "7", "8", "9"]
    );
    let goal = Mutation::parse(
        "goal",
        json!({"objective":"Finish the tasks","status":"active","autonomous":true}),
    )
    .unwrap();
    store.update_state("s", "goal-opt-in", goal).await.unwrap();
    assert_eq!(
        store.state("s").await.unwrap()["goal"]["value"]["autonomous"],
        true
    );
}

#[test]
fn invalid_dependency_graphs_and_cancelled_prerequisites_do_not_become_runnable() {
    let task = |id: &str, status: &str, dependencies: Vec<&str>| json!({"id":id,"content":"Task","status":status,"priority":"high","depends_on":dependencies});
    for tasks in [
        json!([task("1", "pending", vec![]), task("1", "pending", vec![])]),
        json!([task("1", "pending", vec!["missing"])]),
        json!([task("1", "pending", vec!["1"])]),
        json!([
            task("1", "pending", vec!["2"]),
            task("2", "pending", vec!["1"])
        ]),
        json!([
            task("1", "pending", vec![]),
            task("2", "in_progress", vec!["1"])
        ]),
        json!([
            task("1", "pending", vec![]),
            task("2", "completed", vec!["1"])
        ]),
        json!([
            task("1", "pending", vec![]),
            task("2", "pending", vec!["1", "1"])
        ]),
    ] {
        assert!(Mutation::parse("todowrite", json!({"todos":tasks})).is_err());
    }
    let tasks = json!([
        task("4", "cancelled", vec![]),
        task("5", "pending", vec!["4"])
    ]);
    assert!(Mutation::parse("todowrite", json!({"todos":tasks})).is_ok());
    assert!(
        miao_engine::state::runnable_state(&json!({"todos":{"value":{"todos":tasks}}}))
            .unwrap()
            .is_empty()
    );
    let tasks = json!([
        task("4", "waiting", vec![]),
        task("5", "pending", vec!["4"])
    ]);
    assert!(
        miao_engine::state::runnable_state(&json!({"todos":{"value":{"todos":tasks}}}))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn provider_receives_dependency_ready_context_without_unlocking_serial_work() {
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir.path().join("engine.db")).await;
    store.update_state("s", "graph", Mutation::parse("todowrite", json!({"todos":[
        {"id":"4","content":"CI","status":"waiting","priority":"high"},
        {"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]},
        {"id":"7","content":"Independent audit","status":"pending","priority":"medium"}
    ]})).unwrap()).await.unwrap();
    let (send, mut receive) = tokio::sync::mpsc::channel(4);
    let runtime = miao_engine::runtime::Runtime::new(
        store.clone(),
        std::sync::Arc::new(Capture { send }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "two".into(),
                prompt: "continue independent work".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let request = receive.recv().await.unwrap();
    finished(&store, 1).await;
    let text = request
        .messages
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains(r#"Runnable tasks (all prerequisites completed): ["7"]"#));
    assert!(!text.contains(r#"Runnable tasks (all prerequisites completed): ["5""#));
}
