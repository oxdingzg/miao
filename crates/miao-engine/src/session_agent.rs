//! Session-owned agent manifests (ADR-0017).
//!
//! The host resolves an agent — its catalog, config merge and plugins stay
//! product-side — and sends the engine a bounded manifest. The engine records
//! that manifest as durable Session state and applies it at the next
//! provider-turn boundary: nothing here reads product configuration, and no
//! agent name is ever looked up.
use crate::{
    permission::Rule,
    protocol::{CollaborationMode, Error},
    session_model::Binding,
    store::{append, write_tx, Store},
};
use rusqlite::{OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Bounded like every other wire input: an agent manifest is data, and an
/// oversized one must be refused rather than truncated.
const MAX_NAME: usize = 128;
const MAX_INSTRUCTIONS: usize = 64 * 1024;
const MAX_TOOL_NAMES: usize = 256;
const MAX_RULES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTools {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}

/// A host-resolved agent definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentManifest {
    pub name: String,
    /// The host's own manifest revision marker, recorded for provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantics: Option<String>,
    /// Appended to the base system prompt as one bounded block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Intersected with the registered tool names; never additive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<AgentTools>,
    /// Overlaid on the configured policy, ahead of its own rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<Rule>>,
    /// Applied only while the Session has no explicit model selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Binding>,
    /// The collaboration mode this agent runs under, if it pins one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<CollaborationMode>,
}

impl AgentManifest {
    pub fn validate(&self) -> Result<(), Error> {
        let invalid = |reason: &str| Error::Invalid(format!("invalid agent manifest: {reason}"));
        if self.name.is_empty()
            || self.name.len() > MAX_NAME
            || self.name.chars().any(char::is_control)
        {
            return Err(invalid("name"));
        }
        if self
            .semantics
            .as_deref()
            .is_some_and(|value| value.len() > MAX_NAME || value.chars().any(char::is_control))
        {
            return Err(invalid("semantics"));
        }
        if self
            .instructions
            .as_deref()
            .is_some_and(|text| text.len() > MAX_INSTRUCTIONS || text.contains('\0'))
        {
            return Err(invalid("instructions"));
        }
        if let Some(tools) = &self.tools {
            let named = |names: &[String]| {
                names.len() <= MAX_TOOL_NAMES
                    && names.iter().all(|name| {
                        !name.is_empty()
                            && name.len() <= MAX_NAME
                            && !name.chars().any(char::is_control)
                    })
            };
            if !named(&tools.allow) || !named(&tools.deny) {
                return Err(invalid("tools"));
            }
        }
        if self
            .permissions
            .as_ref()
            .is_some_and(|rules| rules.len() > MAX_RULES)
        {
            return Err(invalid("permissions"));
        }
        if let Some(rules) = &self.permissions {
            if rules
                .iter()
                .any(|rule| rule.tool.len() > MAX_NAME || rule.path.len() > 4096)
            {
                return Err(invalid("permission patterns"));
            }
            crate::permission::Policy::new(crate::permission::Config {
                rules: rules.clone(),
                ..crate::permission::Config::default()
            })?;
        }
        if let Some(binding) = &self.model {
            binding.validate()?;
        }
        Ok(())
    }

    /// This check also runs at dispatch, not just disclosure: a model may
    /// hallucinate a call that was never in its advertised tool list.
    pub(crate) fn permits(&self, name: &str) -> bool {
        self.tools.as_ref().is_none_or(|surface| {
            (surface.allow.is_empty() || surface.allow.iter().any(|tool| tool == name))
                && !surface.deny.iter().any(|tool| tool == name)
        })
    }

    /// The name as an XML attribute value. A name is data: it must not be able
    /// to close the instruction block it is written into.
    pub fn attribute(&self) -> String {
        self.name
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    /// Content hash of the manifest, recorded with the selection and folded
    /// into the turn's provider scope.
    pub fn digest(&self) -> Result<String, Error> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).map_err(Error::from)?)
        ))
    }
}

/// The newest applied manifest and its hash, derived from the ledger the same
/// way the Session's model selection is: no second table, no lost history.
pub(crate) fn selected(
    tx: &Transaction<'_>,
    session: &str,
) -> Result<Option<(AgentManifest, String)>, Error> {
    selected_at(tx, session, i64::MAX as u64)
}

pub(crate) fn selected_at(
    tx: &Transaction<'_>,
    session: &str,
    cursor: u64,
) -> Result<Option<(AgentManifest, String)>, Error> {
    let value: Option<String> = tx
        .query_row(
            "SELECT data FROM engine_event WHERE session_id=?1 AND kind='session.agent.selected' AND seq<=?2 ORDER BY seq DESC LIMIT 1",
            rusqlite::params![session, cursor.min(i64::MAX as u64)],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|value| {
            let value: Value = serde_json::from_str(&value)?;
            let agent: AgentManifest =
                serde_json::from_value(value["agent"].clone()).map_err(Error::from)?;
            let hash = value["agent_hash"]
                .as_str()
                .ok_or_else(|| Error::Invalid("agent selection has no hash".into()))?
                .to_owned();
            Ok((agent, hash))
        })
        .transpose()
}

impl Store {
    /// Record a host-resolved agent for this Session's subsequent turns.
    ///
    /// An unchanged manifest is idempotent: the same instructions, tools,
    /// permissions, model and mode produce the same hash and append nothing.
    pub async fn set_agent(&self, session: &str, agent: AgentManifest) -> Result<Value, Error> {
        agent.validate()?;
        let hash = agent.digest()?;
        let session = session.to_owned();
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
            if selected(&tx, &session)?.is_some_and(|(_, recorded)| recorded == hash) {
                return Ok(json!({"agent_hash": hash, "changed": false}));
            }
            // A queued approval reply must not outlive the authority it was
            // requested under. Invalidate pending approvals in this same write
            // transaction, so a concurrent reply either resolves before the
            // switch or observes a resolved approval afterwards.
            let pending = {
                let mut statement = tx.prepare(
                    "SELECT id FROM engine_approval WHERE session_id=?1 AND state='pending'",
                )?;
                let rows = statement.query_map([&session], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for id in pending {
                tx.execute("UPDATE engine_approval SET state='deny' WHERE id=?1", [&id])?;
                append(
                    &tx,
                    &session,
                    "approval.resolved",
                    json!({
                        "request_id":id,"state":"deny","reason":"agent_changed",
                    }),
                )?;
            }
            append(
                &tx,
                &session,
                "session.agent.selected",
                json!({"agent": agent, "agent_hash": hash}),
            )?;
            tx.commit()?;
            Ok(json!({"agent_hash": hash, "changed": true}))
        })
        .await
    }

    /// The agent this Session's next turn runs as, if any.
    pub async fn agent(&self, session: &str) -> Result<Option<(AgentManifest, String)>, Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = connection.transaction()?;
            selected(&tx, &session)
        })
        .await
    }
}
