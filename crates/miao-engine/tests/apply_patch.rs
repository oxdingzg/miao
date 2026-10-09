#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Executor {
    patch: &'static str,
}
#[async_trait]
impl Provider for Executor {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([
                    {"type":"tool_use","id":"patch","name":"apply_patch","input":{"patch":self.patch}}
                ]),
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

const PATCH: &str = r#"*** Begin Patch
*** Add File: docs/new.txt
+created line
*** Update File: readme.md
@@
- Hello
+ Hello, patched
 world
*** Delete File: obsolete.log
*** End Patch
"#;

fn policy(deny_patch: bool) -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: if deny_patch {
                "apply_patch".into()
            } else {
                "*".into()
            },
            path: if deny_patch {
                "@workspace/patch".into()
            } else {
                "**".into()
            },
            decision: if deny_patch {
                Decision::Deny
            } else {
                Decision::Allow
            },
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn drive(parent: &std::path::Path, patch: &'static str, deny_patch: bool) -> String {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Executor { patch }),
        Tools::new(&workspace).await.unwrap(),
        policy(deny_patch),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "patch".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if store
                .events("s", 0, 200)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    serde_json::to_string(&store.history("s").await.unwrap()).unwrap()
}

#[tokio::test]
async fn patch_adds_updates_and_deletes_in_one_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    std::fs::write(workspace.join("obsolete.log"), "old\n").unwrap();
    let transcript = drive(dir.path(), PATCH, false).await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("docs/new.txt")).unwrap(),
        "created line\n"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        " Hello, patched\nworld\n"
    );
    assert!(!workspace.join("obsolete.log").exists());
    assert!(transcript.contains("\"applied\":true"));
    assert!(transcript.contains("\"delete\""));
}

#[tokio::test]
async fn context_mismatch_aborts_the_whole_patch_without_side_effects() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("readme.md"),
        "different
",
    )
    .unwrap();
    let transcript = drive(dir.path(), PATCH, false).await;
    assert!(!workspace.join("docs/new.txt").exists());
    assert!(!workspace.join("obsolete.log").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        "different
"
    );
    assert!(transcript.contains("ambiguous") || transcript.contains("context"));
}
#[tokio::test]
async fn bom_and_crlf_are_preserved_through_updates() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("readme.md"),
        b"\xEF\xBB\xBF Hello\r\nworld\r\n",
    )
    .unwrap();
    drive(dir.path(), PATCH, false).await;
    let bytes = std::fs::read(workspace.join("readme.md")).unwrap();
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
    assert_eq!(String::from_utf8_lossy(&bytes).contains("\r\n"), true);
    assert!(String::from_utf8_lossy(&bytes).contains(" Hello, patched\r\n"));
}
#[tokio::test]
async fn patch_permission_is_a_single_capability_and_deny_has_no_effects() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    let transcript = drive(dir.path(), PATCH, true).await;
    assert!(transcript.contains("permission denied"));
    assert!(!workspace.join("docs/new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        " Hello\nworld\n"
    );
}
#[test]
fn patch_parsing_is_strict_and_bounded() {
    use miao_engine::patch;
    let parse = |text: &str| patch::parse(&patch::Input { patch: text.into() });
    for bad in [
        "not a patch",
        "*** Begin Patch\n*** Add File: a.txt\n+hi\n",
        "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\ntrailing",
        "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Add File: a.txt\n+again\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
        "*** Begin Patch\n*** Add File: a.txt\n*** End Patch",
        "*** Begin Patch\n*** Add File: ../escape.txt\n+hi\n*** End Patch",
        "*** Begin Patch\n*** Add File: /abs.txt\n+hi\n*** End Patch",
        "*** Begin Patch\n*** Add File: a//b.txt\n+hi\n*** End Patch",
        "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch",
        "*** Begin Patch\n*** Touch File: a.txt\n*** End Patch",
    ] {
        assert!(matches!(parse(bad), Err(ToolError::InvalidInput)), "{bad}");
    }
    let good = parse(PATCH).unwrap();
    assert_eq!(good.len(), 3);
    let big = format!(
        "*** Begin Patch\n*** Add File: a.txt\n+{}\n*** End Patch",
        "x".repeat(40000)
    );
    assert!(matches!(parse(&big), Err(ToolError::InvalidInput)));
}
