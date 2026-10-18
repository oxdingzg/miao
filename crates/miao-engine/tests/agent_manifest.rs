mod common;
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
        ordered_permissions: None,
        model: None,
        mode: None,
        request: None,
        steps: None,
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
            agent_references: Default::default(),
            command: None,
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
                agent_references: Default::default(),
                command: None,
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
        variant: None,
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
                variant: None,
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

#[tokio::test]
async fn a_hallucinated_tool_outside_the_agent_surface_never_executes() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = Some(AgentTools {
        allow: vec!["read_file".into()],
        deny: vec![],
    });
    runtime.set_agent("s", agent).await.unwrap();
    // The fixture asks for write_file even though it was not advertised.
    turn(&runtime, &store, "one").await;
    assert!(!dir.path().join("work/note.txt").exists());
    assert!(store
        .events("s", 0, 500)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "permission_denied"
            && event.data["reason"] == "agent_tool_surface"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn agent_denial_overrides_base_allow_and_is_used_during_execution() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = None;
    agent.permissions = Some(vec![miao_engine::permission::Rule {
        tool: "write_file".into(),
        path: "**".into(),
        decision: miao_engine::permission::Decision::Deny,
    }]);
    runtime.set_agent("s", agent).await.unwrap();
    turn(&runtime, &store, "one").await;
    assert!(!dir.path().join("work/note.txt").exists());
    let events = store.events("s", 0, 500).await.unwrap();
    let start = events
        .iter()
        .find(|event| event.kind == "provider.started")
        .unwrap();
    let denial = events
        .iter()
        .find(|event| event.kind == "permission_denied" && event.data["reason"] == "policy")
        .unwrap();
    assert_eq!(
        start.data["policy_revision"],
        denial.data["policy_revision"]
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn switching_agents_invalidates_pending_approval_and_its_late_reply() {
    use miao_engine::{
        approval::{Approval, Response},
        permission::Decision,
        protocol::Error,
    };
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = None;
    agent.permissions = Some(vec![miao_engine::permission::Rule {
        tool: "write_file".into(),
        path: "**".into(),
        decision: Decision::Ask,
    }]);
    runtime.set_agent("s", agent.clone()).await.unwrap();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "go".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let approval: Approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("s", 0, 500)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "approval.requested")
            {
                break serde_json::from_value(event.data).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    agent.name = "different-agent".into();
    runtime.set_agent("s", agent).await.unwrap();
    assert_eq!(
        store.approval_state(&approval.request_id).await.unwrap(),
        "deny"
    );
    let response = Response {
        request_id: approval.request_id.clone(),
        input_hash: approval.input_hash,
        policy_revision: approval.policy_revision,
        decision: Decision::Allow,
        matcher: None,
    };
    assert!(matches!(
        runtime
            .approve(&runtime.controller(), "s", response.clone())
            .await,
        Err(Error::ApprovalMismatch)
    ));
    // Even a reply queued before the switch cannot bypass the transactional
    // invalidation by talking straight to the store's final resolution path.
    assert!(matches!(
        store.resolve_approval("s", response).await,
        Err(Error::ApprovalResolved)
    ));
    assert!(!dir.path().join("work/note.txt").exists());
    runtime.shutdown().await;
}

struct Readers;
#[async_trait]
impl Provider for Readers {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let done = request.messages.iter().any(|message| {
            message.role == "tool"
                || message
                    .content
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
        });
        Ok(Reply {
            content: if done {
                json!([{"type":"text","text":"done"}])
            } else {
                json!([
                    {"type":"tool_use","id":"a","name":"read_file","input":{"path":"a.txt"}},
                    {"type":"tool_use","id":"b","name":"read_file","input":{"path":"b.txt"}}
                ])
            },
            usage: json!({}),
            needs_tools: !done,
        })
    }
}

#[tokio::test]
async fn parallel_read_fast_path_cannot_bypass_agent_denial() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("a.txt"), "secret-a").unwrap();
    std::fs::write(workspace.join("b.txt"), "secret-b").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Readers),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "warm".into(),
            prompt: "warm".into(),
            delivery: Delivery::Queue,
        })
        .await
        .unwrap();
    store.cancel_input("s", "warm").await.unwrap();
    let mut agent = manifest();
    agent.tools = Some(AgentTools {
        allow: vec![],
        deny: vec!["read_file".into()],
    });
    runtime.set_agent("s", agent).await.unwrap();
    turn(&runtime, &store, "one").await;
    let events = store.events("s", 0, 500).await.unwrap();
    assert!(!events
        .iter()
        .any(|event| event.kind == "tool.parallel.started"));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "permission_denied"
                && event.data["reason"] == "agent_tool_surface")
            .count(),
        2
    );
    let history = serde_json::to_string(&store.history("s").await.unwrap()).unwrap();
    assert!(!history.contains("secret-a"));
    assert!(!history.contains("secret-b"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_fork_inherits_the_agent_at_its_selected_history_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path()).await;
    let mut first = manifest();
    first.tools = None;
    runtime.set_agent("s", first).await.unwrap();
    turn(&runtime, &store, "one").await;
    let boundary = store
        .events("s", 0, 500)
        .await
        .unwrap()
        .into_iter()
        .rfind(|event| event.kind == "message.committed")
        .unwrap()
        .seq;
    let mut second = manifest();
    second.name = "later-agent".into();
    runtime.set_agent("s", second).await.unwrap();
    store
        .fork("s", "at-boundary", Some(boundary))
        .await
        .unwrap();
    store.fork("s", "current", None).await.unwrap();
    assert_eq!(
        store.agent("at-boundary").await.unwrap().unwrap().0.name,
        "reviewer"
    );
    assert_eq!(
        store.agent("current").await.unwrap().unwrap().0.name,
        "later-agent"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn real_adapter_records_agent_identity_and_selected_context() {
    let body = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,
        "delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]})
    );
    let (url, mut requests, server) = common::endpoint(vec![(200, body)]).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(
            miao_engine::openai_chat::OpenAIChat::new(url, "fixture".into(), "model".into())
                .unwrap(),
        ),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config::default()).unwrap(),
    )
    .await
    .unwrap();
    store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: "s".into(),
            input_id: "warm".into(),
            prompt: "warm".into(),
            delivery: Delivery::Queue,
        })
        .await
        .unwrap();
    store.cancel_input("s", "warm").await.unwrap();
    let mut agent = manifest();
    agent.tools = Some(AgentTools {
        allow: vec!["read_file".into()],
        deny: vec![],
    });
    runtime.set_agent("s", agent.clone()).await.unwrap();
    turn(&runtime, &store, "one").await;
    let request = requests.recv().await.unwrap();
    assert!(serde_json::to_string(&request)
        .unwrap()
        .contains("Review the diff before answering."));
    let events = store.events("s", 0, 500).await.unwrap();
    let profile = events
        .iter()
        .find(|event| event.kind == "provider.request")
        .unwrap();
    assert_eq!(profile.data["agent"]["name"], agent.name);
    assert_eq!(profile.data["agent"]["agentHash"], agent.digest().unwrap());
    let context = store.context("s", None).await.unwrap().unwrap();
    assert!(serde_json::to_string(&context)
        .unwrap()
        .contains("Review the diff before answering."));
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn ordered_permissions_keep_late_allow_exceptions_at_actual_dispatch() {
    for (resource, allowed) in [("private/**", false), ("note.txt", true)] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, store, _) = setup(dir.path()).await;
        let mut agent = manifest();
        agent.tools = None;
        agent.ordered_permissions = Some(
            serde_json::from_value(json!({
                "semantics":"ordered-wildcard-v1",
                "bindings":{"write_file":{"action":"edit"}},
                "rules":[{"action":"*","resource":"*","effect":"deny"},
                    {"action":"edit","resource":resource,"effect":"allow"}]
            }))
            .unwrap(),
        );
        runtime.set_agent("s", agent).await.unwrap();
        turn(&runtime, &store, "one").await;
        assert_eq!(dir.path().join("work/note.txt").exists(), allowed);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn an_agent_can_narrow_but_not_silently_reset_the_provider_turn_allowance() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path()).await;
    let mut agent = manifest();
    agent.tools = None;
    agent.steps = Some(1);
    runtime.set_agent("s", agent).await.unwrap();
    turn(&runtime, &store, "one").await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(store.active_run("s").await.unwrap().is_none());
    runtime.shutdown().await;
}
