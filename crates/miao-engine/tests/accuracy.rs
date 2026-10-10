use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

// Updating snapshots is an explicit local maintenance operation. CI must always
// compare with reviewed, committed expectations, never rewrite them.
fn golden(name: &str, actual: Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/accuracy")
        .join(format!("{name}.json"));
    if std::env::var_os("MIAO_UPDATE_GOLDEN").is_some() {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI cannot update expectations"
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&actual).unwrap()),
        )
        .unwrap();
    }
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {}", path.display())),
    )
    .unwrap();
    assert_eq!(
        actual,
        expected,
        "{}: review the semantic change, not just the snapshot",
        path.display()
    );
}

struct Fix {
    catalog: Mutex<Option<Value>>,
    denied: bool,
}
#[async_trait]
impl Provider for Fix {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let catalog: BTreeMap<_, _> = request
            .tools
            .iter()
            .map(|tool| (tool.name.clone(), tool.input_schema.clone()))
            .collect();
        *self.catalog.lock().await = Some(serde_json::to_value(catalog).unwrap());
        let results: Vec<_> = request
            .messages
            .iter()
            .flat_map(|message| {
                message
                    .content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|part| part["type"] == "tool_result")
            })
            .collect();
        if results.is_empty() {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"read","name":"read_file","input":{"path":"answer.txt"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        if results.len() == 1 {
            let read: Value =
                serde_json::from_str(results[0]["content"].as_str().unwrap()).unwrap();
            // Independent product outcome checks are never snapshot-updated.
            assert_eq!(read["text"], "2\nkeep\n");
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"patch","name":"apply_patch","input":{"patch":"*** Begin Patch\n*** Update File: answer.txt\n@@\n-2\n+4\n keep\n*** End Patch"}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[1]["is_error"].as_bool().unwrap_or(false),
            self.denied
        );
        Ok(Reply {
            content: json!([{"type":"text","text":if self.denied { "blocked" } else { "fixed" }}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

async fn fix_scenario(denied: bool) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("answer.txt"), "2\nkeep\n").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Fix {
        catalog: Mutex::new(None),
        denied,
    });
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(&workspace).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![
                Rule {
                    tool: "*".into(),
                    path: "**".into(),
                    decision: Decision::Allow,
                },
                Rule {
                    tool: "apply_patch".into(),
                    path: "**".into(),
                    decision: if denied {
                        Decision::Deny
                    } else {
                        Decision::Allow
                    },
                },
            ],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "fix".into(),
                input_id: "one".into(),
                prompt: "Fix the value while preserving unrelated text.".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("fix", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("answer.txt")).unwrap(),
        if denied { "2\nkeep\n" } else { "4\nkeep\n" }
    );
    let history = store.history("fix").await.unwrap();
    assert_eq!(
        history.last().unwrap().content[0]["text"],
        if denied { "blocked" } else { "fixed" }
    );
    let events = store.events("fix", 0, 1000).await.unwrap();
    // Deliberately keep only observable lifecycle order and tool identities;
    // timestamps, UUIDs and checkpoints are not product promises.
    let transcript: Vec<_> = events
        .iter()
        .filter(|event| {
            matches!(
                event.kind.as_str(),
                "input.admitted"
                    | "input.promoted"
                    | "run.started"
                    | "tool.planned"
                    | "tool.dispatched"
                    | "tool.completed"
                    | "run.finished"
                    | "permission_denied"
            )
        })
        .map(|event| json!({"kind":event.kind,"tool":event.data.get("name")}))
        .collect();
    golden(
        if denied {
            "denied-transcript"
        } else {
            "fix-transcript"
        },
        json!(transcript),
    );
    if !denied {
        golden(
            "workspace-tool-schemas",
            provider.catalog.lock().await.clone().unwrap(),
        );
    }
    let mut replayed = Vec::new();
    let mut cursor = 0;
    loop {
        let page = store.events("fix", cursor, 3).await.unwrap();
        if page.is_empty() {
            break;
        }
        cursor = page.last().unwrap().seq;
        replayed.extend(page);
    }
    assert_eq!(
        serde_json::to_value(replayed).unwrap(),
        serde_json::to_value(events).unwrap()
    );
}

#[tokio::test]
async fn product_fix_has_correct_files_replay_and_model_contract() {
    fix_scenario(false).await;
}

#[tokio::test]
async fn denied_write_has_no_filesystem_effect() {
    fix_scenario(true).await;
}

#[tokio::test]
async fn read_only_tool_schema_contract() {
    let dir = tempfile::tempdir().unwrap();
    let catalog: BTreeMap<_, _> = Tools::new(dir.path())
        .await
        .unwrap()
        .definitions()
        .into_iter()
        .map(|tool| (tool.name, tool.input_schema))
        .collect();
    assert!(!catalog.contains_key("apply_patch"));
    assert!(!catalog.contains_key("task"));
    golden(
        "read-only-tool-schemas",
        serde_json::to_value(catalog).unwrap(),
    );
}

#[tokio::test]
async fn seeded_admission_sequences_preserve_delivery_and_exact_retry() {
    // A tiny deterministic PRNG only chooses operations. The oracle below is a
    // separate queue model; it never calls implementation internals to predict.
    for seed in 1u64..=12 {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("engine.db")).await.unwrap();
        let mut random = seed;
        let mut pending: Vec<(String, Delivery)> = Vec::new();
        let mut admitted = Vec::new();
        let mut promoted = Vec::new();
        for step in 0..128 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            match (random >> 32) % 4 {
                0 | 1 => {
                    let id = format!("{seed}-{step}");
                    let delivery = if random & 1 == 0 {
                        Delivery::Steer
                    } else {
                        Delivery::Queue
                    };
                    let input = Input {
                        session_id: "s".into(),
                        input_id: id.clone(),
                        prompt: id.clone(),
                        delivery,
                    };
                    let first = store.admit(input.clone()).await.unwrap();
                    let cursor = store.events("s", 0, 2000).await.unwrap().len();
                    let retry = store.admit(input.clone()).await.unwrap();
                    assert!(retry.duplicate, "seed={seed} step={step}");
                    assert_eq!(retry.admitted_seq, first.admitted_seq);
                    assert!(matches!(
                        store
                            .admit(Input {
                                prompt: "conflict".into(),
                                ..input
                            })
                            .await,
                        Err(Error::Conflict)
                    ));
                    assert_eq!(store.events("s", 0, 2000).await.unwrap().len(), cursor);
                    admitted.push(id.clone());
                    pending.push((id, delivery));
                }
                _ => {
                    let idle = random & 1 == 0;
                    let mut expected: Vec<String> = pending
                        .iter()
                        .filter(|(_, delivery)| *delivery == Delivery::Steer)
                        .map(|(id, _)| id.clone())
                        .collect();
                    if expected.is_empty() && idle {
                        if let Some((id, _)) = pending.first() {
                            expected.push(id.clone());
                        }
                    }
                    let actual: Vec<String> = store
                        .promote("s", idle)
                        .await
                        .unwrap()
                        .iter()
                        .map(|event| event.data["input_id"].as_str().unwrap().to_owned())
                        .collect();
                    assert_eq!(actual, expected, "seed={seed} step={step} idle={idle}");
                    pending.retain(|(id, _)| !expected.contains(id));
                    promoted.extend(expected);
                }
            }
        }
        while !pending.is_empty() {
            let actual = store.promote("s", true).await.unwrap();
            let ids: Vec<String> = actual
                .iter()
                .map(|e| e.data["input_id"].as_str().unwrap().into())
                .collect();
            assert!(!ids.is_empty());
            pending.retain(|(id, _)| !ids.contains(id));
            promoted.extend(ids);
        }
        let mut seen = promoted.clone();
        seen.sort();
        seen.dedup();
        admitted.sort();
        assert_eq!(seen, admitted, "seed={seed}: lost or duplicate admission");
        assert_eq!(promoted.len(), seen.len());
        let history: Vec<String> = store
            .history("s")
            .await
            .unwrap()
            .iter()
            .map(|message| message.content[0]["text"].as_str().unwrap().into())
            .collect();
        assert_eq!(history, promoted, "seed={seed}: projection order");
        let events = store.events("s", 0, 2000).await.unwrap();
        assert!(events.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    }
}
