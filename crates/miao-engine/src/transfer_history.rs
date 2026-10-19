//! Pure semantic-context preparation. Call this before freezing a source or
//! mutating a destination; unsupported histories must fail while still editable.
use crate::{
    protocol::{Attachment, Error, Message},
    provider::Identity,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedMessage {
    pub source_message_id: String,
    pub message: Message,
}

pub fn prepare(
    serialized: &str,
    target: &Identity,
    route_id: Option<&str>,
) -> Result<Vec<PreparedMessage>, Error> {
    if serialized.len() > crate::transfer::MAX_BYTES {
        return Err(invalid("bundle size limit"));
    }
    let source: Value = serde_json::from_str(serialized)?;
    if source["format"] != "miao.session.transfer.v1" {
        return Err(invalid("bundle format"));
    }
    let artifacts = artifacts(&source)?;
    let timeline = source["timeline"]
        .as_array()
        .ok_or_else(|| invalid("canonical timeline"))?;
    let mut by_id = HashMap::new();
    for message in timeline {
        if by_id.insert(text(message, "id")?, message).is_some() {
            return Err(invalid("duplicate message identity"));
        }
    }
    let selected = source["context_ids"]
        .as_array()
        .ok_or_else(|| invalid("selected context"))?;
    let mut seen = HashSet::new();
    let mut calls = HashSet::new();
    let mut output = Vec::new();
    for id in selected {
        let id = id.as_str().ok_or_else(|| invalid("context identity"))?;
        if !seen.insert(id) {
            return Err(invalid("duplicate context identity"));
        }
        let message = by_id
            .get(id)
            .ok_or_else(|| invalid("unknown context identity"))?;
        let mut push = |role: &str, content: Vec<Value>| {
            if !content.is_empty() {
                output.push(PreparedMessage {
                    source_message_id: id.into(),
                    message: Message {
                        role: role.into(),
                        content: Value::Array(content),
                        checkpoint: None,
                        recorded_at_ms: message["time"]["created"].as_u64(),
                    },
                });
            }
        };
        match text(message, "type")? {
            "user" => {
                if message["commandState"]
                    .as_str()
                    .is_some_and(|state| state != "completed")
                {
                    return Err(invalid("unfinished command"));
                }
                let mut content = vec![json!({"type":"text","text":text(message,"text")?})];
                if let Some(files) = message["files"].as_array() {
                    for file in files {
                        content.push(media(file, &artifacts)?);
                    }
                }
                if let Some(agents) = message["agents"].as_array() {
                    for agent in agents {
                        content.push(json!({"type":"agent_reference","name":text(agent,"name")?}));
                    }
                }
                push("user", content);
            }
            "synthetic" | "system" => push(
                "user",
                vec![json!({"type":"text","text":text(message,"text")?})],
            ),
            "compaction" => push(
                "user",
                vec![
                    json!({"type":"text","text":format!("<history-summary>\n{}\n{}\n</history-summary>",text(message,"summary")?,text(message,"recent")?)}),
                ],
            ),
            "shell" => push(
                "user",
                vec![
                    json!({"type":"text","text":format!("[Operator shell: {}]\n{}",text(message,"command")?,text(message,"output")?)}),
                ],
            ),
            "assistant" => {
                if message["time"]["completed"].is_null() {
                    return Err(invalid("unfinished assistant"));
                }
                let parts = message["content"]
                    .as_array()
                    .ok_or_else(|| invalid("assistant content"))?;
                let mut content = Vec::new();
                let mut results = Vec::new();
                let mut lifted = Vec::new();
                for part in parts {
                    match text(part, "type")? {
                        "text" => content.push(json!({"type":"text","text":text(part,"text")?})),
                        "reasoning" => content.push(reasoning(part, message, target, route_id)?),
                        "tool" => {
                            if part["provider"]["executed"] == true {
                                return Err(invalid(
                                    "provider-executed tool requires an explicit replay mapping",
                                ));
                            }
                            let call = text(part, "id")?;
                            if !calls.insert(call.to_owned()) {
                                return Err(invalid("duplicate tool correlation"));
                            }
                            let state = &part["state"];
                            if !matches!(state["status"].as_str(), Some("completed" | "error")) {
                                return Err(invalid("unfinished tool"));
                            }
                            if !state["input"].is_object() {
                                return Err(invalid("tool input"));
                            }
                            content.push(json!({"type":"tool_use","id":call,"name":text(part,"name")?,"input":state["input"]}));
                            let pruned = !part["time"]["pruned"].is_null();
                            let mut blocks = Vec::new();
                            if !pruned {
                                for item in state["content"]
                                    .as_array()
                                    .ok_or_else(|| invalid("tool output"))?
                                {
                                    match text(item, "type")? {
                                        "text" => blocks.push(text(item, "text")?.to_owned()),
                                        "file" => lifted.push(media(item, &artifacts)?),
                                        _ => return Err(invalid("unsupported tool content")),
                                    }
                                }
                                if let Some(files) = state["attachments"].as_array() {
                                    for file in files {
                                        lifted.push(media(file, &artifacts)?);
                                    }
                                }
                            }
                            let value = if pruned {
                                "[Old tool result content cleared]".into()
                            } else {
                                serde_json::to_string(
                                    &json!({"content":blocks,"structured":state["structured"],"result":state["result"],"error":state["error"]}),
                                )?
                            };
                            results.push(json!({"type":"tool_result","tool_use_id":call,"content":value,"is_error":state["status"]=="error"}));
                        }
                        _ => return Err(invalid("unsupported assistant content")),
                    }
                }
                push("assistant", content);
                results.extend(lifted);
                push("user", results);
            }
            "agent-switched" | "model-switched" => {}
            _ => return Err(invalid("unsupported selected message")),
        }
    }
    Ok(output)
}

fn artifacts(source: &Value) -> Result<HashMap<String, String>, Error> {
    let mut artifacts = HashMap::new();
    for artifact in source["artifacts"]
        .as_array()
        .ok_or_else(|| invalid("artifact inventory"))?
    {
        let hash = text(artifact, "hash")?;
        let encoded = text(artifact, "base64")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| invalid("artifact encoding"))?;
        if format!("{:x}", Sha256::digest(bytes)) != hash
            || artifacts.insert(hash.into(), encoded.into()).is_some()
        {
            return Err(invalid("artifact digest or duplicate artifact"));
        }
    }
    Ok(artifacts)
}

