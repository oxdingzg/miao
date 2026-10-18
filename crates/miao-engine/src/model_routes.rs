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
    request: crate::request_options::Options,
    #[serde(default)]
    variants: Vec<Variant>,
    #[serde(default)]
    primary: bool,
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

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum CredentialSource {
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
pub async fn load(
    path: &Path,
    workspace: &Path,
    mut primary: Arc<dyn Provider>,
) -> Result<Arc<dyn Provider>, Box<dyn std::error::Error>> {
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
    let mut routes = Vec::new();
    let mut variants = Vec::new();
    let mut primary_variants = Vec::new();
    let mut default_seen = false;
    for entry in entries {
        let source = match entry.credential {
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
        source.load().await?;
        let provider = crate::routing::build_with_auth(
            &entry.provider,
            entry.endpoint.as_deref(),
            source,
            entry.model,
            entry.prompt_cache,
            entry.auth.as_ref(),
        )?;
        entry.request.validate()?;
        if entry.primary {
            if default_seen || primary.identity() != provider.identity() {
                return Err("invalid default model route".into());
            }
            default_seen = true;
            if !entry.request.is_empty() {
                primary = primary.with_request_options(entry.request.clone())?;
            }
        }
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
                primary_variants.push((variant.id.clone(), selected));
            }
            variants.push((entry.id.clone(), variant.id, selected));
        }
        let provider = if entry.request.is_empty() {
            provider
        } else {
            provider.with_request_options(entry.request)?
        };
        routes.push((entry.id, provider));
    }
    Ok(Arc::new(
        Catalog::new(primary, routes)?.with_variants(variants, primary_variants)?,
    ))
}
