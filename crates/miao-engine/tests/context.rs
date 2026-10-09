use async_trait::async_trait;
use miao_engine::{
    context::assemble,
    permission::{context_digest, digest, Config, Decision, Policy, Rule},
    protocol::{ContextBundle, Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn input(session: &str, id: &str) -> Input {
    Input {
        session_id: session.into(),
        input_id: id.into(),
        prompt: id.into(),
        delivery: Delivery::Steer,
    }
}
fn bundle(system: &str) -> ContextBundle {
    ContextBundle {
        system: system.into(),
        sources: vec![],
        fingerprint: context_digest(system, &[]).unwrap(),
    }
}

#[tokio::test]
async fn project_instructions_are_scoped_bounded_and_policy_checked() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("AGENTS.md"), "请保留用户改动。\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    let policy = Policy::new(Config::default()).unwrap();
    let context = assemble(&tools, &policy, CancellationToken::new())
        .await
        .unwrap();
    assert!(context.system.contains("请保留用户改动"));
    assert_eq!(
        context.sources[0]["sha256"],
        digest("请保留用户改动。\n".as_bytes())
    );
    for decision in [Decision::Deny, Decision::Ask] {
        let policy = Policy::new(Config {
            rules: vec![Rule {
                tool: "read_file".into(),
                path: "AGENTS.md".into(),
                decision,
            }],
            ..Config::default()
        })
        .unwrap();
        let skipped = assemble(&tools, &policy, CancellationToken::new())
            .await
            .unwrap();
        assert!(!skipped.system.contains("请保留用户改动"));
        assert_eq!(skipped.sources[0]["status"], "skipped");
    }
    #[cfg(unix)]
    {
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("private"), "outside instructions").unwrap();
        std::fs::remove_file(dir.path().join("AGENTS.md")).unwrap();
        std::os::unix::fs::symlink(
            external.path().join("private"),
            dir.path().join("AGENTS.md"),
        )
        .unwrap();
        let skipped = assemble(&tools, &policy, CancellationToken::new())
            .await
            .unwrap();
        assert!(!skipped.system.contains("outside instructions"));
        assert_eq!(skipped.sources[0]["reason"], "outside_context_authority");
    }
}

#[tokio::test]
async fn context_epochs_are_immutable_reused_and_inherited_at_message_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .admit_at(input("s", "one"), Some("root".into()))
        .await
        .unwrap();
    assert_eq!(
        store
            .select_context("s", bundle("baseline one"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .select_context("s", bundle("baseline one"))
            .await
            .unwrap(),
        1
    );
    store.promote("s", true).await.unwrap();
    let boundary = store
        .message("s", "assistant", json!([{"type":"text","text":"answer"}]))
        .await
        .unwrap();
    assert_eq!(
        store
            .select_context("s", bundle("baseline two"))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        store.context("s", Some(1)).await.unwrap().unwrap()["system"],
        "baseline one"
    );
    assert_eq!(store.snapshot("s").await.unwrap()["context"]["epoch"], 2);
    store.fork("s", "child", Some(boundary.seq)).await.unwrap();
    let inherited = store.context("child", None).await.unwrap().unwrap();
    assert_eq!(inherited["system"], "baseline one");
    assert_eq!(inherited["epoch"], 1);
    assert_eq!(
        store
            .select_context("child", bundle("baseline one"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .select_context("child", bundle("baseline two"))
            .await
            .unwrap(),
        2
    );
    assert!(store.context("s", Some(99)).await.unwrap().is_none());
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "context.changed")
            .count(),
        2
    );
}

#[tokio::test]
async fn invalid_bundle_does_not_change_epoch_or_events() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store.admit(input("s", "one")).await.unwrap();
    let mut invalid = bundle("body");
    invalid.fingerprint = "other".into();
    assert!(store.select_context("s", invalid).await.is_err());
    assert!(store
        .select_context("s", bundle(&"x".repeat(65537)))
        .await
        .is_err());
    assert!(store.context("s", None).await.unwrap().is_none());
    assert_eq!(store.events("s", 0, 100).await.unwrap().len(), 1);
}

