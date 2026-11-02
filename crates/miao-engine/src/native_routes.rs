//! The native single-binary start derives its own host route manifest.
//!
//! The TypeScript host used to prepare `--model-routes-config` through its
//! engine shim: one route per configured provider model with a live stored
//! credential, mapped onto the engine's native transports. A native start has
//! no host, so the engine builds the same manifest from the operator's config
//! `providers` and the product credential store. Every provider the config
//! names but no credential covers is skipped — a route without a secret
//! cannot serve a turn.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config_derive::{self, Source};

/// Build the manifest for these config sources and write it next to the
/// engine's storage. `Ok(None)` means nothing was routable: the config names
/// no providers, or none of them carries both a known transport and a live
/// credential. The caller keeps its fallback provider in that case.
pub fn materialize(
    sources: &[Source],
    credential_db: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let Some(entries) = routes(sources, credential_db)? else {
        return Ok(None);
    };
    let Some(root) = crate::placement::storage_root() else {
        return Ok(None);
    };
    let directory = root.join("native");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("model-routes.json");
    // The storage root lives outside every workspace, which
    // `model_routes::read` requires of the manifest path.
    let body = serde_json::to_vec_pretty(&entries).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(Some(path))
}

fn routes(sources: &[Source], credential_db: Option<&Path>) -> Result<Option<Vec<Value>>, String> {
    let documents = config_derive::load(sources)?;
    let values = documents
        .iter()
        .map(|document| document.value.clone())
        .collect::<Vec<_>>();
    let merged = crate::config_scope::merge_values(&values);
    let Some(providers) = merged
        .get("providers")
        .and_then(Value::as_object)
        .filter(|providers| !providers.is_empty())
    else {
        return Ok(None);
    };
    let selected = merged.get("model").and_then(Value::as_str);
    // A missing or unreadable credential store leaves every provider without
    // a secret, which routes nothing — the same answer an empty store gives.
    let credentials = match credential_db.map(crate::credential::list_database) {
        Some(Ok(list)) => list,
        _ => Vec::new(),
    };
    // One unexpired credential per integration. A later stored credential is
    // reachable through the product UI, which rewrites the manifest on use.
    let mut live: BTreeMap<&str, &crate::credential::Metadata> = BTreeMap::new();
    for credential in credentials.iter().filter(|credential| !credential.expired) {
        live.entry(credential.integration.as_str())
            .or_insert(credential);
    }
    let mut entries = Vec::new();
    let mut primary_seen = false;
    for (id, provider) in providers {
        if provider.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(credential) = live.get(id.as_str()) else {
            continue;
        };
        let Some(db_path) = credential_db else {
            continue;
        };
        let provider_api = provider.get("api");
        let models = provider.get("models").and_then(Value::as_object);
        let Some(models) = models else { continue };
        for (model_id, model) in models {
            if model.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            // A model's own api overrides the provider's, the way the
            // product's catalog builds it.
            let api = model.get("api").filter(|api| api.get("type").is_some());
            let api = api.or(provider_api);
            let Some(api) = api else { continue };
            let Some((transport, endpoint)) = transport(api, model_id) else {
                continue;
            };
            let key = format!("{id}/{model_id}");
            let primary = selected == Some(key.as_str());
            primary_seen |= primary;
            let mut entry = json!({
                "id": key,
                "provider": transport,
                "model": model_id,
                "credential": {
                    "type": "database",
                    "path": db_path.display().to_string(),
                    "id": credential.id,
                    "integration": credential.integration,
                },
                "primary": primary,
            });
            if let Some(endpoint) = endpoint {
                entry["endpoint"] = json!(endpoint);
            }
            if let Some(input) = model
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("input"))
                .and_then(Value::as_array)
                .filter(|input| !input.is_empty())
            {
                entry["input_modalities"] = json!(input);
            }
            if let Some(limit) = model.get("limit").and_then(Value::as_object) {
                let mut bounded = serde_json::Map::new();
                for field in ["context", "output"] {
                    if let Some(size) = limit.get(field).and_then(Value::as_u64) {
                        bounded.insert(field.into(), json!(size));
                    }
                }
                if !bounded.is_empty() {
                    entry["limit"] = Value::Object(bounded);
                }
            }
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Ok(None);
    }
    // The engine picks the primary entry as the default route; a config that
    // names no model falls back to the first provider the config declares.
    if !primary_seen {
        entries[0]["primary"] = json!(true);
    }
    Ok(Some(entries))
}

