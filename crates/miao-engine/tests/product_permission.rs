use async_trait::async_trait;
use miao_engine::{
    host::Host,
    permission::{Config, Decision, Policy, Rule},
    permission_rules,
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
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
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

#[tokio::test]
async fn active_call_uses_captured_configured_rules_and_only_its_workspace_saved_rules() {
    let (_directory, store, runtime, source) = running().await;
    let mut host = Host::new(runtime.clone());
    let command = serde_json::from_value(
        json!({"method":"product_permission_evaluate","params":{"source":source,"request":request("public")}}),
    )
    .unwrap();
    let asked = host.dispatch(command).await.unwrap();
    assert_eq!(asked["effect"], "ask");
    store
        .project_saved_rules(
            "/different-workspace".into(),
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "*".into(),
                effect: Decision::Allow,
            }],
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("public"))
            .await
            .unwrap()
            .effect,
        Decision::Ask
    );
    let workspace = store.location("s").await.unwrap().unwrap();
    store
        .project_saved_rules(
            workspace,
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "*".into(),
                effect: Decision::Allow,
            }],
        )
        .await
        .unwrap();
    let allowed = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    assert_eq!(allowed.effect, Decision::Allow);
    assert_ne!(
        allowed.authority_revision,
        asked["authority_revision"].as_str().unwrap()
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("secret"))
            .await
            .unwrap()
            .effect,
        Decision::Deny
    );
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    for table in ["engine_approval", "engine_permission_grant"] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }
    runtime.shutdown().await;
}

#[tokio::test]
async fn query_cannot_borrow_a_different_session_call_message_or_bridge() {
    let (_directory, _store, runtime, source) = running().await;
    for forged in [
        Source {
            session_id: "other".into(),
            ..source.clone()
        },
        Source {
            call_id: "other".into(),
            ..source.clone()
        },
        Source {
            message_seq: source.message_seq + 1,
            ..source.clone()
        },
        Source {
            bridge_id: source.bridge_id + 1,
            ..source.clone()
        },
    ] {
        assert!(runtime
            .evaluate_product_permission(&runtime.controller(), &forged, request("public"))
            .await
            .is_err());
    }
    runtime.shutdown().await;
}

#[tokio::test]
async fn active_bridge_keeps_the_turn_rules_when_agent_selection_changes() {
    let (_directory, _store, runtime, source) = running().await;
    let before = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    runtime.set_agent("s",serde_json::from_value(json!({"name":"changed","ordered_permissions":{
        "semantics":"ordered-wildcard-v1","rules":[{"action":"*","resource":"*","effect":"deny"}]
    }})).unwrap()).await.unwrap();
    let after = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    assert_eq!(before, after);
    runtime.shutdown().await;
}

