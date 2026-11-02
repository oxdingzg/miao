//! Serve/acp setup, lifted out of the binary so an in-process caller can
//! build the same Runtime the `serve` subcommand builds.
//!
//! Everything here used to live inside `main.rs`; the paths are unchanged
//! (`miao_engine::…` resolves through the crate self-alias in `lib.rs`).

use miao_engine::{
    credential::{Credential, Source},
    permission::{Mode, Policy},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use std::{collections::HashMap, error::Error, sync::Arc};

/// A Runtime configured exactly as the `serve` subcommand configures it.
pub struct Configured {
    pub runtime: crate::runtime::Runtime,
    pub options: HashMap<String, String>,
    pub acp: bool,
}

/// Where the product keeps credentials when the operator names no source. The
/// single-binary start has no host to pass `--credential-db`, so the engine
/// looks where the product installs write.
fn stored_default() -> Option<std::path::PathBuf> {
    let root = std::env::var_os("MIAO_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_DATA_HOME").map(|dir| std::path::PathBuf::from(dir).join("miao"))
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join(".local/share/miao"))
        })?;
    let path = root.join("miao.db");
    path.is_file().then_some(path)
}

/// The one unexpired credential stored for `integration`. A credential that is
/// expired is skipped rather than used: its owning broker has to refresh it
/// first, and that refusal is the existing, named error.
fn stored_credential(
    path: &std::path::Path,
    integration: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let candidates: Vec<crate::credential::Metadata> = crate::credential::list_database(path)?
        .into_iter()
        .filter(|credential| credential.integration == integration && !credential.expired)
        .collect();
    match candidates.len() {
        1 => Ok(candidates.into_iter().next().expect("one candidate").id),
        0 => Err(format!(
            "no unexpired credential is stored for {integration}; pass --credential-id or set an API key"
        )
        .into()),
        _ => Err(format!(
            "several unexpired credentials are stored for {integration}; pass --credential-id to choose one"
        )
        .into()),
    }
}

/// The configuration sources this start reads, when it names any.
fn config_sources(
    options: &HashMap<String, String>,
) -> Result<Option<Vec<miao_engine::config_derive::Source>>, Box<dyn std::error::Error + Send + Sync>>
{
    let sources = match options.get("--config-sources") {
        Some(plan) => miao_engine::config_derive::plan(plan)?,
        None => match options.get("--config-dir") {
            Some(directory) => vec![miao_engine::config_derive::Source::Dir(
                std::path::PathBuf::from(directory),
            )],
            None => return Ok(None),
        },
    };
    Ok(Some(sources))
}

/// The model the configuration asks for, used when this start names none: a
/// single binary is started from the operator's configuration, not from a host
/// that hands it a model name.
fn configured_model(
    options: &HashMap<String, String>,
) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
    let Some(sources) = config_sources(options)? else {
        return Ok(None);
    };
    let documents = miao_engine::config_derive::load(&sources)?;
    Ok(documents.iter().rev().find_map(|document| {
        document
            .value
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }))
}

/// The transport and endpoint a provider declares in configuration, used when a
/// start names only its model. `--provider` and `--endpoint` still win over it,
/// and an unknown package stays unresolved rather than guessing a protocol.
async fn configured_route(
    options: &HashMap<String, String>,
    provider: Option<&str>,
    model: &str,
) -> Result<Option<(String, Option<String>)>, Box<dyn std::error::Error + Send + Sync>> {
    let Some(provider) = provider else {
        return Ok(None);
    };
    if options.contains_key("--provider") && options.contains_key("--endpoint") {
        return Ok(None);
    }
    let Some(sources) = config_sources(options)? else {
        return Ok(None);
    };
    let documents = miao_engine::config_derive::load(&sources)?;
    let api = documents.iter().rev().find_map(|document| {
        document
            .value
            .get("providers")?
            .get(provider)?
            .get("models")?
            .get(model)?
            .get("api")
            .cloned()
    });
    let Some(api) = api else {
        return Ok(None);
    };
    let Some(transport) = api
        .get("package")
        .and_then(serde_json::Value::as_str)
        .and_then(transport_for_package)
    else {
        return Ok(None);
    };
    let endpoint = api
        .get("url")
        .and_then(serde_json::Value::as_str)
        .map(|url| endpoint_for(url, transport));
    Ok(Some((transport.to_string(), endpoint)))
}

/// The engine transport an aisdk package maps to. The single-model resolution
/// and the generated routes manifest must agree, so they share one table.
fn transport_for_package(package: &str) -> Option<&'static str> {
    match package {
        "@ai-sdk/anthropic" => Some("anthropic"),
        "@ai-sdk/google" | "@ai-sdk/google-vertex" => Some("gemini"),
        "@ai-sdk/openai" | "@ai-sdk/openai-compatible" => Some("openai-chat"),
        _ => None,
    }
}

/// The request URL for a transport over the configured base URL.
fn endpoint_for(url: &str, transport: &str) -> String {
    let base = url.trim_end_matches('/');
    match transport {
        "openai-chat" => format!("{base}/chat/completions"),
        "anthropic" => format!("{base}/messages"),
        _ => base.to_string(),
    }
}

