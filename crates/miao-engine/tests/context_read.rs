use async_trait::async_trait;
use miao_engine::{
    context::{Reference, Source},
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
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

struct Reader {
    paths: Vec<String>,
    batch: bool,
    calls: AtomicUsize,
    send: mpsc::Sender<String>,
}

#[async_trait]
impl Provider for Reader {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let turn = self.calls.fetch_add(1, Ordering::SeqCst);
        self.send.send(request.system).await.unwrap();
        let paths = match (self.batch, turn) {
            (true, 0) => self.paths.iter().collect::<Vec<_>>(),
            (true, _) => Vec::new(),
            (false, _) => self.paths.get(turn).into_iter().collect(),
        };
        Ok(Reply {
            needs_tools: !paths.is_empty(),
            content: if paths.is_empty() {
                json!([{"type":"text","text":"done"}])
            } else {
                json!(paths.iter().enumerate().map(|(index,path)| json!({"type":"tool_use","id":format!("read-{turn}-{index}"),"name":"read_file","input":{"path":path}})).collect::<Vec<_>>())
            },
            usage: json!({}),
        })
    }
}

async fn start(
    store: &Store,
    tools: Tools,
    paths: &[&str],
    policy: Config,
) -> (Runtime, mpsc::Receiver<String>) {
    let (send, receive) = mpsc::channel(32);
    let provider = Arc::new(Reader {
        paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        batch: false,
        calls: AtomicUsize::new(0),
        send,
    });
    let policy = Policy::new(policy).unwrap();
    // Cancelled supervisors may retain the old Runtime until their task exits.
    // Reopening must still acquire the real Store claim, never bypass it.
    let runtime = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match Runtime::with_policy(
                store.clone(),
                provider.clone(),
                tools.clone(),
                policy.clone(),
            )
            .await
            {
                Ok(runtime) => return runtime,
                Err(Error::Busy) => tokio::time::sleep(std::time::Duration::from_millis(2)).await,
                Err(error) => panic!("runtime startup failed: {error}"),
            }
        }
    })
    .await
    .unwrap();
    (runtime, receive)
}

async fn prompt(runtime: &Runtime, session: &str, id: &str) {
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: session.into(),
                input_id: id.into(),
                prompt: id.into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
}

