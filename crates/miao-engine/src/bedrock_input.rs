use crate::{protocol::ModelRequest, provider::ProviderError};
use aws_sdk_bedrockruntime::types;
use aws_smithy_types::{Blob, Document, Number};
use base64::Engine;
use serde_json::Value;

pub(crate) fn messages(
    request: &ModelRequest,
    model: &str,
) -> Result<Vec<types::Message>, ProviderError> {
    request
        .messages
        .iter()
        .map(|message| {
            if message.role != "user" && message.role != "assistant" {
                return Err(invalid());
            }
            let parts = message.content.as_array().ok_or_else(invalid)?;
            let content = parts
                .iter()
                .map(|part| block(part, &message.role, model))
                .collect::<Result<Vec<_>, _>>()?;
            types::Message::builder()
                .role(types::ConversationRole::from(message.role.as_str()))
                .set_content(Some(content))
                .build()
                .map_err(|_| invalid())
        })
        .collect()
}

pub(crate) fn tools(
    request: &ModelRequest,
) -> Result<Option<types::ToolConfiguration>, ProviderError> {
    if request.tools.is_empty() {
        return Ok(None);
    }
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            if !tool.input_schema.is_object() {
                return Err(invalid());
            }
            let specification = types::ToolSpecification::builder()
                .name(&tool.name)
                .set_description((!tool.description.is_empty()).then(|| tool.description.clone()))
                .input_schema(types::ToolInputSchema::Json(document(&tool.input_schema)))
                .build()
                .map_err(|_| invalid())?;
            Ok(types::Tool::ToolSpec(specification))
        })
        .collect::<Result<Vec<_>, ProviderError>>()?;
    Ok(Some(
        types::ToolConfiguration::builder()
            .set_tools(Some(tools))
            .build()
            .map_err(|_| invalid())?,
    ))
}

fn block(part: &Value, role: &str, model: &str) -> Result<types::ContentBlock, ProviderError> {
    match (role, part["type"].as_str()) {
        (_, Some("text")) => Ok(types::ContentBlock::Text(string(part, "text")?.into())),
        ("user", Some("image")) => Ok(types::ContentBlock::Image(image(part)?)),
        ("user", Some("file")) if part["mime"] == "application/pdf" => {
            Ok(types::ContentBlock::Document(pdf(part)?))
        }
        ("assistant", Some("tool_use")) => {
            let input = part
                .get("input")
                .filter(|input| {
                    input.is_object() || (input.is_null() && part["input_error"].is_string())
                })
                .ok_or_else(invalid)?;
            Ok(types::ContentBlock::ToolUse(
                types::ToolUseBlock::builder()
                    .tool_use_id(string(part, "id")?)
                    .name(string(part, "name")?)
                    .input(document(input))
                    .build()
                    .map_err(|_| invalid())?,
            ))
        }
        ("user", Some("tool_result")) => {
            let content = match part.get("content") {
                Some(Value::String(text)) => {
                    vec![types::ToolResultContentBlock::Text(text.clone())]
                }
                Some(Value::Array(parts)) => parts
                    .iter()
                    .map(|part| match part["type"].as_str() {
                        Some("text") => Ok(types::ToolResultContentBlock::Text(
                            string(part, "text")?.into(),
                        )),
                        Some("image") => Ok(types::ToolResultContentBlock::Image(image(part)?)),
                        Some("file") if part["mime"] == "application/pdf" => {
                            Ok(types::ToolResultContentBlock::Document(pdf(part)?))
                        }
                        _ => Err(invalid()),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(invalid()),
            };
            Ok(types::ContentBlock::ToolResult(
                types::ToolResultBlock::builder()
                    .tool_use_id(string(part, "tool_use_id")?)
                    .set_content(Some(content))
                    .status(if part["is_error"] == true {
                        types::ToolResultStatus::Error
                    } else {
                        types::ToolResultStatus::Success
                    })
                    .build()
                    .map_err(|_| invalid())?,
            ))
        }
        ("assistant", Some("provider_opaque"))
            if part["provider"] == "bedrock-converse" && part["model"] == model =>
        {
            reasoning(&part["item"])
        }
        ("assistant", Some("reasoning")) => reasoning(part),
        _ => Err(invalid()),
    }
}

fn reasoning(part: &Value) -> Result<types::ContentBlock, ProviderError> {
    match part["type"].as_str() {
        Some("reasoning") => Ok(types::ContentBlock::ReasoningContent(
            types::ReasoningContentBlock::ReasoningText(
                types::ReasoningTextBlock::builder()
                    .text(string(part, "text")?)
                    .set_signature(part["signature"].as_str().map(str::to_owned))
                    .build()
                    .map_err(|_| invalid())?,
            ),
        )),
        Some("redacted_reasoning") => Ok(types::ContentBlock::ReasoningContent(
            types::ReasoningContentBlock::RedactedContent(Blob::new(bytes(part)?)),
        )),
        _ => Err(invalid()),
    }
}

fn pdf(part: &Value) -> Result<types::DocumentBlock, ProviderError> {
    types::DocumentBlock::builder()
        .name("attachment")
        .format(types::DocumentFormat::Pdf)
        .source(types::DocumentSource::Bytes(Blob::new(bytes(part)?)))
        .build()
        .map_err(|_| invalid())
}

fn image(part: &Value) -> Result<types::ImageBlock, ProviderError> {
    let format = match string(part, "mime")? {
        "image/png" => types::ImageFormat::Png,
        "image/jpeg" => types::ImageFormat::Jpeg,
        "image/gif" => types::ImageFormat::Gif,
        "image/webp" => types::ImageFormat::Webp,
        _ => return Err(invalid()),
    };
    types::ImageBlock::builder()
        .format(format)
        .source(types::ImageSource::Bytes(Blob::new(bytes(part)?)))
        .build()
        .map_err(|_| invalid())
}

fn string<'a>(part: &'a Value, key: &str) -> Result<&'a str, ProviderError> {
    part[key].as_str().ok_or_else(invalid)
}
fn bytes(part: &Value) -> Result<Vec<u8>, ProviderError> {
    base64::engine::general_purpose::STANDARD
        .decode(string(part, "data")?)
        .map_err(|_| invalid())
}
fn invalid() -> ProviderError {
    ProviderError::Stream("unsupported Bedrock request content".into())
}

pub(crate) fn document(value: &Value) -> Document {
    match value {
        Value::Null => Document::Null,
        Value::Bool(value) => Document::Bool(*value),
        Value::String(value) => Document::String(value.clone()),
        Value::Array(value) => Document::Array(value.iter().map(document).collect()),
        Value::Object(value) => Document::Object(
            value
                .iter()
                .map(|(key, value)| (key.clone(), document(value)))
                .collect(),
        ),
        Value::Number(value) => Document::Number(if let Some(value) = value.as_u64() {
            Number::PosInt(value)
        } else if let Some(value) = value.as_i64() {
            Number::NegInt(value)
        } else {
            Number::Float(value.as_f64().expect("JSON number is finite"))
        }),
    }
}
