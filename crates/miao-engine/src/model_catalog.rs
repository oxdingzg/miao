//! Host-owned, exact provider routes. Selecting an id never constructs a new
//! endpoint, credential binding, or model from controller/model-supplied data.
use crate::{
    protocol::ModelRequest,
    provider::{CountTokens, Identity, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const MAX_ROUTES: usize = 1024;

/// The full provider directory the install ships (`models.json`, the same
/// file the TS catalog service reads): an explicit path, a snapshot beside the
/// engine binary, the installer's shipped copy, then the user cache.
pub(crate) fn models_snapshot() -> Option<serde_json::Value> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("MIAO_MODELS_PATH") {
        candidates.push(std::path::PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("models.json"));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        candidates.push(home.join(".miao/bin/models.json"));
        candidates.push(home.join(".local/share/miao/bin/models.json"));
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(std::path::PathBuf::from)
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
/// The context window every catalog entry declares for one model id.
///
/// `models.json` is megabytes and the compaction trigger consults it every
/// turn, so the lookups run against an index built once from the shipped
/// snapshot. The same model id is often served by many providers with
/// different declared windows; the smallest is the one every caller must
/// assume.
pub(crate) fn context_window_in(document: &serde_json::Value, model: &str) -> Option<u64> {
    let mut smallest: Option<u64> = None;
    let mut scan = |probe: &str, smallest: &mut Option<u64>| {
        for provider in document
            .as_object()
            .into_iter()
            .flat_map(|entries| entries.values())
        {
            for (model_id, info) in provider
                .get("models")
                .and_then(|models| models.as_object())
                .into_iter()
                .flatten()
            {
                if model_id != probe {
                    continue;
                }
                let window = info
                    .get("limit")
                    .and_then(|limit| limit.get("context"))
                    .and_then(serde_json::Value::as_u64);
                if let Some(window) = window {
                    *smallest = Some(smallest.map_or(window, |known| known.min(window)));
                }
            }
        }
    };
    scan(model, &mut smallest);
    // Date-suffixed variants (…-261017) share the base model's window: the
    // snapshot indexes the unsuffixed id, so a miss on the pinned id falls
    // back to the family.
    if smallest.is_none() {
        if let Some((base, tail)) = model.rsplit_once('-') {
            if !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()) {
                scan(base, &mut smallest);
            }
        }
    }
    smallest
}

fn window_index() -> &'static std::collections::BTreeMap<String, u64> {
    static INDEX: std::sync::OnceLock<std::collections::BTreeMap<String, u64>> =
        std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = std::collections::BTreeMap::new();
        if let Some(document) = models_snapshot() {
            if let Some(entries) = document.as_object() {
                for (_provider_id, provider) in entries {
                    let Some(models) = provider.get("models").and_then(Value::as_object) else {
                        continue;
                    };
                    for (model_id, info) in models {
                        let Some(window) = info
                            .get("limit")
                            .and_then(|limit| limit.get("context"))
                            .and_then(Value::as_u64)
                        else {
                            continue;
                        };
                        // Several providers serve one id with different declared
                        // windows; the smallest is what every caller must assume.
                        index
                            .entry(model_id.clone())
                            .and_modify(|known: &mut u64| {
                                if window < *known {
                                    *known = window;
                                }
                            })
                            .or_insert(window);
                    }
                }
            }
        }
        index
    })
}

/// The context window the shipped snapshot declares for one model id.
pub(crate) fn context_window_for(model: &str) -> Option<u64> {
    window_index().get(model).copied()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Info {
    pub route_id: Option<String>,
    pub protocol: String,
    pub model: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
}

/// Trusted route metadata. Only logical model and opaque credential identities
/// appear in model_catalog replies; endpoints and secrets remain private. `model_key`
/// is a host-declared logical model family, not inferred from route id syntax.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub id: Option<String>,
    pub model_key: String,
    #[serde(default, rename = "default")]
    pub is_default: bool,
}

