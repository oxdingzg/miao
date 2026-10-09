use async_trait::async_trait;
use miao_engine::{
    approval::{Approval, Response},
    permission::{digest, Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Mutator {
    name: String,
    input: Value,
}
#[async_trait]
impl Provider for Mutator {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":self.name,"input":self.input}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn config(decision: Decision) -> Config {
    Config {
        mode: Mode::Workspace,
        rules: if decision == Decision::Ask {
            vec![]
        } else {
            vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision,
            }]
        },
        ..Config::default()
    }
}
async fn launch(
    root: &std::path::Path,
    name: &str,
    input: Value,
    config: Config,
) -> (Runtime, Store) {
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Mutator {
            name: name.into(),
            input,
        }),
        Tools::new(root).await.unwrap(),
        Policy::new(config).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "change".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store)
}
async fn approval(store: &Store) -> Approval {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .find(|e| e.kind == "approval.requested")
            {
                return serde_json::from_value(event.data.clone()).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
async fn finished(store: &Store) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
async fn approve(runtime: &Runtime, binding: Approval) {
    runtime
        .approve(
            &runtime.controller(),
            "s",
            Response {
                request_id: binding.request_id,
                input_hash: binding.input_hash,
                policy_revision: binding.policy_revision,
                decision: Decision::Allow,
                matcher: Some(binding.matcher),
            },
        )
        .await
        .unwrap();
}
fn staged_files(root: &std::path::Path) -> usize {
    std::fs::read_dir(root)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".miao-engine-")
        })
        .count()
}

#[tokio::test]
async fn workspace_write_waits_for_approval_then_commits_with_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(
        dir.path(),
        "write_file",
        json!({"path":"new.txt","text":"hello\n","expected_sha256":null}),
        config(Decision::Ask),
    )
    .await;
    let binding = approval(&store).await;
    assert_eq!(binding.tool, "write_file");
    assert_eq!(binding.resource, "new.txt");
    assert!(!dir.path().join("new.txt").exists());
    assert_eq!(staged_files(dir.path()), 0);
    approve(&runtime, binding).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("new.txt")).unwrap(),
        "hello\n"
    );
    let result: Value = serde_json::from_str(
        store.history("s").await.unwrap()[2].content[0]["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["sha256"], digest(b"hello\n"));
    assert_eq!(result["applied"], true);
    #[cfg(unix)]
    assert_eq!(result["durability"], "synced", "{result}");
    assert_eq!(staged_files(dir.path()), 0);
    runtime.shutdown().await;
}

#[tokio::test]
async fn cancel_pending_write_has_no_filesystem_effect() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(
        dir.path(),
        "write_file",
        json!({"path":"new.txt","text":"never","expected_sha256":null}),
        config(Decision::Ask),
    )
    .await;
    approval(&store).await;
    runtime.cancel("s").await.unwrap();
    finished(&store).await;
    assert!(!dir.path().join("new.txt").exists());
    assert_eq!(staged_files(dir.path()), 0);
    assert!(!store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|e| e.kind == "tool.dispatched"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn stale_fingerprint_and_create_only_never_clobber_existing_file() {
    for expected in [json!(null), json!("0".repeat(64))] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file"), "original").unwrap();
        let (runtime, store) = launch(
            dir.path(),
            "write_file",
            json!({"path":"file","text":"overwrite","expected_sha256":expected}),
            config(Decision::Allow),
        )
        .await;
        finished(&store).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file")).unwrap(),
            "original"
        );
        assert_eq!(
            store.history("s").await.unwrap()[2].content[0]["is_error"],
            true
        );
        assert_eq!(staged_files(dir.path()), 0);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn exact_edit_preserves_bom_crlf_and_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    let original = "\u{feff}old\r\nline\r\n";
    std::fs::write(&file, original).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let (runtime,store)=launch(dir.path(),"edit_file",json!({"path":"file","old_string":"old\r\n","new_string":"new\r\n","expected_sha256":digest(original.as_bytes())}),config(Decision::Allow)).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "\u{feff}new\r\nline\r\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    assert_eq!(staged_files(dir.path()), 0);
    runtime.shutdown().await;
}

#[tokio::test]
async fn ambiguous_edits_require_replace_all_and_external_change_invalidates_expected_hash() {
    for replace_all in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file"), "old old").unwrap();
        let (runtime,store)=launch(dir.path(),"edit_file",json!({"path":"file","old_string":"old","new_string":"new","replace_all":replace_all,"expected_sha256":digest(b"old old")}),config(Decision::Allow)).await;
        finished(&store).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file")).unwrap(),
            if replace_all { "new new" } else { "old old" }
        );
        runtime.shutdown().await;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file"), "original").unwrap();
    let (runtime, store) = launch(
        dir.path(),
        "write_file",
        json!({"path":"file","text":"overwrite","expected_sha256":digest(b"original")}),
        config(Decision::Ask),
    )
    .await;
    let binding = approval(&store).await;
    std::fs::write(dir.path().join("file"), "external").unwrap();
    approve(&runtime, binding).await;
    finished(&store).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("file")).unwrap(),
        "external"
    );
    assert_eq!(
        store.history("s").await.unwrap()[2].content[0]["is_error"],
        true
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn readonly_or_deny_and_invalid_parent_paths_cannot_mutate_files() {
    for config in [Config::default(), config(Decision::Deny)] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, store) = launch(
            dir.path(),
            "write_file",
            json!({"path":"new.txt","text":"never","expected_sha256":null}),
            config,
        )
        .await;
        finished(&store).await;
        assert!(!dir.path().join("new.txt").exists());
        assert!(!store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .any(|e| e.kind == "tool.dispatched"));
        runtime.shutdown().await;
    }
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = launch(
        dir.path(),
        "write_file",
        json!({"path":"missing/file","text":"never","expected_sha256":null}),
        config(Decision::Allow),
    )
    .await;
    finished(&store).await;
    assert!(!dir.path().join("missing").exists());
    runtime.shutdown().await;
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("file"), "secret").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("file"), dir.path().join("link")).unwrap();
        let (runtime, store) = launch(
            dir.path(),
            "write_file",
            json!({"path":"link","text":"never","expected_sha256":digest(b"secret")}),
            config(Decision::Allow),
        )
        .await;
        finished(&store).await;
        assert_eq!(
            std::fs::read_to_string(outside.path().join("file")).unwrap(),
            "secret"
        );
        runtime.shutdown().await;
    }
}
