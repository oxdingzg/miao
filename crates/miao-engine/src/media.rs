use crate::{protocol::ModelRequest, provider::ProviderError};
use base64::Engine;
use serde_json::{json, Value};

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
            *part = json!({"type":"text","text":text});
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
