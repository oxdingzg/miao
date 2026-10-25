use miao_engine::{context_trigger::prune_history, protocol::Message};
use serde_json::json;

#[test]
fn pruning_never_expands_output_or_underflows_its_savings() {
    for (budget, content) in [
        (1, "important evidence".to_owned()),
        (1000, "x".repeat(1001)),
    ] {
        let mut messages = vec![Message {
            role: "user".into(),
            content: json!([{"type":"tool_result","tool_use_id":"call","content":content}]),
            checkpoint: None,
            recorded_at_ms: None,
        }];
        let original = messages[0].content.clone();
        assert_eq!(prune_history(&mut messages, budget, 0, None), (0, 0));
        assert_eq!(messages[0].content, original);
    }
}
