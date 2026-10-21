//! Trusted host manifest for exact model routes. Credential bytes are never
//! accepted over controller commands or exposed by the public catalog.
use crate::{
    credential::{Credential, Source},
    model_catalog::Catalog,
    provider::Provider,
};
use serde::Deserialize;
use std::{path::Path, sync::Arc};
use tokio::io::AsyncReadExt;

/// Version of the host route manifest this engine accepts. It moves when a
/// route field is added or its meaning changes, so a product can refuse a
/// manifest the engine cannot read instead of failing at startup.
pub const SCHEMA: u32 = 2;

/// Declared context/output capacity for a route's model, published by the
/// host so role bindings can be capacity-checked before a doomed request.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limit {
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default)]
    pub output: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    id: String,
    provider: String,
    model: String,
    endpoint: Option<String>,
    credential: CredentialSource,
    #[serde(default)]
    prompt_cache: bool,
    #[serde(default)]
    auth: Option<Auth>,
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    request: crate::request_options::Options,
    #[serde(default)]
    variants: Vec<Variant>,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    default_variant: Option<String>,
    #[serde(default)]
    account: Option<crate::model_catalog::Account>,
    #[serde(default)]
    limit: Option<Limit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Variant {
    id: String,
    #[serde(default)]
    body: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
}

/// Declarative auth for a route: wire-level auth style plus trusted host
/// headers and literal query parameters. Secrets still travel through the
/// credential source; these fields never carry one.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub(crate) style: Option<String>,
    #[serde(default)]
    pub(crate) headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) query: std::collections::BTreeMap<String, String>,
}

