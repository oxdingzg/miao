use miao_engine::{
    mcp::Registry,
    permission::{Access, Config, Decision, Policy},
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

async fn peer() -> (
    Arc<Registry>,
    Arc<AtomicUsize>,
    Arc<Notify>,
    tokio::task::JoinHandle<()>,
) {
    let (client, server) = tokio::io::duplex(131072);
    let (read, mut write) = tokio::io::split(server);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let seen = Arc::new(Notify::new());
    let notified = seen.clone();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"resources":{},"prompts":{}},"serverInfo":{"name":"resources-only","version":"1"}})
                }
                "resources/list" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    if request["params"]["cursor"] == "more" {
                        json!({"resources":[]})
                    } else {
                        json!({"resources":[{"uri":"mem://fixture","name":"fixture","mimeType":"text/plain"}],"nextCursor":"more"})
                    }
                }
                "resources/templates/list" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    json!({"resourceTemplates":[{"uriTemplate":"mem://{name}","name":"lookup"}]})
                }
                "resources/read" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    notified.notify_one();
                    if request["params"]["uri"] == "mem://pending" {
                        continue;
                    }
                    let text = if request["params"]["uri"] == "mem://large" {
                        "x".repeat(70000)
                    } else {
                        "External resource fixture".into()
                    };
                    json!({"contents":[{"uri":request["params"]["uri"],"mimeType":"text/plain","text":text}]})
                }
                "prompts/list" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    json!({"prompts":[{"name":"review","arguments":[{"name":"topic","required":true}]}]})
                }
                "prompts/get" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    json!({"messages":[{"role":"user","content":{"type":"text","text":format!("Review {}",request["params"]["arguments"]["topic"].as_str().unwrap())}}]})
                }
                _ => panic!("unexpected method: {}", request["method"]),
            };
            let mut bytes =
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"result":result})).unwrap();
            bytes.push(b'\n');
            if write.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    let (read, write) = tokio::io::split(client);
    let registry = Registry::connect_io("fixture".into(), read, write)
        .await
        .unwrap();
    (Arc::new(registry), calls, seen, task)
}

#[tokio::test]
async fn resources_and_prompts_use_capability_gated_external_operations() {
    let (registry, calls, _, task) = peer().await;
    let definitions = registry.definitions();
    assert_eq!(
        definitions.len(),
        5,
        "a resource/prompt-only server must not require tools/list"
    );
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path())
        .await
        .unwrap()
        .with_mcp(registry.clone());
    let policy = Policy::new(Config::default()).unwrap();
    for definition in &definitions {
        assert!(definition.name.len() <= 64);
        let input = if definition.name.ends_with("_resource_read") {
            json!({"uri":"mem://fixture"})
        } else if definition.name.ends_with("_prompt_get") {
            json!({"name":"review","arguments":{"topic":"fixture"}})
        } else {
            json!({})
        };
        let prepared = tools
            .prepare(&definition.name, input.clone())
            .await
            .unwrap();
        assert_eq!(prepared.access(), Access::External);
        assert_eq!(
            policy.evaluate(
                &definition.name,
                &registry.resource(&definition.name).unwrap(),
                Access::External
            ),
            Decision::Deny
        );
        let result = registry
            .call(&definition.name, input, CancellationToken::new())
            .await
            .unwrap();
        if definition.name.ends_with("_resources_list") {
            assert_eq!(result["resources"][0]["uri"], "mem://fixture");
            assert_eq!(result["nextCursor"], "more");
            let page = registry
                .call(
                    &definition.name,
                    json!({"cursor":"more"}),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(page["resources"], json!([]));
        }
        if definition.name.ends_with("_resource_read") {
            assert_eq!(result["contents"][0]["text"], "External resource fixture");
        }
        if definition.name.ends_with("_prompt_get") {
            assert_eq!(result["messages"][0]["role"], "user");
            assert_eq!(result["messages"][0]["content"]["text"], "Review fixture");
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 6);
    let get = definitions
        .iter()
        .find(|definition| definition.name.ends_with("_prompt_get"))
        .unwrap();
    assert!(matches!(
        registry
            .call(
                &get.name,
                json!({"name":"review","arguments":{"topic":7}}),
                CancellationToken::new()
            )
            .await,
        Err(ToolError::InvalidInput)
    ));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        6,
        "schema refusal must precede dispatch"
    );
    let read = definitions
        .iter()
        .find(|definition| definition.name.ends_with("_resource_read"))
        .unwrap();
    let error = registry
        .call(
            &read.name,
            json!({"uri":"mem://large"}),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("output budget"));
    registry.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn resource_cancellation_does_not_retry_or_execute_a_prompt() {
    let (registry, calls, seen, task) = peer().await;
    let read = registry
        .definitions()
        .into_iter()
        .find(|definition| definition.name.ends_with("_resource_read"))
        .unwrap()
        .name;
    let cancel = CancellationToken::new();
    let request = tokio::spawn({
        let registry = registry.clone();
        let cancel = cancel.clone();
        async move {
            registry
                .call(&read, json!({"uri":"mem://pending"}), cancel)
                .await
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), seen.notified())
        .await
        .unwrap();
    cancel.cancel();
    assert!(matches!(
        request.await.unwrap(),
        Err(ToolError::Interrupted)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    registry.shutdown().await;
    task.await.unwrap();
}
