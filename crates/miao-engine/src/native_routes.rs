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

/// Every route this configuration and credential store can address, in the
/// shape the manifest carries. `miao models` prints the same set, so the CLI
/// and a started engine cannot disagree about what a turn can reach.
pub fn routes(
    sources: &[Source],
    credential_db: Option<&Path>,
) -> Result<Option<Vec<Value>>, String> {
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
    let live = accounts_by_integration(&credentials);
    let mut entries = Vec::new();
    let mut primary_seen = false;
    for (id, provider) in providers {
        if provider.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(accounts) = live.get(id.as_str()) else {
            continue;
        };
        let Some(account) = accounts.first() else {
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
                    "id": account.id,
                    "integration": account.integration,
                },
                "primary": primary,
            });
            gateway_session_header(id, &mut entry);
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
            for (position, account) in accounts.iter().enumerate() {
                entries.push(route_entry(
                    &entry, id, model_id, account, position, &entries,
                ));
            }
        }
    }
    // Credential integrations the configuration does not name answer through
    // the catalog snapshot, the way the product host answers them.
    entries.extend(catalog_key_routes(providers, credential_db));
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

/// OpenCode's gateway routes a turn by conversation and refuses one that does
/// not name it (400 MissingSessionID), so every `opencode-go` route carries
/// the Session's opaque digest. The engine substitutes `$session` at send
/// time, keeping sibling Sessions distinct and matching the header the
/// product's own TypeScript and CLI routes send.
fn gateway_session_header(provider: &str, entry: &mut Value) {
    if provider == "opencode-go" {
        entry["auth"] = json!({ "headers": { "x-opencode-session": "$session" } });
    }
}

