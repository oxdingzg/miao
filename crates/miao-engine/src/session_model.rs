//! Session-owned model selection. Endpoints and credential ownership stay on
//! the configured route; the selected binding is durable event state.
use crate::{
    protocol::Error,
    provider::{Identity, Provider},
    store::{append, write_tx, Store},
};
use rusqlite::{OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub protocol: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl Binding {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !crate::provider::valid_model(&self.model)
            || self.protocol.is_empty()
            || self.protocol.len() > 128
            || self.protocol.chars().any(char::is_control)
            || self
                .route_id
                .as_deref()
                .is_some_and(|id| !crate::model_catalog::valid_id(id))
            || self
                .variant
                .as_deref()
                .is_some_and(|variant| !crate::model_catalog::valid_variant(variant))
        {
            return Err(Error::Invalid("invalid Session model binding".into()));
        }
        Ok(())
    }
}

pub(crate) fn select(
    primary: &Arc<dyn Provider>,
    binding: Option<&Binding>,
) -> Result<Arc<dyn Provider>, Error> {
    let Some(binding) = binding else {
        return Ok(Arc::clone(primary));
    };
    binding.validate()?;
    if let Some(variant) = &binding.variant {
        let selected = match primary.for_route_variant(binding.route_id.as_deref(), variant) {
            Some(selected) => selected,
            // Transfer bundles carry the product's projected variant name
            // ("default") even for an explicit single-form provider route,
            // which registers no variants. That name is exactly the primary
            // form, so fall back to it; the identity check below still rejects
            // any binding that would change protocol or model. A named route
            // keeps the strict lookup, and any other variant name stays an
            // error: only "default" is provably the primary form.
            None if binding.route_id.is_none() && variant == "default" => Arc::clone(&primary),
            None => return Err(Error::Invalid("model variant is not registered by the host".into())),
        };
        if selected.identity()
            != Some(Identity {
                protocol: binding.protocol.clone(),
                model: binding.model.clone(),
            })
        {
            return Err(Error::Invalid(
                "model variant identity does not match the host catalog".into(),
            ));
        }
        return Ok(selected);
    }
    if let Some(id) = &binding.route_id {
        let selected = primary
            .for_route(id)
            .ok_or_else(|| Error::Invalid("model route is not registered by the host".into()))?;
        if selected.identity()
            != Some(Identity {
                protocol: binding.protocol.clone(),
                model: binding.model.clone(),
            })
        {
            return Err(Error::Invalid(
                "model route identity does not match the host catalog".into(),
            ));
        }
        return Ok(selected);
    }
    let identity = primary
        .identity()
        .ok_or_else(|| Error::Invalid("provider has no model identity".into()))?;
    if identity.protocol != binding.protocol {
        return Err(Error::Invalid(
            "Session model binding cannot change the configured provider route".into(),
        ));
    }
    if identity.model == binding.model {
        return Ok(Arc::clone(primary));
    }
    let selected = primary.for_model(&binding.model).ok_or_else(|| {
        Error::Invalid("configured provider does not support this model selection".into())
    })?;
    if selected.identity()
        != Some(Identity {
            protocol: binding.protocol.clone(),
            model: binding.model.clone(),
        })
    {
        return Err(Error::Invalid(
            "provider returned a different model identity".into(),
        ));
    }
    Ok(selected)
}

pub(crate) fn selected(tx: &Transaction<'_>, session: &str) -> Result<Option<Binding>, Error> {
    selected_at(tx, session, i64::MAX as u64)
}

pub(crate) fn selected_at(
    tx: &Transaction<'_>,
    session: &str,
    cursor: u64,
) -> Result<Option<Binding>, Error> {
    let value: Option<String> = tx.query_row(
        "SELECT data FROM engine_event WHERE session_id=?1 AND kind='session.model.selected' AND seq<=?2 ORDER BY seq DESC LIMIT 1",
        rusqlite::params![session, cursor], |row| row.get(0),
    ).optional()?;
    value
        .map(|value| {
            let value: Value = serde_json::from_str(&value)?;
            serde_json::from_value(value["binding"].clone()).map_err(Error::from)
        })
        .transpose()
        .map(Option::flatten)
}

impl Store {
    pub async fn model_selection(&self, session: &str) -> Result<Option<Binding>, Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = connection.transaction()?;
            selected(&tx, &session)
        })
        .await
    }

    pub async fn select_model(
        &self,
        session: &str,
        binding: Option<Binding>,
    ) -> Result<Value, Error> {
        if let Some(binding) = &binding {
            binding.validate()?;
        }
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = write_tx(connection)?;
            let value = select_model_tx(&tx, &session, binding.as_ref())?;
            tx.commit()?;
            Ok(value)
        })
        .await
    }
}

