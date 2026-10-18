//! Host-owned, exact provider routes. Selecting an id never constructs a new
//! endpoint, credential binding, or model from controller/model-supplied data.
use crate::{
    protocol::ModelRequest,
    provider::{CountTokens, Identity, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const MAX_ROUTES: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Info {
    pub route_id: Option<String>,
    pub protocol: String,
    pub model: String,
}

pub struct Catalog {
    primary: Arc<dyn Provider>,
    routes: BTreeMap<String, Arc<dyn Provider>>,
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
        Ok(Self { primary, routes })
    }
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
    fn model_catalog(&self) -> Vec<Info> {
        self.primary
            .identity()
            .into_iter()
            .map(|identity| Info {
                route_id: None,
                protocol: identity.protocol,
                model: identity.model,
            })
            .chain(self.routes.iter().filter_map(|(id, provider)| {
                provider.identity().map(|identity| Info {
                    route_id: Some(id.clone()),
                    protocol: identity.protocol,
                    model: identity.model,
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
