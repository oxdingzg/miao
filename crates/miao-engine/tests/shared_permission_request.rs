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

#[tokio::test]
async fn shared_always_settles_only_matching_live_assertions_and_reject_affects_existing_waiters() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let first = context
        .admit_request(
            &source,
            assertion("remember", "public/first", &["public/**"]),
        )
        .await
        .unwrap();
    let matching = context
        .admit_request(&source, assertion("matching", "public/second", &[]))
        .await
        .unwrap();
    let unrelated = context
        .admit_request(&source, assertion("unrelated", "private/file", &[]))
        .await
        .unwrap();
    context
        .reply_request(&source, response(&first, Reply::Always))
        .await
        .unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT state FROM permission_request WHERE id='matching'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "allowed"
    );
    assert_eq!(
        context
            .request_status(&source, matching.id)
            .await
            .unwrap()
            .reply,
        Some(Reply::Always)
    );
    assert_eq!(
        context
            .request_status(&source, unrelated.id.clone())
            .await
            .unwrap()
            .state,
        State::Pending
    );
    let peer = context
        .admit_request(&source, assertion("peer-reject", "another/file", &[]))
        .await
        .unwrap();
    let mut reject = response(&unrelated, Reply::Reject);
    reject.message = Some("Use a narrower path".into());
    context.reply_request(&source, reject).await.unwrap();
    let rejected = context.request_status(&source, peer.id).await.unwrap();
    assert_eq!(rejected.state, State::Denied);
    assert_eq!(rejected.reason.as_deref(), Some("user_rejected"));
    assert!(rejected.feedback.is_none());
    let later = context
        .admit_request(&source, assertion("after-reject", "another/file", &[]))
        .await
        .unwrap();
    assert_eq!(later.state, State::Pending);
    runtime.shutdown().await;
}

