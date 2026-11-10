use async_trait::async_trait;
use miao_engine::{
    permission::{digest, Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Plan = Arc<dyn Fn(usize, &[Value]) -> Vec<Value> + Send + Sync>;

/// The provider replays a scripted conversation: each turn receives the
/// tool results accumulated so far and emits the next content, the way a
/// model reacts to a stale or rejected edit.
struct Script {
    plan: Plan,
    turns: Arc<Mutex<usize>>,
}

#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let index = {
            let mut turns = self.turns.lock().unwrap();
            let index = *turns;
            *turns += 1;
            index
        };
        let results: Vec<Value> = request
            .messages
            .iter()
            .flat_map(|message| message.content.as_array().into_iter().flatten())
            .filter(|part| part["type"] == "tool_result")
            .map(|part| {
                serde_json::from_str(part["content"].as_str().unwrap_or_default())
                    .unwrap_or(json!({}))
            })
            .collect();
        let content = (self.plan)(index, &results);
        let needs_tools = content.iter().any(|part| part["type"] == "tool_use");
        Ok(Reply {
            content: Value::Array(content),
            usage: json!({}),
            needs_tools,
        })
    }
}

fn tool_use(id: &str, name: &str, input: Value) -> Vec<Value> {
    json!([{"type":"tool_use","id":id,"name":name,"input":input}])
        .as_array()
        .cloned()
        .unwrap()
}

fn text_done() -> Vec<Value> {
    json!([{"type":"text","text":"done"}])
        .as_array()
        .cloned()
        .unwrap()
}

fn read_call(id: &str, path: &str) -> Vec<Value> {
    tool_use(id, "read_file", json!({"path": path}))
}

fn digest_at(root: &std::path::Path, path: &str) -> String {
    digest(&std::fs::read(root.join(path)).unwrap())
}

fn config() -> Config {
    Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    }
}

async fn launch(
    root: &std::path::Path,
    plan: Plan,
    recovery: bool,
    short_anchors: bool,
    batch_edit: bool,
) -> (Runtime, Store, Arc<Mutex<usize>>) {
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let tools = Tools::new(root)
        .await
        .unwrap()
        .with_writes(true)
        .with_edit_recovery(recovery)
        .with_short_anchors(short_anchors)
        .with_batch_edit(batch_edit);
    let turns = Arc::new(Mutex::new(0));
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Script {
            plan,
            turns: turns.clone(),
        }),
        tools,
        Policy::new(config()).unwrap(),
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
                prompt: "edit".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store, turns)
}

async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 400)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

async fn last_result(store: &Store) -> Value {
    store
        .events("s", 0, 400)
        .await
        .unwrap()
        .iter()
        .rfind(|event| event.kind == "tool.completed")
        .expect("a completed tool call")
        .data["result"]
        .clone()
}

#[tokio::test]
async fn the_short_anchor_carrier_edits_and_costs_fewer_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\n").unwrap();
    // Same edit, both spellings: the carrier names are strictly shorter, so
    // its wire payload is smaller for identical content.
    let full = json!({
        "path":"f.txt",
        "old_string":"beta\n",
        "new_string":"BETA\n",
        "expected_sha256": digest_at(&root, "f.txt"),
    });
    let short = json!({
        "path":"f.txt",
        "anchor":"beta\n",
        "new_text":"BETA\n",
        "expected_sha256": digest_at(&root, "f.txt"),
    });
    assert!(
        serde_json::to_string(&short).unwrap().len() < serde_json::to_string(&full).unwrap().len(),
        "the short carrier must serialize smaller than the full form"
    );
    let read = read_call("r", "f.txt");
    let short_clone = short.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => tool_use("e", "edit_file", short_clone.clone()),
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\n"
    );
    assert_eq!(last_result(&store).await["applied"], json!(true));
    assert_eq!(*turns.lock().unwrap(), 2, "read + one carrier call");
    runtime.shutdown().await;
}

