use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    state::Mutation,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Script {
    calls: AtomicUsize,
    progress: bool,
    churn: bool,
}
#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.churn {
            return Ok(Reply {
                needs_tools: index.is_multiple_of(2),
                content: if index.is_multiple_of(2) {
                    json!([{"type":"tool_use","id":format!("progress-{index}"),"name":"todowrite","input":{"todos":[
                        {"id":"7","content":format!("Ready update {index}"),"status":"pending","priority":"medium"}
                    ]}}])
                } else {
                    json!([{"type":"text","text":"early stop"}])
                },
                usage: json!({}),
            });
        }
        let content = match (self.progress, index) {
            (true, 1) => {
                json!([{"type":"tool_use","id":"audit-write","name":"write_file","input":{"path":"audit","text":"once","expected_sha256":null}}])
            }
            (true, 2) => {
                json!([{"type":"tool_use","id":"audit-status","name":"todowrite","input":{"todos":[
                    {"id":"4","content":"CI","status":"waiting","priority":"high"},
                    {"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]},
                    {"id":"7","content":"Audit","status":"completed","priority":"medium"}
                ]}}])
            }
            _ => json!([{"type":"text","text":"waiting"}]),
        };
        Ok(Reply {
            needs_tools: self.progress && (index == 1 || index == 2),
            content,
            usage: json!({}),
        })
    }
}

async fn setup(
    store: &Store,
    status: &str,
    autonomous: bool,
    ready: bool,
    location: &std::path::Path,
) {
    store
        .admit_attachments_at(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "Work on the authorized tasks".into(),
                delivery: Delivery::Steer,
            },
            Vec::new(),
            Some(
                std::fs::canonicalize(location)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
        )
        .await
        .unwrap();
    store.update_state("s", "goal", Mutation::parse("goal", json!({"objective":"Finish tasks","status":status,"autonomous":autonomous,"evidence":"Explicit engagement state"})).unwrap()).await.unwrap();
    let mut todos = vec![
        json!({"id":"4","content":"CI","status":"waiting","priority":"high"}),
        json!({"id":"5","content":"Release","status":"pending","priority":"high","depends_on":["4"]}),
    ];
    if ready {
        todos.push(json!({"id":"7","content":"Audit","status":"pending","priority":"medium"}));
    }
    store
        .update_state(
            "s",
            "todos",
            Mutation::parse("todowrite", json!({"todos":todos})).unwrap(),
        )
        .await
        .unwrap();
}
async fn finished(store: &Store) {
    // Windows runners may need several seconds for 25 durable provider turns.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 500)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn continues_independent_work_without_a_human_prompt_then_idles_with_locked_dependents() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: true,
        churn: false,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "write_file".into(),
                path: "*".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        4,
        "{:?}",
        store
            .events("s", 0, 500)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind.contains("tool") || event.kind.contains("state"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("audit")).unwrap(),
        "once"
    );
    let events = store.events("s", 0, 500).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "loop.continuation")
            .count(),
        1
    );
    assert!(
        miao_engine::state::runnable_state(&store.state("s").await.unwrap())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "input.promoted")
            .count(),
        2
    );
}

#[tokio::test]
async fn no_progress_is_bounded_and_synthetic_admissions_do_not_restart_the_loop_budget() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "loop.stopped" && event.data["reason"] == "no-progress"));
}

#[tokio::test]
async fn only_waits_paused_goals_and_missing_authorization_never_create_extra_turns() {
    for (status, autonomous, ready) in [
        ("active", true, false),
        ("active", false, true),
        ("paused", true, true),
        ("blocked", true, true),
        ("done", true, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        setup(&store, status, autonomous, ready, dir.path()).await;
        let provider = Arc::new(Script {
            calls: AtomicUsize::new(0),
            progress: false,
            churn: false,
        });
        let runtime = Runtime::new(
            store.clone(),
            provider.clone(),
            Tools::new(dir.path()).await.unwrap(),
        )
        .await
        .unwrap();
        runtime.resume("s").await.unwrap();
        finished(&store).await;
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "{status}/{autonomous}/{ready}"
        );
    }
}

#[tokio::test]
async fn denied_state_read_does_not_grant_autonomous_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: false,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            rules: vec![Rule {
                tool: "session_state".into(),
                path: "@session/state/**".into(),
                decision: Decision::Deny,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn changing_progress_does_not_refill_the_provider_allowance() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    setup(&store, "active", true, true, dir.path()).await;
    let provider = Arc::new(Script {
        calls: AtomicUsize::new(0),
        progress: false,
        churn: true,
    });
    let runtime = Runtime::new(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.resume("s").await.unwrap();
    finished(&store).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 25);
    let events = store.events("s", 0, 5000).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed"));
    assert!(events.iter().any(|event| event.kind == "message.synthetic"
        && event.data["text"]
            .as_str()
            .unwrap_or_default()
            .contains("provider turn allowance")));
}
