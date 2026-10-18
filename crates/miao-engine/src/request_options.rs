//! Bounded, host-declared generation options. They cannot replace the model,
//! transcript, tool authority, credential binding or streaming protocol.
use crate::provider::ProviderError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub body: Map<String, Value>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}
impl Options {
    pub fn validate(&self) -> Result<(), ProviderError> {
        if self
            .headers
            .keys()
            .map(|name| name.to_ascii_lowercase())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != self.headers.len()
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > 64 * 1024)
            || self.body.keys().any(|key| {
                matches!(
                    key.as_str(),
                    "model"
                        | "messages"
                        | "input"
                        | "instructions"
                        | "system"
                        | "contents"
                        | "systemInstruction"
                        | "tools"
                        | "functions"
                        | "tool_choice"
                        | "function_call"
                        | "toolConfig"
                        | "stream"
                        | "stream_options"
                        | "store"
                        | "include"
                        | "n"
                        | "prompt_cache_key"
                )
            })
            || self
                .body
                .get("generationConfig")
                .and_then(|value| value.get("candidateCount"))
                .is_some_and(|value| value != 1)
            || self.headers.iter().any(|(name, value)| {
                http::HeaderName::from_bytes(name.as_bytes()).is_err()
                    || http::HeaderValue::from_str(value).is_err()
                    || matches!(
                        name.to_ascii_lowercase().as_str(),
                        "authorization"
                            | "api-key"
                            | "x-api-key"
                            | "x-goog-api-key"
                            | "chatgpt-account-id"
                            | "session-id"
                            | "host"
                            | "content-length"
                            | "transfer-encoding"
                            | "connection"
                            | "content-type"
                            | "accept"
                            | "proxy-authorization"
                    )
            })
        {
            return Err(ProviderError::Stream(
                "unsupported host generation options".into(),
            ));
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.body.is_empty() && self.headers.is_empty()
    }

    pub fn merged(&self, variant: &Self) -> Result<Self, ProviderError> {
        self.validate()?;
        variant.validate()?;
        let mut result = self.clone();
        merge(&mut result.body, &variant.body);
        for (name, value) in &variant.headers {
            result
                .headers
                .retain(|key, _| !key.eq_ignore_ascii_case(name));
            result.headers.insert(name.clone(), value.clone());
        }
        result.validate()?;
        Ok(result)
    }

    pub fn apply(&self, body: &mut Value) {
        if let Some(body) = body.as_object_mut() {
            merge(body, &self.body);
        }
    }

    pub fn headers(
        &self,
        builder: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        crate::provider::route_headers(builder, &self.headers)
    }
}

fn merge(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        match (target.get_mut(key), value) {
            (Some(Value::Object(target)), Value::Object(source)) => merge(target, source),
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
