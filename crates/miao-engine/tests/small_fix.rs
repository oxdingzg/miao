#![cfg(any(target_os = "macos", target_os = "linux"))]
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
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A scripted provider that performs a small real fix: read a file, patch it,
/// then run a shell check that proves the fix, and finally summarise. Each turn
/// advances one step, so the test exercises read -> apply_patch -> bash through
/// the durable run loop rather than the tools in isolation.
struct Scripted {
    step: AtomicUsize,
}
#[async_trait]
impl Provider for Scripted {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let (content, needs_tools) = match step {
            0 => (
                json!([{"type":"tool_use","id":"c1","name":"read_file","input":{"path":"answer.txt"}}]),
                true,
            ),
            1 => (
                json!([{"type":"tool_use","id":"c2","name":"apply_patch","input":{"patch":"*** Begin Patch\n*** Update File: answer.txt\n@@\n-2\n+4\n keep\n*** End Patch"}}]),
                true,
            ),
            2 => (
                json!([{"type":"tool_use","id":"c3","name":"bash","input":{"command":"test \"$(head -1 answer.txt)\" = 4 && echo VERIFIED"}}]),
                true,
            ),
            _ => (json!([{"type":"text","text":"fixed and verified"}]), false),
        };
        Ok(Reply {
            content,
            usage: json!({}),
            needs_tools,
        })
    }
}
fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        process_network: false,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

#[tokio::test]
async fn headless_small_fix_reads_patches_and_verifies() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("answer.txt"), "2\nkeep\n").unwrap();

    // The engine database lives outside the workspace, as a process-enabled
    // runtime requires.
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Scripted {
            step: AtomicUsize::new(0),
        }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "fix the value in answer.txt so the check passes".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();

    let final_text = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let events = store.events("s", 0, 2000).await.unwrap();
            if events.iter().any(|e| e.kind == "run.finished") {
                let history = store.history("s").await.unwrap();
                return history
                    .last()
                    .unwrap()
                    .content
                    .as_array()
                    .and_then(|parts| {
                        parts
                            .iter()
                            .find_map(|p| p["text"].as_str())
                            .map(String::from)
                    })
                    .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;

    // The assistant reached the verification summary only after the ordered
    // read -> patch -> bash sequence committed.
    assert!(final_text.contains("fixed"), "{final_text}");
    let kinds: Vec<String> = store
        .events("s", 0, 2000)
        .await
        .unwrap()
        .iter()
        .filter(|e| e.kind == "tool.planned")
        .map(|e| e.data["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        kinds
            .windows(3)
            .any(|window| window == ["read_file", "apply_patch", "bash"]),
        "unexpected tool order {kinds:?}"
    );
    // The fix is real on disk and the check output is durable.
    assert_eq!(
        std::fs::read_to_string(workspace.join("answer.txt")).unwrap(),
        "4\nkeep\n"
    );
    let verified = store
        .events("s", 0, 2000)
        .await
        .unwrap()
        .iter()
        .any(|e| e.data.to_string().contains("VERIFIED"));
    assert!(verified, "the shell verification did not run");
}