#[tokio::test]
async fn ablating_short_anchors_rejects_the_carrier_and_the_full_form_still_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => tool_use(
            "e1",
            "edit_file",
            json!({
                "path":"f.txt",
                "anchor":"beta",
                "new_text":"BETA",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        2 => tool_use(
            "e2",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"beta",
                "new_string":"BETA",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, true, false, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\n",
        "the ablated carrier must not block the full-form edit"
    );
    assert_eq!(*turns.lock().unwrap(), 3);
    runtime.shutdown().await;
}

#[tokio::test]
async fn ablating_batch_edit_hides_the_tool_and_rejects_its_calls() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_writes(true)
        .with_batch_edit(false);
    let names: Vec<String> = tools
        .definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert!(
        !names.contains(&"apply_patch".to_string()),
        "the ablated batch carrier must leave the definitions: {names:?}"
    );
    assert!(names.contains(&"edit_file".to_string()));

    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => tool_use(
            "p",
            "apply_patch",
            json!({"patch":"*** Begin Patch\n*** Update File: f.txt\n@@\n-beta\n+BETA\n*** End Patch"}),
        ),
        2 => tool_use(
            "e",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"beta",
                "new_string":"BETA",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, _) = launch(&root, plan, true, true, false).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\n",
        "the ablated batch tool must not block edit_file"
    );
    let result = last_result(&store).await;
    assert_eq!(result["applied"], json!(true), "tool result: {result}");
    runtime.shutdown().await;
}

#[tokio::test]
async fn batch_edit_lands_three_files_in_one_call() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("c.txt"), "one\ntwo\nthree\n").unwrap();
    let patch = "*** Begin Patch\n*** Add File: a.txt\n+added\n*** Update File: c.txt\n@@\n-two\n+TWO\n*** Add File: sub/b.txt\n+b\n*** End Patch";
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => tool_use("p", "apply_patch", json!({"patch": patch})),
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    let result = last_result(&store).await;
    assert_eq!(result["applied"], json!(true), "tool result: {result}");
    assert_eq!(result["count"], json!(3));
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "added\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("sub/b.txt")).unwrap(),
        "b\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("c.txt")).unwrap(),
        "one\nTWO\nthree\n"
    );
    assert_eq!(*turns.lock().unwrap(), 1, "one call instead of three");
    runtime.shutdown().await;
}