fn media(file: &Value, artifacts: &HashMap<String, String>) -> Result<Value, Error> {
    let uri = text(file, "uri")?;
    let mime = text(file, "mime")?;
    let data = if let Some(hash) = uri.strip_prefix("blob://") {
        artifacts
            .get(hash)
            .ok_or_else(|| invalid("missing attachment"))?
            .clone()
    } else if let Some(data) = uri.strip_prefix(&format!("data:{mime};base64,")) {
        data.into()
    } else {
        return Err(invalid("attachment is not immutable content"));
    };
    let attachment = Attachment {
        mime: mime.into(),
        data,
        metadata: Some(
            ["name", "description"]
                .into_iter()
                .filter_map(|key| file.get(key).map(|value| (key.into(), value.clone())))
                .collect(),
        ),
    };
    attachment.validate()?;
    Ok(attachment.part())
}

fn reasoning(
    part: &Value,
    message: &Value,
    target: &Identity,
    route_id: Option<&str>,
) -> Result<Value, Error> {
    let value = text(part, "text")?;
    let metadata = &part["providerMetadata"];
    if let Some(encrypted) = metadata["openai"]["reasoningEncryptedContent"].as_str() {
        if target.protocol != "openai-responses" || message["model"]["id"] != target.model {
            return Err(invalid(
                "encrypted reasoning is bound to its original model/protocol",
            ));
        }
        return Ok(
            json!({"type":"provider_opaque","provider":"openai-responses","model":target.model,"_miao_route_id":route_id,
            "item":{"type":"reasoning","id":text(&metadata["openai"],"itemId")?,"encrypted_content":encrypted,"summary":[{"type":"summary_text","text":value}]}}),
        );
    }
    let signature = metadata["anthropic"]["signature"]
        .as_str()
        .or_else(|| metadata["bedrock"]["signature"].as_str());
    if signature.is_some()
        && (message["model"]["id"] != target.model
            || (metadata["anthropic"]["signature"].is_string()
                && target.protocol != "anthropic-messages")
            || (metadata["bedrock"]["signature"].is_string()
                && target.protocol != "bedrock-converse"))
    {
        return Err(invalid(
            "signed reasoning requires its original model/protocol",
        ));
    }
    if let Some(signature) = signature {
        return Ok(json!({"type":"reasoning","text":value,"signature":signature}));
    }
    if metadata.is_object() && metadata.as_object().is_some_and(|value| !value.is_empty()) {
        return Err(invalid("reasoning metadata has no native replay mapping"));
    }
    Ok(json!({"type":"reasoning","text":value}))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value[key].as_str().ok_or_else(|| invalid(key))
}
fn invalid(detail: &str) -> Error {
    Error::Invalid(format!("unsupported semantic transfer: {detail}"))
}
