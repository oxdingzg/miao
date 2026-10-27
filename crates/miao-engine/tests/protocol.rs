use miao_engine::events::{Lifecycle, PROTOCOL_VERSION};
use serde_json::json;

/// The M0 vocabulary is a public surface: pin the names, order and wire form.
/// A rename or removal here is a deliberate protocol break, not a refactor.
#[test]
fn lifecycle_vocabulary_is_frozen() {
    let names = Lifecycle::ALL.iter().map(|e| e.name()).collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "session_start",
            "user_prompt_submit",
            "pre_tool_use",
            "post_tool_use",
            "permission_request",
            "permission_denied",
            "subagent_start",
            "subagent_stop",
            "pre_compact",
            "post_compact",
            "stop",
            "stop_failure",
            "instructions_loaded",
        ]
    );
    for event in Lifecycle::ALL {
        assert_eq!(
            event.name(),
            serde_json::from_value::<Lifecycle>(json!(event.name()))
                .unwrap()
                .name()
        );
        assert_eq!(serde_json::to_value(event).unwrap(), json!(event.name()));
        assert!(
            !event.payload_fields().is_empty(),
            "{} has no fields",
            event.name()
        );
    }
    assert!(Lifecycle::PreToolUse.tool_scoped());
    assert!(Lifecycle::PostToolUse.tool_scoped());
    assert!(!Lifecycle::SessionStart.tool_scoped());
    assert_eq!(PROTOCOL_VERSION, "engine-stdio-0");
}

#[test]
fn permission_evaluate_parses_from_the_wire_and_decides() {
    use miao_engine::permission::Decision;
    use miao_engine::permission_rules::{self, Rule};
    use miao_engine::protocol::Command;

    let wire = serde_json::json!({
        "method": "permission_evaluate",
        "params": {
            "request": {
                "actions": ["bash"],
                "resources": ["git push origin"],
                "configured": [{"action": "bash", "resource": "git push *", "effect": "deny"}],
                "saved": [{"action": "bash", "resource": "git *", "effect": "allow"}]
            }
        }
    });
    let Command::PermissionEvaluate { request } = serde_json::from_value(wire).unwrap() else {
        panic!("wrong variant");
    };
    let outcome = permission_rules::evaluate(&request).unwrap();
    assert_eq!(outcome.effect, Decision::Deny);
    // A configured deny is reported before saved approvals join.
    assert_eq!(
        outcome.rules,
        vec![Rule {
            action: "bash".into(),
            resource: "git push *".into(),
            effect: Decision::Deny,
        }]
    );
    assert!(!outcome.authority_revision.is_empty());

    // Degenerate queries parse, and the pure evaluator keeps the TypeScript
    // vacuous semantics; Host::dispatch refuses them before calling it.
    let Command::PermissionEvaluate { request } = serde_json::from_value(serde_json::json!({
        "method": "permission_evaluate",
        "params": {"request": {"actions": ["read"], "resources": []}}
    }))
    .unwrap() else {
        panic!("wrong variant");
    };
    assert!(request.resources.is_empty());
    assert_eq!(request.configured, None);
    assert!(permission_rules::evaluate(&request).is_ok());
}
