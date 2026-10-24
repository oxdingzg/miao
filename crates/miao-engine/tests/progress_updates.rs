//! Exercise progress guidance through real tool execution and durable history.
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
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Recording {
    requests: Mutex<Vec<ModelRequest>>,
}

#[async_trait]
impl Provider for Recording {
    async fn stream(
        &self,
        request: ModelRequest,
        _: tokio::sync::mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let turn = {
            let mut requests = self.requests.lock().unwrap();
            let turn = requests.len();
            requests.push(request);
            turn
        };
        let mut content = vec![];
        if turn == 1 {
            content.push(
                json!({"type":"reasoning","text":"Internal analysis is not a progress update."}),
            );
        }
        if turn == 2 {
            content.push(json!({"type":"text","text":" \n "}));
        }
        if turn == 3 || turn >= 7 {
            content.push(json!({"type":"text","text":"已核对文件内容，继续检查下一项。"}));
        }
        if turn < 7 {
            content.push(json!({"type":"tool_use","id":format!("read-{turn}"),"name":"read_file","input":{"path":format!("file-{turn}")}}));
        }
        Ok(Reply {
            content: json!(content),
            usage: json!({}),
            needs_tools: turn < 7,
        })
    }
}

async fn finished(store: &Store, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "run.finished")
                .count()
                >= count
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn silent_tool_batches_trigger_request_only_guidance_and_visible_text_resets_it() {
    let dir = tempfile::tempdir().unwrap();
    for turn in 0..7 {
        std::fs::write(
            dir.path().join(format!("file-{turn}")),
            format!("evidence {turn}"),
        )
        .unwrap();
    }
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let provider = Arc::new(Recording::default());
    let runtime = Runtime::with_policy(
        store.clone(),
        provider.clone(),
        Tools::new(dir.path()).await.unwrap(),
        Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            }],
            ..Config::default()
        })
        .unwrap(),
    )
    .await
    .unwrap();
    for (id, count) in [("one", 1), ("two", 2)] {
        runtime
            .admit(
                Input {
                    agent_references: Default::default(),
                    command: None,
                    session_id: "s".into(),
                    input_id: id.into(),
                    prompt: "检查这些文件并说明发现。".into(),
                    delivery: Delivery::Steer,
                },
                true,
            )
            .await
            .unwrap();
        finished(&store, count).await;
    }
    runtime.shutdown().await;
    let history = store.history("s").await.unwrap();
    assert!(!serde_json::to_string(&history)
        .unwrap()
        .contains("<system-reminder>"));
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 9);
    let reminders = requests
        .iter()
        .enumerate()
        .filter_map(|(turn, request)| {
            request
                .messages
                .last()
                .is_some_and(|message| {
                    message.role == "user"
                        && message.content.to_string().contains("<system-reminder>")
                })
                .then_some(turn)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        reminders,
        vec![3, 7],
        "reasoning/blank text do not reset silence; visible text and a new prompt do"
    );
    assert!(requests
        .iter()
        .all(|request| request.system == requests[0].system));
    // Guidance must not omit real evidence or force a text-only provider turn.
    for turn in [3, 7] {
        assert!(!requests[turn].tools.is_empty());
        assert_eq!(
            requests[turn].messages.last().unwrap().content[0]["type"],
            "tool_result"
        );
        assert!(requests[turn]
            .messages
            .iter()
            .any(|message| message.content.to_string().contains("tool_result")));
    }
}