/// The wire a configured api rides, and the endpoint it reaches. The mapping
/// mirrors the product's route planner: an explicit URL wins over the
/// package's default, the suffix is appended once, and URLs carrying
/// credentials in the query or userinfo are refused.
fn transport(api: &Value, model_id: &str) -> Option<(String, Option<String>)> {
    let url = api.get("url").and_then(Value::as_str);
    match api.get("type").and_then(Value::as_str)? {
        // Plugin catalogs without an AI SDK package declare an
        // OpenAI-compatible base URL directly.
        "native" => {
            let base = url?.trim_end_matches('/');
            let suffix = "chat/completions";
            let endpoint = if base.ends_with(suffix) {
                base.to_string()
            } else {
                format!("{base}/{suffix}")
            };
            Some(("openai-chat".into(), Some(endpoint)))
        }
        "aisdk" => {
            let package = api.get("package").and_then(Value::as_str)?;
            let defaults: &[(&str, &str)] = &[
                ("@ai-sdk/deepseek", "https://api.deepseek.com/v1"),
                ("@ai-sdk/groq", "https://api.groq.com/openai/v1"),
                ("@ai-sdk/mistral", "https://api.mistral.ai/v1"),
                ("@ai-sdk/xai", "https://api.x.ai/v1"),
            ];
            let base = url
                .map(|url| url.trim_end_matches('/').to_string())
                .or_else(|| {
                    defaults
                        .iter()
                        .find(|(name, _)| *name == package)
                        .map(|(_, base)| base.to_string())
                });
            match package {
                "@ai-sdk/anthropic" => {
                    let endpoint = base.as_deref().unwrap_or("https://api.anthropic.com/v1");
                    endpoint
                        .join_pair("messages")
                        .map(|url| ("anthropic".into(), Some(url)))
                }
                "@ai-sdk/google" => {
                    let endpoint = base
                        .as_deref()
                        .unwrap_or("https://generativelanguage.googleapis.com/v1beta");
                    let suffix = format!(
                        "models/{}:streamGenerateContent",
                        model_id.trim_start_matches("models/")
                    );
                    endpoint
                        .join_pair(&suffix)
                        .map(|url| ("gemini".into(), Some(url)))
                }
                "@ai-sdk/openai" => {
                    let endpoint = base.as_deref().unwrap_or("https://api.openai.com/v1");
                    endpoint
                        .join_pair("responses")
                        .map(|url| ("openai-responses".into(), Some(url)))
                }
                "@ai-sdk/amazon-bedrock" => Some(("amazon-bedrock".into(), url.map(str::to_owned))),
                // The OpenAI-compatible family, including every package whose
                // default URL is itself chat-completions shaped.
                "@ai-sdk/openai-compatible"
                | "@ai-sdk/deepseek"
                | "@ai-sdk/groq"
                | "@ai-sdk/mistral"
                | "@ai-sdk/xai" => {
                    let endpoint = base?;
                    endpoint
                        .join_pair("chat/completions")
                        .map(|url| ("openai-chat".into(), Some(url)))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Append one path suffix to an http(s) base URL, refusing anything that
/// would carry a secret in the address the way the product planner does.
trait EndpointJoin {
    fn join_pair(self, suffix: &str) -> Option<String>;
}

impl EndpointJoin for &str {
    fn join_pair(self, suffix: &str) -> Option<String> {
        let mut url = reqwest::Url::parse(self).ok()?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return None;
        }
        if !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let forbidden = |key: &str| {
            let key = key.to_ascii_lowercase();
            ["key", "token", "secret", "auth"]
                .iter()
                .any(|word| key.contains(word))
        };
        if url
            .query_pairs()
            .any(|(key, _)| forbidden(key.to_string().trim()))
        {
            return None;
        }
        let path = url.path().trim_end_matches('/').to_string();
        let next = if path.ends_with(&format!("/{suffix}")) {
            path
        } else {
            format!("{path}/{suffix}")
        };
        url.set_path(&next);
        Some(url.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_configured_provider_with_a_live_credential_becomes_a_route() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("miao.json"),
            serde_json::to_string(&json!({
                "model": "volcengine/deepseek",
                "providers": {
                    "volcengine": {
                        "models": {
                            "deepseek": {
                                "api": {
                                    "type": "aisdk",
                                    "package": "@ai-sdk/openai-compatible",
                                    "url": "https://ark.example.com/api/v3",
                                },
                                "capabilities": {"tools": true, "input": ["text"], "output": ["text"]},
                                "limit": {"context": 1048576, "output": 393216},
                            },
                            "unknown-wire": {
                                "api": {"type": "aisdk", "package": "@ai-sdk/something-else"},
                            },
                        }
                    },
                    "uncovered": {
                        "models": {
                            "m": {"api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://x.example/v1"}},
                        }
                    },
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let database = directory.path().join("credentials.db");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute(
                "CREATE TABLE credential (id text primary key, integration_id text, label text, value text)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO credential VALUES ('cred1', 'volcengine', 'volc', '{\"kind\":\"key\"}')",
                [],
            )
            .unwrap();
        let entries = routes(
            &[Source::Dir(directory.path().to_path_buf())],
            Some(&database),
        )
        .unwrap()
        .unwrap();
        // Only the covered provider's routable model survives; the unknown
        // wire and the credential-less provider contribute nothing.
        assert_eq!(
            entries.len(),
            1,
            "{}",
            serde_json::to_string(&entries).unwrap()
        );
        let entry = &entries[0];
        assert_eq!(entry["id"], "volcengine/deepseek");
        assert_eq!(entry["provider"], "openai-chat");
        assert_eq!(
            entry["endpoint"],
            "https://ark.example.com/api/v3/chat/completions"
        );
        assert_eq!(entry["primary"], true);
        assert_eq!(entry["credential"]["integration"], "volcengine");
        assert_eq!(entry["input_modalities"], json!(["text"]));
        assert_eq!(entry["limit"]["context"], 1048576);
    }

    #[test]
    fn the_url_suffix_appends_once() {
        let url = "https://ark.example.com/api/v3"
            .join_pair("chat/completions")
            .unwrap();
        assert_eq!(url, "https://ark.example.com/api/v3/chat/completions");
        let already = "https://ark.example.com/api/v3/chat/completions"
            .join_pair("chat/completions")
            .unwrap();
        assert_eq!(already, "https://ark.example.com/api/v3/chat/completions");
    }

    #[test]
    fn a_url_carrying_secrets_in_its_query_is_refused() {
        assert!("https://host.example/v1?api-key=xyz"
            .join_pair("chat/completions")
            .is_none());
        assert!("https://user:pw@host.example/v1"
            .join_pair("chat/completions")
            .is_none());
        assert!("ftp://host.example/v1"
            .join_pair("chat/completions")
            .is_none());
    }
}