#[tokio::test]
async fn owner_retirement_cancels_its_finished_source_without_touching_peer_owners_or_rules() {
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
    let pending = context
        .admit_request(
            &source,
            assertion("retiring", "public/file", &["public/**"]),
        )
        .await
        .unwrap();
    let other = context
        .admit_request(&peer_source, assertion("remaining", "public/file", &[]))
        .await
        .unwrap();
    assert!(runtime.cancel("s").await.unwrap());
    assert_eq!(context.retire_source_requests(&source).await.unwrap(), 1);
    assert_eq!(context.retire_source_requests(&source).await.unwrap(), 0);
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT state FROM permission_request WHERE id='retiring'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "cancelled"
    );
    assert!(context
        .reply_request(&source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert_eq!(
        context
            .request_status(&peer_source, other.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    runtime.shutdown().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn same_runtime_always_resolves_another_live_session_but_reject_never_crosses_sessions() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, wire, mut receive) = running_with_sources().await;
    runtime
        .admit(
            Input {
                session_id: "peer-session".into(),
                input_id: "peer-input".into(),
                prompt: "call host".into(),
                delivery: Delivery::Steer,
                command: None,
                agent_references: Default::default(),
            },
            false,
        )
        .await
        .unwrap();
    runtime.set_agent("peer-session",serde_json::from_value(json!({"name":"peer-agent","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[{"action":"*","resource":"*","effect":"allow"},{"action":"read","resource":"*","effect":"ask"},{"action":"read","resource":"secret","effect":"deny"}]}})).unwrap()).await.unwrap();
    runtime.resume("peer-session").await.unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "product_tool");
    let peer_wire = Source {
        session_id: "peer-session".into(),
        bridge_id: frame["bridge_id"].as_u64().unwrap(),
        call_id: frame["params"]["call_id"].as_str().unwrap().into(),
        message_seq: frame["params"]["message_seq"].as_u64().unwrap(),
    };
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let peer_source = runtime
        .capture_permission_source(&runtime.controller(), &peer_wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let first = context
        .admit_request(
            &source,
            assertion("session-a", "public/file", &["public/**"]),
        )
        .await
        .unwrap();
    let second = context
        .admit_request(&peer_source, assertion("session-b", "public/file", &[]))
        .await
        .unwrap();
    context
        .reply_request(&source, response(&first, Reply::Always))
        .await
        .unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT state FROM permission_request WHERE id='session-b'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "allowed"
    );
    assert_eq!(
        context
            .request_status(&peer_source, second.id)
            .await
            .unwrap()
            .reply,
        Some(Reply::Always)
    );
    let rejected = context
        .admit_request(&source, assertion("reject-a", "other/file", &[]))
        .await
        .unwrap();
    let untouched = context
        .admit_request(&peer_source, assertion("untouched-b", "other/file", &[]))
        .await
        .unwrap();
    context
        .reply_request(&source, response(&rejected, Reply::Reject))
        .await
        .unwrap();
    assert_eq!(
        context
            .request_status(&peer_source, untouched.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn durable_source_metadata_records_the_real_database_run_epoch_and_pid_and_is_immutable() {
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("origin", "public/file", &[]))
        .await
        .unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    let encoded: String = sql
        .query_row(
            "SELECT origin FROM permission_request WHERE id='origin'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let origin: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(origin["database"], store.path().to_str().unwrap());
    assert_eq!(
        origin["run_id"],
        store.active_run("s").await.unwrap().unwrap()
    );
    assert_eq!(origin["owner_pid"], std::process::id());
    let native = rusqlite::Connection::open(store.path()).unwrap();
    let epoch: u64 = native
        .query_row(
            "SELECT lease_epoch FROM engine_run WHERE state='running'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(origin["lease_epoch"], epoch);
    assert!(sql
        .execute(
            "UPDATE permission_request SET origin='{}' WHERE id='origin'",
            []
        )
        .is_err());
    assert!(sql
        .execute(
            "UPDATE permission_request SET owner='different' WHERE id='origin'",
            []
        )
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_old_source_cannot_adopt_a_rewritten_run_lease_epoch_even_in_the_same_process() {
    use miao_engine::product_permission_request::Reply;
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let pending = context
        .admit_request(
            &source,
            assertion("superseded", "public/file", &["public/**"]),
        )
        .await
        .unwrap();
    let native = rusqlite::Connection::open(store.path()).unwrap();
    native
        .busy_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    native.execute_batch("BEGIN IMMEDIATE; UPDATE engine_lease SET epoch=epoch+1; UPDATE engine_run SET lease_epoch=(SELECT epoch FROM engine_lease WHERE session_id=engine_run.session_id) WHERE state='running'; COMMIT;").unwrap();
    assert!(context
        .reply_request(&source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert!(runtime
        .evaluate_product_permission(&runtime.controller(), &wire, request("public/file"))
        .await
        .is_err());
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    assert_eq!(context.retire_source_requests(&source).await.unwrap(), 1);
    runtime.shutdown().await;
}

#[tokio::test]
async fn schema_four_requests_without_a_provable_source_are_cancelled_without_replaying_or_changing_rules(
) {
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .put(miao_engine::permission_rules::Rule {
            action: "read".into(),
            resource: "unrelated/**".into(),
            effect: Decision::Allow,
        })
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("old-request", "public/file", &[]))
        .await
        .unwrap();
    let before = context.observe().await.unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    // Reconstruct precisely the v4 table shape; this is a schema compatibility
    // fixture, not a claim that a second binary was run in this test.
    sql.execute_batch("DROP TRIGGER permission_request_origin_required; DROP TRIGGER permission_request_binding_immutable; ALTER TABLE permission_request DROP COLUMN origin; PRAGMA user_version=4;").unwrap();
    let mut old_insert=sql.prepare("INSERT INTO permission_request(id,project,location,owner,session,binding,state,data) SELECT 'old-writer',project,location,owner,session,binding,state,data FROM permission_request WHERE id='old-request'").unwrap();
    let upgraded = shared(directory.path()).await;
    assert_eq!(upgraded.observe().await.unwrap().cursor, before.cursor);
    assert_eq!(upgraded.snapshot().await.unwrap(), before.snapshot);
    let encoded: String = sql
        .query_row(
            "SELECT data FROM permission_request WHERE id='old-request'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let cancelled: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(cancelled["reason"], "source_metadata_unavailable");
    assert_eq!(
        sql.query_row("SELECT count(*) FROM permission_request_event", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        2
    );
    assert!(old_insert
        .execute([])
        .unwrap_err()
        .to_string()
        .contains("durable permission source metadata"));
    assert!(upgraded
        .request_status(&source, "old-request".into())
        .await
        .is_err());
    assert_eq!(
        upgraded
            .admit_request(&source, assertion("fresh-request", "public/file", &[]))
            .await
            .unwrap()
            .state,
        miao_engine::product_permission_request::State::Pending
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_corrupt_legacy_request_rolls_back_the_entire_source_metadata_upgrade() {
    let (directory, _store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("corrupt-old", "public", &[]))
        .await
        .unwrap();
    let before = context.observe().await.unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    sql.execute_batch("DROP TRIGGER permission_request_origin_required; DROP TRIGGER permission_request_binding_immutable; ALTER TABLE permission_request DROP COLUMN origin; PRAGMA user_version=4; UPDATE permission_request SET data='not JSON' WHERE id='corrupt-old';").unwrap();
    assert!(miao_engine::permission_project::Authority::open(
        directory.path().join("permissions.db")
    )
    .await
    .is_err());
    assert_eq!(
        sql.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM pragma_table_info('permission_request') WHERE name='origin'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM permission_request_event", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row(
            "SELECT state FROM permission_request WHERE id='corrupt-old'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "pending"
    );
    assert_eq!(context.observe().await.unwrap().cursor, before.cursor);
    assert_eq!(context.snapshot().await.unwrap(), before.snapshot);
    runtime.shutdown().await;
}

#[tokio::test]
async fn recovery_pages_pass_live_sources_and_cancel_only_the_actual_finished_database() {
    use miao_engine::product_permission_request::State;
    let (directory, store, runtime, wire) = running().await;
    let workspace = directory.path().join("workspace");
    let (_peer_directory, peer_store, peer, peer_wire, mut receive) =
        running_in_workspace(None, Some(&workspace)).await;
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let peer_source = peer
        .capture_permission_source(&peer.controller(), &peer_wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("a-live", "public", &[]))
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("b-live", "public", &[]))
        .await
        .unwrap();
    let foreign = context
        .admit_request(&peer_source, assertion("foreign-db", "public", &[]))
        .await
        .unwrap();
    assert!(context
        .recover_source_requests(&store, None, 0)
        .await
        .is_err());
    let first = context
        .recover_source_requests(&store, None, 1)
        .await
        .unwrap();
    assert_eq!(first.settled, 0);
    assert!(first.has_more);
    assert_eq!(first.after.as_deref(), Some("a-live"));
    let last = context
        .recover_source_requests(&store, first.after, 1)
        .await
        .unwrap();
    assert_eq!(last.settled, 0);
    assert!(!last.has_more);
    assert!(runtime.cancel("s").await.unwrap());
    runtime.shutdown().await;
    let events = store.events("s", 0, 1000).await.unwrap().len();
    let recovered = context
        .recover_source_requests(&store, None, 256)
        .await
        .unwrap();
    assert_eq!(recovered.settled, 2);
    assert_eq!(
        context
            .recover_source_requests(&store, None, 256)
            .await
            .unwrap()
            .settled,
        0
    );
    assert_eq!(
        store.events("s", 0, 1000).await.unwrap().len(),
        events,
        "recovery wrote the Session source"
    );
    assert_eq!(
        context
            .request_status(&peer_source, foreign.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        context
            .recover_source_requests(&peer_store, None, 256)
            .await
            .unwrap()
            .settled,
        0
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    peer.shutdown().await;
}

#[tokio::test]
async fn recovery_failure_rolls_back_all_root_receipts_and_never_writes_the_source() {
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("a-retire", "public", &[]))
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("b-retire", "public", &[]))
        .await
        .unwrap();
    runtime.cancel("s").await.unwrap();
    runtime.shutdown().await;
    let events = store.events("s", 0, 1000).await.unwrap().len();
    let sql = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fixture_failed_recovery BEFORE INSERT ON permission_request_event WHEN NEW.request_id='b-retire' AND NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'injected recovery event failure'); END;").unwrap();
    assert!(context
        .recover_source_requests(&store, None, 256)
        .await
        .is_err());
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM permission_request WHERE state='pending'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM permission_request_event", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        2
    );
    assert_eq!(store.events("s", 0, 1000).await.unwrap().len(), events);
    sql.execute_batch("DROP TRIGGER fixture_failed_recovery")
        .unwrap();
    assert_eq!(
        context
            .recover_source_requests(&store, None, 256)
            .await
            .unwrap()
            .settled,
        2
    );
    assert_eq!(
        context
            .recover_source_requests(&store, None, 256)
            .await
            .unwrap()
            .settled,
        0
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
}

struct OwnerProcess {
    child: std::process::Child,
    directory: Option<std::path::PathBuf>,
}

impl Drop for OwnerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

#[tokio::test]
#[ignore = "subprocess fixture selected explicitly by the owner-exit test"]
async fn shared_owner_subprocess_helper() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MIAO_SHARED_OWNER_FIXTURE").expect("owner fixture root"),
    );
    let (directory, store, runtime, wire, _receive) =
        running_in_workspace(None, Some(&root.join("workspace"))).await;
    let context = miao_engine::permission_project::Authority::open(root.join("permissions.db"))
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap()
        .context(root.join("workspace"), None)
        .await
        .unwrap();
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    context
        .admit_request(&source, assertion("child-pending", "public/file", &[]))
        .await
        .unwrap();
    std::fs::write(
        root.join("ready.part"),
        serde_json::to_vec(&json!({"source":store.path(),"directory":directory.path()})).unwrap(),
    )
    .unwrap();
    std::fs::rename(root.join("ready.part"), root.join("ready.json")).unwrap();
    std::future::pending::<()>().await;
    runtime.shutdown().await;
    drop(directory);
}

#[tokio::test]
async fn an_actual_foreign_process_is_preserved_while_live_and_cancelled_after_it_exits() {
    let root = tempfile::tempdir().unwrap();
    let mut owner = OwnerProcess {
        child: std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "shared_owner_subprocess_helper"])
            .env("MIAO_SHARED_OWNER_FIXTURE", root.path())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
        directory: None,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !root.path().join("ready.json").exists() {
        assert!(
            owner.child.try_wait().unwrap().is_none(),
            "owner fixture exited before readiness"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "owner fixture readiness timed out"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let ready: Value =
        serde_json::from_slice(&std::fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    owner.directory = Some(std::path::PathBuf::from(
        ready["directory"].as_str().unwrap(),
    ));
    let source = Store::open(ready["source"].as_str().unwrap())
        .await
        .unwrap();
    let context =
        miao_engine::permission_project::Authority::open(root.path().join("permissions.db"))
            .await
            .unwrap()
            .project("fixture".into())
            .unwrap()
            .context(root.path().join("workspace"), None)
            .await
            .unwrap();
    let events = source.events("s", 0, 1000).await.unwrap().len();
    assert_eq!(
        context
            .recover_source_requests(&source, None, 16)
            .await
            .unwrap()
            .settled,
        0,
        "a foreign live source was treated as abandoned"
    );
    owner.child.kill().unwrap();
    owner.child.wait().unwrap();
    assert_eq!(
        context
            .recover_source_requests(&source, None, 16)
            .await
            .unwrap()
            .settled,
        1
    );
    assert_eq!(
        context
            .recover_source_requests(&source, None, 16)
            .await
            .unwrap()
            .settled,
        0
    );
    let sql = rusqlite::Connection::open(root.path().join("permissions.db")).unwrap();
    let record: String = sql
        .query_row(
            "SELECT data FROM permission_request WHERE id='child-pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(record["state"], "cancelled");
    assert_eq!(record["reason"], "source_owner_exited");
    assert_eq!(
        source.events("s", 0, 1000).await.unwrap().len(),
        events,
        "cleanup wrote Session history or replayed work"
    );
    assert!(
        source.active_run("s").await.unwrap().is_some(),
        "cleanup altered the source run"
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    source.close().await.unwrap();
}

#[tokio::test]
async fn root_request_notifications_project_once_and_keep_admission_distinct_from_resolution() {
    use miao_engine::product_permission_request::Reply;
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    let pending = context
        .admit_request(&source, assertion("projected", "public/file", &[]))
        .await
        .unwrap();
    let first = context.project_request_events(&store, 16).await.unwrap();
    assert_eq!(first.emitted, 1);
    assert!(!first.has_more);
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        0
    );
    context
        .reply_request(&source, response(&pending, Reply::Once))
        .await
        .unwrap();
    let (left, right) = tokio::join!(
        context.project_request_events(&store, 16),
        context.project_request_events(&store, 16)
    );
    assert_eq!(left.unwrap().emitted + right.unwrap().emitted, 1);
    let events = store.events("s", 0, 1000).await.unwrap();
    let projected = events
        .iter()
        .filter(|event| event.kind.starts_with("product.permission."))
        .collect::<Vec<_>>();
    assert_eq!(projected.len(), 2);
    assert_eq!(projected[0].kind, "product.permission.requested");
    assert_eq!(projected[1].kind, "product.permission.resolved");
    assert_eq!(projected[1].data["reply"], "once");
    runtime.shutdown().await;
    drop(runtime);
    store.close().await.unwrap();
    let reopened = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    assert_eq!(
        context
            .project_request_events(&reopened, 16)
            .await
            .unwrap()
            .emitted,
        0
    );
    assert_eq!(
        reopened
            .events("s", 0, 1000)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind.starts_with("product.permission."))
            .count(),
        2
    );
}

#[tokio::test]
async fn request_event_cursors_are_typed_root_bound_and_filter_the_actual_source_database() {
    let (directory, store, runtime, wire) = running().await;
    let workspace = directory.path().join("workspace");
    let (_peer_directory, peer_store, peer, peer_wire, mut receive) =
        running_in_workspace(None, Some(&workspace)).await;
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let peer_source = peer
        .capture_permission_source(&peer.controller(), &peer_wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("own-event", "public", &[]))
        .await
        .unwrap();
    context
        .admit_request(&peer_source, assertion("foreign-event", "public", &[]))
        .await
        .unwrap();
    let own = context.request_events(&store, None, 1).await.unwrap();
    assert_eq!(own.events.len(), 1);
    assert_eq!(own.events[0].record.id, "own-event");
    assert!(!own.has_more);
    let foreign = context.request_events(&peer_store, None, 1).await.unwrap();
    assert_eq!(foreign.events[0].record.id, "foreign-event");
    assert_eq!(
        own.cursor, foreign.cursor,
        "final cursors did not advance through filtered events"
    );
    assert!(context
        .request_events(&store, Some(own.cursor.clone()), 1)
        .await
        .unwrap()
        .events
        .is_empty());
    assert!(
        serde_json::from_value::<miao_engine::shared_permission_events::Cursor>(
            json!({"authority":own.cursor.authority,"seq":0})
        )
        .is_err()
    );
    let mut wrong = own.cursor.clone();
    wrong.authority = uuid::Uuid::new_v4().to_string();
    assert!(context
        .request_events(&store, Some(wrong), 1)
        .await
        .is_err());
    let mut future = own.cursor;
    future.seq += 1;
    assert!(context
        .request_events(&store, Some(future), 1)
        .await
        .is_err());
    assert!(context.request_events(&store, None, 0).await.is_err());
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        1
    );
    assert_eq!(
        context
            .project_request_events(&peer_store, 16)
            .await
            .unwrap()
            .emitted,
        1
    );
    runtime.shutdown().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn source_projection_failure_rolls_back_events_deduplication_and_cursor_together() {
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .admit_request(&source, assertion("project-a", "public", &[]))
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("project-b", "public", &[]))
        .await
        .unwrap();
    let sql = rusqlite::Connection::open(store.path()).unwrap();
    sql.execute_batch("CREATE TRIGGER fixture_projection_failure BEFORE INSERT ON engine_event WHEN NEW.kind='product.permission.requested' AND json_extract(NEW.data,'$.id')='project-b' BEGIN SELECT RAISE(ABORT,'injected source projection failure'); END;").unwrap();
    assert!(context.project_request_events(&store, 16).await.is_err());
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM engine_root_permission_event",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM engine_root_permission_cursor",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        store
            .events("s", 0, 1000)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind.starts_with("product.permission."))
            .count(),
        0
    );
    sql.execute_batch("DROP TRIGGER fixture_projection_failure")
        .unwrap();
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        2
    );
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        0
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn initial_policy_decisions_do_not_fake_ui_replies_and_peer_rule_settlement_closes_the_question(
) {
    let (directory, store, runtime, wire) = running().await;
    let source = runtime
        .capture_permission_source(&runtime.controller(), &wire)
        .unwrap();
    let context = shared(directory.path()).await;
    context
        .put(miao_engine::permission_rules::Rule {
            action: "read".into(),
            resource: "preallowed/**".into(),
            effect: Decision::Allow,
        })
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("preallowed", "preallowed/file", &[]))
        .await
        .unwrap();
    context
        .admit_request(&source, assertion("predenied", "secret", &[]))
        .await
        .unwrap();
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        0
    );
    let pending = context
        .admit_request(&source, assertion("rule-changed", "public/file", &[]))
        .await
        .unwrap();
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        1
    );
    context
        .put(miao_engine::permission_rules::Rule {
            action: "read".into(),
            resource: "public/**".into(),
            effect: Decision::Allow,
        })
        .await
        .unwrap();
    let settled = context.request_status(&source, pending.id).await.unwrap();
    assert_eq!(
        settled.reply,
        Some(miao_engine::product_permission_request::Reply::Always)
    );
    assert_eq!(settled.reason.as_deref(), Some("saved_rules_allowed"));
    assert_eq!(
        context
            .project_request_events(&store, 16)
            .await
            .unwrap()
            .emitted,
        1
    );
    let events = store.events("s", 0, 1000).await.unwrap();
    let final_event = events
        .iter()
        .find(|event| event.kind == "product.permission.resolved")
        .unwrap();
    assert_eq!(final_event.data["id"], "rule-changed");
    assert_eq!(final_event.data["reply"], "always");
    runtime.shutdown().await;
}
