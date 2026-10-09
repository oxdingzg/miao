use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{CollaborationMode, Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Writer {
    system: Arc<Mutex<Option<String>>>,
}
#[async_trait]
impl Provider for Writer {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        *self.system.lock().unwrap() = Some(request.system);
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([
                    {"type":"tool_use","id":"w","name":"write_file","input":{"path":"out.txt","text":"created","expected_sha256":null}}
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

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn drive(
    dir: &std::path::Path,
    mode: CollaborationMode,
) -> (Store, Arc<Mutex<Option<String>>>) {
    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.join("engine.db")).await.unwrap();
    let system = Arc::new(Mutex::new(None));
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Writer {
            system: system.clone(),
        }),
        Tools::new(&workspace).await.unwrap(),
        policy(),
    )
    .await
    .unwrap();
    runtime.set_mode("s", mode).await.unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "write".into(),
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
                .any(|e| e.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    (store, system)
}

#[tokio::test]
async fn plan_mode_denies_writes_and_tells_the_model_to_plan() {
    let dir = tempfile::tempdir().unwrap();
    let (store, system) = drive(dir.path(), CollaborationMode::Plan).await;
    assert!(!dir.path().join("workspace").join("out.txt").exists());
    let denied = store
        .events("s", 0, 200)
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "permission_denied")
        .expect("a plan-mode denial event");
    assert_eq!(denied.data["reason"], "plan_mode");
    assert!(system
        .lock()
        .unwrap()
        .as_deref()
        .unwrap()
        .contains("collaboration-mode mode=\"plan\""));
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["mode"], "plan");
}

#[tokio::test]
async fn build_mode_allows_the_same_write() {
    let dir = tempfile::tempdir().unwrap();
    let (store, system) = drive(dir.path(), CollaborationMode::Build).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("workspace").join("out.txt")).unwrap(),
        "created"
    );
    assert!(!system
        .lock()
        .unwrap()
        .as_deref()
        .unwrap()
        .contains("collaboration-mode mode=\"plan\""));
    assert!(store
        .events("s", 0, 200)
        .await
        .unwrap()
        .iter()
        .all(|e| e.kind != "permission_denied"));
}
