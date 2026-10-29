use super::*;
use crate::{
    product::Bridge, product_permission::Source, protocol::ToolDefinition, provider::Reply,
};
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

struct Caller;

#[async_trait]
impl Provider for Caller {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        Ok(Reply {
            content: json!([{"type":"tool_use","id":"call","name":"host_probe","input":{}}]),
            usage: json!({}),
            needs_tools: true,
        })
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    store: Store,
    runtime: Runtime,
    bridge: Bridge,
    source: Source,
    send: mpsc::Sender<Value>,
    receive: mpsc::Receiver<Value>,
}

async fn running() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Caller),
        Tools::new(directory.path()).await.unwrap(),
        Policy::new(Config {
            rules: vec![crate::permission::Rule {
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
    let (send, mut receive) = mpsc::channel(1);
    let bridge = Bridge::new(send.clone());
    runtime.with_product_tools(
        vec![ToolDefinition {
            name: "host_probe".into(),
            description: "Cancellation boundary fixture".into(),
            input_schema: json!({"type":"object"}),
        }],
        bridge.clone(),
        None,
    );
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "call host".into(),
                delivery: Delivery::Steer,
                command: None,
                agent_references: Default::default(),
            },
            true,
        )
        .await
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "product_tool");
    let source = Source {
        session_id: "s".into(),
        bridge_id: frame["bridge_id"].as_u64().unwrap(),
        call_id: "call".into(),
        message_seq: frame["params"]["message_seq"].as_u64().unwrap(),
    };
    Fixture {
        directory,
        store,
        runtime,
        bridge,
        source,
        send,
        receive,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_ack_waits_for_the_authorization_commit_boundary() {
    for conditional in [false, true] {
        let fixture = running().await;
        let authority = fixture
            .bridge
            .permission_authority(&fixture.source)
            .unwrap();
        let run = fixture.store.active_run("s").await.unwrap().unwrap();
        let (entered, started) = oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let committed = Arc::new(AtomicBool::new(false));
        let written = committed.clone();
        let guarded = fixture.bridge.clone();
        let source = fixture.source.clone();
        let path = fixture.directory.path().join("authorization.db");
        // Pause the actual bridge serialization boundary immediately before a
        // durable commit, after its last cancellation check could have passed.
        let writer = tokio::task::spawn_blocking(move || {
            guarded.with_permission_authority(&source, |_| {
                let mut connection = rusqlite::Connection::open(path)?;
                connection.execute_batch("CREATE TABLE decision(value TEXT)")?;
                let transaction = connection.transaction()?;
                transaction.execute("INSERT INTO decision VALUES('allow')", [])?;
                let _ = entered.send(());
                held.recv().unwrap();
                transaction.commit()?;
                written.store(true, Ordering::SeqCst);
                Ok(())
            })
        });
        started.await.unwrap();
        let cancelled = fixture.runtime.clone();
        let seen = committed.clone();
        let mut acknowledgement = tokio::spawn(async move {
            let accepted = if conditional {
                cancelled.cancel_if("s", &run).await
            } else {
                cancelled.cancel("s").await
            }?;
            Ok::<_, Error>((accepted, seen.load(Ordering::SeqCst)))
        });
        authority.cancel.cancelled().await;
        // This negative assertion has an explicit entered/token handshake;
        // the timeout tests that acknowledgement stays blocked by the writer.
        let early = tokio::time::timeout(Duration::from_millis(100), &mut acknowledgement).await;
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let (accepted, committed_at_ack) = match early {
            Ok(result) => result.unwrap().unwrap(),
            Err(_) => acknowledgement.await.unwrap().unwrap(),
        };
        fixture.runtime.shutdown().await;
        assert!(accepted);
        assert!(
            committed_at_ack,
            "cancel acknowledged before the source authorization critical section committed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_withdraws_before_ack_without_waiting_for_host_output_capacity() {
    let mut fixture = running().await;
    fixture
        .send
        .send(json!({"fixture":"occupy host output"}))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), fixture.runtime.cancel("s"))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(fixture
        .bridge
        .permission_authority(&fixture.source)
        .is_none());
    assert!(fixture.bridge.pending().lock().unwrap().is_empty());
    assert_eq!(
        fixture.receive.recv().await.unwrap()["fixture"],
        "occupy host output"
    );
    let notice = tokio::time::timeout(Duration::from_secs(5), fixture.receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notice["method"], "product_tool.cancel");
    assert_eq!(notice["bridge_id"], fixture.source.bridge_id);
    fixture.runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_releases_a_detach_waiting_to_deliver_its_cancellation_notice() {
    let fixture = running().await;
    fixture
        .send
        .send(json!({"fixture":"occupy host output"}))
        .await
        .unwrap();
    assert!(fixture.runtime.cancel("s").await.unwrap());
    let runtime = fixture.runtime.clone();
    let detached = tokio::spawn(async move { runtime.detach("s").await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.runtime.inner.actors.lock().await.contains_key("s") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.runtime.shutdown().await;
    assert!(tokio::time::timeout(Duration::from_secs(5), detached)
        .await
        .unwrap()
        .unwrap()
        .unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authority_withdrawal_preserves_hook_cancellation_when_host_output_is_full() {
    let mut fixture = running().await;
    let bridge = fixture.bridge.clone();
    let hook = tokio::spawn(async move {
        bridge
            .call_hook("s", "before", "read_file", "hook-call", json!({}))
            .await
    });
    let frame = tokio::time::timeout(Duration::from_secs(5), fixture.receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "hook_tool");
    fixture.send.send(json!({"fixture":"full"})).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), fixture.runtime.cancel("s"))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(fixture.bridge.pending().lock().unwrap().is_empty());
    assert!(tokio::time::timeout(Duration::from_secs(5), hook)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert_eq!(fixture.receive.recv().await.unwrap()["fixture"], "full");
    let mut notices = Vec::new();
    for _ in 0..2 {
        notices.push(
            tokio::time::timeout(Duration::from_secs(5), fixture.receive.recv())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert!(notices
        .iter()
        .any(|notice| notice["method"] == "hook_tool.cancel"
            && notice["bridge_id"] == frame["bridge_id"]));
    assert!(notices
        .iter()
        .any(|notice| notice["method"] == "product_tool.cancel"
            && notice["bridge_id"] == fixture.source.bridge_id));
    fixture.runtime.shutdown().await;
}