impl Auth {
    pub(crate) fn validate(&self) -> Result<(), crate::provider::ProviderError> {
        crate::request_options::Options {
            body: Default::default(),
            headers: self.headers.clone(),
        }
        .validate()?;
        if self
            .headers
            .keys()
            .map(|key| key.to_ascii_lowercase())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != self.headers.len()
        {
            return Err(crate::provider::ProviderError::Stream(
                "duplicate host route header".into(),
            ));
        }
        if self.query.len() > 32
            || self.query.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 256
                    || value.len() > 8192
                    || key.chars().any(char::is_control)
                    || value.chars().any(char::is_control)
            })
        {
            return Err(crate::provider::ProviderError::Stream(
                "invalid host route query".into(),
            ));
        }
        Ok(())
    }
    pub(crate) fn apply_headers(&self, target: &mut std::collections::BTreeMap<String, String>) {
        for (name, value) in &self.headers {
            target.retain(|key, _| !key.eq_ignore_ascii_case(name));
            target.insert(name.clone(), value.clone());
        }
    }
    pub(crate) fn query_string(&self) -> Result<Option<String>, crate::provider::ProviderError> {
        if self.query.is_empty() {
            return Ok(None);
        }
        let mut url = reqwest::Url::parse("http://localhost")
            .map_err(|_| crate::provider::ProviderError::Transport)?;
        url.query_pairs_mut().extend_pairs(self.query.iter());
        Ok(url.query().map(str::to_owned))
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum CredentialSource {
    Aws {
        region: String,
        profile: Option<String>,
    },
    Environment {
        key: String,
        account: Option<String>,
    },
    Database {
        path: std::path::PathBuf,
        id: String,
        integration: String,
    },
    Legacy {
        path: std::path::PathBuf,
        integration: String,
    },
    Daemon {
        path: std::path::PathBuf,
        id: String,
        integration: String,
    },
}

/// The caller protects the canonical manifest path alongside all provider
/// credential paths. Reject workspace-owned configuration before reading it.
/// Per-model capacity declared by the host manifest, consulted before a
/// role-bound request is attempted.
#[derive(Debug, Clone, Default)]
pub struct RouteLimits {
    limits: std::collections::BTreeMap<String, Limit>,
}

impl RouteLimits {
    pub fn context_limit_for(&self, model: &str) -> Option<u64> {
        self.limits.get(model).and_then(|limit| limit.context)
    }
}

pub async fn load(
    path: &Path,
    workspace: &Path,
    mut primary: Arc<dyn Provider>,
) -> Result<(Arc<dyn Provider>, RouteLimits), Box<dyn std::error::Error>> {
    if path.starts_with(workspace) {
        return Err("Model routes host config must be outside model-writable workspace".into());
    }
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 1024 * 1024 {
        return Err("Model routes config exceeds 1 MiB".into());
    }
    let entries = serde_json::from_slice::<Vec<Route>>(&bytes)
        .map_err(|_| "invalid Model routes host config")?;
    if entries.len() > crate::model_catalog::MAX_ROUTES {
        return Err("model route catalog exceeds 1024 entries".into());
    }
    let mut limits = std::collections::BTreeMap::new();
    let mut routes = Vec::new();
    let mut variants = Vec::new();
    let mut primary_variants = Vec::new();
    let mut default_seen = false;
    let mut accounts = Vec::new();
    let mut primary_account_route = None;
    for entry in entries {
        if let Some(limit) = entry.limit {
            limits.insert(entry.model.clone(), limit);
        }
        if let Some(account) = entry.account {
            if entry.primary {
                primary_account_route = Some(entry.id.clone());
            }
            accounts.push((entry.id.clone(), account));
        }
        let source = match entry.credential {
            CredentialSource::Aws { region, profile } => Source::Aws { region, profile },
            CredentialSource::Environment { key, account } => {
                let secret = std::env::var(key)
                    .map_err(|_| "route credential environment variable is missing")?;
                if entry.provider == "subscription-responses" {
                    Source::Static(Credential::token(
                        secret,
                        account
                            .map(std::env::var)
                            .transpose()
                            .map_err(|_| "route account environment variable is missing")?,
                    ))
                } else {
                    if account.is_some() {
                        return Err(
                            "route account is only supported for subscription-responses".into()
                        );
                    }
                    Source::Static(Credential::key(secret))
                }
            }
            CredentialSource::Database {
                path,
                id,
                integration,
            } => Source::Database {
                path: tokio::fs::canonicalize(path).await?,
                id,
                integration,
            },
            CredentialSource::Legacy { path, integration } => Source::Legacy {
                path: tokio::fs::canonicalize(path).await?,
                integration,
            },
            CredentialSource::Daemon {
                path,
                id,
                integration,
            } => Source::Daemon {
                #[cfg(unix)]
                socket: tokio::fs::canonicalize(path).await?,
                #[cfg(windows)]
                socket: path,
                id,
                integration,
            },
        };
        if source
            .path()
            .is_some_and(|path| path.starts_with(workspace))
        {
            return Err("model route credentials must be outside workspace".into());
        }
        source.validate().await?;
        let provider = crate::routing::build_with_auth(
            &entry.provider,
            entry.endpoint.as_deref(),
            source,
            entry.model,
            entry.prompt_cache,
            entry.auth.as_ref(),
        )?;
        if entry.provider == "amazon-bedrock" {
            crate::bedrock::validate_credential_paths(provider.protected_resources(), workspace)
                .await?;
        }
        let provider = if entry.input_modalities.is_empty() {
            provider
        } else {
            provider.with_input_modalities(entry.input_modalities.clone())?
        };
        entry.request.validate()?;
        if entry.primary {
            if default_seen || primary.identity() != provider.identity() {
                return Err("invalid default model route".into());
            }
            default_seen = true;
            if let Some(auth) = entry.auth.as_ref() {
                primary = primary.with_route_auth(auth)?;
            }
            if !entry.input_modalities.is_empty() {
                primary = primary.with_input_modalities(entry.input_modalities.clone())?;
            }
        }
        let mut default_provider = if entry.request.is_empty() {
            Arc::clone(&provider)
        } else {
            provider.with_request_options(entry.request.clone())?
        };
        let mut default_primary = if entry.primary {
            Some(if entry.request.is_empty() {
                Arc::clone(&primary)
            } else {
                primary.with_request_options(entry.request.clone())?
            })
        } else {
            None
        };
        let mut matched_default = entry.default_variant.is_none();
        for variant in entry.variants {
            let options = entry.request.merged(&crate::request_options::Options {
                body: variant.body,
                headers: variant.headers,
            })?;
            let selected = if options.is_empty() {
                Arc::clone(&provider)
            } else {
                provider.with_request_options(options.clone())?
            };
            if entry.primary {
                let selected = if options.is_empty() {
                    Arc::clone(&primary)
                } else {
                    primary.with_request_options(options)?
                };
                if entry.default_variant.as_deref() == Some(variant.id.as_str()) {
                    default_primary = Some(Arc::clone(&selected));
                }
                primary_variants.push((variant.id.clone(), selected));
            }
            if entry.default_variant.as_deref() == Some(variant.id.as_str()) {
                matched_default = true;
                default_provider = Arc::clone(&selected);
            }
            variants.push((entry.id.clone(), variant.id, selected));
        }
        if !matched_default {
            return Err("default model variant is not registered".into());
        }
        if let Some(default) = default_primary {
            primary = default;
        }
        routes.push((entry.id, default_provider));
    }
    let provider = Arc::new(
        Catalog::new(primary, routes)?
            .with_variants(variants, primary_variants)?
            .with_accounts(accounts, primary_account_route)?,
    );
    Ok((provider, RouteLimits { limits }))
}
