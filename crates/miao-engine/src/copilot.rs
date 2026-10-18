use crate::{protocol::ModelRequest, provider::ProviderError};
use serde_json::Value;
use std::collections::BTreeMap;

tokio::task_local! { static CHILD: bool; }

pub(crate) async fn scoped<F: std::future::Future>(child: bool, future: F) -> F::Output {
    CHILD.scope(child, future).await
}

/// Metadata is computed from the actual lowered request and Session context,
/// not from model-supplied headers or a shared owner's startup state.
pub(crate) fn turn(request: &ModelRequest) -> BTreeMap<String, String> {
    let child = CHILD.try_with(|value| *value).unwrap_or(false);
    let user = request.messages.last().is_some_and(|message| {
        message.role == "user"
            && !message
                .content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
    });
    let mut headers = BTreeMap::from([
        (
            "x-initiator".into(),
            (if child || !user { "agent" } else { "user" }).into(),
        ),
        (
            "X-Interaction-Id".into(),
            crate::cache_affinity::session_key()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        ),
    ]);
    if request.messages.iter().any(|message| {
        message
            .content
            .as_array()
            .is_some_and(|parts| parts.iter().any(image))
    }) {
        headers.insert("Copilot-Vision-Request".into(), "true".into());
    }
    headers
}

fn image(part: &Value) -> bool {
    (part["type"] == "image"
        && part["mime"]
            .as_str()
            .is_some_and(|mime| mime.starts_with("image/")))
        || (part["type"] == "tool_result"
            && part["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(image)))
}

pub(crate) fn apply(
    request: &mut reqwest::Request,
    turn: &BTreeMap<String, String>,
    anthropic: bool,
) -> Result<(), ProviderError> {
    for (name, value) in [
        (
            "user-agent",
            format!("miao/{}", env!("MIAO_ENGINE_VERSION")),
        ),
        ("x-github-api-version", "2026-06-01".into()),
        ("openai-intent", "conversation-edits".into()),
    ] {
        if !request.headers().contains_key(name) {
            request.headers_mut().insert(
                http::HeaderName::from_static(name),
                http::HeaderValue::from_str(&value).map_err(|_| ProviderError::AuthProfile)?,
            );
        }
    }
    if anthropic {
        let beta = match request.headers().get("anthropic-beta") {
            Some(value) => value.to_str().map_err(|_| ProviderError::AuthProfile)?,
            None => "",
        };
        if !beta
            .split(',')
            .any(|flag| flag.trim() == "interleaved-thinking-2025-05-14")
        {
            let value = if beta.is_empty() {
                "interleaved-thinking-2025-05-14".to_string()
            } else {
                format!("{beta},interleaved-thinking-2025-05-14")
            };
            if value.len() > 8192 {
                return Err(ProviderError::AuthProfile);
            }
            request.headers_mut().insert(
                http::HeaderName::from_static("anthropic-beta"),
                http::HeaderValue::from_str(&value).map_err(|_| ProviderError::AuthProfile)?,
            );
        }
    }
    // Clear a host/variant's stale vision flag when normalization removed images.
    request.headers_mut().remove("copilot-vision-request");
    for (name, value) in turn {
        request.headers_mut().insert(
            http::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| ProviderError::AuthProfile)?,
            http::HeaderValue::from_str(value).map_err(|_| ProviderError::AuthProfile)?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Message;
    use serde_json::json;

    #[tokio::test]
    async fn child_scope_is_isolated_and_nested_tool_images_enable_vision() {
        let request = ModelRequest {
            system: String::new(),
            messages: vec![Message {
                role: "user".into(),
                content: json!([{"type":"image","mime":"image/png"}]),
                checkpoint: None,
                recorded_at_ms: None,
            }],
            tools: vec![],
        };
        let (child, root) = tokio::join!(
            scoped(true, async {
                tokio::task::yield_now().await;
                turn(&request)
            }),
            scoped(false, async {
                tokio::task::yield_now().await;
                turn(&request)
            }),
        );
        assert_eq!(child["x-initiator"], "agent");
        assert_eq!(root["x-initiator"], "user");
        assert_eq!(root["Copilot-Vision-Request"], "true");
        assert_eq!(turn(&request)["x-initiator"], "user");
        let mut tool = request;
        tool.messages[0].content =
            json!([{"type":"tool_result","content":[{"type":"image","mime":"image/png"}]}]);
        assert_eq!(turn(&tool)["x-initiator"], "agent");
        assert_eq!(turn(&tool)["Copilot-Vision-Request"], "true");
    }
}
