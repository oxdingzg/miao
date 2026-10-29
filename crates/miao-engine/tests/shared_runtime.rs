//! Actual Runtime selection after a completed pair of permission handoffs.
use async_trait::async_trait;
use miao_engine::{
    approval::{Approval, Response},
    permission::{Config, Decision, Policy, Rule},
    permission_context::{Context, HandoffBinding},
    permission_project::Authority,
    permission_rules,
    permission_source::Target,
    product::Bridge,
    product_permission::{Request, Source},
    product_permission_request,
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

struct Caller(&'static str);
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
                json!([{"type":"tool_use","id":"call","name":self.0,"input":if self.0=="read_file" {json!({"path":"file"})} else {json!({})}}])
            } else {
                json!([{"type":"text","text":"done"}])
            },
            usage: json!({}),
            needs_tools: first,
        })
    }
}

async fn setup(project_handoff: bool) -> (tempfile::TempDir, Store, Context, HandoffBinding) {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("file"), "fixture contents").unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let project = Authority::open(directory.path().join("permissions.db"))
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap();
    let initial = project.snapshot().await.unwrap();
    if project_handoff {
        project
            .handoff(initial.authority.clone(), vec![])
            .await
            .unwrap();
    }
    let context = project.context(&workspace, None).await.unwrap();
    let snapshot = context.snapshot().await.unwrap();
    let prepared = store
        .prepare_directory_permission_source(
            snapshot.directory.clone(),
            Target {
                authority: snapshot.project.authority.clone(),
                project: "fixture".into(),
                directory: snapshot.directory.clone(),
                workspace_id: None,
            },
        )
        .await
        .unwrap();
    let imported = context
        .handoff(snapshot.project.authority, prepared.patterns)
        .await
        .unwrap();
    store
        .complete_directory_permission_source(imported.directory.clone(), imported)
        .await
        .unwrap();
    let binding = context.bind_handoff(&store).await.unwrap();
    (directory, store, context, binding)
}

fn policy(host: bool) -> Policy {
    Policy::new(Config {
        rules: vec![Rule {
            tool: if host { "*" } else { "read_file" }.into(),
            path: if host { "**" } else { "file" }.into(),
            decision: if host { Decision::Allow } else { Decision::Ask },
        }],
        ..Config::default()
    })
    .unwrap()
}

fn input(session: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: format!("input-{session}"),
        prompt: "probe".into(),
        delivery: Delivery::Steer,
    }
}

