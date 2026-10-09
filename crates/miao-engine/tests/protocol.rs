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
