use async_trait::async_trait;
use miao_engine::{
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    question::Answer,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;
struct Ask {
    multiple: bool,
    custom: bool,
    timeout: u64,
    done: Arc<Notify>,
}
#[async_trait]
impl Provider for Ask {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"q-call","name":"question","input":{"timeout_ms":self.timeout,"questions":[{"question":"选择方向","header":"方向","options":[{"label":"A"},{"label":"B"}],"custom":self.custom,"multiSelect":self.multiple}]}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        self.done.notify_one();
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
async fn setup(path: &std::path::Path, timeout: u64) -> (Runtime, Store, Arc<Notify>) {
    setup_choices(path, timeout, false, false).await
}
async fn setup_choices(
    path: &std::path::Path,
    timeout: u64,
    multiple: bool,
    custom: bool,
) -> (Runtime, Store, Arc<Notify>) {
    let store = Store::open(path.join("engine.db")).await.unwrap();
    let done = Arc::new(Notify::new());
    let runtime = Runtime::new(
        store.clone(),
        Arc::new(Ask {
            multiple,
            custom,
            timeout,
            done: done.clone(),
        }),
        Tools::new(path).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "ask".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    (runtime, store, done)
}
async fn requested(store: &Store) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Some(request) = store.questions("s").await.unwrap().into_iter().next() {
                return request;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
fn answer(request: &Value, choice: &str) -> Answer {
    Answer {
        question_id: request["question_id"].as_str().unwrap().into(),
        input_hash: request["input_hash"].as_str().unwrap().into(),
        answers: vec![vec![choice.into()]],
    }
}
#[tokio::test]
async fn answers_are_bound_validated_durable_and_exact_retries_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, done) = setup(dir.path(), 3000).await;
    let request = requested(&store).await;
    assert_eq!(
        store.snapshot("s").await.unwrap()["questions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(runtime
        .answer_question(&runtime.controller(), "other", answer(&request, "A"))
        .await
        .is_err());
    let mut wrong = answer(&request, "A");
    wrong.input_hash = "wrong".into();
    assert!(runtime
        .answer_question(&runtime.controller(), "s", wrong)
        .await
        .is_err());
    assert!(runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "C"))
        .await
        .is_err());
    assert_eq!(store.questions("s").await.unwrap().len(), 1);
    runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "A"))
        .await
        .unwrap();
    runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "A"))
        .await
        .unwrap();
    assert!(runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "B"))
        .await
        .is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), done.notified())
        .await
        .unwrap();
    runtime.shutdown().await;
    assert!(store.questions("s").await.unwrap().is_empty());
    let events = store.events("s", 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "question.resolved")
            .count(),
        1
    );
    assert!(serde_json::to_string(&store.history("s").await.unwrap())
        .unwrap()
        .contains("answered"));
}
#[tokio::test]
async fn cancellation_closes_pending_question_and_historical_fork_has_no_pending_requests() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), 3000).await;
    let request = requested(&store).await;
    let first = store.snapshot("s").await.unwrap()["messages"][0]["seq"]
        .as_u64()
        .unwrap();
    runtime.fork("s", "child", Some(first)).await.unwrap();
    assert!(store.questions("child").await.unwrap().is_empty());
    runtime.cancel("s").await.unwrap();
    assert!(store.questions("s").await.unwrap().is_empty());
    assert!(runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "A"))
        .await
        .is_err());
    assert!(store
        .events("s", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "question.resolved" && event.data["state"] == "cancelled"));
    runtime.shutdown().await;
}
#[tokio::test]
async fn expired_questions_return_error_results_and_foreign_controller_cannot_answer() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, done) = setup(dir.path(), 200).await;
    let request = requested(&store).await;
    let foreign_dir = tempfile::tempdir().unwrap();
    let foreign = Runtime::new(
        Store::open(foreign_dir.path().join("engine.db"))
            .await
            .unwrap(),
        Arc::new(Ask {
            multiple: false,
            custom: false,
            timeout: 1000,
            done: Arc::new(Notify::new()),
        }),
        Tools::new(foreign_dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    assert!(runtime
        .answer_question(&foreign.controller(), "s", answer(&request, "A"))
        .await
        .is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), done.notified())
        .await
        .unwrap();
    assert!(runtime
        .answer_question(&runtime.controller(), "s", answer(&request, "A"))
        .await
        .is_err());
    runtime.shutdown().await;
    foreign.shutdown().await;
    let events = store.events("s", 0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == "question.resolved" && event.data["state"] == "expired"));
    assert!(events.iter().any(|event| event.kind == "message.committed"
        && event.data["content"].as_array().is_some_and(|parts| parts
            .iter()
            .any(|part| part["type"] == "tool_result" && part["is_error"] == true))));
}
#[tokio::test]
async fn question_shapes_are_bounded_and_unambiguous() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    for options in [
        json!([{"label":"A"}]),
        json!([{"label":"A"},{"label":"A"}]),
        json!([{"label":" "},{"label":"B"}]),
    ] {
        assert!(tools
            .prepare(
                "question",
                json!({"questions":[{"question":"choose","options":options}]})
            )
            .await
            .is_err());
    }
    assert!(tools.prepare("question",json!({"questions":[{"question":"choose","options":[{"label":"A"},{"label":"B"}],"multiSelect":true}]})).await.is_ok());
}

#[tokio::test]
async fn recovery_closes_orphaned_requests_without_execution_or_messages() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store, _) = setup(dir.path(), 3000).await;
    let mut request = requested(&store).await;
    runtime.cancel("s").await.unwrap();
    runtime.shutdown().await;
    // Simulate a historical interrupted run whose transcript was reconciled
    // before the interactive-request projection was closed.
    request["question_id"] = json!("orphaned-request");
    store
        .record("s", "question.requested", request)
        .await
        .unwrap();
    let messages = store.history("s").await.unwrap().len();
    store.recover_questions().await.unwrap();
    store.recover_questions().await.unwrap();
    assert!(store.questions("s").await.unwrap().is_empty());
    assert_eq!(store.history("s").await.unwrap().len(), messages);
    assert_eq!(
        store
            .events("s", 0, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "question.resolved"
                && event.data["question_id"] == "orphaned-request")
            .count(),
        1
    );
}

#[tokio::test]
async fn multiple_choice_and_custom_answers_follow_the_request_contract() {
    for custom in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, store, done) = setup_choices(dir.path(), 3000, true, custom).await;
        let request = requested(&store).await;
        let mut duplicate = answer(&request, "A");
        duplicate.answers[0].push("A".into());
        assert!(runtime
            .answer_question(&runtime.controller(), "s", duplicate)
            .await
            .is_err());
        let mut multiple = answer(&request, "A");
        multiple.answers[0].push(if custom {
            "typed answer".into()
        } else {
            "B".into()
        });
        runtime
            .answer_question(&runtime.controller(), "s", multiple)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), done.notified())
            .await
            .unwrap();
        runtime.shutdown().await;
    }
}
