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

async fn running() -> (tempfile::TempDir, Store, Runtime, Source) {
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
            serde_json::from_value(json!({"name":"fixture","ordered_permissions":{
                "semantics":"ordered-wildcard-v1","rules":[
                    {"action":"*","resource":"*","effect":"allow"},
                    {"action":"read","resource":"*","effect":"ask"},
                    {"action":"read","resource":"secret","effect":"deny"}
                ]
            }}))
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
    // Keep the receiver alive while the pending call waits; cancellation may
    // send its notice without requiring a cooperative host response.
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
