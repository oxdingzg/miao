use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
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
use tokio_util::sync::CancellationToken;
struct Caller(AtomicUsize);
#[async_trait]
impl Provider for Caller {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            let input: Value =
                serde_json::from_str(request.messages[0].content[0]["text"].as_str().unwrap())
                    .unwrap();
            if let Some(calls) = input.as_array() {
                return Ok(Reply {content:Value::Array(calls.iter().map(|call|json!({"type":"tool_use","id":format!("knowledge-{}",self.0.fetch_add(1,Ordering::SeqCst)),"name":call["name"],"input":call["input"]})).collect()),usage:json!({}),needs_tools:true});
            }
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":format!("knowledge-{}",self.0.fetch_add(1,Ordering::SeqCst)),"name":"knowledge","input":input}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        let results: Vec<_> = request
            .messages
            .iter()
            .flat_map(|message| message.content.as_array().into_iter().flatten())
            .filter(|block| block["type"] == "tool_result")
            .collect();
        if results.len() > 1 {
            assert!(results.iter().all(|block| block["is_error"] != true));
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
#[tokio::test]
async fn knowledge_reads_work_inside_a_declared_read_batch_without_creating_storage() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path(), Config::default()).await;
    std::fs::write(
        dir.path().join("workspace/module.rs"),
        "pub fn alpha() {}\n",
    )
    .unwrap();
    let result=run(&runtime,&store,json!([{"name":"knowledge","input":{"op":"list"}},{"name":"read_file","input":{"path":"module.rs"}}])).await;
    assert_eq!(result["notes"], json!([]));
    assert!(!dir.path().join("workspace/.miao/knowledge.json").exists());
    runtime.shutdown().await;
}

