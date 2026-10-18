use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Mode, Policy},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    session_agent::{AgentManifest, AgentTools},
    session_model::Binding,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Answers, records the outgoing request, and exposes one extra route so an
/// agent's pinned model can be observed.
struct Answer {
    system: Mutex<Vec<String>>,
    tools: Mutex<Vec<Vec<String>>>,
    calls: AtomicUsize,
}

impl Answer {
    fn new() -> Self {
        Self {
            system: Mutex::new(Vec::new()),
            tools: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Provider for Answer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.system.lock().unwrap().push(request.system.clone());
        self.tools.lock().unwrap().push(
            request
                .tools
                .iter()
                .map(|tool| tool.name.clone())
                .collect::<Vec<_>>(),
        );
        // The first turn asks for a write through the tool surface; further
        // turns answer with text so the run settles.
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":"write_file","input":{"path":"note.txt","text":"hi","expected_sha256":null}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"answered"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }

    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: "fixture".into(),
        })
    }

    fn for_route(&self, route_id: &str) -> Option<Arc<dyn Provider>> {
        if route_id != "account-two/shared" {
            return None;
        }
        Some(Arc::new(Routed))
    }
}

struct Routed;

#[async_trait]
impl Provider for Routed {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type":"text","text":"answered on the pinned route"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }

    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "openai-chat".into(),
            model: "fixture-alt".into(),
        })
    }
}

fn manifest() -> AgentManifest {
    AgentManifest {
        name: "reviewer".into(),
        semantics: Some("product-agent-v1".into()),
        instructions: Some("Review the diff before answering.".into()),
        tools: Some(AgentTools {
            allow: vec!["write_file".into(), "read_file".into()],
            deny: vec!["read_file".into()],
        }),
        permissions: None,
        model: None,
        mode: None,
    }
}

async fn setup(path: &std::path::Path) -> (Runtime, Store, Arc<Answer>) {
    // The database lives outside the workspace: a process-enabled runtime
    // refuses to let a model-writable directory hold its own storage.
    let workspace = path.join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Answer::new());
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            rules: vec![miao_engine::permission::Rule {
                tool: "write_file".into(),
                path: "**".into(),
                decision: miao_engine::permission::Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    // Create the Session identity without running a turn: selecting an agent
    // requires an existing Session, exactly as the product's flow does.
    store
        .admit(Input {
            session_id: "s".into(),
            input_id: "warm".into(),
            prompt: "warm".into(),
            delivery: Delivery::Queue,
        })
        .await
        .unwrap();
    store.cancel_input("s", "warm").await.unwrap();
    (runtime, store, provider)
}

async fn turn(runtime: &Runtime, store: &Store, input_id: &str) {
    let before = store.events("s", 0, 500).await.unwrap().len();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: input_id.into(),
                prompt: "go".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let events = store.events("s", 0, 500).await.unwrap();
            if events
                .iter()
                .skip(before)
                .any(|event| event.kind == "provider.started")
                && store.active_run("s").await.unwrap().is_none()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the new turn settled");
}

#[tokio::test]
async fn an_agent_shapes_instructions_tools_mode_and_its_recorded_scope() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.mode = Some(miao_engine::protocol::CollaborationMode::Plan);
    runtime.set_agent("s", agent.clone()).await.unwrap();
    turn(&runtime, &store, "one").await;

    let system = provider.system.lock().unwrap().first().cloned().unwrap();
    assert!(system.contains("<agent name=\"reviewer\">"), "{system}");
    assert!(
        system.contains("Review the diff before answering."),
        "{system}"
    );
    // The agent pinned plan mode, and the collaboration block follows it.
    assert!(
        system.contains("<collaboration-mode mode=\"plan\">"),
        "{system}"
    );
    // `allow` intersected with `deny` leaves exactly the allowed surface.
    let tools = provider.tools.lock().unwrap().first().cloned().unwrap();
    assert_eq!(tools, vec!["write_file".to_owned()], "{tools:?}");
    // Plan mode denies the write the provider asked for, as it always does.
    assert!(
        store
            .events("s", 0, 500)
            .await
            .unwrap()
            .iter()
            .any(|event| event.kind == "permission_denied" && event.data["reason"] == "plan_mode"),
        "plan mode denies the write"
    );
    let started = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "provider.started")
        .expect("a turn started");
    assert_eq!(started.data["identity"]["model"], "fixture");
    runtime.shutdown().await;
}

/// The model identity of the newest started turn.
async fn started_model(store: &Store) -> Value {
    store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .rfind(|event| event.kind == "provider.started")
        .expect("a turn started")
        .data["identity"]["model"]
        .clone()
}

#[tokio::test]
async fn an_agent_pinned_model_applies_only_without_an_explicit_selection() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _provider) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = None;
    agent.instructions = None;
    agent.model = Some(Binding {
        protocol: "openai-chat".into(),
        model: "fixture-alt".into(),
        route_id: Some("account-two/shared".into()),
    });
    runtime.set_agent("s", agent).await.unwrap();
    turn(&runtime, &store, "one").await;
    // The agent's route answered the turn while the Session had no selection.
    assert_eq!(started_model(&store).await, json!("fixture-alt"));
    // An explicit selection outranks the agent's pin.
    store
        .select_model(
            "s",
            Some(Binding {
                protocol: "openai-chat".into(),
                model: "fixture".into(),
                route_id: None,
            }),
        )
        .await
        .unwrap();
    turn(&runtime, &store, "two").await;
    assert_eq!(started_model(&store).await, json!("fixture"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_agent_naming_an_unknown_tool_is_refused_at_admission() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _provider) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = Some(AgentTools {
        allow: vec!["read_file".into(), "not_a_tool".into()],
        deny: vec![],
    });
    assert!(matches!(
        runtime.set_agent("s", agent).await,
        Err(miao_engine::protocol::Error::Invalid(_))
    ));
    assert!(store.agent("s").await.unwrap().is_none());
    runtime.shutdown().await;
}
