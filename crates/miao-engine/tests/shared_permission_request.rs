use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    product::Bridge,
    product_permission::{Request, Source},
    protocol::{Delivery, Input, ModelRequest, ToolDefinition},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Caller;
#[async_trait]
impl Provider for Caller {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let first = request.messages.len() == 1;
        Ok(Reply {
            content: if first {
                json!([{"type":"tool_use","id":"host-call","name":"host_probe","input":{}}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools: first,
        })
    }
}

fn request(resource: &str) -> Request {
    Request {
        actions: vec!["read".into()],
        resources: vec![resource.into()],
        explicit: false,
    }
}

async fn running_with_sources() -> (
    tempfile::TempDir,
    Store,
    Runtime,
    Source,
    mpsc::Receiver<Value>,
) {
    running_with_mode(None).await
}

async fn running_with_mode(
    mode: Option<&str>,
) -> (
    tempfile::TempDir,
    Store,
    Runtime,
    Source,
    mpsc::Receiver<Value>,
) {
    running_in_workspace(mode, None).await
}

async fn running_in_workspace(
    mode: Option<&str>,
    workspace: Option<&std::path::Path>,
) -> (
    tempfile::TempDir,
    Store,
    Runtime,
    Source,
    mpsc::Receiver<Value>,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = workspace
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| directory.path().join("workspace"));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Caller),
        Tools::new(&root).await.unwrap(),
        Policy::new(Config {
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
    let (send, mut receive) = mpsc::channel(8);
    runtime.with_product_tools(
        vec![ToolDefinition {
            name: "host_probe".into(),
            description: "Fixture host callback".into(),
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        }],
        Bridge::new(send),
        None,
    );
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "call host".into(),
                delivery: Delivery::Steer,
            },
            false,
        )
        .await
        .unwrap();
    runtime
        .set_agent(
            "s",
            serde_json::from_value(
                json!({"name":"fixture","permission_mode":mode,"ordered_permissions":{
                    "semantics":"ordered-wildcard-v1","rules":[
                        {"action":"*","resource":"*","effect":"allow"},
                        {"action":"read","resource":"*","effect":"ask"},
                        {"action":"read","resource":"secret","effect":"deny"}
                    ]
                }}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    runtime.resume("s").await.unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "product_tool");
    let source = Source {
        session_id: "s".into(),
        bridge_id: frame["bridge_id"].as_u64().unwrap(),
        call_id: frame["params"]["call_id"].as_str().unwrap().into(),
        message_seq: frame["params"]["message_seq"].as_u64().unwrap(),
    };
    (directory, store, runtime, source, receive)
}

async fn running() -> (tempfile::TempDir, Store, Runtime, Source) {
    let (directory, store, runtime, source, mut receive) = running_with_sources().await;
    // Cancellation can send a notice without a cooperative host response.
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    (directory, store, runtime, source)
}

async fn shared(directory: &std::path::Path) -> miao_engine::permission_context::Context {
    miao_engine::permission_project::Authority::open(directory.join("permissions.db"))
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap()
        .context(directory.join("workspace"), None)
        .await
        .unwrap()
}

fn assertion(
    id: &str,
    resource: &str,
    save: &[&str],
) -> miao_engine::product_permission_request::Input {
    miao_engine::product_permission_request::Input {
        request_id: id.into(),
        facts: request(resource),
        save: Some(save.iter().map(|value| value.to_string()).collect()),
        metadata: None,
        timeout_ms: None,
    }
}

fn response(
    record: &miao_engine::product_permission_request::Record,
    reply: miao_engine::product_permission_request::Reply,
) -> miao_engine::product_permission_request::Response {
    miao_engine::product_permission_request::Response {
        request_id: record.id.clone(),
        input_hash: record.input_hash.clone(),
        authority_revision: record.authority_revision.clone(),
        reply,
        message: None,
    }
}

#[tokio::test]
async fn shared_once_is_not_a_rule_and_always_commits_rules_receipt_and_changes_together() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let once = context
        .admit_request(&source, assertion("once", "public/file", &[]))
        .await
        .unwrap();
    assert_eq!(once.state, State::Pending);
    assert_eq!(
        context
            .reply_request(&source, response(&once, Reply::Once))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    let next = context
        .admit_request(
            &source,
            assertion("next", "public/file", &["public/**", "other/**"]),
        )
        .await
        .unwrap();
    assert_eq!(next.state, State::Pending);
    let before = context.observe().await.unwrap();
    let allowed = context
        .reply_request(&source, response(&next, Reply::Always))
        .await
        .unwrap();
    assert_eq!(allowed.state, State::Allowed);
    assert_eq!(context.snapshot().await.unwrap().patterns.len(), 2);
    let after = context.observe().await.unwrap();
    assert!(after.cursor.seq > before.cursor.seq);
    assert_eq!(
        context
            .reply_request(&source, response(&next, Reply::Always))
            .await
            .unwrap()
            .input_hash,
        allowed.input_hash
    );
    assert_eq!(context.observe().await.unwrap().cursor, after.cursor);
    assert!(context
        .reply_request(&source, response(&next, Reply::Reject))
        .await
        .is_err());
    assert_eq!(
        context
            .admit_request(&source, assertion("later", "public/later", &[]))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert!(context
        .admit_request(&source, assertion("later", "different", &[]))
        .await
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn failed_multi_pattern_always_rolls_back_rules_reply_and_invalidation_events() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let pending = context
        .admit_request(
            &source,
            assertion("fault", "public/file", &["first/**", "second/**"]),
        )
        .await
        .unwrap();
    let before = context.observe().await.unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fixture_failure BEFORE INSERT ON permission_directory_rule WHEN json_extract(NEW.rule,'$.resource')='second/**' BEGIN SELECT RAISE(ABORT,'injected second-pattern failure'); END;").unwrap();
    assert!(context
        .reply_request(&source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert_eq!(context.observe().await.unwrap().cursor, before.cursor);
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    assert_eq!(
        context
            .request_status(&source, pending.id.clone())
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM permission_request_event", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        1
    );
    sql.execute_batch("DROP TRIGGER fixture_failure").unwrap();
    assert_eq!(
        context
            .reply_request(&source, response(&pending, Reply::Always))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_peer_rule_change_is_reevaluated_by_the_live_owner_and_cannot_override_its_agent_deny() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let peer = shared(directory.path()).await;
    let pending = context
        .admit_request(&source, assertion("peer", "public/file", &[]))
        .await
        .unwrap();
    peer.put(miao_engine::permission_rules::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: Decision::Allow,
    })
    .await
    .unwrap();
    assert_eq!(
        context
            .request_status(&source, pending.id)
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    let denied = context
        .admit_request(&source, assertion("secret", "secret", &["secret"]))
        .await
        .unwrap();
    assert_eq!(denied.state, State::Denied);
    assert!(context
        .reply_request(&source, response(&denied, Reply::Always))
        .await
        .is_err());
    assert_eq!(context.snapshot().await.unwrap().patterns.len(), 1);
    runtime.shutdown().await;
}

#[tokio::test]
async fn replies_after_cancel_or_from_another_scope_never_save_rules() {
    use miao_engine::product_permission_request::Reply;
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let pending = context
        .admit_request(&source, assertion("late", "public/file", &["public/**"]))
        .await
        .unwrap();
    let foreign =
        miao_engine::permission_project::Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap()
            .project("other-project".into())
            .unwrap()
            .context(directory.path().join("workspace"), None)
            .await
            .unwrap();
    assert!(foreign
        .request_status(&source, pending.id.clone())
        .await
        .is_err());
    let explicit =
        miao_engine::permission_project::Authority::open(directory.path().join("permissions.db"))
            .await
            .unwrap()
            .project("fixture".into())
            .unwrap()
            .context(directory.path().join("workspace"), Some("reserved".into()))
            .await
            .unwrap();
    assert!(explicit
        .admit_request(&source, assertion("explicit", "public", &[]))
        .await
        .is_err());
    assert!(runtime.cancel("s").await.unwrap());
    assert!(context
        .reply_request(&source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn explicit_request_cancel_and_expiry_do_not_write_standing_rules() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let pending = context
        .admit_request(&source, assertion("cancel", "public", &["public/**"]))
        .await
        .unwrap();
    assert_eq!(
        context
            .cancel_request(&source, pending.id.clone())
            .await
            .unwrap()
            .state,
        State::Cancelled
    );
    assert!(context
        .reply_request(&source, response(&pending, Reply::Always))
        .await
        .is_err());
    let mut input = assertion("expire", "public", &["public/**"]);
    input.timeout_ms = Some(1);
    let pending = context.admit_request(&source, input).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    assert_eq!(
        context
            .reply_request(&source, response(&pending, Reply::Always))
            .await
            .unwrap()
            .state,
        State::Expired
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn independent_runtimes_share_rules_but_never_reply_for_each_others_sources() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let workspace = directory.path().join("workspace");
    let (_peer_directory, _peer_store, peer, peer_wire, mut receive) =
        running_in_workspace(None, Some(&workspace)).await;
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let peer_source = peer
        .capture_permission_source(&peer.controller(), &peer_wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let first = context
        .admit_request(
            &source,
            assertion("first-owner", "public/file", &["public/**"]),
        )
        .await
        .unwrap();
    let second = context
        .admit_request(&peer_source, assertion("second-owner", "public/file", &[]))
        .await
        .unwrap();
    assert!(context
        .reply_request(&peer_source, response(&first, Reply::Always))
        .await
        .is_err());
    assert_eq!(
        context
            .request_status(&peer_source, second.id.clone())
            .await
            .unwrap()
            .state,
        State::Pending
    );
    context
        .reply_request(&source, response(&first, Reply::Always))
        .await
        .unwrap();
    assert_eq!(
        context
            .request_status(&peer_source, second.id)
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    runtime.shutdown().await;
    peer.shutdown().await;
}