#[tokio::test]
async fn replies_cancellation_and_durable_tool_settlement_invalidate_the_query() {
    for boundary in ["reply", "cancel", "settle"] {
        let (_directory, store, runtime, source) = running().await;
        if boundary == "reply" {
            assert!(runtime.deliver_product_reply(source.bridge_id, json!({"result":{}})));
        }
        if boundary == "cancel" {
            runtime.cancel("s").await.unwrap();
        }
        if boundary == "settle" {
            let run = store.active_run("s").await.unwrap().unwrap();
            store
                .tool_result(
                    "s",
                    &run,
                    &source.call_id,
                    json!({"error":"settled externally"}),
                    true,
                )
                .await
                .unwrap();
        }
        assert!(
            runtime
                .evaluate_product_permission(&runtime.controller(), &source, request("public"))
                .await
                .is_err(),
            "{boundary}"
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn wire_refuses_client_rules_and_queries_refuse_empty_facts() {
    let (_directory, _store, runtime, source) = running().await;
    for field in ["configured", "saved", "workspace"] {
        let mut value = json!({"method":"product_permission_evaluate","params":{"source":source,"request":request("public")}});
        assert!(serde_json::from_value::<miao_engine::protocol::Command>(value.clone()).is_ok());
        value["params"]["request"][field] = json!([]);
        assert!(
            serde_json::from_value::<miao_engine::protocol::Command>(value).is_err(),
            "{field}"
        );
    }
    assert!(runtime
        .evaluate_product_permission(
            &runtime.controller(),
            &source,
            Request {
                actions: vec![],
                ..request("public")
            }
        )
        .await
        .is_err());
    assert!(runtime
        .evaluate_product_permission(
            &runtime.controller(),
            &source,
            Request {
                resources: vec![],
                ..request("public")
            }
        )
        .await
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn owner_controllers_and_authority_revisions_do_not_cross_workspaces() {
    let (_first_directory, _first_store, first, source) = running().await;
    let (_other_directory, _other_store, other, other_source) = running().await;
    assert!(first
        .evaluate_product_permission(&other.controller(), &source, request("public"))
        .await
        .is_err());
    let first_outcome = first
        .evaluate_product_permission(&first.controller(), &source, request("public"))
        .await
        .unwrap();
    let other_outcome = other
        .evaluate_product_permission(&other.controller(), &other_source, request("public"))
        .await
        .unwrap();
    assert_ne!(
        first_outcome.authority_revision,
        other_outcome.authority_revision
    );
    first.shutdown().await;
    other.shutdown().await;
}

#[tokio::test]
async fn native_patterns_are_live_revocable_and_separate_from_projection_and_exact_grants() {
    let (directory, store, runtime, source) = running().await;
    let mut host = Host::new(runtime.clone());
    let rule = permission_rules::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: Decision::Allow,
    };
    let before = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    assert_eq!(before.effect, Decision::Ask);
    let put = || {
        serde_json::from_value(json!({"method":"permission_pattern_put","params":{"rule":rule}}))
            .unwrap()
    };
    let stored = host.dispatch(put()).await.unwrap();
    assert_eq!(stored["source"], "native");
    assert_eq!(
        stored["workspace"],
        store.location("s").await.unwrap().unwrap()
    );
    assert_eq!(host.dispatch(put()).await.unwrap(), stored);
    let listed = host
        .dispatch(serde_json::from_value(json!({"method":"permission_pattern_list"})).unwrap())
        .await
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let allowed = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    assert_eq!(allowed.effect, Decision::Allow);
    assert_ne!(before.authority_revision, allowed.authority_revision);
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("secret"))
            .await
            .unwrap()
            .effect,
        Decision::Deny
    );
    let workspace = store.location("s").await.unwrap().unwrap();
    store
        .project_saved_rules(
            workspace.clone(),
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "legacy".into(),
                effect: Decision::Allow,
            }],
        )
        .await
        .unwrap();
    let removed = host
        .dispatch(
            serde_json::from_value(
                json!({"method":"permission_pattern_remove","params":{"rule_id":stored["id"]}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(removed["removed"], true);
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("public"))
            .await
            .unwrap()
            .effect,
        Decision::Ask
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("legacy"))
            .await
            .unwrap()
            .effect,
        Decision::Allow
    );
    assert_eq!(store.saved_rules(workspace).await.unwrap().len(), 1);
    let connection = rusqlite::Connection::open(directory.path().join("engine.db")).unwrap();
    assert_eq!(
        connection
            .query_row::<u64, _, _>("SELECT COUNT(*) FROM engine_permission_grant", [], |row| {
                row.get(0)
            })
            .unwrap(),
        0
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn pattern_control_is_runtime_scoped_and_cannot_select_a_workspace_or_origin() {
    let (_first, _store, runtime, _source) = running().await;
    let (_other, _other_store, other, _other_source) = running().await;
    let rule = permission_rules::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: Decision::Allow,
    };
    let stored = runtime
        .put_permission_pattern(&runtime.controller(), rule.clone())
        .await
        .unwrap();
    assert!(runtime
        .permission_patterns(&other.controller())
        .await
        .is_err());
    assert!(runtime
        .put_permission_pattern(&other.controller(), rule.clone())
        .await
        .is_err());
    assert!(runtime
        .remove_permission_pattern(&other.controller(), stored.id.clone())
        .await
        .is_err());
    assert!(!other
        .remove_permission_pattern(&other.controller(), stored.id.clone())
        .await
        .unwrap());
    let second = other
        .put_permission_pattern(&other.controller(), rule.clone())
        .await
        .unwrap();
    assert_ne!(stored.id, second.id);
    assert_eq!(
        runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap(),
        vec![stored]
    );
    for extra in [
        json!({"workspace":"/foreign"}),
        json!({"source":"projection"}),
        json!({"configured":[]}),
    ] {
        let mut params = extra;
        params["rule"] = json!(rule);
        assert!(serde_json::from_value::<miao_engine::protocol::Command>(
            json!({"method":"permission_pattern_put","params":params})
        )
        .is_err());
    }
    assert!(runtime
        .put_permission_pattern(
            &runtime.controller(),
            permission_rules::Rule {
                effect: Decision::Deny,
                ..rule
            }
        )
        .await
        .is_err());
    runtime.shutdown().await;
    other.shutdown().await;
}

fn assertion(id: &str, resource: &str) -> miao_engine::product_permission_request::Input {
    miao_engine::product_permission_request::Input {
        request_id: id.into(),
        facts: request(resource),
        save: None,
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
async fn durable_host_assertions_distinguish_new_asks_from_exact_retries() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, _store, runtime, source) = running().await;
    let first = runtime
        .admit_product_permission(&runtime.controller(), &source, assertion("first", "public"))
        .await
        .unwrap();
    assert_eq!(first.state, State::Pending);
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(
            runtime
                .admit_product_permission(
                    &runtime.controller(),
                    &source,
                    assertion("first", "public")
                )
                .await
                .unwrap()
        )
        .unwrap()
    );
    assert!(runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("first", "different")
        )
        .await
        .is_err());
    let second = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("second", "public"),
        )
        .await
        .unwrap();
    assert_eq!(second.state, State::Pending);
    let allowed = runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Once),
        )
        .await
        .unwrap();
    assert_eq!(allowed.state, State::Allowed);
    assert_eq!(
        runtime
            .reply_product_permission(
                &runtime.controller(),
                &source,
                response(&first, Reply::Once)
            )
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert!(runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Always)
        )
        .await
        .is_err());
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        runtime
            .pending_product_permissions(&runtime.controller(), "s".into())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        runtime
            .reply_product_permission(
                &runtime.controller(),
                &source,
                response(&second, Reply::Reject)
            )
            .await
            .unwrap()
            .state,
        State::Denied
    );
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, assertion("third", "public"))
            .await
            .unwrap()
            .state,
        State::Pending
    );
    let secret = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("secret", "secret"),
        )
        .await
        .unwrap();
    assert_eq!(secret.state, State::Denied);
    assert!(runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&secret, Reply::Always)
        )
        .await
        .is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn always_responses_atomically_save_patterns_without_creating_exact_grants() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, source) = running().await;
    let mut input = assertion("always", "public");
    input.save = Some(vec!["*".into(), "other".into()]);
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    let allowed = runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always),
        )
        .await
        .unwrap();
    assert_eq!(allowed.state, State::Allowed);
    assert_eq!(
        runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .len(),
        2
    );
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, assertion("next", "public"))
            .await
            .unwrap()
            .state,
        State::Allowed
    );
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("secret", "secret")
            )
            .await
            .unwrap()
            .state,
        State::Denied
    );
    for pattern in runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
    {
        runtime
            .remove_permission_pattern(&runtime.controller(), pattern.id)
            .await
            .unwrap();
    }
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("after-revoke", "public")
            )
            .await
            .unwrap()
            .state,
        State::Pending
    );
    let connection = rusqlite::Connection::open(directory.path().join("engine.db")).unwrap();
    assert_eq!(
        connection
            .query_row::<u64, _, _>("SELECT COUNT(*) FROM engine_permission_grant", [], |row| {
                row.get(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row::<u64, _, _>(
                "SELECT COUNT(*) FROM engine_event WHERE kind='product.permission.resolved'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn failed_always_pattern_writes_roll_back_the_reply_and_all_patterns() {
    use miao_engine::product_permission_request::{Reply, State};
    let (directory, _store, runtime, source) = running().await;
    let mut input = assertion("rollback", "public");
    input.save = Some(vec!["first".into(), "second".into()]);
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("engine.db")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_second_pattern BEFORE INSERT ON engine_owned_permission_rule WHEN json_extract(NEW.rule,'$.resource')='second' BEGIN SELECT RAISE(ABORT,'fixture pattern fault'); END;").unwrap();
    assert!(runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always)
        )
        .await
        .is_err());
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, pending.id.clone())
            .await
            .unwrap()
            .state,
        State::Pending
    );
    connection
        .execute_batch("DROP TRIGGER fail_second_pattern")
        .unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .len(),
        2
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn durable_assertions_enforce_source_bindings_and_recheck_denies_before_response() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, store, runtime, source) = running().await;
    let (_other, _other_store, other, _other_source) = running().await;
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, assertion("bound", "public"))
        .await
        .unwrap();
    assert!(runtime
        .product_permission_status(&other.controller(), &source, pending.id.clone())
        .await
        .is_err());
    for wrong in [
        Source {
            session_id: "foreign".into(),
            ..source.clone()
        },
        Source {
            bridge_id: source.bridge_id + 1,
            ..source.clone()
        },
        Source {
            call_id: "different".into(),
            ..source.clone()
        },
        Source {
            message_seq: source.message_seq + 1,
            ..source.clone()
        },
    ] {
        assert!(runtime
            .reply_product_permission(
                &runtime.controller(),
                &wrong,
                response(&pending, Reply::Always)
            )
            .await
            .is_err());
    }
    let mut wrong = response(&pending, Reply::Once);
    wrong.input_hash = "0".repeat(64);
    assert!(runtime
        .reply_product_permission(&runtime.controller(), &source, wrong)
        .await
        .is_err());
    let workspace = store.location("s").await.unwrap().unwrap();
    store
        .project_saved_rules(
            workspace,
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "public".into(),
                effect: Decision::Deny,
            }],
        )
        .await
        .unwrap();
    let denied = runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always),
        )
        .await
        .unwrap();
    assert_eq!(denied.state, State::Denied);
    assert_eq!(denied.reason.as_deref(), Some("policy_denied"));
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    runtime.shutdown().await;
    other.shutdown().await;
}