async fn setup(root: &std::path::Path, config: Config) -> (Runtime, Store) {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(root.join(uuid::Uuid::new_v4().to_string()))
        .await
        .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Caller(AtomicUsize::new(0))),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(config).unwrap(),
    )
    .await
    .unwrap();
    (runtime, store)
}
fn writable() -> Config {
    Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "knowledge".into(),
            path: ".miao/knowledge.json".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    }
}
async fn run(runtime: &Runtime, store: &Store, op: Value) -> Value {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let mut progress = runtime.progress();
    runtime
        .admit(
            Input {
                session_id: session.clone(),
                input_id: uuid::Uuid::new_v4().to_string(),
                prompt: op.to_string(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    // This verifies committed knowledge semantics, not disk throughput. A 2ms
    // polling loop competes with the runtime's SQLite writes on hosted Windows.
    // Keep a bounded hang watchdog, and preserve evidence instead of reporting
    // only Elapsed(()) when a run fails to settle.
    let mut observed = Vec::new();
    let mut events = Vec::new();
    let settled = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            events = store.events(&session, 0, 100).await.unwrap();
            if events.iter().any(|event| event.kind == "run.finished") {
                return true;
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
                event = progress.recv() => {
                    if let Ok(event) = event {
                        if event["session_id"] == session {
                            let failed = event["kind"] == "runtime.error";
                            observed.push(event);
                            if failed { return false; }
                        }
                    }
                }
            }
        }
    })
    .await;
    assert!(matches!(settled, Ok(true)), "knowledge run did not settle: session={session}, op={op}, watchdog={settled:?}, events={events:?}, progress={observed:?}");
    let history = store.history(&session).await.unwrap();
    let result = history
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_result")
        .unwrap();
    serde_json::from_str(result["content"].as_str().unwrap()).unwrap()
}
#[tokio::test]
async fn indexed_sources_survive_sessions_and_become_stale_until_explicitly_refreshed() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path(), writable()).await;
    let source = dir.path().join("workspace/module.rs");
    std::fs::write(&source, "pub fn alpha() {}\nstruct Beta;\n").unwrap();
    let first = run(
        &runtime,
        &store,
        json!({"op":"index_file","id":"module","path":"module.rs","expected_revision":0}),
    )
    .await;
    assert_eq!(first["applied"], true);
    assert_eq!(first["revision"], 1);
    let get = run(&runtime, &store, json!({"op":"get","id":"module"})).await;
    assert_eq!(get["source_state"], "current");
    let body: Value = serde_json::from_str(get["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["symbol_candidates"][0]["name"], "alpha");
    assert_eq!(body["symbol_coverage"], "lexical_only");
    assert!(get["instructions"].as_str().unwrap().contains("AGENTS.md"));
    std::fs::write(&source, "pub fn gamma() {}\n").unwrap();
    let stale = run(&runtime, &store, json!({"op":"get","id":"module"})).await;
    assert_eq!(stale["source_state"], "source_changed");
    assert!(stale["body"].is_null());
    let review = run(
        &runtime,
        &store,
        json!({"op":"get","id":"module","include_stale":true}),
    )
    .await;
    assert!(review["body"].as_str().unwrap().contains("alpha"));
    let refreshed=run(&runtime,&store,json!({"op":"index_file","id":"module","path":"module.rs","expected_revision":1,"expected_store_sha256":first["store_sha256"]})).await;
    assert_eq!(refreshed["revision"], 2);
    let conflict=run(&runtime,&store,json!({"op":"delete","id":"module","expected_revision":1,"expected_store_sha256":refreshed["store_sha256"]})).await;
    assert_eq!(conflict["applied"], false);
    assert_eq!(conflict["current_revision"], 2);
    let deleted=run(&runtime,&store,json!({"op":"delete","id":"module","expected_revision":2,"expected_store_sha256":refreshed["store_sha256"]})).await;
    assert_eq!(deleted["deleted"], true);
    let recreated=run(&runtime,&store,json!({"op":"index_file","id":"module","path":"module.rs","expected_revision":0,"expected_store_sha256":deleted["store_sha256"]})).await;
    assert_eq!(recreated["revision"], 4);
    runtime.shutdown().await;
}
#[tokio::test]
async fn preferences_require_explicit_review_and_external_edits_are_not_silently_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path(), writable()).await;
    let first=run(&runtime,&store,json!({"op":"put","id":"style","expected_revision":0,"title":"Style","kind":"preference","body":"Prefer concise answers"})).await;
    assert_eq!(first["applied"], true);
    let get = run(&runtime, &store, json!({"op":"get","id":"style"})).await;
    assert_eq!(get["source_state"], "unverified");
    assert!(get["body"].is_null());
    let review = run(
        &runtime,
        &store,
        json!({"op":"get","id":"style","include_stale":true}),
    )
    .await;
    assert_eq!(review["body"], "Prefer concise answers");
    assert!(review["expires_at_ms"].is_u64());
    let path = dir.path().join("workspace/.miao/knowledge.json");
    let mut document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    document["notes"]["style"]["body"] = json!("Human correction");
    std::fs::write(&path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    let old = std::fs::read(&path).unwrap();
    let refused=run(&runtime,&store,json!({"op":"delete","id":"style","expected_revision":1,"expected_store_sha256":first["store_sha256"]})).await;
    assert_eq!(refused["applied"], false);
    assert_eq!(std::fs::read(&path).unwrap(), old);
    std::fs::write(&path, b"{\"user_work\":true}").unwrap();
    let malformed=run(&runtime,&store,json!({"op":"put","id":"new","expected_revision":0,"title":"new","kind":"preference","body":"new"})).await;
    assert!(malformed["error"].is_string());
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"user_work\":true}");
    runtime.shutdown().await;
}
#[tokio::test]
async fn readonly_and_source_denials_are_preserved_by_knowledge_operations() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path(), Config::default()).await;
    let denied=run(&runtime,&store,json!({"op":"put","id":"x","expected_revision":0,"title":"x","kind":"preference","body":"x"})).await;
    assert!(denied["error"].is_string());
    assert!(!dir.path().join("workspace/.miao/knowledge.json").exists());
    runtime.shutdown().await;
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path(), writable()).await;
    std::fs::write(
        dir.path().join("workspace/secret.rs"),
        "pub fn private_marker() {}\n",
    )
    .unwrap();
    run(
        &runtime,
        &store,
        json!({"op":"index_file","id":"source","path":"secret.rs","expected_revision":0}),
    )
    .await;
    runtime.shutdown().await;
    let mut config = Config::default();
    config.rules.push(Rule {
        tool: "read_file".into(),
        path: "secret.rs".into(),
        decision: Decision::Deny,
    });
    let (reader, store) = setup(dir.path(), config).await;
    let result = run(
        &reader,
        &store,
        json!({"op":"get","id":"source","include_stale":true}),
    )
    .await;
    assert_eq!(result["source_state"], "restricted");
    assert!(!result.to_string().contains("private_marker"));
    reader.shutdown().await;
}