/// Every unexpired credential per integration, the default label first: the
/// engine models an account as a route, so a provider holding two keys has to
/// answer through two routes. Keeping the first account on the plain
/// `provider/model` id leaves a Session that already pinned that id working.
fn accounts_by_integration(
    credentials: &[crate::credential::Metadata],
) -> BTreeMap<&str, Vec<&crate::credential::Metadata>> {
    let mut live: BTreeMap<&str, Vec<&crate::credential::Metadata>> = BTreeMap::new();
    for credential in credentials.iter().filter(|credential| !credential.expired) {
        live.entry(credential.integration.as_str())
            .or_default()
            .push(credential);
    }
    for accounts in live.values_mut() {
        accounts.sort_by(|left, right| {
            let rank =
                |credential: &crate::credential::Metadata| u8::from(credential.label != "default");
            rank(left)
                .cmp(&rank(right))
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    live
}

/// The catalogue half of the derivation: every provider the configuration does
/// not name, routed by the key credentials the product store already holds.
///
/// A stored key is the operator saying "serve this provider", so a launcher has
/// to turn it into a route even when no config entry mentions it. The snapshot
/// supplies the transport, endpoint and models, which is why nothing had to be
/// configured for this to work — and why leaving it out made a stored key look
/// unsaved until the operator edited their configuration by hand.
pub fn catalog_key_routes(
    declared: &serde_json::Map<String, Value>,
    credential_db: Option<&Path>,
) -> Vec<Value> {
    let Some(snapshot) = models_snapshot() else {
        return Vec::new();
    };
    snapshot_key_routes(&snapshot, declared, credential_db)
}

/// Reconcile an existing manifest with the product credential store: drop the
/// routes whose credential is gone, add the ones a newly stored key covers, and
/// answer how many entries the manifest gained or lost.
///
/// The launcher writes the manifest once, before the engine starts, and an
/// engine restart re-reads exactly that file. A key stored afterwards had no
/// route to serve, and a key deleted afterwards left a route that could only
/// fail, so a restart could never tell the operator the truth about the store.
/// Providers the manifest already routes stay untouched, which keeps a
/// re-entered key a no-op instead of a duplicate.
pub fn refresh_key_routes(path: &Path, credential_db: Option<&Path>) -> Result<usize, String> {
    let Some(snapshot) = models_snapshot() else {
        return Ok(0);
    };
    refresh_snapshot_key_routes(path, &snapshot, credential_db)
}

fn refresh_snapshot_key_routes(
    path: &Path,
    snapshot: &Value,
    credential_db: Option<&Path>,
) -> Result<usize, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let manifest: Value =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    let Some(entries) = manifest.as_array() else {
        return Err(format!("{}: not a route list", path.display()));
    };
    // An unreadable store is not evidence that every key is gone, so a failed
    // read leaves the manifest alone: the engine still fails honestly on use.
    let stored = match credential_db.map(crate::credential::list_database) {
        None => None,
        Some(Ok(list)) => Some(
            list.iter()
                .map(|entry| entry.id.clone())
                .collect::<std::collections::HashSet<_>>(),
        ),
        Some(Err(_)) => None,
    };
    let kept = entries
        .iter()
        .filter(|entry| {
            let credential = &entry["credential"];
            if credential["type"].as_str() != Some("database") {
                return true;
            }
            match (&stored, credential["id"].as_str()) {
                (Some(stored), Some(id)) => stored.contains(id),
                _ => true,
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    let removed = entries.len() - kept.len();
    // A route id is provider-qualified, so the providers the manifest still
    // serves are the ones whose configuration must keep winning.
    let mut declared = serde_json::Map::new();
    for provider in kept
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter_map(|id| id.split_once('/'))
        .map(|(provider, _)| provider.to_string())
    {
        declared.insert(provider, Value::Null);
    }
    let extra = snapshot_key_routes(snapshot, &declared, credential_db);
    let added = extra.len();
    if removed == 0 && added == 0 {
        return Ok(0);
    }
    let mut merged = kept;
    merged.extend(extra);
    let body = serde_json::to_vec(&merged).map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(removed + added)
}

fn snapshot_key_routes(
    snapshot: &Value,
    declared: &serde_json::Map<String, Value>,
    credential_db: Option<&Path>,
) -> Vec<Value> {
    let Some(db_path) = credential_db else {
        return Vec::new();
    };
    let Ok(credentials) = crate::credential::list_database(db_path) else {
        return Vec::new();
    };
    let live = accounts_by_integration(&credentials);
    let empty = serde_json::Map::new();
    let snapshot_providers = snapshot.as_object().unwrap_or(&empty);
    let mut entries: Vec<Value> = Vec::new();
    for (id, provider) in snapshot_providers {
        if declared.contains_key(id) {
            continue;
        }
        // An OAuth grant speaks its own transport, so only key credentials
        // route a snapshot provider here.
        let Some(accounts) = live
            .get(id.as_str())
            .map(|accounts| {
                accounts
                    .iter()
                    .filter(|account| account.kind == "key")
                    .copied()
                    .collect::<Vec<_>>()
            })
            .filter(|accounts| !accounts.is_empty())
        else {
            continue;
        };
        let Some(account) = accounts.first() else {
            continue;
        };
        let npm = provider.get("npm").and_then(Value::as_str);
        if npm != Some("@ai-sdk/openai-compatible") {
            continue;
        }
        let Some(base) = provider.get("api").and_then(Value::as_str) else {
            continue;
        };
        let models = provider.get("models").and_then(Value::as_object);
        let Some(models) = models else { continue };
        for (model_id, model) in models {
            let produces_text = model
                .get("modalities")
                .and_then(|modalities| modalities.get("output"))
                .and_then(Value::as_array)
                .is_some_and(|outputs| outputs.iter().any(|item| item == "text"));
            if !produces_text {
                continue;
            }
            let Some(endpoint) = base.join_pair("chat/completions") else {
                continue;
            };
            let mut entry = json!({
                "id": format!("{id}/{model_id}"),
                "provider": "openai-chat",
                "model": model_id,
                "endpoint": endpoint,
                "credential": {
                    "type": "database",
                    "path": db_path.display().to_string(),
                    "id": account.id,
                    "integration": account.integration,
                },
            });
            gateway_session_header(id, &mut entry);
            let limit = model.get("limit").and_then(Value::as_object);
            let mut bounded = serde_json::Map::new();
            for field in ["context", "output"] {
                if let Some(size) = limit
                    .and_then(|limit| limit.get(field))
                    .and_then(Value::as_u64)
                {
                    bounded.insert(field.into(), json!(size));
                }
            }
            if !bounded.is_empty() {
                entry["limit"] = Value::Object(bounded);
            }
            if let Some(input) = model
                .get("modalities")
                .and_then(|modalities| modalities.get("input"))
                .and_then(Value::as_array)
                .filter(|input| !input.is_empty())
            {
                entry["input_modalities"] = json!(input);
            }
            for (position, account) in accounts.iter().enumerate() {
                entries.push(route_entry(
                    &entry, id, model_id, account, position, &entries,
                ));
            }
        }
    }
    entries
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

/// The provider catalog snapshot the product ships and caches, in the order
/// the TS catalog service reads them: an explicit path, a snapshot beside the
/// engine binary, the installer's shipped copy, then the user cache.
fn models_snapshot() -> Option<Value> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("MIAO_MODELS_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("models.json"));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".miao/bin/models.json"));
        candidates.push(home.join(".local/share/miao/bin/models.json"));
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"));
        // The newest copy the TS catalog service keeps, and the one it
        // actually serves from once it has fetched at least once.
        candidates.push(cache.join("miao/models.json"));
    }
    candidates
        .iter()
        .find_map(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// One route per account. The engine models an account as a route, so a
/// provider holding several keys answers through several routes; the first
/// keeps the plain `provider/model` id a Session may already carry, and the
/// rest name their account so they stay distinct and findable.
fn route_entry(
    base: &Value,
    provider: &str,
    model: &str,
    account: &crate::credential::Metadata,
    position: usize,
    entries: &[Value],
) -> Value {
    let key = format!("{provider}/{model}");
    let mut entry = base.clone();
    if position > 0 {
        let candidate = format!("{key}@{}", account_slot(&account.label));
        entry["id"] = json!(free_route_id(&candidate, entries));
        // Only the account that answers the plain id can be the primary route.
        entry["primary"] = json!(false);
    }
    entry["credential"]["id"] = json!(account.id);
    entry["credential"]["integration"] = json!(account.integration);
    entry["account"] = json!({
        "id": account.id,
        "model_key": key,
        "label": account.label,
        "default": position == 0,
    });
    entry
}

/// A label that can sit in a route id: ids travel through Session pins and
/// command arguments, so keep them to characters that need no quoting.
fn account_slot(label: &str) -> String {
    let slot: String = label
        .chars()
        .map(|character| {
            match character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                true => character,
                false => '-',
            }
        })
        .collect();
    let slot = slot.trim_matches('-').to_string();
    match slot.is_empty() {
        true => "account".to_string(),
        false => slot,
    }
}

/// Two labels can normalize to the same slot (`work!` and `work?`), so a route
/// id is only reused when nothing already claims it.
fn free_route_id(candidate: &str, entries: &[Value]) -> String {
    let taken = |id: &str| {
        entries
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
    };
    if !taken(candidate) {
        return candidate.to_string();
    }
    (2..)
        .map(|suffix| format!("{candidate}-{suffix}"))
        .find(|id| !taken(id))
        .expect("a free route id")
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

    /// A provider can hold several accounts, and the engine models an account as
    /// a route: both keys have to answer for the same model, with the default
    /// one on the plain id a Session may already have pinned.
    #[test]
    fn a_second_credential_adds_a_second_route_for_the_same_model() {
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
                            }
                        }
                    }
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
        // "default" sorts after "work" by id, so the label rank has to decide.
        for (id, label) in [("cred_b", "default"), ("cred_a", "work")] {
            connection
                .execute(
                    "INSERT INTO credential VALUES (?1, 'volcengine', ?2, '{\"type\":\"key\",\"key\":\"k\"}')",
                    rusqlite::params![id, label],
                )
                .unwrap();
        }
        let entries = routes(
            &[Source::Dir(directory.path().to_path_buf())],
            Some(&database),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            entries.len(),
            2,
            "{}",
            serde_json::to_string(&entries).unwrap()
        );
        let default = entries
            .iter()
            .find(|entry| entry["id"] == "volcengine/deepseek")
            .expect("the default account keeps the plain id");
        assert_eq!(default["primary"], true);
        assert_eq!(default["credential"]["id"], "cred_b");
        assert_eq!(default["account"]["label"], "default");
        assert_eq!(default["account"]["default"], true);
        assert_eq!(default["account"]["model_key"], "volcengine/deepseek");
        let named = entries
            .iter()
            .find(|entry| entry["id"] == "volcengine/deepseek@work")
            .expect("the named account gets its own route");
        assert_eq!(named["primary"], false);
        assert_eq!(named["credential"]["id"], "cred_a");
        assert_eq!(named["account"]["label"], "work");
        assert_eq!(named["account"]["default"], false);
        assert_eq!(named["model"], "deepseek");
    }

    /// A key stored for a provider the configuration never names is the
    /// operator asking for that provider's models. It used to route nothing
    /// outside the native single-binary start, so the provider stayed
    /// unconfigured however often the key was re-entered.
    #[test]
    fn a_stored_key_routes_a_provider_the_config_never_names() {
        let directory = tempfile::tempdir().unwrap();
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
                "INSERT INTO credential VALUES ('cred_zhipu', 'zhipuai-coding-plan', 'default', '{\"type\":\"key\",\"key\":\"sk-test\"}')",
                [],
            )
            .unwrap();
        let snapshot = json!({
            "zhipuai-coding-plan": {
                "name": "Zhipu AI Coding Plan",
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://open.bigmodel.cn/api/coding/paas/v4",
                "models": {
                    "glm-5.3": {
                        "tool_call": true,
                        "modalities": { "input": ["text"], "output": ["text"] },
                        "limit": { "context": 1000000, "output": 131072 },
                    },
                    "glm-image": {
                        "modalities": { "input": ["text"], "output": ["image"] },
                    },
                },
            },
        });
        let entries = snapshot_key_routes(&snapshot, &serde_json::Map::new(), Some(&database));
        // Only the model that answers in text becomes a route.
        assert_eq!(
            entries.len(),
            1,
            "{}",
            serde_json::to_string(&entries).unwrap()
        );
        let entry = &entries[0];
        assert_eq!(entry["id"], "zhipuai-coding-plan/glm-5.3");
        assert_eq!(entry["provider"], "openai-chat");
        assert_eq!(
            entry["endpoint"],
            "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
        );
        assert_eq!(entry["credential"]["id"], "cred_zhipu");
        assert_eq!(entry["credential"]["integration"], "zhipuai-coding-plan");
        // The primary is the launcher's decision: a catalog route never claims
        // it, so a configured default stays the default.
        assert_eq!(entry.get("primary"), None);
    }

    /// The configuration owns the providers it names. A stored key for the
    /// same integration must not add a second route under an id the config
    /// already routes.
    #[test]
    fn a_declared_provider_is_left_to_the_configuration() {
        let directory = tempfile::tempdir().unwrap();
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
                "INSERT INTO credential VALUES ('cred_volcengine', 'volcengine', 'default', '{\"type\":\"key\",\"key\":\"sk-test\"}')",
                [],
            )
            .unwrap();
        let snapshot = json!({
            "volcengine": {
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://ark.example.com/api/v3",
                "models": { "deepseek": { "modalities": { "output": ["text"] } } },
            },
        });
        let mut declared = serde_json::Map::new();
        declared.insert("volcengine".into(), json!({ "models": {} }));
        assert!(snapshot_key_routes(&snapshot, &declared, Some(&database)).is_empty());
    }

    /// A key stored while the TUI runs has to reach the manifest the engine
    /// re-reads on restart. Writing it there is what makes the "restarting the
    /// engine to load its models" notice true instead of another dead end.
    #[test]
    fn a_refreshed_manifest_gains_the_stored_keys_routes() {
        let directory = tempfile::tempdir().unwrap();
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
                "INSERT INTO credential VALUES ('cred_zhipu', 'zhipuai-coding-plan', 'default', '{\"type\":\"key\",\"key\":\"sk-test\"}')",
                [],
            )
            .unwrap();
        let path = directory.path().join("routes.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!([{
                "id": "vendor/other",
                "provider": "openai-chat",
                "model": "other",
                "endpoint": "https://vendor.test/v1/chat/completions",
                "primary": true,
            }]))
            .unwrap(),
        )
        .unwrap();
        let snapshot = json!({
            "zhipuai-coding-plan": {
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://open.bigmodel.cn/api/coding/paas/v4",
                "models": { "glm-5.3": { "modalities": { "output": ["text"] } } },
            },
            // The provider the manifest already routes must not be duplicated.
            "vendor": {
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://vendor.test/v1",
                "models": { "other": { "modalities": { "output": ["text"] } } },
            },
        });
        let added =
            refresh_snapshot_key_routes(&path, &snapshot, Some(&database)).expect("refreshes");
        assert_eq!(added, 1, "only the new provider's model is appended");
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).expect("valid JSON");
        let ids: Vec<&str> = manifest
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["vendor/other", "zhipuai-coding-plan/glm-5.3"]);
        // Re-running is how a re-entered key behaves: nothing is added twice.
        let again =
            refresh_snapshot_key_routes(&path, &snapshot, Some(&database)).expect("idempotent");
        assert_eq!(again, 0);
        // Deleting the key takes its route with it: the manifest must not keep
        // pointing at a credential that is gone.
        rusqlite::Connection::open(&database)
            .unwrap()
            .execute("DELETE FROM credential", [])
            .unwrap();
        assert_eq!(
            refresh_snapshot_key_routes(&path, &snapshot, Some(&database)).expect("prunes"),
            1
        );
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).expect("valid JSON");
        let ids: Vec<&str> = manifest
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .collect();
        // The catalog route lost its credential and went with it; a manifest
        // entry that names no credential (an operator's own route) is not ours
        // to drop.
        assert_eq!(ids, vec!["vendor/other"]);
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

    /// OpenCode's gateway refuses a turn that does not name its conversation
    /// (400 MissingSessionID), so a derived `opencode-go` route has to carry
    /// the Session-bound header, and only that provider's routes do.
    #[test]
    fn an_opencode_go_route_carries_the_session_header() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("miao.json"),
            serde_json::to_string(&json!({
                "model": "opencode-go/deepseek",
                "providers": {
                    "opencode-go": {
                        "models": {
                            "deepseek": {
                                "api": {
                                    "type": "aisdk",
                                    "package": "@ai-sdk/openai-compatible",
                                    "url": "https://opencode.ai/inference/go/openai/v1",
                                },
                            }
                        }
                    },
                    "vendor": {
                        "models": {
                            "other": {
                                "api": {
                                    "type": "aisdk",
                                    "package": "@ai-sdk/openai-compatible",
                                    "url": "https://vendor.test/v1",
                                },
                            }
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
                "INSERT INTO credential VALUES ('cred_go', 'opencode-go', 'default', '{\"kind\":\"key\"}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO credential VALUES ('cred_vendor', 'vendor', 'default', '{\"kind\":\"key\"}')",
                [],
            )
            .unwrap();
        let entries = routes(
            &[Source::Dir(directory.path().to_path_buf())],
            Some(&database),
        )
        .unwrap()
        .unwrap();
        let gateway = entries
            .iter()
            .find(|entry| entry["id"] == "opencode-go/deepseek")
            .expect("a gateway route");
        assert_eq!(
            gateway["auth"]["headers"]["x-opencode-session"],
            "$session",
            "{}",
            serde_json::to_string(&gateway).unwrap()
        );
        let vendor = entries
            .iter()
            .find(|entry| entry["id"] == "vendor/other")
            .expect("a configured route");
        assert!(
            vendor.get("auth").is_none(),
            "{}",
            serde_json::to_string(&vendor).unwrap()
        );
    }

    /// The catalog half of the derivation routes a provider the configuration
    /// never names, and the gateway among them needs the same Session header.
    #[test]
    fn a_snapshot_gateway_route_names_the_session_too() {
        let directory = tempfile::tempdir().unwrap();
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
                "INSERT INTO credential VALUES ('cred_go', 'opencode-go', 'default', '{\"type\":\"key\",\"key\":\"sk-test\"}')",
                [],
            )
            .unwrap();
        let snapshot = json!({
            "opencode-go": {
                "name": "OpenCode Go",
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://opencode.ai/inference/go/openai/v1",
                "models": {
                    "deepseek": {
                        "modalities": { "input": ["text"], "output": ["text"] },
                    },
                },
            },
        });
        let entries = snapshot_key_routes(&snapshot, &serde_json::Map::new(), Some(&database));
        assert_eq!(
            entries.len(),
            1,
            "{}",
            serde_json::to_string(&entries).unwrap()
        );
        assert_eq!(
            entries[0]["auth"]["headers"]["x-opencode-session"],
            "$session",
            "{}",
            serde_json::to_string(&entries[0]).unwrap()
        );
    }
}
