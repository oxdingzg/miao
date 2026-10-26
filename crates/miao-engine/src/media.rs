use crate::{protocol::ModelRequest, provider::ProviderError};
use base64::Engine;
use serde_json::{json, Value};

/// Largest attached text inlined into a request, in characters. Same limit as
/// the TS runner's `TEXT_LIMIT`; the tail is replaced by a count so one
/// oversized attachment cannot dominate the prompt.
const TEXT_LIMIT: usize = 100_000;

pub(crate) fn validate_modalities(input: &[String]) -> Result<(), ProviderError> {
    if input.len() > 32
        || input
            .iter()
            .any(|item| item.is_empty() || item.len() > 128 || item.chars().any(char::is_control))
    {
        return Err(ProviderError::Stream(
            "invalid host input modalities".into(),
        ));
    }
    Ok(())
}

/// Normalize a request copy, leaving the durable attachment bytes unchanged.
/// An absent/empty host declaration is unknown, matching product behavior.
pub(crate) fn normalize(
    mut request: ModelRequest,
    protocol: &str,
    input: &[String],
) -> Result<ModelRequest, ProviderError> {
    for message in &mut request.messages {
        if let Some(parts) = message.content.as_array_mut() {
            normalize_parts(parts, protocol, input)?;
        }
    }
    Ok(request)
}

fn normalize_parts(
    parts: &mut [Value],
    protocol: &str,
    input: &[String],
) -> Result<(), ProviderError> {
    for part in parts {
        // Catalog identity is durable presentation metadata, not provider input.
        if let Some(object) = part.as_object_mut() {
            object.remove("_miao_mcp");
        }
        if part["type"] == "command_reference" {
            let name = part["name"]
                .as_str()
                .ok_or_else(|| ProviderError::Stream("invalid command reference".into()))?;
            let arguments = part["arguments"].as_str().unwrap_or("");
            *part =
                json!({"type":"text","text":format!("[Operator command: /{name} {arguments}]")});
            continue;
        }

        if part["type"] == "agent_reference" {
            let name = part["name"]
                .as_str()
                .filter(|name| {
                    !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control)
                })
                .ok_or_else(|| ProviderError::Stream("invalid named agent reference".into()))?;
            *part = json!({"type":"text","text":format!("[Agent reference: @{name}. Delegate named work with task.agent={}.]",serde_json::to_string(name).expect("serializable agent name"))});
            continue;
        }
        if part["type"] == "tool_result" {
            if let Some(content) = part["content"].as_array_mut() {
                normalize_parts(content, protocol, input)?;
            }
            continue;
        }
        let image = part["type"] == "image";
        if !image && part["type"] != "file" {
            continue;
        }
        let mime = part["mime"]
            .as_str()
            .ok_or_else(|| ProviderError::Stream("invalid media type".into()))?;
        let name = part["metadata"]["name"].as_str().unwrap_or("attachment");
        if image && !input.is_empty() && !input.iter().any(|item| item.starts_with("image")) {
            *part = json!({"type":"text","text":format!("[image attachment omitted: model does not support image input: {name}]")});
            continue;
        }
        if mime.starts_with("text/") {
            let data = part["data"]
                .as_str()
                .ok_or_else(|| ProviderError::Stream("invalid text attachment".into()))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| ProviderError::Stream("invalid text attachment base64".into()))?;
            let text = String::from_utf8(bytes)
                .map_err(|_| ProviderError::Stream("text attachment must be UTF-8".into()))?;
            let block = file_block(part, &text);
            *part = json!({"type":"text","text":block});
            continue;
        }
        if mime == "application/pdf"
            && (protocol == "openai-chat"
                || (!input.is_empty()
                    && !input
                        .iter()
                        .any(|item| item == "pdf" || item == "application/pdf")))
        {
            let location = part["metadata"]["path"]
                .as_str()
                .map(|path| format!(" (local file: {path})"))
                .unwrap_or_default();
            *part = json!({"type":"text","text":format!("[attachment not sent: \"{name}\"{location}, {mime}]\nThis model/provider cannot receive {mime} directly; read the file with tools (for PDFs: pdftotext, or render pages to images with pdftoppm and read them).\nTell the user that this attachment could not be sent to the model directly.")});
        }
    }
    Ok(())
}