/// The full model list the configuration names, as a generated routes
/// manifest. A standalone start answers the model picker the way the product
/// host answers: every provider entry that carries a transport and an
/// unexpired stored credential contributes its models, and the configured
/// default model's route is the primary. A provider or model without a
/// usable transport or credential steps aside instead of failing the start.
///
/// The manifest lives in one temporary file so a `config_reload` re-reads
/// exactly what startup served; the caller protects the path alongside the
/// credential stores.
pub async fn config_routes_manifest(
    options: &HashMap<String, String>,
    database: Option<&std::path::Path>,
) -> Result<Option<std::path::PathBuf>, Box<dyn Error + Send + Sync>> {
    let Some(database) = database else {
        return Ok(None);
    };
    let Some(sources) = config_sources(options)? else {
        return Ok(None);
    };
    // The default model ref names the primary route the same way the
    // operator's `--model` does.
    let default_model = options
        .get("--model")
        .cloned()
        .or_else(|| configured_model(options).ok().flatten());
    let mut credentials: std::collections::BTreeMap<String, Vec<crate::credential::Metadata>> =
        std::collections::BTreeMap::new();
    for entry in crate::credential::list_database(database)? {
        // A generic chat route carries a key. OAuth grants (ChatGPT, Gemini,
        // Copilot) speak their own transports and wait for their own routes.
        if !entry.expired && entry.kind == "key" {
            credentials
                .entry(entry.integration.clone())
                .or_default()
                .push(entry);
        }
    }
    let normalized = miao_engine::config_derive::normalized_from_sources(&sources)?;
    let providers = match normalized.get("providers").and_then(serde_json::Value::as_object) {
        Some(map) if !map.is_empty() => map,
        _ => return Ok(None),
    };
    let mut entries = Vec::new();
    for (provider_id, provider) in providers {
        if provider.get("disabled").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        let Some(stored) = credentials
            .get(provider_id.as_str())
            .filter(|list| !list.is_empty())
        else {
            continue;
        };
        let models = match provider.get("models").and_then(serde_json::Value::as_object) {
            Some(map) => map,
            None => continue,
        };
        let provider_api = provider.get("api").filter(|api| !api.is_null());
        for (model_id, model) in models {
            // Mirror the product's picker: a model without tool calling never
            // reaches a coding Session.
            let capabilities = model.get("capabilities");
            if !capabilities
                .and_then(|caps| caps.get("tools"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let api = model
                .get("api")
                .filter(|api| !api.is_null())
                .or(provider_api);
            let Some(transport) = api
                .and_then(|api| api.get("package"))
                .and_then(serde_json::Value::as_str)
                .and_then(transport_for_package)
            else {
                continue;
            };
            let url = api
                .and_then(|api| api.get("url"))
                .and_then(serde_json::Value::as_str);
            // A base URL is what makes an openai-compatible entry routable;
            // the default-endpoint transports can stand without one.
            if url.is_none() && transport != "anthropic" {
                continue;
            }
            let endpoint = url.map(|url| endpoint_for(url, transport));
            let model_ref = format!("{provider_id}/{model_id}");
            let input = capabilities
                .and_then(|caps| caps.get("input"))
                .and_then(serde_json::Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (index, credential) in stored.iter().enumerate() {
                let primary = index == 0
                    && default_model.as_deref().is_some_and(|default| {
                        default == model_ref.as_str()
                    });
                let id = if index == 0 {
                    model_ref.clone()
                } else {
                    use sha2::Digest;
                    let digest = sha2::Sha256::digest(serde_json::to_vec(&serde_json::json!([
                        provider_id, model_id, credential.id,
                    ]))?);
                    let mut hex = String::with_capacity(digest.len() * 2);
                    for byte in digest {
                        hex.push_str(&format!("{byte:02x}"));
                    }
                    format!("account/{hex}")
                };
                let mut entry = serde_json::json!({
                    "id": id,
                    "provider": transport,
                    "model": model_id,
                    "credential": {
                        "type": "database",
                        "path": database.display().to_string(),
                        "id": credential.id.clone(),
                        "integration": provider_id,
                    },
                    "account": {
                        "id": credential.id.clone(),
                        "model_key": model_ref,
                        "default": index == 0,
                    },
                });
                if let Some(endpoint) = &endpoint {
                    entry["endpoint"] = serde_json::Value::String(endpoint.clone());
                }
                if primary {
                    entry["primary"] = serde_json::Value::Bool(true);
                }
                let limit = model.get("limit");
                let context = limit
                    .and_then(|limit| limit.get("context"))
                    .and_then(serde_json::Value::as_u64);
                let output = limit
                    .and_then(|limit| limit.get("output"))
                    .and_then(serde_json::Value::as_u64);
                if context.is_some() || output.is_some() {
                    entry["limit"] = serde_json::json!({ "context": context, "output": output });
                }
                if !input.is_empty() {
                    entry["input_modalities"] = serde_json::json!(input);
                }
                entries.push(entry);
            }
        }
    }
    // The credential integrations the configuration does not name still
    // answer the picker the way the product host answers: the catalog
    // snapshot names their transport, endpoint and models, and a stored key
    // credential routes them. Configuration wins where both name a provider.
    if let Some(snapshot) = models_snapshot() {
        let snapshot_providers = match snapshot.as_object() {
            Some(map) => map,
            None => return finish_manifest(entries).await,
        };
        for (provider_id, provider) in snapshot_providers {
            if providers.contains_key(provider_id) {
                continue;
            }
            let Some(stored) = credentials
                .get(provider_id.as_str())
                .filter(|list| !list.is_empty())
            else {
                continue;
            };
            let Some(transport) = provider
                .get("npm")
                .and_then(serde_json::Value::as_str)
                .and_then(transport_for_package)
            else {
                continue;
            };
            let Some(api) = provider.get("api").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let models = match provider.get("models").and_then(serde_json::Value::as_object) {
                Some(map) => map,
                None => continue,
            };
            for (model_id, model) in models {
                // The snapshot describes modalities instead of capabilities;
                // a model that cannot answer in text never reaches a coding
                // Session.
                let produces_text = model
                    .get("modalities")
                    .and_then(|modalities| modalities.get("output"))
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|outputs| outputs.iter().any(|item| item == "text"));
                if !produces_text {
                    continue;
                }
                let model_ref = format!("{provider_id}/{model_id}");
                let input = model
                    .get("modalities")
                    .and_then(|modalities| modalities.get("input"))
                    .and_then(serde_json::Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(serde_json::Value::as_str)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for (index, credential) in stored.iter().enumerate() {
                    let primary = index == 0
                        && default_model.as_deref().is_some_and(|default| default == model_ref);
                    let id = if index == 0 {
                        model_ref.clone()
                    } else {
                        use sha2::Digest;
                        let digest = sha2::Sha256::digest(serde_json::to_vec(&serde_json::json!([
                            provider_id, model_id, credential.id,
                        ]))?);
                        let mut hex = String::with_capacity(digest.len() * 2);
                        for byte in digest {
                            hex.push_str(&format!("{byte:02x}"));
                        }
                        format!("account/{hex}")
                    };
                    let mut entry = serde_json::json!({
                        "id": id,
                        "provider": transport,
                        "model": model_id,
                        "credential": {
                            "type": "database",
                            "path": database.display().to_string(),
                            "id": credential.id.clone(),
                            "integration": provider_id,
                        },
                        "account": {
                            "id": credential.id.clone(),
                            "model_key": model_ref,
                            "default": index == 0,
                        },
                        "endpoint": endpoint_for(api, transport),
                    });
                    if primary {
                        entry["primary"] = serde_json::Value::Bool(true);
                    }
                    let limit = model.get("limit");
                    let context = limit
                        .and_then(|limit| limit.get("context"))
                        .and_then(serde_json::Value::as_u64);
                    let output = limit
                        .and_then(|limit| limit.get("output"))
                        .and_then(serde_json::Value::as_u64);
                    if context.is_some() || output.is_some() {
                        entry["limit"] = serde_json::json!({ "context": context, "output": output });
                    }
                    if !input.is_empty() {
                        entry["input_modalities"] = serde_json::json!(input);
                    }
                    entries.push(entry);
                }
            }
        }
    }
    finish_manifest(entries).await
}

/// Publish the manifest when the derivation found anything routable.
async fn finish_manifest(
    entries: Vec<serde_json::Value>,
) -> Result<Option<std::path::PathBuf>, Box<dyn Error + Send + Sync>> {
    if entries.is_empty() {
        return Ok(None);
    }
    let path = std::env::temp_dir().join(format!("miao-routes-{}.json", std::process::id()));
    tokio::fs::write(&path, serde_json::to_vec(&entries)?).await?;
    Ok(Some(path))
}

/// Test and diagnostic access to the generated manifest derivation.
pub mod test_support {
    pub use super::config_routes_manifest;
}

pub async fn configure(args: &[String]) -> Result<Configured, Box<dyn Error + Send + Sync>> {
    let mode = args.first().map(String::as_str);
    if !matches!(mode, Some("serve" | "acp")) {
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses|gemini|amazon-bedrock] [--endpoint URL] [--policy PATH] [--agent-config PATH] [--config-dir PATH] [--mode read-only|workspace] [--permission-root-db PATH --permission-project ID] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off] [--context-limits JSON] [--http ADDR [--http-token TOKEN]]\n       miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH] [--agent-config PATH] [--config-dir PATH] [--mode read-only|workspace] [--permission-root-db PATH --permission-project ID] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine config explain --config-dir PATH | --config-sources JSON|-\n       miao-engine doctor [--db PATH]\n       miao-engine retention --db PATH [--session ID] [--apply]\n       miao-engine permissions --db PATH --project ID [--directory PATH [--workspace-id ID]]\n       miao-engine permission-source --db PATH --project ID --directory PATH\nUse ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY for the selected provider. Bedrock uses AWS_BEARER_TOKEN_BEDROCK or the AWS SDK credential chain (--aws-region/--aws-profile). An explicit engine database is required.");
        std::process::exit(2);
    }
    let acp = mode == Some("acp");
    let mut options = HashMap::new();
    let (flags, remainder) = args[1..].as_chunks::<2>();
    for flag in flags {
        if ![
            "--db",
            "--workspace",
            "--model",
            "--endpoint",
            "--fallback-model",
            "--fallback-endpoint",
            "--provider",
            "--policy",
            "--agent-config",
            "--config-dir",
            "--config-sources",
            "--mode",
            "--edit-recovery",
            "--verify-command",
            "--prompt-cache",
            "--responses-cache-contract",
            "--responses-websocket-contract",
            "--tool-disclosure",
            "--tool-replay",
            "--mcp-config",
            "--lsp-config",
            "--formatter-config",
            "--lsp-diagnostics",
            "--context-limits",
            "--hooks-config",
            "--context-config",
            "--workspace-instructions",
            "--skills-config",
            "--references-config",
            "--model-routes-config",
            "--product-tools",
            "--worker-config",
            "--credential-db",
            "--credential-id",
            "--credential-integration",
            "--aws-region",
            "--aws-profile",
            "--credential-socket",
            "--auth-file",
            "--http",
            "--http-token",
            "--http-idle-ms",
            "--permission-root-db",
            "--permission-project",
        ]
        .contains(&flag[0].as_str())
            || options.insert(flag[0].clone(), flag[1].clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    if !remainder.is_empty() {
        return Err("missing option value".into());
    }
    // The native single-binary start has no host to materialize a route
    // manifest, so the engine derives one from the operator's config and the
    // product credential store — the same plan the product's shim used to
    // build. An explicit `--model` or `--provider` keeps the operator's own
    // single-route selection, and a manifest the host passed wins outright.
    if !options.contains_key("--model-routes-config")
        && !options.contains_key("--model")
        && !options.contains_key("--provider")
    {
        if let Some(sources) = config_sources(&options)? {
            match miao_engine::native_routes::materialize(&sources, stored_default().as_deref()) {
                Ok(Some(path)) => {
                    options.insert("--model-routes-config".into(), path.display().to_string());
                }
                Ok(None) => {}
                Err(error) => eprintln!("miao-engine native routes: {error}"),
            }
        }
    }
    if options.contains_key("--permission-root-db") != options.contains_key("--permission-project")
    {
        return Err(
            "--permission-root-db and --permission-project must be selected together".into(),
        );
    }
    let db = options.get("--db").ok_or("--db is required")?;
    let workspace = options
        .get("--workspace")
        .ok_or("--workspace is required")?;
    // One directory, one Location: the workspace string reaches
    // engine_location.root, the tools' working directory, and every permission
    // boundary, so it is normalised once here instead of spelled differently
    // at each consumer. CFG-06.
    let workspace = miao_engine::placement::identity(std::path::Path::new(workspace))
        .display()
        .to_string();
    let model = match options.get("--model") {
        Some(model) => model.clone(),
        None => configured_model(&options)?.ok_or("--model is required")?,
    };
    // A `provider/model` value also names the host-side provider, which is what a
    // credential is stored under: `volcengine/deepseek-v4-1` bills the volcengine
    // credential even though the transport underneath is OpenAI-compatible.
    let model_provider = model
        .split_once('/')
        .map(|(prefix, _)| prefix.to_owned())
        .filter(|prefix| !prefix.is_empty());
    let bare_model = match model.split_once('/') {
        Some((_, bare)) => bare.to_owned(),
        None => model.to_owned(),
    };
    // Naming only the model is enough: the transport and endpoint then come from
    // the provider's entry in configuration, exactly where the product's route
    // plan read them.
    let configured = configured_route(&options, model_provider.as_deref(), &bare_model).await?;
    let provider_name = options
        .get("--provider")
        .map(String::as_str)
        .map(str::to_owned)
        .or_else(|| configured.as_ref().map(|(transport, _)| transport.clone()))
        .unwrap_or_else(|| "anthropic".to_string());
    let provider_name = provider_name.as_str();
    // A prefix that resolved to a configured provider is the host-side provider,
    // so the model is the bare id. A prefix that resolves to nothing is part of
    // the model name and stays whole (`fixture/fixture`).
    let named_provider = configured.is_some();
    let endpoint: Option<String> = options
        .get("--endpoint")
        .cloned()
        .or_else(|| configured.and_then(|(_, endpoint)| endpoint));
    // A `provider/model` --model value names the provider for host-side
    // routing; when the provider is given explicitly (the acp mode always
    // does), the transport wants the bare model id, mirroring serve-mode
    // route resolution.
    let model: String = match model.split_once('/') {
        Some((prefix, bare)) if prefix == provider_name => bare.to_owned(),
        Some(_) if named_provider => bare_model,
        _ => model,
    };
    if ![
        "anthropic",
        "openai-chat",
        "openai-responses",
        "subscription-responses",
        "gemini",
        "amazon-bedrock",
    ]
    .contains(&provider_name)
    {
        return Err("unknown provider".into());
    }
    if provider_name != "amazon-bedrock"
        && (options.contains_key("--aws-region") || options.contains_key("--aws-profile"))
    {
        return Err("AWS selection is only supported by amazon-bedrock".into());
    }
    let integration = options
        .get("--credential-integration")
        .cloned()
        .or_else(|| {
            model_provider
                .clone()
                .filter(|prefix| prefix != provider_name)
        })
        .unwrap_or_else(|| match provider_name {
            "anthropic" => "anthropic".into(),
            "amazon-bedrock" => "amazon-bedrock".into(),
            "gemini" => "google".into(),
            "openai-chat" | "openai-responses" | "subscription-responses" => "openai".into(),
            // The product names a third-party provider's integration after the
            // provider itself (`provider.integrationID ?? provider.id`), which is
            // where a route like volcengine stores its credential.
            other => other.to_string(),
        });
    if options.contains_key("--credential-db") && options.contains_key("--auth-file") {
        return Err("select only one credential source".into());
    }
    if options.contains_key("--credential-socket")
        && (options.contains_key("--credential-db") || options.contains_key("--auth-file"))
    {
        return Err("select only one credential source".into());
    }
    let source = if let Some(socket) = options.get("--credential-socket") {
        Source::Daemon {
            #[cfg(unix)]
            socket: tokio::fs::canonicalize(socket).await?,
            #[cfg(windows)]
            socket: std::path::PathBuf::from(socket),
            id: options
                .get("--credential-id")
                .ok_or("--credential-id is required")?
                .clone(),
            integration,
        }
    } else if let Some(path) = options.get("--credential-db") {
        let path = tokio::fs::canonicalize(path).await?;
        // Naming the database is enough: a host that does not choose between the
        // credentials stored for this integration leaves it to the engine, which
        // refuses to guess when two of them are live.
        let id = match options.get("--credential-id") {
            Some(id) => id.clone(),
            None => stored_credential(&path, &integration)?,
        };
        Source::Database {
            path,
            id,
            integration,
        }
    } else if let Some(path) = options.get("--auth-file") {
        if options.contains_key("--credential-id") {
            return Err("credential-id requires a database or socket source".into());
        }
        Source::Legacy {
            path: tokio::fs::canonicalize(path).await?,
            integration,
        }
    } else {
        // A selection without a source resolves against the store the product
        // installation writes, which is what a single-binary start has.
        if (options.contains_key("--credential-id")
            || options.contains_key("--credential-integration"))
            && stored_default().is_none()
        {
            return Err("credential selection requires a file, database, or socket source".into());
        }
        if provider_name == "amazon-bedrock" {
            match std::env::var("AWS_BEARER_TOKEN_BEDROCK") {
                Ok(token) => Source::Static(Credential::key(token)),
                Err(_) => Source::Aws {
                    region: options
                        .get("--aws-region")
                        .cloned()
                        .or_else(|| std::env::var("AWS_REGION").ok())
                        .unwrap_or_else(|| "us-east-1".into()),
                    profile: options
                        .get("--aws-profile")
                        .cloned()
                        .or_else(|| std::env::var("AWS_PROFILE").ok()),
                },
            }
        } else if provider_name == "subscription-responses" {
            Source::Static(Credential::token(
                std::env::var("OPENAI_ACCESS_TOKEN")
                    .map_err(|_| "OPENAI_ACCESS_TOKEN is required")?,
                std::env::var("OPENAI_ACCOUNT_ID").ok(),
            ))
        } else {
            let name = if provider_name == "anthropic" {
                "ANTHROPIC_API_KEY"
            } else if provider_name == "gemini" {
                "GEMINI_API_KEY"
            } else {
                "OPENAI_API_KEY"
            };
            // An exported key is the operator's own override, so it wins. Without
            // one, a single-binary start reads the product store the installation
            // writes, because it has no host to pass `--credential-db`.
            match std::env::var(name) {
                Ok(key) => Source::Static(Credential::key(key)),
                Err(_) => {
                    let stored = match stored_default() {
                        Some(path) => {
                            let path = tokio::fs::canonicalize(&path).await?;
                            let id = match options.get("--credential-id") {
                                Some(id) => Some(id.clone()),
                                None => stored_credential(&path, &integration).ok(),
                            };
                            id.map(|id| (path, id))
                        }
                        None => None,
                    };
                    match stored {
                        Some((path, id)) => Source::Database {
                            path,
                            id,
                            integration,
                        },
                        None => {
                            return Err("API key or explicit credential source is required".into())
                        }
                    }
                }
            }
        }
    };
    source.validate().await?;
    if options.contains_key("--fallback-endpoint") && !options.contains_key("--fallback-model") {
        return Err("fallback-endpoint requires fallback-model".into());
    }
    if provider_name == "gemini"
        && options.contains_key("--fallback-model")
        && options.contains_key("--endpoint")
        && !options.contains_key("--fallback-endpoint")
    {
        return Err("custom Gemini endpoint requires an explicit fallback-endpoint".into());
    }
    // Prompt caching is a pure win for the transports that consume the flag
    // (Anthropic and Bedrock charge 0.1x for cache reads), so it defaults on;
    // `--prompt-cache off` opts out explicitly.
    let prompt_cache = match options.get("--prompt-cache").map(String::as_str) {
        None | Some("on") => true,
        Some("off") => false,
        Some(_) => return Err("--prompt-cache must be on or off".into()),
    };
    let cache_contract = options
        .get("--responses-cache-contract")
        .map(|value| miao_engine::responses_cache::Contract::from_wire(value))
        .transpose()?;
    let websocket_contract = options
        .get("--responses-websocket-contract")
        .map(|value| miao_engine::responses_websocket::Contract::from_wire(value))
        .transpose()
        .map_err(std::io::Error::other)?;
    let provider = if provider_name == "amazon-bedrock" {
        if cache_contract.is_some() || websocket_contract.is_some() {
            return Err("Responses continuation contracts are unsupported by Bedrock".into());
        }
        miao_engine::routing::build_bedrock(
            endpoint.as_deref(),
            source.clone(),
            model.clone(),
            options.get("--aws-region").map(String::as_str),
            prompt_cache,
        )?
    } else {
        miao_engine::routing::build_with_responses(
            provider_name,
            endpoint.as_deref(),
            source.clone(),
            model.clone(),
            prompt_cache,
            cache_contract,
            websocket_contract,
        )?
    };
    let provider: Arc<dyn Provider> = if let Some(model) = options.get("--fallback-model") {
        let endpoint = options.get("--fallback-endpoint").or_else(|| {
            if provider_name == "gemini" {
                None
            } else {
                endpoint.as_ref()
            }
        });
        let fallback = if provider_name == "amazon-bedrock" {
            miao_engine::routing::build_bedrock(
                endpoint.map(String::as_str),
                source.clone(),
                model.clone(),
                options.get("--aws-region").map(String::as_str),
                prompt_cache,
            )?
        } else {
            miao_engine::routing::build(
                provider_name,
                endpoint.map(String::as_str),
                source.clone(),
                model.clone(),
                prompt_cache,
            )?
        };
        Arc::new(miao_engine::routing::Fallback::new(provider, fallback)?)
    } else {
        provider
    };
    // An explicit flag wins over both the entry default and the policy file,
    // so an operator can keep a shared policy and pick the mode per launch.
    let mode = match options.get("--mode").map(String::as_str) {
        None => None,
        Some("read-only" | "read_only") => Some(Mode::ReadOnly),
        Some("workspace") => Some(Mode::Workspace),
        Some(other) => {
            return Err(format!("unknown --mode `{other}`, expected read-only or workspace").into())
        }
    };
    // Where the base policy comes from. Kept for the process lifetime so
    // `config_reload` derives it from exactly the sources startup used.
    let policy_origin = if let Some(path) = options.get("--policy") {
        miao_engine::config_derive::PolicyOrigin::File(path.into())
    } else if let Some(json) = options.get("--config-sources") {
        // The host forwards the ordered config source plan it resolved for
        // this Location, so the project chain overrides the global directory
        // exactly the way the product applies them. The plan supersedes the
        // single-directory fallback, which only sees the global files.
        miao_engine::config_derive::PolicyOrigin::Sources(miao_engine::config_derive::plan(json)?)
    } else if let Some(directory) = options.get("--config-dir") {
        // No explicit operator policy: derive the product policy from the
        // config directory and the environment the host forwarded, the way
        // the product used to before materializing a temporary file.
        miao_engine::config_derive::PolicyOrigin::Directory(directory.into())
    } else {
        miao_engine::config_derive::PolicyOrigin::Entry { acp }
    };
    let policy = Policy::new(policy_origin.derive(mode)?)?;
    let mut tools = Tools::new(workspace)
        .await?
        .with_workspace_instructions(
            match options.get("--workspace-instructions").map(String::as_str) {
                None | Some("true") => true,
                Some("false") => false,
                Some(_) => return Err("--workspace-instructions must be true or false".into()),
            },
        )
        .with_process_runner(std::env::current_exe()?)
        .with_edit_recovery(match options.get("--edit-recovery").map(String::as_str) {
            None | Some("on") => true,
            Some("off") => false,
            Some(_) => return Err("--edit-recovery must be on or off".into()),
        })
        .with_lsp_diagnostics(match options.get("--lsp-diagnostics").map(String::as_str) {
            None | Some("on") => true,
            Some("off") => false,
            Some(_) => return Err("--lsp-diagnostics must be on or off".into()),
        });
    let mut route_limits = miao_engine::model_routes::RouteLimits::default();
    let mut model_origin = None;
    // An operator who names a route, a transport, or a credential source has
    // said exactly what this start serves; the generated manifest is for the
    // standalone start that only names configuration.
    let operator_named_route = ["--model-routes-config", "--provider", "--endpoint", "--credential-db", "--auth-file", "--credential-id", "--credential-integration", "--credential-socket"]
        .iter()
        .any(|flag| options.contains_key(*flag));
    let provider = if let Some(path) = options.get("--model-routes-config") {
        let path = tokio::fs::canonicalize(path).await?;
        let workspace = std::path::PathBuf::from(tools.location());
        // Keep the unrouted provider: a reload layers the new manifest over
        // exactly this base instead of re-deriving the operator's flags.
        let base = provider;
        let (provider, route_limits_new) =
            miao_engine::model_routes::load(&path, &workspace, base.clone())
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> {
                    error.to_string().into()
                })?;
        tools = tools.with_protected_resource(&path);
        route_limits = route_limits_new;
        model_origin = Some(miao_engine::model_routes::Origin {
            base,
            path,
            workspace,
        });
        provider
    } else if !operator_named_route {
        // The picker should answer with every configured model, the way the
        // product host answers. A manifest that cannot be derived or loaded
        // keeps the single configured provider: a degraded list beats a
        // start that refuses.
        match config_routes_manifest(&options, stored_default().as_deref()).await {
            Ok(Some(path)) => {
                let workspace = std::path::PathBuf::from(tools.location());
                let base = provider.clone();
                match miao_engine::model_routes::load(&path, &workspace, base.clone()).await {
                    Ok((routed, limits)) => {
                        tools = tools.with_protected_resource(&path);
                        route_limits = limits;
                        model_origin = Some(miao_engine::model_routes::Origin {
                            base,
                            path,
                            workspace,
                        });
                        routed
                    }
                    Err(error) => {
                        eprintln!(
                            "miao-engine generated model routes unavailable: {error}; serving only the configured model"
                        );
                        provider
                    }
                }
            }
            Ok(None) => provider,
            Err(error) => {
                eprintln!(
                    "miao-engine generated model routes unavailable: {error}; serving only the configured model"
                );
                provider
            }
        }
    } else {
        provider
    };
    if provider_name == "amazon-bedrock" {
        miao_engine::bedrock::validate_credential_paths(
            provider.protected_resources(),
            std::path::Path::new(tools.location()),
        )
        .await?;
    }
    if let Some(path) = source.path() {
        if policy.process_enabled() && path.starts_with(std::path::Path::new(tools.location())) {
            return Err("process-enabled credential sources must be outside workspace".into());
        }
        tools = tools.with_protected_resource(path);
    }
    // The five host files that carry context sources, skills, references,
    // hooks and formatters. One origin records their canonical paths, so a
    // reload reads exactly what startup read; one derive validates all of them
    // before any is applied.
    let context_origin = miao_engine::config_derive::ContextOrigin {
        sources: canonical_option(&options, "--context-config").await?,
        skills: canonical_option(&options, "--skills-config").await?,
        references: canonical_option(&options, "--references-config").await?,
        hooks: canonical_option(&options, "--hooks-config").await?,
        formatter: canonical_option(&options, "--formatter-config").await?,
    };
    for path in context_origin.files() {
        tools = tools.with_protected_resource(&path);
    }
    context_origin
        .derive(std::path::Path::new(tools.location()))?
        .apply(&tools);
    tools =
        tools.with_compact_disclosure(match options.get("--tool-disclosure").map(String::as_str) {
            None | Some("full") => false,
            Some("compact") => true,
            Some(_) => return Err("--tool-disclosure must be full or compact".into()),
        });
    if let Some(path) = options.get("--worker-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Worker host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Worker config exceeds 64 KiB".into());
        }
        let config = serde_json::from_slice::<miao_engine::worker::Config>(&bytes)
            .map_err(|_| "invalid Worker host config")?;
        tools = tools.with_protected_resource(&path);
        match miao_engine::worker::Registry::connect(config, std::path::Path::new(tools.location())).await {
            Ok(registry) => tools = tools.with_worker(Arc::new(registry)),
            Err(error) => eprintln!("miao-engine extension worker unavailable: {error}; built-in tools remain available"),
        }
    }
    let mut mcp_origin = None;
    if let Some(raw) = std::env::var_os("MIAO_ENGINE_MCP_SERVERS") {
        // A host that already holds the server list hands it over inline: no
        // temporary file to write, guard, and clean up. An explicit
        // `--mcp-config` still wins, so an operator's on-disk manifest is never
        // silently replaced by a product default.
        if !options.contains_key("--mcp-config") {
            if !policy.mcp_enabled() {
                return Err("MCP config requires explicit workspace allow_mcp authority".into());
            }
            let value: serde_json::Value = serde_json::from_str(&raw.to_string_lossy())
                .map_err(|_| "invalid inline MCP host config")?;
            let origin = miao_engine::config_derive::McpOrigin::Inline(value);
            let registry = miao_engine::mcp::Registry::connect(
                origin.derive()?,
                std::path::Path::new(tools.location()),
            )
            .await?;
            let registry = Arc::new(registry);
            registry.start_watchers();
            tools = tools.with_mcp(registry);
            mcp_origin = Some(origin);
        }
    }
    if let Some(path) = options.get("--mcp-config") {
        if !policy.mcp_enabled() {
            return Err("MCP config requires explicit workspace allow_mcp authority".into());
        }
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("MCP host config must be outside model-writable workspace".into());
        }
        let origin = miao_engine::config_derive::McpOrigin::Manifest(path.clone());
        let registry = miao_engine::mcp::Registry::connect(
            origin.derive()?,
            std::path::Path::new(tools.location()),
        )
        .await?;
        let registry = Arc::new(registry);
        registry.start_watchers();
        tools = tools.with_protected_resource(&path).with_mcp(registry);
        mcp_origin = Some(origin);
    }
    // The origin a reload re-derives from. Every branch below records one, so
    // `config_reload` reads exactly the files startup read.
    let mut lsp_origin = None;
    if let Some(path) = options.get("--lsp-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("LSP host config must be outside model-writable workspace".into());
        }
        let origin = miao_engine::config_derive::LspOrigin::Manifest(path.clone());
        let registry = miao_engine::lsp::Registry::connect(
            origin.derive()?,
            std::path::Path::new(tools.location()),
        )
        .await?;
        tools = tools
            .with_protected_resource(&path)
            .with_lsp(Arc::new(registry));
        lsp_origin = Some(origin);
    } else if let Some(json) = options.get("--config-sources") {
        // Derive the servers from the same ordered plan the policy used, so
        // project-level `lsp` sections override the global directory.
        let origin =
            miao_engine::config_derive::LspOrigin::Sources(miao_engine::config_derive::plan(json)?);
        let configs = origin.derive()?;
        if !configs.is_empty() {
            let registry = miao_engine::lsp::Registry::connect(
                configs,
                std::path::Path::new(tools.location()),
            )
            .await?;
            tools = tools.with_lsp(Arc::new(registry));
        }
        lsp_origin = Some(origin);
    } else if let Some(directory) = options.get("--config-dir") {
        // No explicit LSP manifest: derive the servers from the config
        // directory the way the product used to before materializing one.
        let origin = miao_engine::config_derive::LspOrigin::Directory(directory.into());
        let configs = origin.derive()?;
        if !configs.is_empty() {
            let registry = miao_engine::lsp::Registry::connect(
                configs,
                std::path::Path::new(tools.location()),
            )
            .await?;
            tools = tools.with_lsp(Arc::new(registry));
        }
        lsp_origin = Some(origin);
    }
    let replay = options
        .get("--tool-replay")
        .map(|file| {
            if std::path::Path::new(db).exists() {
                return Err(miao_engine::protocol::Error::Invalid(
                    "native tool replay requires a fresh diagnostic database".into(),
                ));
            }
            miao_engine::tool_replay::ToolReplay::load(std::path::Path::new(file))
        })
        .transpose()?;
    let context_limits = options
        .get("--context-limits")
        .map(|json| miao_engine::context_trigger::ContextLimits::from_wire(json))
        .transpose()?;
    let default_agent = options
        .get("--agent-config")
        .map(|file| {
            if std::fs::metadata(file)?.len() > 4 * 1024 * 1024 {
                return Err(miao_engine::protocol::Error::Invalid(
                    "agent manifest exceeds 4 MiB".into(),
                ));
            }
            let agent: miao_engine::session_agent::AgentManifest =
                serde_json::from_slice(&std::fs::read(file)?)?;
            agent.validate()?;
            Ok::<_, miao_engine::protocol::Error>(agent)
        })
        .transpose()?;
    let runtime = match (
        options.get("--permission-root-db"),
        options.get("--permission-project"),
    ) {
        (Some(root), Some(project)) => {
            if replay.is_some() {
                return Err(
                    "shared permissions cannot use a fresh diagnostic replay database".into(),
                );
            }
            if !tokio::fs::metadata(root).await?.is_file() {
                return Err(
                    "shared permission selection requires an existing Root database".into(),
                );
            }
            let authority = miao_engine::permission_project::Authority::open(root).await?;
            let context = authority
                .project(project.clone())?
                .context(tools.location(), None)
                .await?;
            let source = Store::open(db).await?;
            let binding = context.bind_handoff(&source).await?;
            Runtime::with_shared_permissions_and_agent(
                binding,
                provider,
                tools,
                policy,
                default_agent,
            )
            .await?
        }
        (None, None) => {
            Runtime::with_policy_agent_and_tool_replay(
                Store::open(db).await?,
                provider,
                tools,
                policy,
                replay,
                default_agent,
            )
            .await?
        }
        _ => {
            return Err(
                "--permission-root-db and --permission-project must be selected together".into(),
            )
        }
    };
    if let Some(limits) = context_limits {
        runtime.set_context_limits(Some(limits)).await;
    }
    if let Some(origin) = &lsp_origin {
        runtime.set_lsp_origin(origin.clone()).await;
    }
    if let Some(origin) = &mcp_origin {
        runtime.set_mcp_origin(origin.clone()).await;
    }
    // The origin is recorded even when it names no file: the context section
    // is then supported and simply has nothing to derive.
    runtime.set_context_origin(context_origin.clone()).await;
    if let Some(origin) = &model_origin {
        runtime.set_model_origin(origin.clone()).await?;
    }
    runtime.set_policy_origin(policy_origin.clone(), mode).await;
    // No host watches these files in the standalone entry, so the engine polls
    // them itself; a hosted engine gets an explicit `config_reload`. Both
    // origins contribute: one reload re-derives every section from its source.
    let watched = {
        let mut files = policy_origin.files();
        if let Some(origin) = &lsp_origin {
            files.extend(origin.files());
        }
        if let Some(origin) = &mcp_origin {
            files.extend(origin.files());
        }
        if let Some(origin) = &model_origin {
            files.push(origin.path.clone());
        }
        files.extend(context_origin.files());
        files.sort();
        files.dedup();
        files
    };
    if !watched.is_empty() {
        watch_config(runtime.clone(), watched);
    }
    runtime.set_route_limits(route_limits).await;
    let roles = miao_engine::roles::Bindings {
        summarize: options.get("--role-summarize").cloned(),
        retrieve: options.get("--role-retrieve").cloned(),
        verify: options.get("--role-verify").cloned(),
    };
    if roles.summarize.is_some() || roles.retrieve.is_some() || roles.verify.is_some() {
        runtime.set_role_bindings(roles).await;
    }
    runtime
        .verify_with(options.get("--verify-command").cloned())
        .await;
    Ok(Configured {
        runtime,
        options,
        acp,
    })
}