pub struct Catalog {
    primary: Arc<dyn Provider>,
    routes: BTreeMap<String, Arc<dyn Provider>>,
    variants: BTreeMap<(String, String), Arc<dyn Provider>>,
    primary_variants: BTreeMap<String, Arc<dyn Provider>>,
    accounts: BTreeMap<String, Account>,
    primary_route: Option<String>,
}
impl Catalog {
    pub fn new(
        primary: Arc<dyn Provider>,
        entries: Vec<(String, Arc<dyn Provider>)>,
    ) -> Result<Self, ProviderError> {
        if entries.len() > MAX_ROUTES {
            return Err(ProviderError::Stream(
                "model route catalog exceeds 1024 entries".into(),
            ));
        }
        let mut routes = BTreeMap::new();
        for (id, provider) in entries {
            if !valid_id(&id) || provider.identity().is_none() {
                return Err(ProviderError::Stream(
                    "invalid model route catalog entry".into(),
                ));
            }
            if routes.insert(id, provider).is_some() {
                return Err(ProviderError::Stream("duplicate model route id".into()));
            }
        }
        Ok(Self {
            primary,
            routes,
            variants: BTreeMap::new(),
            primary_variants: BTreeMap::new(),
            accounts: BTreeMap::new(),
            primary_route: None,
        })
    }

    pub fn with_accounts(
        mut self,
        entries: Vec<(String, Account)>,
        primary_route: Option<String>,
    ) -> Result<Self, ProviderError> {
        let mut defaults = BTreeSet::new();
        let mut identities = BTreeSet::new();
        for (route, account) in entries {
            if !self.routes.contains_key(&route)
                || account.model_key.is_empty()
                || account.model_key.len() > 512
                || account.model_key.chars().any(char::is_control)
                || account.id.as_ref().is_some_and(|id| {
                    id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
                })
                || (account.is_default && !defaults.insert(account.model_key.clone()))
                || (account.id.is_some()
                    && !identities.insert((account.model_key.clone(), account.id.clone())))
                || self.accounts.insert(route, account).is_some()
            {
                return Err(ProviderError::Stream(
                    "invalid or ambiguous account route metadata".into(),
                ));
            }
        }
        if primary_route.as_ref().is_some_and(|route| {
            !self.accounts.contains_key(route)
                || self
                    .routes
                    .get(route)
                    .is_none_or(|provider| provider.identity() != self.primary.identity())
        }) {
            return Err(ProviderError::Stream(
                "default model account route is not registered".into(),
            ));
        }
        self.primary_route = primary_route;
        Ok(self)
    }

    pub fn with_variants(
        mut self,
        entries: Vec<(String, String, Arc<dyn Provider>)>,
        primary: Vec<(String, Arc<dyn Provider>)>,
    ) -> Result<Self, ProviderError> {
        if entries.len() + primary.len() > 8192 {
            return Err(ProviderError::Stream("model variant catalog limit".into()));
        }
        for (route, variant, provider) in entries {
            if !valid_variant(&variant)
                || self
                    .routes
                    .get(&route)
                    .is_none_or(|base| base.identity() != provider.identity())
                || self.variants.insert((route, variant), provider).is_some()
            {
                return Err(ProviderError::Stream(
                    "invalid or duplicate model variant".into(),
                ));
            }
        }
        for (variant, provider) in primary {
            if !valid_variant(&variant)
                || self.primary.identity() != provider.identity()
                || self.primary_variants.insert(variant, provider).is_some()
            {
                return Err(ProviderError::Stream(
                    "invalid or duplicate default model variant".into(),
                ));
            }
        }
        Ok(self)
    }
}

pub(crate) fn valid_variant(variant: &str) -> bool {
    !variant.is_empty() && variant.len() <= 128 && !variant.chars().any(char::is_control)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c))
}