#[tokio::test]
async fn rebasing_saves_the_reread_and_retry_turns() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => {
            std::fs::write(plan_root.join("f.txt"), "alpha\nrenamed\ngamma\nextra\n").unwrap();
            // The digest names the pre-drift read; the rebase relocates the
            // edit onto the drifted content instead of failing it.
            tool_use(
                "e",
                "edit_file",
                json!({
                    "path":"f.txt",
                    "old_string":"beta",
                    "new_string":"BETA",
                    "expected_sha256": digest(b"alpha\nbeta\ngamma\n"),
                }),
            )
        }
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\ngamma\nextra\n"
    );
    let result = last_result(&store).await;
    assert_eq!(result["rebased"], json!(true), "tool result: {result}");
    assert_eq!(
        *turns.lock().unwrap(),
        2,
        "recovery lands the edit in the read+edit turns alone"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_ablated_rebase_costs_a_reread_and_a_retry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => {
            std::fs::write(plan_root.join("f.txt"), "alpha\nrenamed\ngamma\nextra\n").unwrap();
            tool_use(
                "e1",
                "edit_file",
                json!({
                    "path":"f.txt",
                    "old_string":"beta",
                    "new_string":"BETA",
                    "expected_sha256": digest(b"alpha\nbeta\ngamma\n"),
                }),
            )
        }
        // The stale failure forces the full re-read the recovery avoids.
        2 => read_call("r2", "f.txt"),
        3 => tool_use(
            "e2",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"renamed",
                "new_string":"BETA",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, false, true, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\ngamma\nextra\n"
    );
    assert_eq!(
        *turns.lock().unwrap(),
        4,
        "without recovery the drift costs a re-read and a retry edit"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_stale_failure_hands_back_the_fingerprint_for_a_readless_retry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let carried_fingerprint = Arc::new(Mutex::new(false));
    let read = read_call("r", "f.txt");
    let flag = carried_fingerprint.clone();
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, results| match turn {
        0 => read.clone(),
        1 => {
            // The drift keeps old_string present, so the readless retry can
            // genuinely land the edit against the current content.
            std::fs::write(plan_root.join("f.txt"), "alpha\nbeta\ngamma\nextra\n").unwrap();
            tool_use(
                "e1",
                "edit_file",
                json!({
                    "path":"f.txt",
                    "old_string":"beta",
                    "new_string":"BETA",
                    "expected_sha256": digest(b"alpha\nbeta\ngamma\n"),
                }),
            )
        }
        // The stale payload names the current content: the retry corrects
        // its expectation without a separate read turn.
        2 => {
            let stale = results.last().expect("the stale failure result");
            let current = stale["current_sha256"].as_str().expect("fingerprint");
            *flag.lock().unwrap() = stale["error"].as_str().is_some();
            tool_use(
                "e2",
                "edit_file",
                json!({
                    "path":"f.txt",
                    "old_string":"beta",
                    "new_string":"BETA",
                    "expected_sha256": current,
                }),
            )
        }
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, false, true, true).await;
    finished(&store).await;
    assert!(
        *carried_fingerprint.lock().unwrap(),
        "the failure carries an error reason"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "alpha\nBETA\ngamma\nextra\n",
        "the readless retry must land the edit"
    );
    assert_eq!(
        *turns.lock().unwrap(),
        3,
        "read + fail + corrected retry, no re-read"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_unique_fuzzy_target_applies_and_explains_itself() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "fn kept() {\n    work();\n}\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        // The transcription carries a tab, so the needle is absent exactly
        // and only the whitespace-insensitive target can land.
        1 => tool_use(
            "e",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"\twork();",
                "new_string":"work(1);",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, turns) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "fn kept() {\n    work(1);\n}\n"
    );
    let result = last_result(&store).await;
    assert_eq!(result["fuzzy"], json!(true), "tool result: {result}");
    let note = result["note"].as_str().unwrap();
    assert!(note.contains("line 2"), "the note names the match: {note}");
    assert!(note.contains("whitespace-insensitive"), "note: {note}");
    assert_eq!(
        *turns.lock().unwrap(),
        2,
        "no re-read for a recoverable target"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_ambiguous_fuzzy_target_is_rejected_with_every_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let body = "if a {\n    ok()\n}\nif b {\n\tok()\n}\n";
    std::fs::write(root.join("f.txt"), body).unwrap();
    let read = read_call("r", "f.txt");
    let body_digest = digest(body.as_bytes());
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => tool_use(
            "e",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"  ok()  ",
                "new_string":"ok(1)",
                "expected_sha256": body_digest,
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, _) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    let result = last_result(&store).await;
    let error = result["error"].as_str().unwrap();
    assert!(
        error.contains("lines 2, 5"),
        "names the candidates: {error}"
    );
    assert!(
        error.contains("replace_all"),
        "names the escape hatch: {error}"
    );
    assert_eq!(
        result["current_sha256"].as_str().unwrap().len(),
        64,
        "the rejection carries the fingerprint for a readless retry: {result}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        body,
        "a refused edit must not touch the file"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_exact_match_never_goes_fuzzy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("f.txt"), "alpha\nbeta\n").unwrap();
    let read = read_call("r", "f.txt");
    let plan_root = root.clone();
    let plan: Plan = Arc::new(move |turn, _| match turn {
        0 => read.clone(),
        1 => tool_use(
            "e",
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"beta",
                "new_string":"BETA",
                "expected_sha256": digest_at(&plan_root, "f.txt"),
            }),
        ),
        _ => text_done(),
    });
    let (runtime, store, _) = launch(&root, plan, true, true, true).await;
    finished(&store).await;
    let result = last_result(&store).await;
    assert_eq!(result["applied"], json!(true), "tool result: {result}");
    assert!(result.get("fuzzy").is_none(), "tool result: {result}");
    runtime.shutdown().await;
}