#[tokio::test]
async fn source_tool_settlement_and_cancel_clear_pending_host_assertions() {
    use miao_engine::product_permission_request::Reply;
    for finish in [false, true] {
        let (_directory, store, runtime, source) = running().await;
        let pending = runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("cancel", "public"),
            )
            .await
            .unwrap();
        if finish {
            let run = store.snapshot("s").await.unwrap()["active_run"]
                .as_str()
                .unwrap()
                .to_owned();
            store
                .tool_result(
                    "s",
                    &run,
                    &source.call_id,
                    json!({"error":"cancelled"}),
                    true,
                )
                .await
                .unwrap();
        }
        if !finish {
            runtime.cancel("s").await.unwrap();
        }
        runtime.shutdown().await;
        assert!(runtime
            .reply_product_permission(
                &runtime.controller(),
                &source,
                response(&pending, Reply::Always)
            )
            .await
            .is_err());
        assert!(runtime
            .pending_product_permissions(&runtime.controller(), "s".into())
            .await
            .unwrap()
            .is_empty());
        let events = store.events("s", 0, 500).await.unwrap();
        let resolved = events
            .iter()
            .find(|event| event.kind == "product.permission.resolved")
            .unwrap();
        assert_eq!(resolved.data["state"], "cancelled");
        assert!(runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn host_assertion_expiry_and_pending_budgets_are_bounded() {
    use miao_engine::product_permission_request::State;
    let (_directory, _store, runtime, source) = running().await;
    let mut input = assertion("expires", "public");
    input.timeout_ms = Some(1);
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, pending.id)
            .await
            .unwrap()
            .state,
        State::Expired
    );
    for index in 0..64 {
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion(&format!("pending-{index}"), "public"),
            )
            .await
            .unwrap();
    }
    assert!(runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("over-budget", "public")
        )
        .await
        .is_err());
    assert_eq!(
        runtime
            .pending_product_permissions(&runtime.controller(), "s".into())
            .await
            .unwrap()
            .len(),
        64
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn always_without_save_patterns_does_not_remember_requested_resources() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, _store, runtime, source) = running().await;
    for (index, save) in [None, Some(vec![])].into_iter().enumerate() {
        let mut input = assertion(&format!("no-save-{index}"), "public");
        input.save = save;
        let pending = runtime
            .admit_product_permission(&runtime.controller(), &source, input)
            .await
            .unwrap();
        let allowed = runtime
            .reply_product_permission(
                &runtime.controller(),
                &source,
                response(&pending, Reply::Always),
            )
            .await
            .unwrap();
        assert_eq!(allowed.state, State::Allowed);
        assert!(runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .is_empty());
    }
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("still-asks", "public")
            )
            .await
            .unwrap()
            .state,
        State::Pending
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn late_always_replies_cannot_cross_bridge_replacement_or_source_reply() {
    use miao_engine::product_permission_request::Reply;
    for replace in [false, true] {
        let (_directory, _store, runtime, source) = running().await;
        let mut input = assertion("late", "public");
        input.save = Some(vec!["*".into()]);
        let pending = runtime
            .admit_product_permission(&runtime.controller(), &source, input)
            .await
            .unwrap();
        if replace {
            let (send, _receive) = mpsc::channel(8);
            runtime.with_product_tools(vec![], Bridge::new(send), None);
        }
        if !replace {
            assert!(runtime.deliver_product_reply(source.bridge_id, json!({"result":{}})));
        }
        assert!(runtime
            .reply_product_permission(
                &runtime.controller(),
                &source,
                response(&pending, Reply::Always)
            )
            .await
            .is_err());
        assert!(runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap()
            .is_empty());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn recovery_cancels_abandoned_assertions_without_retrying_provider_work() {
    let (directory, store, runtime, source) = running().await;
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, assertion("crash", "public"))
        .await
        .unwrap();
    let copy = directory.path().join("abandoned.db");
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    connection
        .execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
        .unwrap();
    let copied = rusqlite::Connection::open(&copy).unwrap();
    copied.execute("DELETE FROM engine_lease", []).unwrap();
    let recovered = Store::open(&copy).await.unwrap();
    let before = recovered
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "provider.started")
        .count();
    recovered.recover().await.unwrap();
    assert_eq!(
        copied
            .query_row::<String, _, _>(
                "SELECT state FROM engine_product_permission_request WHERE id=?1",
                [&pending.id],
                |row| row.get(0)
            )
            .unwrap(),
        "cancelled"
    );
    let events = recovered.events("s", 0, 1000).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "provider.started")
            .count(),
        before
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "product.permission.resolved")
            .count(),
        1
    );
    recovered.recover().await.unwrap();
    assert_eq!(
        recovered
            .events("s", 0, 1000)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "product.permission.resolved")
            .count(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn source_completion_failure_rolls_back_permission_cancellation() {
    use miao_engine::product_permission_request::State;
    let (_directory, store, runtime, source) = running().await;
    let pending = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("tool-rollback", "public"),
        )
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_tool_completed BEFORE INSERT ON engine_event WHEN NEW.kind='tool.completed' BEGIN SELECT RAISE(ABORT,'fixture completion fault'); END;").unwrap();
    let run = store.active_run("s").await.unwrap().unwrap();
    assert!(store
        .tool_result("s", &run, &source.call_id, json!({}), false)
        .await
        .is_err());
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, pending.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert!(!store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "product.permission.resolved"));
    connection
        .execute_batch("DROP TRIGGER fail_tool_completed")
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn competing_host_replies_have_one_durable_outcome() {
    use miao_engine::product_permission_request::Reply;
    let (_directory, store, runtime, source) = running().await;
    let mut input = assertion("race", "public");
    input.save = Some(vec!["*".into()]);
    let pending = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    let controller = runtime.controller();
    let (allow, deny) = tokio::join!(
        runtime.reply_product_permission(&controller, &source, response(&pending, Reply::Always)),
        runtime.reply_product_permission(&controller, &source, response(&pending, Reply::Reject)),
    );
    assert_ne!(allow.is_ok(), deny.is_ok());
    let resolved = runtime
        .product_permission_status(&controller, &source, pending.id)
        .await
        .unwrap();
    let patterns = runtime.permission_patterns(&controller).await.unwrap();
    assert_eq!(
        patterns.len(),
        usize::from(resolved.reply == Some(Reply::Always))
    );
    assert_eq!(
        store
            .events("s", 0, 1000)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "product.permission.resolved")
            .count(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn assertion_wire_refuses_caller_authority_and_unbounded_inputs() {
    let (_directory, store, runtime, source) = running().await;
    for field in [
        "configured",
        "saved",
        "workspace",
        "owner",
        "auto",
        "host_context",
        "cwd",
        "denial",
        "rules",
    ] {
        let mut input = serde_json::to_value(assertion("invalid", "public")).unwrap();
        input[field] = json!([]);
        assert!(serde_json::from_value::<miao_engine::protocol::Command>(json!({"method":"product_permission_admit","params":{"source":source,"input":input}})).is_err(), "{field}");
    }
    for index in 0..5 {
        let mut input = assertion("invalid", "public");
        match index {
            0 => input.request_id = "bad\nidentity".into(),
            1 => input.timeout_ms = Some(0),
            2 => input.timeout_ms = Some(600_001),
            3 => input.save = Some(vec!["pattern".into(); 65]),
            _ => input.metadata = Some(json!({"large":"x".repeat(16_384)})),
        }
        assert!(runtime
            .admit_product_permission(&runtime.controller(), &source, input)
            .await
            .is_err());
    }
    assert!(runtime
        .pending_product_permissions(&runtime.controller(), "s".into())
        .await
        .unwrap()
        .is_empty());
    assert!(!store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "product.permission.requested"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn rejecting_a_host_assertion_rejects_only_already_pending_session_siblings() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, store, runtime, source) = running().await;
    let first = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("reject-first", "public"),
        )
        .await
        .unwrap();
    let sibling = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("reject-sibling", "other"),
        )
        .await
        .unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Reject),
        )
        .await
        .unwrap();
    let rejected = runtime
        .product_permission_status(&runtime.controller(), &source, sibling.id.clone())
        .await
        .unwrap();
    assert_eq!(rejected.state, State::Denied);
    assert_eq!(rejected.reply, Some(Reply::Reject));
    assert!(runtime
        .pending_product_permissions(&runtime.controller(), "s".into())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("after-reject", "other")
            )
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        store
            .events("s", 0, 1000)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "product.permission.resolved")
            .count(),
        2
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn always_releases_matching_pending_assertions_across_live_session_sources() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, _store, runtime, source, mut receive) = running_with_sources().await;
    runtime
        .admit(
            Input {
                session_id: "other-session".into(),
                input_id: "other-input".into(),
                prompt: "call host".into(),
                delivery: Delivery::Steer,
                agent_references: Default::default(),
                command: None,
            },
            false,
        )
        .await
        .unwrap();
    runtime.set_agent("other-session", serde_json::from_value(json!({"name":"other-agent","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[
        {"action":"*","resource":"*","effect":"allow"},
        {"action":"read","resource":"*","effect":"ask"},
        {"action":"read","resource":"blocked","effect":"deny"}
    ]}})).unwrap()).await.unwrap();
    runtime.resume("other-session").await.unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame["method"], "product_tool");
    let other = Source {
        session_id: "other-session".into(),
        bridge_id: frame["bridge_id"].as_u64().unwrap(),
        call_id: frame["params"]["call_id"].as_str().unwrap().into(),
        message_seq: frame["params"]["message_seq"].as_u64().unwrap(),
    };
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    let mut input = assertion("always-first", "public");
    input.save = Some(vec!["public".into(), "blocked".into()]);
    let first = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    let sibling = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("same-source", "public"),
        )
        .await
        .unwrap();
    let cross_session = runtime
        .admit_product_permission(
            &runtime.controller(),
            &other,
            assertion("cross-session", "public"),
        )
        .await
        .unwrap();
    let unmatched = runtime
        .admit_product_permission(
            &runtime.controller(),
            &other,
            assertion("unmatched", "different"),
        )
        .await
        .unwrap();
    // A new selected agent belongs to a later turn, not either live source.
    runtime.set_agent("other-session", serde_json::from_value(json!({"name":"later-agent","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[{"action":"*","resource":"*","effect":"deny"}]}})).unwrap()).await.unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Always),
        )
        .await
        .unwrap();
    for (source, record) in [(&source, sibling), (&other, cross_session)] {
        let allowed = runtime
            .product_permission_status(&runtime.controller(), source, record.id)
            .await
            .unwrap();
        assert_eq!(allowed.state, State::Allowed);
        assert_eq!(allowed.reply, Some(Reply::Always));
    }
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &other, unmatched.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &other,
                assertion("blocked", "blocked")
            )
            .await
            .unwrap()
            .state,
        State::Denied
    );
    for pattern in runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
    {
        runtime
            .remove_permission_pattern(&runtime.controller(), pattern.id)
            .await
            .unwrap();
    }
    let fresh = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("after-revoke", "public"),
        )
        .await
        .unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Always),
        )
        .await
        .unwrap();
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, fresh.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    let reject = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("local-reject", "different"),
        )
        .await
        .unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&reject, Reply::Reject),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .pending_product_permissions(&runtime.controller(), "other-session".into())
            .await
            .unwrap()
            .len(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn failed_always_does_not_partially_release_sibling_assertions() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, store, runtime, source) = running().await;
    let mut input = assertion("atomic-first", "public");
    input.save = Some(vec!["public".into()]);
    let first = runtime
        .admit_product_permission(&runtime.controller(), &source, input)
        .await
        .unwrap();
    let sibling = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("atomic-sibling", "public"),
        )
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_sibling_resolution BEFORE UPDATE ON engine_product_permission_request WHEN NEW.id='atomic-sibling' BEGIN SELECT RAISE(ABORT,'fixture sibling fault'); END;").unwrap();
    assert!(runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Always)
        )
        .await
        .is_err());
    for record in [&first, &sibling] {
        assert_eq!(
            runtime
                .product_permission_status(&runtime.controller(), &source, record.id.clone())
                .await
                .unwrap()
                .state,
            State::Pending
        );
    }
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    connection
        .execute_batch("DROP TRIGGER fail_sibling_resolution")
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn corrected_rejection_feedback_belongs_only_to_the_selected_request() {
    let (_directory, store, runtime, source) = running().await;
    let first = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("corrected", "public"),
        )
        .await
        .unwrap();
    let sibling = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("declined-peer", "different"),
        )
        .await
        .unwrap();
    let mut host = Host::new(runtime.clone());
    let mut wire = json!({"method":"product_permission_reply","params":{"source":source,"response":{
        "request_id":first.id,"input_hash":first.input_hash,"authority_revision":first.authority_revision,
        "reply":"reject","message":"先检查配置，再修改。\nKeep the existing data."
    }}});
    let rejected = host
        .dispatch(serde_json::from_value(wire.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(rejected["state"], "denied");
    assert_eq!(rejected["reason"], "user_corrected");
    assert_eq!(
        rejected["feedback"],
        "先检查配置，再修改。\nKeep the existing data."
    );
    assert_eq!(
        host.dispatch(serde_json::from_value(wire.clone()).unwrap())
            .await
            .unwrap(),
        rejected
    );
    wire["params"]["response"]["message"] = json!("different correction");
    assert!(host
        .dispatch(serde_json::from_value(wire).unwrap())
        .await
        .is_err());
    let persisted = serde_json::to_value(
        runtime
            .product_permission_status(&runtime.controller(), &source, first.id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted, rejected);
    let peer = serde_json::to_value(
        runtime
            .product_permission_status(&runtime.controller(), &source, sibling.id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(peer["state"], "denied");
    assert_eq!(peer["reason"], "user_rejected");
    assert!(peer.get("feedback").is_none());
    let events = store.events("s", 0, 1000).await.unwrap();
    let replies = events
        .iter()
        .filter(|event| event.kind == "product.permission.resolved")
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0].data["feedback"], rejected["feedback"]);
    assert!(replies[1].data.get("feedback").is_none());
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn reply_feedback_bounds_and_empty_message_match_the_host_contract() {
    use miao_engine::product_permission_request::State;
    let (_directory, store, runtime, source) = running().await;
    let pending = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("feedback-bounds", "public"),
        )
        .await
        .unwrap();
    let mut host = Host::new(runtime.clone());
    let mut wire = json!({"method":"product_permission_reply","params":{"source":source,"response":{
        "request_id":pending.id,"input_hash":pending.input_hash,"authority_revision":pending.authority_revision,
        "reply":"reject","message":""
    }}});
    for message in ["x".repeat(4097), "invalid\0feedback".into()] {
        wire["params"]["response"]["message"] = json!(message);
        assert!(host
            .dispatch(serde_json::from_value(wire.clone()).unwrap())
            .await
            .is_err());
        assert_eq!(
            runtime
                .product_permission_status(&runtime.controller(), &source, pending.id.clone())
                .await
                .unwrap()
                .state,
            State::Pending
        );
    }
    assert!(!store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "product.permission.resolved"));
    wire["params"]["response"]["message"] = json!("");
    let rejected = host
        .dispatch(serde_json::from_value(wire.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(rejected["reason"], "user_rejected");
    assert!(rejected.get("feedback").is_none());
    wire["params"]["response"]
        .as_object_mut()
        .unwrap()
        .remove("message");
    assert_eq!(
        host.dispatch(serde_json::from_value(wire).unwrap())
            .await
            .unwrap(),
        rejected
    );
    let once = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("ignored-message", "public"),
        )
        .await
        .unwrap();
    let ignored = json!({"method":"product_permission_reply","params":{"source":source,"response":{
        "request_id":once.id,"input_hash":once.input_hash,"authority_revision":once.authority_revision,
        "reply":"once","message":"ignored for non-reject replies"
    }}});
    let allowed = host
        .dispatch(serde_json::from_value(ignored).unwrap())
        .await
        .unwrap();
    assert_eq!(allowed["state"], "allowed");
    assert!(allowed.get("feedback").is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn host_auto_mode_uses_the_captured_agent_and_never_lifts_denies_or_stdin() {
    use miao_engine::product_permission_request::State;
    let (_directory, _store, runtime, source, mut receive) = running_with_mode(Some("auto")).await;
    tokio::spawn(async move { while receive.recv().await.is_some() {} });
    // This mode change belongs to the next turn, not the active callback.
    runtime.set_agent("s", serde_json::from_value(json!({"name":"later","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[{"action":"*","resource":"*","effect":"deny"}]}})).unwrap()).await.unwrap();
    let root = runtime.store().location("s").await.unwrap().unwrap();
    let mut input = assertion("safe-edit", &format!("{root}/src/file.rs"));
    input.facts.actions = vec!["edit".into()];
    // The fixture's wildcard allows edit; use explicit to skip that wildcard
    // and exercise the auto classifier on an actual ask.
    input.facts.explicit = true;
    let allowed = runtime
        .admit_product_permission(&runtime.controller(), &source, input.clone())
        .await
        .unwrap();
    assert_eq!(allowed.state, State::Allowed);
    assert_eq!(allowed.reason.as_deref(), Some("auto_allowed"));
    input.request_id = "protected-edit".into();
    input.facts.resources = vec![format!("{root}/.env")];
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, input)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    let mut bash = assertion("readonly-bash", "git status");
    bash.facts.actions = vec!["bash".into()];
    bash.facts.explicit = true;
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, bash.clone())
            .await
            .unwrap()
            .state,
        if cfg!(windows) {
            State::Pending
        } else {
            State::Allowed
        }
    );
    bash.request_id = "stdin-bash".into();
    bash.metadata = Some(json!({"stdin":null}));
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, bash)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        runtime
            .admit_product_permission(
                &runtime.controller(),
                &source,
                assertion("deny-still-wins", "secret")
            )
            .await
            .unwrap()
            .state,
        State::Denied
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn changing_to_auto_does_not_retroactively_change_a_manual_source() {
    use miao_engine::product_permission_request::State;
    let (_directory, _store, runtime, source) = running().await;
    runtime.set_agent("s", serde_json::from_value(json!({"name":"later-auto","permission_mode":"auto","ordered_permissions":{"semantics":"ordered-wildcard-v1","rules":[]}})).unwrap()).await.unwrap();
    let root = runtime.store().location("s").await.unwrap().unwrap();
    let mut input = assertion("manual-edit", &format!("{root}/src/file.rs"));
    input.facts.actions = vec!["edit".into()];
    input.facts.explicit = true;
    assert_eq!(
        runtime
            .admit_product_permission(&runtime.controller(), &source, input)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn host_path_context_is_location_bound_and_cannot_change_a_live_source() {
    use miao_engine::product::HostContext;
    let (directory, store, runtime, source) = running().await;
    let root = store.location("s").await.unwrap().unwrap();
    let before = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("before-context", "public"),
        )
        .await
        .unwrap();
    assert!(runtime
        .set_product_context(HostContext {
            directory: directory.path().to_string_lossy().into(),
            cwd: None
        })
        .await
        .is_err());
    assert!(runtime
        .set_product_context(HostContext {
            directory: root.clone(),
            cwd: Some("relative".into())
        })
        .await
        .is_err());
    runtime
        .set_product_context(HostContext {
            directory: root,
            cwd: None,
        })
        .await
        .unwrap();
    let after = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("after-context", "public"),
        )
        .await
        .unwrap();
    assert_eq!(before.authority_revision, after.authority_revision);
    runtime.shutdown().await;
}

#[tokio::test]
async fn withdrawing_one_assertion_preserves_siblings_and_cannot_be_answered_later() {
    use miao_engine::product_permission_request::{Reply, State};
    let (_directory, store, runtime, source) = running().await;
    let first = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("withdraw-first", "public"),
        )
        .await
        .unwrap();
    let sibling = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("withdraw-sibling", "other"),
        )
        .await
        .unwrap();
    let mut host = Host::new(runtime.clone());
    let cancel = json!({"method":"product_permission_cancel","params":{"source":source,"request_id":first.id}});
    let cancelled = host
        .dispatch(serde_json::from_value(cancel.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(cancelled["reason"], "caller_cancelled");
    assert_eq!(cancelled["reply"], Value::Null);
    assert_eq!(
        host.dispatch(serde_json::from_value(cancel).unwrap())
            .await
            .unwrap(),
        cancelled
    );
    assert_eq!(
        runtime
            .pending_product_permissions(&runtime.controller(), "s".into())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, sibling.id)
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert!(runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&first, Reply::Always)
        )
        .await
        .is_err());
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    let events = store.events("s", 0, 1000).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "product.permission.resolved")
            .count(),
        1
    );
    let allowed = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("withdraw-resolved", "public"),
        )
        .await
        .unwrap();
    runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&allowed, Reply::Once),
        )
        .await
        .unwrap();
    let result = host.dispatch(serde_json::from_value(json!({"method":"product_permission_cancel","params":{"source":source,"request_id":allowed.id}})).unwrap()).await.unwrap();
    assert_eq!(result["state"], "allowed");
    let mut foreign = source.clone();
    foreign.message_seq += 1;
    assert!(host.dispatch(serde_json::from_value(json!({"method":"product_permission_cancel","params":{"source":foreign,"request_id":first.id}})).unwrap()).await.is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn withdrawing_an_assertion_rolls_back_if_its_resolution_event_cannot_commit() {
    use miao_engine::product_permission_request::State;
    let (_directory, store, runtime, source) = running().await;
    let pending = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("withdraw-atomic", "public"),
        )
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_permission_withdraw BEFORE INSERT ON engine_event WHEN NEW.kind='product.permission.resolved' BEGIN SELECT RAISE(ABORT,'fixture withdrawal fault'); END;").unwrap();
    let mut host = Host::new(runtime.clone());
    let cancel = json!({"method":"product_permission_cancel","params":{"source":source,"request_id":pending.id}});
    assert!(host
        .dispatch(serde_json::from_value(cancel.clone()).unwrap())
        .await
        .is_err());
    assert_eq!(
        runtime
            .product_permission_status(&runtime.controller(), &source, pending.id.clone())
            .await
            .unwrap()
            .state,
        State::Pending
    );
    assert_eq!(
        runtime
            .pending_product_permissions(&runtime.controller(), "s".into())
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(!store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "product.permission.resolved"));
    connection
        .execute_batch("DROP TRIGGER fail_permission_withdraw")
        .unwrap();
    assert_eq!(
        host.dispatch(serde_json::from_value(cancel).unwrap())
            .await
            .unwrap()["state"],
        "cancelled"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn policy_denial_keeps_the_actual_native_outcome_when_later_rules_change() {
    let (_directory, store, runtime, source) = running().await;
    let original = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("secret"))
        .await
        .unwrap();
    let denied = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("denial-admit", "secret"),
        )
        .await
        .unwrap();
    let wire = serde_json::to_value(&denied).unwrap();
    assert_eq!(
        wire["denial"]["rules"],
        serde_json::to_value(&original.rules).unwrap()
    );
    assert_eq!(wire["denial"]["effect"], "deny");
    assert_eq!(
        wire["denial"]["authority_revision"],
        wire["authority_revision"]
    );
    let workspace = store.location("s").await.unwrap().unwrap();
    store
        .project_saved_rules(
            workspace,
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "other".into(),
                effect: Decision::Allow,
            }],
        )
        .await
        .unwrap();
    let later = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("denial-later", "secret"),
        )
        .await
        .unwrap();
    assert_ne!(denied.authority_revision, later.authority_revision);
    let historical = runtime
        .product_permission_status(&runtime.controller(), &source, denied.id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(historical).unwrap()["denial"],
        wire["denial"]
    );
    // Rows written before this additive diagnostic field still decode honestly.
    let mut legacy = wire.clone();
    legacy.as_object_mut().unwrap().remove("denial");
    let legacy: miao_engine::product_permission_request::Record =
        serde_json::from_value(legacy).unwrap();
    assert!(serde_json::to_value(legacy)
        .unwrap()
        .get("denial")
        .is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn reply_time_policy_denial_records_the_recheck_without_changing_the_reply_binding() {
    use miao_engine::product_permission_request::Reply;
    let (_directory, store, runtime, source) = running().await;
    let pending = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("denial-reply", "public"),
        )
        .await
        .unwrap();
    assert!(serde_json::to_value(&pending)
        .unwrap()
        .get("denial")
        .is_none());
    let workspace = store.location("s").await.unwrap().unwrap();
    store
        .project_saved_rules(
            workspace,
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "public".into(),
                effect: Decision::Deny,
            }],
        )
        .await
        .unwrap();
    let recheck = runtime
        .evaluate_product_permission(&runtime.controller(), &source, request("public"))
        .await
        .unwrap();
    let denied = runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&pending, Reply::Always),
        )
        .await
        .unwrap();
    let wire = serde_json::to_value(&denied).unwrap();
    assert_eq!(wire["reason"], "policy_denied");
    assert_eq!(
        wire["denial"]["rules"],
        serde_json::to_value(recheck.rules).unwrap()
    );
    assert_eq!(wire["denial"]["effect"], "deny");
    let current = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("denial-current", "public"),
        )
        .await
        .unwrap();
    assert_eq!(
        wire["denial"]["authority_revision"],
        current.authority_revision
    );
    assert_ne!(
        wire["denial"]["authority_revision"],
        wire["authority_revision"]
    );
    assert_eq!(wire["authority_revision"], pending.authority_revision);
    assert_eq!(
        serde_json::to_value(
            runtime
                .reply_product_permission(
                    &runtime.controller(),
                    &source,
                    response(&pending, Reply::Always)
                )
                .await
                .unwrap()
        )
        .unwrap(),
        wire
    );
    assert!(runtime
        .permission_patterns(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    let event = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "product.permission.resolved" && event.data["id"] == denied.id)
        .unwrap();
    assert_eq!(event.data["denial"], wire["denial"]);
    let rejected = runtime
        .admit_product_permission(
            &runtime.controller(),
            &source,
            assertion("denial-user", "other"),
        )
        .await
        .unwrap();
    let rejected = runtime
        .reply_product_permission(
            &runtime.controller(),
            &source,
            response(&rejected, Reply::Reject),
        )
        .await
        .unwrap();
    assert_eq!(rejected.reason.as_deref(), Some("user_rejected"));
    assert!(serde_json::to_value(rejected)
        .unwrap()
        .get("denial")
        .is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn one_time_saved_rule_handoff_is_controller_bound_live_and_cannot_resurrect_revocations() {
    let (_directory, store, runtime, source) = running().await;
    let (_other_directory, _other_store, other, _other_source) = running().await;
    let mut host = Host::new(runtime.clone());
    assert_eq!(
        host.dispatch(
            serde_json::from_value(json!({"method":"permission_saved_migration"})).unwrap()
        )
        .await
        .unwrap(),
        Value::Null
    );
    let initial = host
        .dispatch(serde_json::from_value(json!({"method":"permission_import_snapshot"})).unwrap())
        .await
        .unwrap();
    assert_eq!(initial["cursor"], 0);
    assert_eq!(initial["migration"], Value::Null);
    let command = json!({"method":"permission_saved_migrate","params":{
        "project":"legacy-project", "rules":[{"id":"legacy-row", "rule":{"action":"read","resource":"public","effect":"allow"}}]
    }});
    let native = runtime
        .put_permission_pattern(
            &runtime.controller(),
            permission_rules::Rule {
                action: "read".into(),
                resource: "native/**".into(),
                effect: Decision::Allow,
            },
        )
        .await
        .unwrap();
    let receipt = host
        .dispatch(serde_json::from_value(command.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(receipt["project"], "legacy-project");
    assert_eq!(receipt["imported"], 1);
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("public"))
            .await
            .unwrap()
            .effect,
        Decision::Allow
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("secret"))
            .await
            .unwrap()
            .effect,
        Decision::Deny
    );
    assert_eq!(
        host.dispatch(
            serde_json::from_value(json!({"method":"permission_saved_imported"})).unwrap()
        )
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        1
    );
    assert!(runtime
        .saved_permission_migration(&other.controller())
        .await
        .is_err());
    assert!(runtime
        .imported_permissions(&other.controller())
        .await
        .is_err());
    assert!(runtime
        .remove_imported_permission(&other.controller(), "legacy-row".into())
        .await
        .is_err());
    assert!(runtime
        .migrate_saved_permissions(
            &other.controller(),
            miao_engine::permission_migration::Input {
                project: "legacy-project".into(),
                rules: vec![]
            }
        )
        .await
        .is_err());
    for expected in [true, false] {
        assert_eq!(
            host.dispatch(
                serde_json::from_value(
                    json!({"method":"permission_saved_remove","params":{"id":"legacy-row"}})
                )
                .unwrap()
            )
            .await
            .unwrap(),
            json!({"removed":expected})
        );
    }
    assert_eq!(
        host.dispatch(serde_json::from_value(command.clone()).unwrap())
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        runtime
            .evaluate_product_permission(&runtime.controller(), &source, request("public"))
            .await
            .unwrap()
            .effect,
        Decision::Ask
    );
    assert_eq!(
        runtime
            .permission_patterns(&runtime.controller())
            .await
            .unwrap(),
        vec![native]
    );
    assert!(runtime
        .imported_permissions(&runtime.controller())
        .await
        .unwrap()
        .is_empty());
    let workspace = store.location("s").await.unwrap().unwrap();
    assert!(store
        .project_saved_rules(
            workspace,
            vec![permission_rules::Rule {
                action: "read".into(),
                resource: "public".into(),
                effect: Decision::Allow
            }]
        )
        .await
        .is_err());
    let snapshot = host
        .dispatch(serde_json::from_value(json!({"method":"permission_import_snapshot"})).unwrap())
        .await
        .unwrap();
    assert!(snapshot["rules"].as_array().unwrap().is_empty());
    let changes = host
        .dispatch(
            serde_json::from_value(
                json!({"method":"permission_import_changes","params":{"after":0,"limit":256}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changes["changes"].as_array().unwrap().len(), 2);
    assert_eq!(changes["changes"][0]["change"]["kind"], "migrated");
    assert_eq!(changes["changes"][1]["change"]["kind"], "removed");
    assert_eq!(snapshot["cursor"], changes["cursor"]);
    assert!(runtime
        .permission_import_snapshot(&other.controller())
        .await
        .is_err());
    assert!(runtime
        .permission_import_changes(
            &other.controller(),
            miao_engine::permission_import_changes::Input { after: 0, limit: 1 }
        )
        .await
        .is_err());
    let mut foreign_scope = command;
    foreign_scope["params"]["workspace"] = json!("/foreign");
    assert!(serde_json::from_value::<miao_engine::protocol::Command>(foreign_scope).is_err());
    runtime.shutdown().await;
    other.shutdown().await;
}
