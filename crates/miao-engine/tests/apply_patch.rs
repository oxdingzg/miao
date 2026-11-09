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

const RENAME_PATCH: &str = r#"*** Begin Patch
*** Update File: readme.md
*** Move to: docs/renamed.md
@@
- Hello
+ Hello, moved
 world
*** End Patch
"#;

const PURE_RENAME_PATCH: &str = r#"*** Begin Patch
*** Update File: readme.md
*** Move to: renamed.md
*** End Patch
"#;

const ROLLBACK_PATCH: &str = r#"*** Begin Patch
*** Add File: fresh.txt
+created
*** Update File: readme.md
*** Move to: occupied.txt
*** End Patch
"#;

const PROTECTED_TARGET_PATCH: &str = r#"*** Begin Patch
*** Update File: readme.md
*** Move to: private.txt
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
            path: "**".into(),
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

async fn drive(
    parent: &std::path::Path,
    patch: &'static str,
    deny_patch: bool,
    protected: Option<&str>,
) -> String {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace).await.unwrap();
    let tools = if let Some(name) = protected {
        tools.with_protected_resource(&workspace.join(name))
    } else {
        tools
    };
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Executor { patch }),
        tools,
        policy(deny_patch),
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
    let transcript = drive(dir.path(), PATCH, false, None).await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("docs/new.txt")).unwrap(),
        "created line\n"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        " Hello, patched\nworld\n"
    );
    assert!(!workspace.join("obsolete.log").exists());
    let history: Value = serde_json::from_str(&transcript).unwrap();
    let result: Value = serde_json::from_str(
        history[2]["content"][0]["content"]
            .as_str()
            .expect("tool result text"),
    )
    .unwrap();
    assert_eq!(result["applied"], json!(true));
    assert!(result["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["action"] == json!("delete")));
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
    let transcript = drive(dir.path(), PATCH, false, None).await;
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
    std::fs::write(workspace.join("obsolete.log"), "old\n").unwrap();
    drive(dir.path(), PATCH, false, None).await;
    let bytes = std::fs::read(workspace.join("readme.md")).unwrap();
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
    assert!(String::from_utf8_lossy(&bytes).contains("\r\n"));
    assert!(String::from_utf8_lossy(&bytes).contains(" Hello, patched\r\n"));
}
#[tokio::test]
async fn patch_permission_is_a_single_capability_and_deny_has_no_effects() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    let transcript = drive(dir.path(), PATCH, true, None).await;
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
        "*** Begin Patch\n*** Touch File: a.txt\n*** End Patch",
        "*** Begin Patch\n*** Add File: a.txt\n*** Move to: b.txt\n+hi\n*** End Patch",
        "*** Begin Patch\n*** Delete File: a.txt\n*** Move to: b.txt\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: a.txt\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: b.txt\n+hi\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Update File: c.txt\n*** Move to: b.txt\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** Move to: b.txt\n*** End Patch",
    ] {
        assert!(
            matches!(parse(bad), Err(ToolError::InvalidArgs(_))),
            "{bad}"
        );
    }
    let good = parse(PATCH).unwrap();
    assert_eq!(good.len(), 3);
    let renamed =
        parse("*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch")
            .unwrap();
    assert_eq!(renamed.len(), 1);
    assert_eq!(renamed[0].move_to.as_deref(), Some("b.txt"));
    // Larger than the whole patch bound (256 KiB); the per-file bound is
    // 1 MiB so a large file can be updated by a bounded patch.
    let big = format!(
        "*** Begin Patch\n*** Add File: a.txt\n+{}\n*** End Patch",
        "x".repeat(300_000)
    );
    assert!(matches!(parse(&big), Err(ToolError::InvalidArgs(_))));
    // The rejection has to say what to change; a bare "invalid tool input"
    // left the model resending the same absolute path.
    let Err(ToolError::InvalidArgs(message)) =
        parse("*** Begin Patch\n*** Add File: /abs.txt\n+hi\n*** End Patch")
    else {
        panic!("absolute path must be rejected with a reason");
    };
    assert!(message.contains("workspace-relative"), "{message}");
}

#[tokio::test]
async fn rename_moves_the_file_and_reports_the_destination() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    let transcript = drive(dir.path(), RENAME_PATCH, false, None).await;
    assert!(!workspace.join("readme.md").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.join("docs/renamed.md")).unwrap(),
        " Hello, moved\nworld\n"
    );
    let history: Value = serde_json::from_str(&transcript).unwrap();
    let result: Value = serde_json::from_str(
        history[2]["content"][0]["content"]
            .as_str()
            .expect("tool result text"),
    )
    .unwrap();
    assert_eq!(result["applied"], json!(true));
    assert_eq!(result["files"][0]["path"], json!("docs/renamed.md"));
    assert_eq!(result["files"][0]["action"], json!("update"));
}

#[tokio::test]
async fn pure_rename_keeps_bytes_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), "keep").unwrap();
    drive(dir.path(), PURE_RENAME_PATCH, false, None).await;
    assert!(!workspace.join("readme.md").exists());
    assert_eq!(
        std::fs::read(workspace.join("renamed.md")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn bom_and_crlf_survive_a_rename() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("readme.md"),
        b"\xEF\xBB\xBF Hello\r\nworld\r\n",
    )
    .unwrap();
    drive(dir.path(), PURE_RENAME_PATCH, false, None).await;
    assert_eq!(
        std::fs::read(workspace.join("renamed.md")).unwrap(),
        b"\xEF\xBB\xBF Hello\r\nworld\r\n"
    );
}

#[tokio::test]
async fn occupied_rename_target_aborts_the_whole_patch() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    std::fs::write(workspace.join("occupied.txt"), "occupied\n").unwrap();
    let transcript = drive(dir.path(), ROLLBACK_PATCH, false, None).await;
    assert!(!workspace.join("fresh.txt").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.join("occupied.txt")).unwrap(),
        "occupied\n"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        " Hello\nworld\n"
    );
    assert!(
        transcript.contains("fingerprint does not match"),
        "an occupied rename target must fail the patch"
    );
}

#[tokio::test]
async fn protected_move_target_is_denied_without_effects() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("readme.md"), " Hello\nworld\n").unwrap();
    let transcript = drive(
        dir.path(),
        PROTECTED_TARGET_PATCH,
        false,
        Some("private.txt"),
    )
    .await;
    assert!(transcript.contains("protected"));
    assert_eq!(
        std::fs::read_to_string(workspace.join("readme.md")).unwrap(),
        " Hello\nworld\n"
    );
    assert!(!workspace.join("private.txt").exists());
}

#[test]
fn a_large_file_renames_without_touching_its_bytes() {
    use miao_engine::patch;
    let dir = tempfile::tempdir().unwrap();
    let body: String = (0..20_000)
        .map(|index| format!("line {index} 中文\n"))
        .collect();
    std::fs::write(dir.path().join("big.log"), &body).unwrap();
    let root =
        cap_std::fs::Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
    let operations = patch::parse(&patch::Input {
        patch:
            "*** Begin Patch\n*** Update File: big.log\n*** Move to: big.moved.log\n*** End Patch"
                .into(),
    })
    .unwrap();
    let result = patch::apply(&root, &operations).unwrap();
    assert_eq!(result["files"][0]["path"], json!("big.moved.log"));
    assert!(!dir.path().join("big.log").exists());
    assert_eq!(
        std::fs::read(dir.path().join("big.moved.log")).unwrap(),
        body.as_bytes()
    );
}