#[async_trait]
impl Provider for Catalog {
    fn identity(&self) -> Option<Identity> {
        self.primary.identity()
    }
    fn reply_identity(&self, reply: &Reply) -> Option<Identity> {
        self.primary.reply_identity(reply)
    }
    fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        self.primary.for_model(model)
    }
    fn for_route(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.routes.get(id).cloned()
    }
    fn for_route_variant(&self, id: Option<&str>, variant: &str) -> Option<Arc<dyn Provider>> {
        match id {
            Some(id) => self
                .variants
                .get(&(id.to_owned(), variant.to_owned()))
                .cloned(),
            None => self.primary_variants.get(variant).cloned(),
        }
    }
    fn route_account(&self, route: &str) -> Option<Account> {
        self.accounts.get(route).cloned()
    }

    fn account_route(
        &self,
        credential: Option<&str>,
        current: Option<&crate::session_model::Binding>,
        identity: &Identity,
    ) -> Result<Option<Info>, ProviderError> {
        if self.accounts.is_empty() {
            return Ok(None);
        }
        let current_route = current
            .and_then(|binding| binding.route_id.as_ref())
            .or_else(|| {
                (self.primary.identity().as_ref() == Some(identity))
                    .then_some(self.primary_route.as_ref())
                    .flatten()
            });
        let family = current_route
            .and_then(|route| self.accounts.get(route))
            .map(|account| account.model_key.as_str());
        let candidates = self
            .model_catalog()
            .into_iter()
            .filter(|info| {
                let Some(account) = info
                    .route_id
                    .as_ref()
                    .and_then(|route| self.accounts.get(route))
                else {
                    return false;
                };
                let same_model = family.map_or(
                    info.protocol == identity.protocol && info.model == identity.model,
                    |family| family == account.model_key,
                );
                same_model
                    && match credential {
                        Some(id) => account.id.as_deref() == Some(id),
                        None => account.is_default,
                    }
            })
            .collect::<Vec<_>>();
        if candidates.len() > 1 {
            return Err(ProviderError::Stream(
                "account route is ambiguous for the selected model".into(),
            ));
        }
        Ok(candidates.into_iter().next())
    }

    fn model_catalog(&self) -> Vec<Info> {
        self.primary
            .identity()
            .into_iter()
            .map(|identity| Info {
                route_id: None,
                protocol: identity.protocol,
                model: identity.model,
                variants: self.primary_variants.keys().cloned().collect(),
                model_key: self
                    .primary_route
                    .as_ref()
                    .and_then(|route| self.accounts.get(route))
                    .map(|account| account.model_key.clone()),
                credential_id: self
                    .primary_route
                    .as_ref()
                    .and_then(|route| self.accounts.get(route))
                    .and_then(|account| account.id.clone()),
            })
            .chain(self.routes.iter().filter_map(|(id, provider)| {
                provider.identity().map(|identity| Info {
                    model_key: self
                        .accounts
                        .get(id)
                        .map(|account| account.model_key.clone()),
                    credential_id: self.accounts.get(id).and_then(|account| account.id.clone()),
                    route_id: Some(id.clone()),
                    protocol: identity.protocol,
                    model: identity.model,
                    variants: self
                        .variants
                        .range((id.clone(), String::new())..)
                        .take_while(|((route, _), _)| route == id)
                        .map(|((_, variant), _)| variant.clone())
                        .collect(),
                })
            }))
            .collect()
    }
    fn protected_resources(&self) -> Vec<PathBuf> {
        self.primary
            .protected_resources()
            .into_iter()
            .chain(
                self.routes
                    .values()
                    .flat_map(|provider| provider.protected_resources()),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    async fn count_tokens(&self, request: &ModelRequest) -> CountTokens {
        self.primary.count_tokens(request).await
    }
    fn supports_tool_free_stream(&self) -> bool {
        self.primary.supports_tool_free_stream()
    }
    async fn stream_without_tools(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.primary
            .stream_without_tools(request, progress, cancel)
            .await
    }
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.primary.stream(request, progress, cancel).await
    }
}

#[cfg(test)]
mod window_tests {
    use super::context_window_in;

    #[test]
    fn context_windows_are_indexed_per_model_id() {
        let document = serde_json::json!({
            "alpha": {"models": {
                "m-big": {"limit": {"context": 200000}},
                "m-small": {"limit": {"context": 64000}},
                "m-none": {}
            }},
            "beta": {"models": {
                "m-big": {"limit": {"context": 100000}}
            }}
        });
        let window = |model: &str| context_window_in(&document, model);
        assert_eq!(
            window("m-big"),
            Some(100000),
            "the smallest declared window wins"
        );
        assert_eq!(window("m-small"), Some(64000));
        assert_eq!(window("m-none"), None);
        assert_eq!(window("unknown"), None);
        // A date-suffixed pin falls back to the base model's window.
        assert_eq!(window("m-big-261017"), Some(100000));
        // A date-suffixed pin falls back to the base model's window.
        assert_eq!(window("m-big-261017"), Some(100000));
    }
}
