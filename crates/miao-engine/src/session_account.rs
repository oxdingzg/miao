//! Session account selection resolves only trusted host routes. The command
//! carries an opaque credential identity, never a credential or endpoint.
use crate::{
    protocol::Error,
    session_model::Binding,
    store::{append, write_tx, Store},
};
use rusqlite::{OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub credential_id: Option<String>,
}

impl Selection {
    fn validate(&self) -> Result<(), Error> {
        if self
            .credential_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err(Error::Invalid("invalid credential identity".into()));
        }
        Ok(())
    }
}

pub(crate) fn selected_at(
    tx: &Transaction<'_>,
    session: &str,
    cursor: u64,
) -> Result<Option<Selection>, Error> {
    let data: Option<String> = tx.query_row(
        "SELECT data FROM engine_event WHERE session_id=?1 AND kind='session.account.selected' AND seq<=?2 ORDER BY seq DESC LIMIT 1",
        rusqlite::params![session, cursor.min(i64::MAX as u64)], |row| row.get(0)).optional()?;
    let Some(data) = data else { return Ok(None) };
    let value: Value = serde_json::from_str(&data)?;
    value
        .get("account")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.clone()).map_err(Error::from))
        .transpose()
}

impl Store {
    pub async fn account_selection(&self, session: &str) -> Result<Option<Selection>, Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = connection.transaction()?;
            selected_at(&tx, &session, i64::MAX as u64)
        })
        .await
    }

    /// Account intent is independent of explicit model selection. The resolved
    /// binding is an admission receipt, never a new user model pin.
    pub async fn select_account_binding(
        &self,
        session: &str,
        binding: Option<Binding>,
        credential_id: Option<String>,
    ) -> Result<Value, Error> {
        if let Some(binding) = &binding {
            binding.validate()?;
        }
        let session = session.to_owned();
        let account = Selection { credential_id };
        account.validate()?;
        self.call(move |connection| {
            let tx = write_tx(connection)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
                [&session],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(Error::Invalid("Session does not exist".into()));
            }
            if selected_at(&tx, &session, i64::MAX as u64)? == Some(account.clone()) {
                return Ok(json!({"binding":binding,"account":account,"changed":false}));
            }
            append(
                &tx,
                &session,
                "session.account.selected",
                json!({"binding":binding,"account":account}),
            )?;
            tx.commit()?;
            Ok(json!({"binding":binding,"account":account,"changed":true}))
        })
        .await
    }
    pub async fn select_model_with_account(
        &self,
        session: &str,
        binding: Option<Binding>,
        account: Option<Selection>,
    ) -> Result<Value, Error> {
        if let Some(binding) = &binding {
            binding.validate()?;
        }
        if let Some(account) = &account {
            account.validate()?;
        }
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = write_tx(connection)?;
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)", [&session], |row| row.get(0))?;
            if !exists { return Err(Error::Invalid("Session does not exist".into())); }
            let model_changed = crate::session_model::selected(&tx, &session)? != binding;
            let account_changed = selected_at(&tx,&session,i64::MAX as u64)? != account;
            if model_changed { append(&tx,&session,"session.model.selected",json!({"binding":binding}))?; }
            if account_changed { append(&tx,&session,"session.account.selected",json!({"account":account,"binding":binding}))?; }
            tx.commit()?;
            Ok(json!({"binding":binding,"account":account,"changed":model_changed || account_changed}))
        }).await
    }
}

/// Resolve account intent against trusted host routes while retaining the
/// logical model family and explicit variant. No endpoint or credential
/// bytes can be supplied by the command.
pub(crate) fn resolve(
    provider: &std::sync::Arc<dyn crate::provider::Provider>,
    current: Option<&crate::session_model::Binding>,
    credential_id: Option<&str>,
) -> Result<Option<crate::session_model::Binding>, Error> {
    let selected = crate::session_model::select(provider, current)?;
    let identity = selected
        .identity()
        .ok_or_else(|| Error::Invalid("current model identity is unavailable".into()))?;
    let route = provider
        .account_route(credential_id, current, &identity)
        .map_err(|error| Error::Invalid(error.to_string()))?;
    let binding = match route {
        Some(route) => {
            let variant = current.and_then(|binding| binding.variant.clone());
            if variant
                .as_ref()
                .is_some_and(|variant| !route.variants.contains(variant))
            {
                return Err(Error::Invalid(
                    "account route does not support the selected variant".into(),
                ));
            }
            Some(crate::session_model::Binding {
                protocol: route.protocol,
                model: route.model,
                route_id: route.route_id,
                variant,
            })
        }
        None if credential_id.is_none() && current.is_none() => None,
        None => {
            return Err(Error::Invalid(
                "no registered account route for the selected model".into(),
            ))
        }
    };
    Ok(binding)
}