async fn event(store: &Store, session: &str, kind: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let events = store.events(session, 0, 256).await.unwrap();
            if let Some(event) = events.iter().find(|event| event.kind == kind) {
                return event.data.clone();
            }
            if kind != "run.finished" && events.iter().any(|event| event.kind == "run.finished") {
                panic!("run ended before {kind}: {events:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("timed out waiting for {session}/{kind}: {error}"))
}

fn allow(resource: &str) -> permission_rules::Rule {
    permission_rules::Rule {
        action: "read".into(),
        resource: resource.into(),
        effect: Decision::Allow,
    }
}

#[tokio::test]
async fn shared_constructor_requires_both_handoffs_and_the_bound_directory() {
    let (directory, _, _, binding) = setup(false).await;
    assert!(Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("read_file")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(false)
    )
    .await
    .is_err());
    let (directory, _, _, binding) = setup(true).await;
    let wrong = directory.path().join("other");
    std::fs::create_dir(&wrong).unwrap();
    assert!(Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("read_file")),
        Tools::new(wrong).await.unwrap(),
        policy(false)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn native_tools_use_root_rules_and_revocation_without_reading_the_frozen_source() {
    let (directory, store, context, binding) = setup(true).await;
    context
        .put(permission_rules::Rule {
            action: "read_file".into(),
            resource: "file".into(),
            effect: Decision::Allow,
        })
        .await
        .unwrap();
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("read_file")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(false),
    )
    .await
    .unwrap();
    runtime.admit(input("allowed"), true).await.unwrap();
    event(&store, "allowed", "run.finished").await;
    let events = store.events("allowed", 0, 256).await.unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == "permission.saved_allowed"),
        "{events:?}"
    );
    assert!(!events
        .iter()
        .any(|event| event.kind == "approval.requested"));
    assert!(store
        .saved_rules(context.snapshot().await.unwrap().directory)
        .await
        .is_err());
    let patterns = runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap();
    assert_eq!(patterns.len(), 1);
    assert!(runtime
        .remove_permission_pattern(&runtime.controller(), patterns[0].id.clone())
        .await
        .unwrap());
    runtime.admit(input("revoked"), true).await.unwrap();
    let approval: Approval =
        serde_json::from_value(event(&store, "revoked", "approval.requested").await).unwrap();
    runtime
        .approve(
            &runtime.controller(),
            "revoked",
            Response {
                request_id: approval.request_id,
                input_hash: approval.input_hash,
                policy_revision: approval.policy_revision,
                decision: Decision::Deny,
                matcher: None,
            },
        )
        .await
        .unwrap();
    event(&store, "revoked", "run.finished").await;
    assert!(runtime
        .replace_saved_rules(
            &runtime.controller(),
            context.snapshot().await.unwrap().directory,
            vec![allow("*")]
        )
        .await
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn exact_native_grants_remain_source_owned_and_root_rule_changes_invalidate_their_namespace()
{
    let (directory, store, context, binding) = setup(true).await;
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("read_file")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(false),
    )
    .await
    .unwrap();
    runtime.admit(input("first"), true).await.unwrap();
    let approval: Approval =
        serde_json::from_value(event(&store, "first", "approval.requested").await).unwrap();
    runtime
        .approve_persistent(
            &runtime.controller(),
            "first",
            Response {
                request_id: approval.request_id,
                input_hash: approval.input_hash,
                policy_revision: approval.policy_revision,
                decision: Decision::Allow,
                matcher: None,
            },
        )
        .await
        .unwrap();
    event(&store, "first", "run.finished").await;
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    runtime.admit(input("cached"), true).await.unwrap();
    event(&store, "cached", "run.finished").await;
    assert!(store
        .events("cached", 0, 256)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "permission.grant.used"));
    context.put(allow("unrelated")).await.unwrap();
    runtime.admit(input("changed"), true).await.unwrap();
    event(&store, "changed", "approval.requested").await;
    runtime.cancel("changed").await.unwrap();
    runtime.shutdown().await;
}