async fn request(receive: &mut mpsc::Receiver<String>) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn idle(store: &Store, session: &str, completed: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events(session, 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= completed
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src/deep")).unwrap();
    std::fs::write(dir.path().join("AGENTS.md"), "ROOT_RULE").unwrap();
    std::fs::write(dir.path().join("src/AGENTS.md"), "PARENT_RULE").unwrap();
    std::fs::write(dir.path().join("src/deep/AGENTS.md"), "CHILD_RULE").unwrap();
    std::fs::write(dir.path().join("src/deep/CLAUDE.md"), "LOWER_PRIORITY_RULE").unwrap();
    std::fs::write(dir.path().join("src/deep/file.txt"), "fixture").unwrap();
    dir
}

#[tokio::test]
async fn successful_reads_activate_scoped_instructions_at_the_next_boundary_once() {
    let dir = workspace();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &["src/deep/file.txt", "src/deep/file.txt"],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "one").await;
    assert!(!request(&mut receive).await.contains("PARENT_RULE"));
    for _ in 0..2 {
        let system = request(&mut receive).await;
        assert_eq!(system.matches("PARENT_RULE").count(), 1);
        assert_eq!(system.matches("CHILD_RULE").count(), 1);
        assert!(system.find("ROOT_RULE") < system.find("PARENT_RULE"));
        assert!(system.find("PARENT_RULE") < system.find("CHILD_RULE"));
        assert!(system.contains("path=\"src/deep/AGENTS.md\""));
        assert!(!system.contains("LOWER_PRIORITY_RULE"));
    }
    idle(&store, "s", 1).await;
    let events = store.events("s", 0, 1000).await.unwrap();
    let settled = events
        .iter()
        .find(|event| event.kind == "tool.completed")
        .unwrap();
    assert_eq!(settled.data["read"]["path"], "src/deep/file.txt");
    let context = store.context("s", None).await.unwrap().unwrap();
    let sources = context["sources"].as_array().unwrap();
    assert_eq!(
        sources
            .iter()
            .filter(|source| source["type"] == "read_instruction")
            .count(),
        2
    );
    assert!(sources
        .iter()
        .any(|source| source["read_path"] == "src/deep/file.txt"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn observations_survive_reopen_and_never_leak_to_another_session() {
    let dir = workspace();
    let database = dir.path().join("engine.db");
    let store = Store::open(&database).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &["src/deep/file.txt"],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    assert!(request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 1).await;
    runtime.shutdown().await;
    drop(runtime);
    drop(store);
    let store = Store::open(&database).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &[],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "two").await;
    assert_eq!(request(&mut receive).await.matches("CHILD_RULE").count(), 1);
    idle(&store, "s", 2).await;
    prompt(&runtime, "other", "other-one").await;
    assert!(!request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "other", 1).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_settled_read_before_context_selection_is_recovered_from_the_ledger() {
    let dir = workspace();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let location = tools.location().to_owned();
    let (runtime, mut receive) = start(&store, tools, &[], Config::default()).await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    idle(&store, "s", 1).await;
    // Model the durable cut after result commit but before the next context.
    store.record("s", "tool.completed", json!({"call_id":"interrupted/read","is_error":false,"read":{"location":location,"path":"src/deep/file.txt"}})).await.unwrap();
    runtime.shutdown().await;
    drop(runtime);
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &[],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "two").await;
    assert!(request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 2).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn failed_reads_and_instruction_policy_denials_do_not_inject_bodies() {
    for (path, denied) in [
        ("src/deep/missing.txt", "none"),
        ("src/deep/file.txt", "src/deep/file.txt"),
        ("src/deep/file.txt", "src/deep/AGENTS.md"),
    ] {
        let dir = workspace();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let (runtime, mut receive) = start(
            &store,
            Tools::new(dir.path()).await.unwrap(),
            &[path],
            Config {
                rules: vec![Rule {
                    tool: "read_file".into(),
                    path: denied.into(),
                    decision: Decision::Deny,
                }],
                ..Config::default()
            },
        )
        .await;
        prompt(&runtime, "s", "one").await;
        request(&mut receive).await;
        assert!(!request(&mut receive).await.contains("CHILD_RULE"));
        idle(&store, "s", 1).await;
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn host_selected_sources_deduplicate_and_suppressed_root_is_not_reintroduced() {
    let dir = workspace();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_workspace_instructions(false)
        .with_context_sources(vec![Source {
            label: "host-selected".into(),
            path: "src/AGENTS.md".into(),
        }])
        .unwrap();
    let (runtime, mut receive) =
        start(&store, tools, &["src/deep/file.txt"], Config::default()).await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    let system = request(&mut receive).await;
    assert!(!system.contains("ROOT_RULE"));
    assert_eq!(system.matches("PARENT_RULE").count(), 1);
    assert_eq!(system.matches("CHILD_RULE").count(), 1);
    idle(&store, "s", 1).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn authorized_external_reads_do_not_discover_external_instructions() {
    let dir = workspace();
    let external = workspace();
    let path = external
        .path()
        .join("src/deep/file.txt")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_references(vec![Reference {
            path: external
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            description: "fixture read reference".into(),
        }])
        .unwrap();
    let (runtime, mut receive) = start(&store, tools, &[&path], Config::default()).await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    assert!(!request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 1).await;
    assert!(store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "tool.completed" && event.data["is_error"] == false));
    runtime.shutdown().await;
}

#[tokio::test]
async fn foreign_location_receipts_and_sources_are_not_adopted() {
    let dir = workspace();
    let external = workspace();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &[],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    idle(&store, "s", 1).await;
    let location = external
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    store.record("s", "instructions_loaded", json!({"run_id":"old-location","location":location,"sources":[{"type":"read_instruction","path":"src/deep/AGENTS.md","location":location,"read_path":"src/deep/file.txt"}]})).await.unwrap();
    store.record("s", "tool.completed", json!({"call_id":"old-location/read","is_error":false,"read":{"location":location,"path":"src/deep/file.txt"}})).await.unwrap();
    prompt(&runtime, "s", "two").await;
    assert!(!request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 2).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn nested_instructions_respect_the_existing_context_budget() {
    let dir = workspace();
    std::fs::write(
        dir.path().join("src/AGENTS.md"),
        format!("PARENT_RULE{}", "x".repeat(32768 - 11)),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("src/deep/AGENTS.md"),
        format!("CHILD_RULE{}", "x".repeat(32768 - 10)),
    )
    .unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &["src/deep/file.txt"],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    let system = request(&mut receive).await;
    assert!(system.contains("PARENT_RULE"));
    assert!(!system.contains("CHILD_RULE"));
    assert!(system.len() <= 65536);
    idle(&store, "s", 1).await;
    let context = store.context("s", None).await.unwrap().unwrap();
    assert!(context["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |source| source["path"] == "src/deep/AGENTS.md" && source["reason"] == "context_budget"
        ));
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn an_external_reference_does_not_authorize_a_nested_instruction_symlink() {
    let dir = workspace();
    let external = workspace();
    std::fs::remove_file(dir.path().join("src/deep/AGENTS.md")).unwrap();
    std::os::unix::fs::symlink(
        external.path().join("src/deep/AGENTS.md"),
        dir.path().join("src/deep/AGENTS.md"),
    )
    .unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_references(vec![Reference {
            path: external
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            description: "external read authority only".into(),
        }])
        .unwrap();
    let (runtime, mut receive) =
        start(&store, tools, &["src/deep/file.txt"], Config::default()).await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    assert!(!request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 1).await;
    let context = store.context("s", None).await.unwrap().unwrap();
    assert!(context["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|source| source["path"] == "src/deep/AGENTS.md"
            && source["reason"] == "outside_context_authority"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_fork_inherits_only_the_instructions_selected_at_its_checkpoint() {
    let dir = workspace();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (runtime, mut receive) = start(
        &store,
        Tools::new(dir.path()).await.unwrap(),
        &["src/deep/file.txt"],
        Config::default(),
    )
    .await;
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    assert!(request(&mut receive).await.contains("CHILD_RULE"));
    idle(&store, "s", 1).await;
    store.fork("s", "forked", None).await.unwrap();
    prompt(&runtime, "forked", "fork-one").await;
    assert_eq!(request(&mut receive).await.matches("CHILD_RULE").count(), 1);
    idle(&store, "forked", 1).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn parallel_reads_activate_each_directory_and_strip_internal_metadata_from_history() {
    let dir = workspace();
    std::fs::create_dir(dir.path().join("other")).unwrap();
    std::fs::write(dir.path().join("other/CONTEXT.md"), "OTHER_RULE").unwrap();
    std::fs::write(dir.path().join("other/file.txt"), "other fixture").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (send, mut receive) = mpsc::channel(8);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Reader {
            paths: vec!["src/deep/file.txt".into(), "other/file.txt".into()],
            batch: true,
            calls: AtomicUsize::new(0),
            send,
        }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    prompt(&runtime, "s", "one").await;
    request(&mut receive).await;
    let system = request(&mut receive).await;
    assert!(system.contains("CHILD_RULE"));
    assert!(system.contains("OTHER_RULE"));
    idle(&store, "s", 1).await;
    let events = store.events("s", 0, 1000).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "tool.parallel.started"));
    for event in events.iter().filter(|event| event.kind == "tool.completed") {
        assert!(event.data["read"]["path"].is_string());
        assert!(event.data["result"].get("_instruction_read").is_none());
        assert!(!event.data["result_json"]
            .as_str()
            .unwrap()
            .contains("_instruction_read"));
    }
    runtime.shutdown().await;
}
