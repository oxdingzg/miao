//! Session-owned model selection. Endpoints and credential ownership stay on
//! the configured route; the selected binding is durable event state.
use crate::{
    protocol::Error,
    provider::{Identity, Provider},
    store::{append, Store},
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
}

impl Binding {
    fn validate(&self) -> Result<(), Error> {
        if !crate::provider::valid_model(&self.model)
            || self.protocol.is_empty()
            || self.protocol.len() > 128
            || self.protocol.chars().any(char::is_control)
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
            let tx = connection.transaction()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
                [&session],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(Error::Invalid("Session does not exist".into()));
            }
            if selected(&tx, &session)? == binding {
                return Ok(json!({"binding":binding,"changed":false}));
            }
            append(
                &tx,
                &session,
                "session.model.selected",
                json!({"binding":binding}),
            )?;
            tx.commit()?;
            Ok(json!({"binding":binding,"changed":true}))
        })
        .await
    }
}