struct Capture {
    send: mpsc::Sender<String>,
}
#[async_trait]
impl Provider for Capture {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.send.send(request.system).await.unwrap();
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
async fn idle(store: &Store, session: &str, completed: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events(session, 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|e| e.kind == "run.finished")
                .count()
                >= completed
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn runtime_reloads_instructions_at_boundaries_without_session_id_in_cache_prefix() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("AGENTS.md"), "original instructions").unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let (send, mut receive) = mpsc::channel(10);
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Capture { send }),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime.admit(input("s", "one"), true).await.unwrap();
    let first = receive.recv().await.unwrap();
    idle(&store, "s", 1).await;
    runtime.admit(input("other", "other"), true).await.unwrap();
    let other = receive.recv().await.unwrap();
    idle(&store, "other", 1).await;
    assert_eq!(first, other);
    std::fs::write(dir.path().join("AGENTS.md"), "updated instructions").unwrap();
    runtime.admit(input("s", "two"), true).await.unwrap();
    let next = receive.recv().await.unwrap();
    idle(&store, "s", 2).await;
    assert!(first.contains("original instructions"));
    assert!(next.contains("updated instructions"));
    assert_eq!(store.context("s", None).await.unwrap().unwrap()["epoch"], 2);
    let steps = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "provider.started")
        .collect::<Vec<_>>();
    assert_eq!(steps[0].data["context_epoch"], 1);
    assert_eq!(steps[1].data["context_epoch"], 2);
    runtime.shutdown().await;
}

#[tokio::test]
async fn explicit_sources_preserve_order_policy_and_fingerprints() {
    use miao_engine::context::Source;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("AGENTS.md"), "root rules").unwrap();
    std::fs::write(dir.path().join("persona.md"), "persona rules").unwrap();
    std::fs::write(dir.path().join("team.md"), "team rules").unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_context_sources(vec![
            Source {
                label: "persona".into(),
                path: "persona.md".into(),
            },
            Source {
                label: "team".into(),
                path: "team.md".into(),
            },
            Source {
                label: "missing".into(),
                path: "missing.md".into(),
            },
        ])
        .unwrap();
    let policy = Policy::new(Config::default()).unwrap();
    let first = assemble(&tools, &policy, CancellationToken::new())
        .await
        .unwrap();
    assert!(first.system.find("root rules").unwrap() < first.system.find("persona rules").unwrap());
    assert!(first.system.find("persona rules").unwrap() < first.system.find("team rules").unwrap());
    assert_eq!(first.sources[3]["status"], "missing");
    std::fs::write(dir.path().join("team.md"), "changed rules").unwrap();
    let next = assemble(&tools, &policy, CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(first.fingerprint, next.fingerprint);
    assert_eq!(first.sources[1]["sha256"], next.sources[1]["sha256"]);
    for decision in [Decision::Ask, Decision::Deny] {
        let policy = Policy::new(Config {
            rules: vec![
                Rule {
                    tool: "read_file".into(),
                    path: "AGENTS.md".into(),
                    decision,
                },
                Rule {
                    tool: "read_file".into(),
                    path: "persona.md".into(),
                    decision,
                },
            ],
            ..Config::default()
        })
        .unwrap();
        let selected = assemble(&tools, &policy, CancellationToken::new())
            .await
            .unwrap();
        assert!(!selected.system.contains("root rules"));
        assert!(!selected.system.contains("persona rules"));
        assert!(selected.system.contains("changed rules"));
        assert_eq!(selected.sources[1]["status"], "skipped");
    }
}

#[tokio::test]
async fn explicit_sources_reject_ambiguous_paths_and_total_context_overflow() {
    use miao_engine::{context::Source, tools::ToolError};
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    for path in [
        "../private",
        "/absolute",
        "a/../b",
        "a/./b",
        "AGENTS.md",
        "a\\b",
    ] {
        assert!(tools
            .clone()
            .with_context_sources(vec![Source {
                label: "extra".into(),
                path: path.into()
            }])
            .is_err());
    }
    assert!(tools
        .clone()
        .with_context_sources(vec![Source {
            label: "invalid\"label".into(),
            path: "a.md".into()
        }])
        .is_err());
    std::fs::write(dir.path().join("AGENTS.md"), "r".repeat(32768)).unwrap();
    std::fs::write(dir.path().join("extra.md"), "x".repeat(32768)).unwrap();
    let tools = tools
        .with_context_sources(vec![Source {
            label: "extra".into(),
            path: "extra.md".into(),
        }])
        .unwrap();
    assert!(matches!(
        assemble(
            &tools,
            &Policy::new(Config::default()).unwrap(),
            CancellationToken::new()
        )
        .await,
        Err(ToolError::ContextBudget)
    ));
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        assemble(&tools, &Policy::new(Config::default()).unwrap(), token).await,
        Err(ToolError::Interrupted)
    ));
}