/// Check at both controller admission and the actual provider-turn boundary:
/// an in-flight old turn may append opaque content after a selection is admitted.
pub(crate) fn validate_history(
    history: &[crate::protocol::Message],
    binding: Option<&Binding>,
    identity: Option<Identity>,
) -> Result<(), Error> {
    let route = binding.and_then(|binding| binding.route_id.as_deref());
    if history
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten())
        .any(|block| {
            block["type"] == "provider_opaque"
                && (block["_miao_route_id"].as_str() != route
                    || identity.as_ref().is_some_and(|identity| {
                        block["model"]
                            .as_str()
                            .is_some_and(|model| model != identity.model)
                    }))
        })
    {
        return Err(Error::Invalid("selected history contains route/model-bound opaque content; compact on its original route before switching".into()));
    }
    Ok(())
}

pub(crate) fn stamp_route(content: &mut Value, binding: Option<&Binding>) {
    let Some(blocks) = content.as_array_mut() else {
        return;
    };
    for block in blocks {
        if block["type"] != "provider_opaque" {
            continue;
        }
        if let Some(object) = block.as_object_mut() {
            object.insert(
                "_miao_route_id".into(),
                binding
                    .and_then(|binding| binding.route_id.as_ref())
                    .map(|id| json!(id))
                    .unwrap_or(Value::Null),
            );
        }
    }
}

pub(crate) fn select_model_tx(
    tx: &Transaction<'_>,
    session: &str,
    binding: Option<&Binding>,
) -> Result<Value, Error> {
    if let Some(binding) = binding {
        binding.validate()?;
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
        [session],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(Error::Invalid("Session does not exist".into()));
    }
    if selected(tx, session)? == binding.cloned() {
        return Ok(json!({"binding":binding,"changed":false}));
    }
    append(
        tx,
        session,
        "session.model.selected",
        json!({"binding":binding}),
    )?;
    Ok(json!({"binding":binding,"changed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderError, Reply};
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    /// An explicit single-form provider route: one identity, no registered
    /// variants, and no named routes.
    struct Single {
        protocol: &'static str,
        model: &'static str,
    }

    #[async_trait]
    impl Provider for Single {
        fn identity(&self) -> Option<Identity> {
            Some(Identity {
                protocol: self.protocol.into(),
                model: self.model.into(),
            })
        }

        async fn stream(
            &self,
            _: crate::protocol::ModelRequest,
            _: mpsc::Sender<Value>,
            _: CancellationToken,
        ) -> Result<Reply, ProviderError> {
            unreachable!("select never streams")
        }
    }

    fn binding(protocol: &str, model: &str, variant: Option<&str>, route: Option<&str>) -> Binding {
        Binding {
            route_id: route.map(str::to_owned),
            variant: variant.map(str::to_owned),
            protocol: protocol.into(),
            model: model.into(),
        }
    }

    #[test]
    fn a_projected_default_variant_names_the_single_form_of_the_primary() {
        let primary = Arc::new(Single {
            protocol: "openai-chat",
            model: "fixture",
        });
        let selected = select(
            &(Arc::clone(&primary) as Arc<dyn Provider>),
            Some(&binding("openai-chat", "fixture", Some("default"), None)),
        )
        .unwrap();
        assert_eq!(
            selected.identity(),
            Some(Identity {
                protocol: "openai-chat".into(),
                model: "fixture".into(),
            })
        );
    }

    #[test]
    fn an_unknown_variant_still_fails_on_the_primary_route() {
        let primary = Arc::new(Single {
            protocol: "openai-chat",
            model: "fixture",
        });
        let error = select(
            &(Arc::clone(&primary) as Arc<dyn Provider>),
            Some(&binding("openai-chat", "fixture", Some("high"), None)),
        )
        .map(|_| ())
        .map(|_| ())
        .unwrap_err();
        assert!(error.to_string().contains("model variant is not registered"));
    }

    #[test]
    fn a_variant_missing_from_a_named_route_stays_strict() {
        let primary = Arc::new(Single {
            protocol: "openai-chat",
            model: "fixture",
        });
        let error = select(
            &(Arc::clone(&primary) as Arc<dyn Provider>),
            Some(&binding("openai-chat", "fixture", Some("default"), Some("account/route"))),
        )
        .map(|_| ())
        .map(|_| ())
        .unwrap_err();
        assert!(error.to_string().contains("model variant is not registered"));
    }

    #[test]
    fn a_default_variant_cannot_change_the_bound_model() {
        let primary = Arc::new(Single {
            protocol: "openai-chat",
            model: "fixture",
        });
        let error = select(
            &(Arc::clone(&primary) as Arc<dyn Provider>),
            Some(&binding("openai-chat", "other", Some("default"), None)),
        )
        .map(|_| ())
        .unwrap_err();
        assert!(error.to_string().contains("identity does not match"));
    }

}
