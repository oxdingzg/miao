use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    session_agent::{AgentManifest, AgentTools},
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

/// Asks for one read every turn until it has made `tool_turns` of them, then
/// answers with text. Every reply bills the same 40 tokens.
struct Reader {
    tool_turns: usize,
    calls: AtomicUsize,
    requests: Mutex<Vec<ModelRequest>>,
}

impl Reader {
    fn new(tool_turns: usize) -> Self {
        Self {
            tool_turns,
            calls: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Provider for Reader {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.requests.lock().unwrap().push(request);
        let turn = self.calls.fetch_add(1, Ordering::SeqCst);
        let wants_tool = turn < self.tool_turns;
        Ok(Reply {
            needs_tools: wants_tool,
            content: if wants_tool {
                json!([{"type":"tool_use","id":format!("read-{turn}"),"name":"read_file","input":{"path":format!("note-{turn}.txt")}}])
            } else {
                json!([{"type":"text","text":"closed"}])
            },
            usage: json!({"inputTokens":30,"outputTokens":10}),
        })
    }
}

async fn setup(path: &std::path::Path, tool_turns: usize) -> (Runtime, Store, Arc<Reader>) {
    let workspace = path.join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    for turn in 0..6 {
        std::fs::write(workspace.join(format!("note-{turn}.txt")), "budget fixture").unwrap();
    }
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let provider = Arc::new(Reader::new(tool_turns));
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            rules: vec![Rule {
                tool: "read_file".into(),
                path: "*".into(),
                decision: Decision::Allow,
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

async fn run_to_stop(runtime: &Runtime, store: &Store, before: usize, input_id: &str) {
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
            let events = store.events("s", 0, 1000).await.unwrap();
            let stopped = events
                .iter()
                .skip(before)
                .any(|event| event.kind == "stop" || event.kind == "stop_failure");
            if stopped && store.active_run("s").await.unwrap().is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the turn settled");
}

fn message_text(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .filter_map(|message| message.content.as_array())
        .flatten()
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn manifest(budget: u64) -> AgentManifest {
    AgentManifest {
        name: "budgeted".into(),
        semantics: Some("product-agent-ordered-v1".into()),
        instructions: None,
        tools: Some(AgentTools {
            allow: vec!["read_file".into()],
            deny: vec![],
        }),
        permissions: None,
        ordered_permissions: None,
        permission_mode: None,
        model: None,
        mode: None,
        request: None,
        steps: None,
        budget: Some(budget),
    }
}

/// The soft budget asks for a wrap-up at 80% and then withholds tools for one
/// closing turn, pausing the run with a recoverable history fact. Four turns
/// at 40 billed tokens each cross both thresholds of a 100-token budget.
#[tokio::test]
async fn soft_prompt_budget_wraps_up_then_pauses_with_text_only() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), 3).await;
    runtime.set_agent("s", manifest(100)).await.unwrap();
    run_to_stop(&runtime, &store, 0, "one").await;

    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 4, "three tool turns and one closing answer");
    assert!(!requests[0].tools.is_empty());
    assert!(!message_text(&requests[0]).contains("PROMPT BUDGET WRAP-UP"));
    assert!(!requests[1].tools.is_empty());
    // Spent after two billed turns is 80 of 100: the wrap-up note rides the
    // third request while tools are still available.
    assert!(message_text(&requests[2]).contains("PROMPT BUDGET WRAP-UP"));
    assert!(!requests[2].tools.is_empty());
    // Spent after three is 120: the closing turn has no tools and asks for text.
    assert!(requests[3].tools.is_empty());
    assert!(message_text(&requests[3]).contains("PROMPT TOKEN BUDGET EXHAUSTED"));
    assert!(!message_text(&requests[3]).contains("PROMPT BUDGET WRAP-UP"));

    let events = store.events("s", 0, 1000).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "tool.completed")
            .count(),
        3
    );
    assert!(events.iter().any(|event| event.kind == "message.synthetic"
        && event.data["text"]
            .as_str()
            .unwrap_or_default()
            .contains("prompt token budget (100 tokens) is exhausted")));
    let stop = events
        .iter()
        .rev()
        .find(|event| event.kind == "stop" || event.kind == "stop_failure")
        .unwrap();
    assert_eq!(stop.kind, "stop");
    runtime.shutdown().await;
}

/// The budget is per prompt: the next admitted user input starts at zero and
/// gets the full tool surface back.
#[tokio::test]
async fn a_new_prompt_grants_a_fresh_budget() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, provider) = setup(dir.path(), 3).await;
    runtime.set_agent("s", manifest(100)).await.unwrap();
    run_to_stop(&runtime, &store, 0, "one").await;
    let before = store.events("s", 0, 1000).await.unwrap().len();
    run_to_stop(&runtime, &store, before, "two").await;

    let requests = provider.requests.lock().unwrap();
    let resumed = &requests[4];
    assert!(
        !resumed.tools.is_empty(),
        "a fresh prompt re-arms the tools"
    );
    assert!(!message_text(resumed).contains("PROMPT TOKEN BUDGET EXHAUSTED"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_agent_budget_is_bounded_like_the_config() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), 1).await;
    for budget in [0, 1_000_000_001] {
        assert!(matches!(
            runtime.set_agent("s", manifest(budget)).await,
            Err(miao_engine::protocol::Error::Invalid(_))
        ));
    }
    assert!(store.agent("s").await.unwrap().is_none());
    runtime.shutdown().await;
}