fn assertion(id: &str, resource: &str) -> product_permission_request::Input {
    product_permission_request::Input {
        request_id: id.into(),
        facts: Request {
            actions: vec!["read".into()],
            resources: vec![resource.into()],
            explicit: false,
        },
        save: Some(vec![resource.into()]),
        metadata: None,
        timeout_ms: None,
    }
}
fn response(
    record: &product_permission_request::Record,
    reply: product_permission_request::Reply,
) -> product_permission_request::Response {
    product_permission_request::Response {
        request_id: record.id.clone(),
        input_hash: record.input_hash.clone(),
        authority_revision: record.authority_revision.clone(),
        reply,
        message: None,
    }
}
async fn host_call(
    runtime: &Runtime,
    receive: &mut mpsc::Receiver<Value>,
    session: &str,
) -> Source {
    runtime.admit(input(session), false).await.unwrap();
    runtime.set_agent(session,serde_json::from_value(json!({"name":"fixture","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[{"action":"*","resource":"*","effect":"allow"},{"action":"read","resource":"*","effect":"ask"},{"action":"read","resource":"secret","effect":"deny"}]}})).unwrap()).await.unwrap();
    runtime.resume(session).await.unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(8), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "product_tool", "{frame}");
    Source {
        session_id: session.into(),
        bridge_id: frame["bridge_id"].as_u64().unwrap(),
        call_id: frame["params"]["call_id"].as_str().unwrap().into(),
        message_seq: frame["params"]["message_seq"].as_u64().unwrap(),
    }
}

#[tokio::test]
async fn shared_host_once_always_revoke_cancel_and_ui_projection_follow_the_real_runtime() {
    use product_permission_request::{Reply, State};
    let (directory, store, context, binding) = setup(true).await;
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("host_probe")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let (send, mut receive) = mpsc::channel(16);
    runtime.with_product_tools(
        vec![ToolDefinition {
            name: "host_probe".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object"}),
        }],
        Bridge::new(send),
        None,
    );
    let source = host_call(&runtime, &mut receive, "host").await;
    let controller = runtime.controller();
    let once = runtime
        .admit_product_permission(&controller, &source, assertion("once", "public/file"))
        .await
        .unwrap();
    assert_eq!(once.state, State::Pending);
    assert_eq!(
        runtime
            .pending_product_permissions(&controller, "host".into())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        runtime
            .reply_product_permission(&controller, &source, response(&once, Reply::Once))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    let always = runtime
        .admit_product_permission(&controller, &source, assertion("always", "public/file"))
        .await
        .unwrap();
    assert_eq!(
        runtime
            .reply_product_permission(&controller, &source, response(&always, Reply::Always))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(
                &controller,
                &source,
                assertion("query", "public/file").facts
            )
            .await
            .unwrap()
            .effect,
        Decision::Allow
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(&controller, &source, assertion("deny", "secret").facts)
            .await
            .unwrap()
            .effect,
        Decision::Deny
    );
    let pattern = context.snapshot().await.unwrap().patterns[0].id.clone();
    runtime
        .remove_permission_pattern(&controller, pattern)
        .await
        .unwrap();
    let pending = runtime
        .admit_product_permission(&controller, &source, assertion("cancel", "public/file"))
        .await
        .unwrap();
    assert_eq!(pending.state, State::Pending);
    // The Root request owner is the exact UUID on this actual Runtime's run.
    let native = rusqlite::Connection::open(store.path()).unwrap();
    let marker: String = native
        .query_row(
            "SELECT shared_permission FROM engine_run WHERE session_id='host'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let marker: Value = serde_json::from_str(&marker).unwrap();
    let root = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    let owner: String = root
        .query_row(
            "SELECT owner FROM permission_request WHERE id='cancel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker["runtime"], owner);
    assert_eq!(
        marker["target"]["authority"],
        context.snapshot().await.unwrap().project.authority
    );
    runtime.cancel("host").await.unwrap();
    let state: String = root
        .query_row(
            "SELECT state FROM permission_request WHERE id='cancel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cancelled");
    assert!(runtime
        .reply_product_permission(&controller, &source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    let events = store.events("host", 0, 256).await.unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == "product.permission.requested"),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| event.kind == "product.permission.resolved"),
        "{events:?}"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn two_real_runtimes_share_always_and_tool_completion_cancels_unanswered_assertions() {
    use product_permission_request::{Reply, State};
    let (directory, first_store, context, first_binding) = setup(true).await;
    let snapshot = context.snapshot().await.unwrap();
    let second_store = Store::open(directory.path().join("second.db"))
        .await
        .unwrap();
    let prepared = second_store
        .prepare_directory_permission_source(
            snapshot.directory.clone(),
            Target {
                authority: snapshot.project.authority.clone(),
                project: snapshot.project.project.clone(),
                directory: snapshot.directory.clone(),
                workspace_id: None,
            },
        )
        .await
        .unwrap();
    let imported = context
        .handoff(snapshot.project.authority, prepared.patterns)
        .await
        .unwrap();
    second_store
        .complete_directory_permission_source(imported.directory.clone(), imported)
        .await
        .unwrap();
    let second_binding = context.bind_handoff(&second_store).await.unwrap();
    let first = Runtime::with_shared_permissions(
        first_binding,
        Arc::new(Caller("host_probe")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let second = Runtime::with_shared_permissions(
        second_binding,
        Arc::new(Caller("host_probe")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let (send, mut first_wire) = mpsc::channel(16);
    first.with_product_tools(
        vec![ToolDefinition {
            name: "host_probe".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object"}),
        }],
        Bridge::new(send),
        None,
    );
    let (send, mut second_wire) = mpsc::channel(16);
    second.with_product_tools(
        vec![ToolDefinition {
            name: "host_probe".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object"}),
        }],
        Bridge::new(send),
        None,
    );
    let first_source = host_call(&first, &mut first_wire, "first").await;
    let second_source = host_call(&second, &mut second_wire, "second").await;
    let first_pending = first
        .admit_product_permission(
            &first.controller(),
            &first_source,
            assertion("first-request", "shared/file"),
        )
        .await
        .unwrap();
    let second_pending = second
        .admit_product_permission(
            &second.controller(),
            &second_source,
            assertion("second-request", "shared/file"),
        )
        .await
        .unwrap();
    assert_eq!(first_pending.state, State::Pending);
    assert_eq!(second_pending.state, State::Pending);
    first
        .reply_product_permission(
            &first.controller(),
            &first_source,
            response(&first_pending, Reply::Always),
        )
        .await
        .unwrap();
    // No status/list call wakes the second owner: its Root cursor supervisor
    // must re-evaluate the real local source and deliver the durable event.
    let resolved = permission_resolution(&second_store, "second", &second_pending.id).await;
    assert_eq!(resolved["state"], "allowed");
    assert_eq!(
        second
            .product_permission_status(&second.controller(), &second_source, second_pending.id)
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    let unanswered = first
        .admit_product_permission(
            &first.controller(),
            &first_source,
            assertion("unanswered", "other/file"),
        )
        .await
        .unwrap();
    assert_eq!(unanswered.state, State::Pending);
    assert!(first.deliver_product_reply(first_source.bridge_id, json!({"result":{}})));
    event(&first_store, "first", "run.finished").await;
    let root = rusqlite::Connection::open(directory.path().join("permissions.db")).unwrap();
    let state: String = root
        .query_row(
            "SELECT state FROM permission_request WHERE id='unanswered'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cancelled");
    let patterns = context.snapshot().await.unwrap().patterns;
    assert_eq!(patterns.len(), 1);
    second.cancel("second").await.unwrap();
    first.shutdown().await;
    second.shutdown().await;
}

struct GatedReader {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
#[async_trait]
impl Provider for GatedReader {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.entered.notify_one();
        self.release.notified().await;
        Ok(Reply {
            content: json!([{"type":"tool_use","id":"call","name":"read_file","input":{"path":"file"}}]),
            usage: json!({}),
            needs_tools: true,
        })
    }
}

#[tokio::test]
async fn configured_allow_cannot_bypass_the_actual_captured_lease_after_takeover() {
    let (directory, store, _, binding) = setup(true).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(GatedReader {
            entered: entered.clone(),
            release: release.clone(),
        }),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let mut progress = runtime.progress();
    runtime.admit(input("fenced"), true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(8), entered.notified())
        .await
        .unwrap();
    let native = rusqlite::Connection::open(store.path()).unwrap();
    // Simulate the same PID adopting the run under a newer durable claim. A
    // check that only compares current SQL rows would wrongly accept this.
    native.execute_batch("BEGIN IMMEDIATE; UPDATE engine_lease SET epoch=epoch+1; UPDATE engine_run SET lease_epoch=(SELECT epoch FROM engine_lease WHERE session_id=engine_run.session_id) WHERE state='running'; COMMIT;").unwrap();
    release.notify_one();
    let error = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let event = progress.recv().await.unwrap();
            if event["kind"] == "runtime.error" {
                return event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(error["code"], "store_fenced", "{error}");
    assert!(!store
        .events("fenced", 0, 256)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "tool.dispatched" || event.kind == "tool.result"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn shared_runtime_refuses_a_root_database_inside_the_model_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = Store::open(directory.path().join("engine.db"))
        .await
        .unwrap();
    let project = Authority::open(workspace.join("permissions.db"))
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap();
    let snapshot = project.snapshot().await.unwrap();
    project
        .handoff(snapshot.authority.clone(), vec![])
        .await
        .unwrap();
    let context = project.context(&workspace, None).await.unwrap();
    let snapshot = context.snapshot().await.unwrap();
    let prepared = store
        .prepare_directory_permission_source(
            snapshot.directory.clone(),
            Target {
                authority: snapshot.project.authority.clone(),
                project: "fixture".into(),
                directory: snapshot.directory,
                workspace_id: None,
            },
        )
        .await
        .unwrap();
    let imported = context
        .handoff(snapshot.project.authority, prepared.patterns)
        .await
        .unwrap();
    store
        .complete_directory_permission_source(imported.directory.clone(), imported)
        .await
        .unwrap();
    let binding = context.bind_handoff(&store).await.unwrap();
    let error = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("read_file")),
        Tools::new(&workspace).await.unwrap(),
        policy(true),
    )
    .await
    .err()
    .expect("model-writable Root must be refused");
    assert!(
        error.to_string().contains("outside the workspace"),
        "{error}"
    );
    assert!(store.sessions().await.unwrap().is_empty());
}

async fn permission_resolution(store: &Store, session: &str, request: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let events = store.events(session, 0, 256).await.unwrap();
            if let Some(event) = events.iter().find(|event| {
                event.kind == "product.permission.resolved" && event.data["id"] == request
            }) {
                return event.data.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("missing permission resolution {request}: {error}"))
}

#[tokio::test]
async fn request_notifications_and_replaced_bridges_are_supervised_without_host_polling() {
    use product_permission_request::{Reply, State};
    let (directory, store, context, binding) = setup(true).await;
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("host_probe")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let definition = ToolDefinition {
        name: "host_probe".into(),
        description: "fixture".into(),
        input_schema: json!({"type":"object"}),
    };
    let (send, mut receive) = mpsc::channel(16);
    runtime.with_product_tools(vec![definition.clone()], Bridge::new(send), None);
    let source = host_call(&runtime, &mut receive, "supervised").await;
    let controller = runtime.controller();
    let pending = runtime
        .admit_product_permission(
            &controller,
            &source,
            assertion("external-once", "public/file"),
        )
        .await
        .unwrap();
    let captured = runtime
        .capture_permission_source(&controller, &source)
        .unwrap();
    // A trusted external control writes a Root reply without any rule change
    // or Runtime status call. UI projection must follow its separate journal.
    context
        .reply_request(&captured, response(&pending, Reply::Once))
        .await
        .unwrap();
    let resolved = permission_resolution(&store, "supervised", &pending.id).await;
    assert_eq!(resolved["state"], "allowed");
    assert_eq!(resolved["reply"], "once");
    let mut timed = assertion("expired-without-polling", "public/file");
    timed.timeout_ms = Some(50);
    let timed = runtime
        .admit_product_permission(&controller, &source, timed)
        .await
        .unwrap();
    assert_eq!(timed.state, State::Pending);
    let resolved = permission_resolution(&store, "supervised", &timed.id).await;
    assert_eq!(resolved["state"], "expired");
    let pending = runtime
        .admit_product_permission(
            &controller,
            &source,
            assertion("replaced-bridge", "public/file"),
        )
        .await
        .unwrap();
    assert_eq!(pending.state, State::Pending);
    let (send, _replacement) = mpsc::channel(16);
    runtime.with_product_tools(vec![definition], Bridge::new(send), None);
    let resolved = permission_resolution(&store, "supervised", &pending.id).await;
    assert_eq!(resolved["state"], "cancelled");
    assert!(runtime
        .reply_product_permission(&controller, &source, response(&pending, Reply::Always))
        .await
        .is_err());
    assert!(context.snapshot().await.unwrap().patterns.is_empty());
    runtime.cancel("supervised").await.unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn an_idle_shared_supervisor_does_not_keep_writing_the_session_database() {
    let (directory, store, _, binding) = setup(true).await;
    let runtime = Runtime::with_shared_permissions(
        binding,
        Arc::new(Caller("host_probe")),
        Tools::new(directory.path().join("workspace"))
            .await
            .unwrap(),
        policy(true),
    )
    .await
    .unwrap();
    let observer = rusqlite::Connection::open(store.path()).unwrap();
    let before: u64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(450)).await;
    let after: u64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after);
    runtime.shutdown().await;
}
