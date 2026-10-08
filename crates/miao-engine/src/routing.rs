use crate::{
    credential::Source,
    gemini::Gemini,
    openai_chat::OpenAIChat,
    openai_responses::{OpenAIResponses, Profile},
    protocol::ModelRequest,
    provider::{scoped, Anthropic, Budget, Identity, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn build(
    name: &str,
    endpoint: Option<&str>,
    source: Source,
    model: String,
) -> Result<Arc<dyn Provider>, ProviderError> {
    match name {
        "anthropic" => Ok(Arc::new(
            Anthropic::with_source(
                endpoint
                    .unwrap_or("https://api.anthropic.com/v1/messages")
                    .into(),
                source,
                model,
            )
            .map_err(|_| ProviderError::Transport)?,
        )),
        "openai-chat" => Ok(Arc::new(
            OpenAIChat::with_source(
                endpoint
                    .unwrap_or("https://api.openai.com/v1/chat/completions")
                    .into(),
                source,
                model,
            )
            .map_err(|_| ProviderError::Transport)?,
        )),
        "openai-responses" | "subscription-responses" => {
            let subscription = name == "subscription-responses";
            let default = if subscription {
                "https://chatgpt.com/backend-api/codex/responses"
            } else {
                "https://api.openai.com/v1/responses"
            };
            Ok(Arc::new(
                OpenAIResponses::with_source(
                    endpoint.unwrap_or(default).into(),
                    source,
                    model,
                    if subscription {
                        Profile::Subscription
                    } else {
                        Profile::Api
                    },
                )
                .map_err(|_| ProviderError::Transport)?,
            ))
        }
        "gemini" => {
            let default = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent",
                model.strip_prefix("models/").unwrap_or(&model)
            );
            Ok(Arc::new(Gemini::with_source(
                endpoint.unwrap_or(&default).into(),
                source,
                model,
            )?))
        }
        _ => Err(ProviderError::Stream("unknown provider".into())),
    }
}
pub struct Fallback {
    primary: Arc<dyn Provider>,
    secondary: Arc<dyn Provider>,
    first: Identity,
    second: Identity,
}
impl Fallback {
    pub fn new(
        primary: Arc<dyn Provider>,
        secondary: Arc<dyn Provider>,
    ) -> Result<Self, ProviderError> {
        let first = primary
            .identity()
            .ok_or_else(|| ProviderError::Stream("fallback requires provider identity".into()))?;
        let second = secondary
            .identity()
            .ok_or_else(|| ProviderError::Stream("fallback requires provider identity".into()))?;
        if [&first, &second].iter().any(|identity| {
            identity.model.is_empty()
                || identity.model.len() > 256
                || identity.protocol.is_empty()
                || identity.protocol.len() > 64
        }) {
            return Err(ProviderError::Stream("invalid fallback identity".into()));
        }
        Ok(Self {
            primary,
            secondary,
            first,
            second,
        })
    }
}
#[async_trait]
impl Provider for Fallback {
    fn identity(&self) -> Option<Identity> {
        Some(self.first.clone())
    }
    fn protected_resources(&self) -> Vec<std::path::PathBuf> {
        self.primary
            .protected_resources()
            .into_iter()
            .chain(self.secondary.protected_resources())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        let mut required = BTreeSet::new();
        for message in &request.messages {
            for block in message
                .content
                .as_array()
                .ok_or_else(|| ProviderError::Stream("invalid routing history".into()))?
            {
                if block["type"] != "provider_opaque" {
                    continue;
                }
                let protocol = block["protocol"]
                    .as_str()
                    .or_else(|| block["provider"].as_str())
                    .ok_or_else(|| {
                        ProviderError::Stream("opaque history lacks protocol binding".into())
                    })?;
                if block["protocol"]
                    .as_str()
                    .zip(block["provider"].as_str())
                    .is_some_and(|(a, b)| a != b)
                {
                    return Err(ProviderError::Stream(
                        "conflicting opaque protocol binding".into(),
                    ));
                }
                let model = block["model"].as_str().ok_or_else(|| {
                    ProviderError::Stream("opaque history lacks model binding".into())
                })?;
                required.insert((protocol.to_owned(), model.to_owned()));
            }
        }
        if required.len() > 1 {
            return Err(ProviderError::Stream(
                "mixed opaque history cannot be routed losslessly".into(),
            ));
        }
        let required = required
            .into_iter()
            .next()
            .map(|(protocol, model)| Identity { protocol, model });
        let pinned = required.is_some();
        let secondary = match required.as_ref() {
            None => false,
            Some(required) if required == &self.first => false,
            Some(required) if required == &self.second => true,
            _ => {
                return Err(ProviderError::Stream(
                    "no configured provider matches opaque history".into(),
                ))
            }
        };
        let budget = Budget::new();
        if secondary {
            let result = scoped(
                budget.clone(),
                3,
                self.secondary.stream(request, progress, cancel),
            )
            .await;
            return finish(result, &self.second, true, pinned, None, budget.used());
        }
        let can_switch = !pinned || self.first == self.second;
        let result = scoped(
            budget.clone(),
            if can_switch { 1 } else { 3 },
            self.primary
                .stream(request.clone(), progress.clone(), cancel.clone()),
        )
        .await;
        match result {
            Err(error) if can_switch && error.can_fallback() && !cancel.is_cancelled() => {
                let reason = error.to_string();
                let result = scoped(
                    budget.clone(),
                    2,
                    self.secondary.stream(request, progress, cancel),
                )
                .await;
                finish(
                    result,
                    &self.second,
                    true,
                    pinned,
                    Some(reason),
                    budget.used(),
                )
            }
            result => finish(result, &self.first, false, pinned, None, budget.used()),
        }
    }
}
fn finish(
    result: Result<Reply, ProviderError>,
    identity: &Identity,
    secondary: bool,
    pinned: bool,
    reason: Option<String>,
    attempts: usize,
) -> Result<Reply, ProviderError> {
    let selection = json!({"identity":identity,"route":if secondary{"fallback"}else{"primary"},"opaque_pinned":pinned,"fallback_reason":reason,"http_attempts":attempts});
    match result {
        Ok(mut reply) => {
            reply.usage = json!({"reported":reply.usage,"routing":selection});
            Ok(reply)
        }
        Err(ProviderError::Interrupted) => Err(ProviderError::Interrupted),
        Err(source) => Err(ProviderError::Routed {
            selection,
            source: Box::new(source),
        }),
    }
}
