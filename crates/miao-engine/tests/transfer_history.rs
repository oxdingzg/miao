use base64::Engine;
use miao_engine::{provider::Identity, transfer_history::prepare};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn identity(protocol: &str) -> Identity {
    Identity {
        protocol: protocol.into(),
        model: "fixture".into(),
    }
}
fn source() -> Value {
    let bytes = b"original attachment";
    let hash = format!("{:x}", Sha256::digest(bytes));
    json!({"format":"miao.session.transfer.v1", "artifacts":[{"hash":hash,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}],
    "context_ids":["msg_user","msg_assistant"],
    "timeline":[
        {"id":"msg_old","type":"unsupported-old-state"},
        {"id":"msg_user","type":"user","text":"read attached","time":{"created":123},"files":[{"uri":format!("blob://{hash}"),"mime":"text/plain","name":"original.txt"}]},
        {"id":"msg_assistant","type":"assistant","model":{"id":"fixture"},"time":{"created":456,"completed":789},"content":[
            {"type":"reasoning","text":"thinking"},
            {"type":"tool","id":"original-call","name":"read","time":{"created":456},
                "state":{"status":"completed","input":{"path":"original.txt"},"content":[{"type":"text","text":"tool output"}],"structured":{"count":1},"result":{"exact":"value"}}},
            {"type":"text","text":"done"}
        ]}
    ]})
}

#[test]
fn preparation_preserves_selected_messages_media_times_and_tool_correlation() {
    let source = source();
    let prepared = prepare(&source.to_string(), &identity("openai-chat"), None).unwrap();
    assert_eq!(prepared.len(), 3);
    assert_eq!(prepared[0].source_message_id, "msg_user");
    assert_eq!(prepared[0].message.recorded_at_ms, Some(123));
    assert_eq!(prepared[0].message.content[1]["mime"], "text/plain");
    assert_eq!(
        prepared[0].message.content[1]["data"],
        source["artifacts"][0]["base64"]
    );
    assert_eq!(prepared[1].source_message_id, "msg_assistant");
    assert_eq!(prepared[1].message.content[1]["id"], "original-call");
    assert_eq!(
        prepared[1].message.content[1]["input"],
        json!({"path":"original.txt"})
    );
    assert_eq!(prepared[2].source_message_id, "msg_assistant");
    assert_eq!(
        prepared[2].message.content[0]["tool_use_id"],
        "original-call"
    );
    let result: Value =
        serde_json::from_str(prepared[2].message.content[0]["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["structured"], json!({"count":1}));
    assert_eq!(result["result"], json!({"exact":"value"}));
    assert_eq!(result["content"], json!(["tool output"]));
}

#[test]
fn opaque_reasoning_is_model_protocol_and_route_bound() {
    let mut source = source();
    source["timeline"][2]["content"][0]["providerMetadata"] =
        json!({"openai":{"itemId":"original-reasoning","reasoningEncryptedContent":"encrypted"}});
    let prepared = prepare(
        &source.to_string(),
        &identity("openai-responses"),
        Some("original-route"),
    )
    .unwrap();
    let opaque = &prepared[1].message.content[0];
    assert_eq!(opaque["type"], "provider_opaque");
    assert_eq!(opaque["_miao_route_id"], "original-route");
    assert_eq!(opaque["item"]["id"], "original-reasoning");
    assert_eq!(opaque["item"]["encrypted_content"], "encrypted");
    assert!(prepare(&source.to_string(), &identity("openai-chat"), None).is_err());
    let other = Identity {
        protocol: "openai-responses".into(),
        model: "different-model".into(),
    };
    assert!(prepare(&source.to_string(), &other, None).is_err());
}

#[test]
fn unsupported_selected_work_and_corrupt_artifacts_fail_before_any_store_mutation() {
    let mut corrupt = source();
    corrupt["artifacts"][0]["base64"] = json!("Y29ycnVwdA==");
    assert!(prepare(&corrupt.to_string(), &identity("openai-chat"), None).is_err());
    let mut missing = source();
    missing["artifacts"] = json!([]);
    assert!(prepare(&missing.to_string(), &identity("openai-chat"), None).is_err());
    let mut pending = source();
    pending["timeline"][2]["content"][1]["state"]["status"] = json!("running");
    assert!(prepare(&pending.to_string(), &identity("openai-chat"), None).is_err());
    let mut hosted = source();
    hosted["timeline"][2]["content"][1]["provider"] = json!({"executed":true});
    assert!(prepare(&hosted.to_string(), &identity("openai-chat"), None).is_err());
    let mut command = source();
    command["timeline"][1]["commandState"] = json!("running");
    assert!(prepare(&command.to_string(), &identity("openai-chat"), None).is_err());
    let mut unknown = source();
    unknown["context_ids"] = json!(["msg_old"]);
    assert!(prepare(&unknown.to_string(), &identity("openai-chat"), None).is_err());
}
