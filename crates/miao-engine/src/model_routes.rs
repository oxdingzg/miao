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
    primary: Arc<dyn Provider>,
) -> Result<Arc<dyn Provider>, Box<dyn std::error::Error>> {
    if path.starts_with(workspace) {
        return Err("Model routes host config must be outside model-writable workspace".into());
    }
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(65537)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 65536 {
        return Err("Model routes config exceeds 64 KiB".into());
    }
    let entries = serde_json::from_slice::<Vec<Route>>(&bytes)
        .map_err(|_| "invalid Model routes host config")?;
    if entries.len() > 64 {
        return Err("model route catalog exceeds 64 entries".into());
    }
    let mut routes = Vec::new();
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
        routes.push((
            entry.id,
            crate::routing::build(
                &entry.provider,
                entry.endpoint.as_deref(),
                source,
                entry.model,
                entry.prompt_cache,
            )?,
        ));
    }
    Ok(Arc::new(Catalog::new(primary, routes)?))
}
