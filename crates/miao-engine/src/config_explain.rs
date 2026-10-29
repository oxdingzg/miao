//! Read-only configuration provenance for the native diagnostic command.

use crate::config_derive::{self, Source};
use serde_json::Value;

pub fn report(sources: &[Source]) -> Result<Value, String> {
    let mut documents = config_derive::load(sources)?;
    // Redact before merging so overridden credentials cannot escape through
    // the provenance chain even when the winning value is harmless.
    for document in &mut documents {
        redact(&mut document.value);
    }
    Ok(config_derive::explain(&documents))
}

fn secret_key(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    matches!(
        key.as_str(),
        "key" | "auth" | "headers" | "cookie" | "signature" | "sig" | "code" | "tokens"
    ) || key.ends_with("token")
        || [
            "password",
            "passwd",
            "secret",
            "apikey",
            "authorization",
            "credential",
            "privatekey",
            "accesskey",
        ]
        .iter()
        .any(|part| key.contains(part))
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if secret_key(key) {
                    mask(value);
                } else {
                    redact(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact),
        Value::String(text) => {
            let Ok(mut url) = reqwest::Url::parse(text) else {
                return;
            };
            if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
                return;
            }
            let credentials = !url.username().is_empty() || url.password().is_some();
            let query: Vec<(String, String)> = url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            let sensitive_query = query.iter().any(|(key, _)| secret_key(key));
            if !credentials && !sensitive_query {
                return;
            }
            if credentials {
                let _ = url.set_username("[redacted]");
                let _ = url.set_password(None);
            }
            if sensitive_query {
                url.query_pairs_mut()
                    .clear()
                    .extend_pairs(query.iter().map(|(key, value)| {
                        (
                            key.as_str(),
                            if secret_key(key) {
                                "[redacted]"
                            } else {
                                value.as_str()
                            },
                        )
                    }));
            }
            *text = url.to_string();
        }
        _ => {}
    }
}

fn mask(value: &mut Value) {
    match value {
        Value::Object(map) => map.values_mut().for_each(mask),
        Value::Array(values) => values.iter_mut().for_each(mask),
        Value::String(_) | Value::Number(_) => *value = Value::String("[redacted]".into()),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn final_values_and_override_chains_keep_sources_but_mask_credentials() {
        let sources = [
            Source::Content(json!({"model":"global/model","provider":{"demo":{"apiKey":"global-private","headers":{"X-Custom":"header-private"}}}}).to_string()),
            Source::Content(json!({"model":"project/model","provider":{"demo":{"apiKey":"project-private"}}}).to_string()),
        ];
        let value = report(&sources).unwrap();
        assert_eq!(value["sources"].as_array().unwrap().len(), 2);
        let keys = value["keys"].as_array().unwrap();
        let model = keys
            .iter()
            .find(|row| row["path"] == json!(["model"]))
            .unwrap();
        assert_eq!(model["value"], "project/model");
        assert_eq!(model["overridden"][0]["value"], "global/model");
        let key = keys
            .iter()
            .find(|row| row["path"] == json!(["provider", "demo", "apiKey"]))
            .unwrap();
        assert_eq!(key["value"], "[redacted]");
        assert_eq!(key["overridden"][0]["value"], "[redacted]");
        for secret in ["global-private", "project-private", "header-private"] {
            assert!(!value.to_string().contains(secret));
        }
    }

    #[test]
    fn urls_hide_credentials_and_labelled_query_secrets_without_hiding_settings() {
        let value = report(&[Source::Content(json!({"endpoint":"https://alice:password-private@example.test/v1?api_key=query-private&region=west","model":"a/b","enabled":true,"max_tokens":4000}).to_string())]).unwrap();
        let text = value.to_string();
        for secret in ["alice", "password-private", "query-private"] {
            assert!(!text.contains(secret));
        }
        assert!(text.contains("region=west"));
        assert!(text.contains("a/b"));
        assert!(text.contains("4000"));
    }
}