async fn canonical_option(
    options: &HashMap<String, String>,
    name: &str,
) -> Result<Option<std::path::PathBuf>, Box<dyn std::error::Error + Send + Sync>> {
    match options.get(name) {
        Some(path) => Ok(Some(tokio::fs::canonicalize(path).await?)),
        None => Ok(None),
    }
}

/// Standalone config reload. A hosted engine learns about a configuration
/// change from `config_reload`; the standalone entry has no host to tell it,
/// so it stats the same sources a reload reads.
///
/// Polling rather than an OS watcher is deliberate: network filesystems,
/// container mounts and editors' atomic renames do not deliver consistent
/// events across platforms, while mtime plus size does. A tick that lands
/// while a Session is draining is skipped, so a turn never observes half a
/// change. A failed derivation is reported once and retried only when a file
/// changes again, not on every tick.
fn watch_config(runtime: Runtime, files: Vec<std::path::PathBuf>) {
    tokio::spawn(async move {
        let mut stamp = config_stamp(&files);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let next = config_stamp(&files);
            if next == stamp {
                continue;
            }
            if runtime.is_draining() {
                continue;
            }
            stamp = next;
            match runtime.reload_config().await {
                Ok(report)
                    if report["changed"]
                        .as_array()
                        .is_some_and(|changed| !changed.is_empty()) =>
                {
                    eprintln!("miao-engine configuration reloaded: {}", report["changed"]);
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("miao-engine configuration reload failed: {error}");
                    runtime.announce_config_failure(&error.to_string());
                }
            }
        }
    });
}

/// Per-source `(mtime, size)`, `None` for a missing file. Nanosecond mtimes
/// keep two edits in the same second distinguishable.
fn config_stamp(files: &[std::path::PathBuf]) -> Vec<Option<(u128, u64)>> {
    files
        .iter()
        .map(|path| {
            std::fs::metadata(path).ok().map(|meta| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0);
                (mtime, meta.len())
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `config_stamp` moved here with the CLI; the test that covers it moved
    /// with it so the binary's test build does not reference a function this
    /// module keeps private.
    #[test]
    fn config_stamp_tracks_rewrites_and_absent_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("miao.json");
        let origin = crate::config_derive::LspOrigin::Manifest(path.clone());
        let files = origin.files();
        assert_eq!(config_stamp(&files), vec![None]);
        std::fs::write(&path, "{}").unwrap();
        let first = config_stamp(&files);
        assert!(first[0].is_some());
        std::fs::write(&path, "{ }").unwrap();
        assert_ne!(config_stamp(&files), first);
    }
}