/// Attached text reaches the model as a file block: the TS runner gives the
/// same wrapper, and it is what tells the model where the text came from. The
/// tail beyond [`TEXT_LIMIT`] becomes a count instead of failing the request.
fn file_block(part: &Value, text: &str) -> String {
    let name = part["metadata"]["name"].as_str().unwrap_or("attachment");
    let location = part["metadata"]["path"]
        .as_str()
        .map(|path| format!(" path=\"{}\"", attribute(path)))
        .unwrap_or_default();
    let characters = text.chars().count();
    let clipped = match characters > TEXT_LIMIT {
        true => format!(
            "{}\n[truncated: {} more characters]",
            text.chars().take(TEXT_LIMIT).collect::<String>(),
            characters - TEXT_LIMIT
        ),
        false => text.to_owned(),
    };
    format!(
        "<file name=\"{}\"{location}>\n{clipped}\n</file>",
        attribute(name)
    )
}

/// A name that quotes the wrapper's own delimiters would forge its end, so the
/// attributes are escaped even though the TS runner interpolates them raw.
fn attribute(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn anthropic_part(part: &Value, role: &str) -> Result<Value, ProviderError> {
    if part["type"] != "image" && part["type"] != "file" {
        return Ok(part.clone());
    }
    if role != "user" {
        return Err(ProviderError::Stream(
            "media attachments are only valid on user messages".into(),
        ));
    }
    let mime = part["mime"]
        .as_str()
        .ok_or_else(|| ProviderError::Stream("invalid Anthropic media attachment".into()))?;
    let data = part["data"]
        .as_str()
        .ok_or_else(|| ProviderError::Stream("invalid Anthropic media attachment".into()))?;
    Ok(
        json!({"type":if mime == "application/pdf" {"document"} else {"image"},"source":{"type":"base64","media_type":mime,"data":data}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_identity_stays_durable_but_never_crosses_provider_boundaries() {
        let content = json!([{"type":"tool_use","id":"call","name":"mcp_alias","input":{},"_miao_mcp":{"server":"original_server","tool":"original_tool"}}]);
        for protocol in [
            "anthropic",
            "openai-chat",
            "openai-responses",
            "gemini",
            "bedrock-converse",
        ] {
            let request = ModelRequest {
                system: String::new(),
                tools: Vec::new(),
                messages: vec![crate::protocol::Message {
                    role: "assistant".into(),
                    content: content.clone(),
                    checkpoint: None,
                    recorded_at_ms: None,
                }],
            };
            let normalized = normalize(request, protocol, &[]).unwrap();
            assert!(normalized.messages[0].content[0].get("_miao_mcp").is_none());
            assert_eq!(normalized.messages[0].content[0]["name"], "mcp_alias");
            assert!(content[0].get("_miao_mcp").is_some());
        }
    }

    fn text_part(text: &str, metadata: Value) -> Value {
        json!({
            "type":"file",
            "mime":"text/plain",
            "data":base64::engine::general_purpose::STANDARD.encode(text),
            "metadata":metadata,
        })
    }

    fn normalized_text(text: &str, metadata: Value) -> String {
        let request = ModelRequest {
            system: String::new(),
            tools: Vec::new(),
            messages: vec![crate::protocol::Message {
                role: "user".into(),
                content: json!([text_part(text, metadata)]),
                checkpoint: None,
                recorded_at_ms: None,
            }],
        };
        normalize(request, "openai-chat", &[]).unwrap().messages[0].content[0]["text"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn inlined_text_keeps_the_file_provenance_and_escapes_its_attributes() {
        assert_eq!(
            normalized_text(
                "attached text",
                json!({"name":"notes.md","path":"/client/notes.md"})
            ),
            "<file name=\"notes.md\" path=\"/client/notes.md\">\nattached text\n</file>"
        );
        assert_eq!(
            normalized_text("x", json!({"name":"a\"b<c>.md"})),
            "<file name=\"a&quot;b&lt;c&gt;.md\">\nx\n</file>"
        );
        assert_eq!(
            normalized_text("x", json!({})),
            "<file name=\"attachment\">\nx\n</file>"
        );
    }

    #[test]
    fn text_past_the_limit_is_clipped_with_a_count_instead_of_failing() {
        let oversized = "中".repeat(TEXT_LIMIT + 20);
        let block = normalized_text(&oversized, json!({"name":"large.md"}));
        assert!(block.ends_with("\n[truncated: 20 more characters]\n</file>"));
        assert_eq!(
            block.chars().filter(|character| *character == '中').count(),
            TEXT_LIMIT
        );
    }
}
