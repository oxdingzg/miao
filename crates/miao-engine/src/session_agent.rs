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
    /// A host-resolved ordered action/resource contract; native rules above
    /// remain a separate operator-shaped restriction layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered_permissions: Option<crate::agent_policy::OrderedPolicy>,
    /// Applied only while the Session has no explicit model selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Binding>,
    /// The collaboration mode this agent runs under, if it pins one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<CollaborationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<crate::request_options::Options>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentMention {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentReferences {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog: Vec<AgentManifest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<AgentMention>,
}
impl AgentReferences {
    pub fn is_empty(&self) -> bool {
        self.catalog.is_empty() && self.mentions.is_empty()
    }
    pub fn validate(&self) -> Result<(), Error> {
        validate_references(&self.catalog)?;
        if self.mentions.len() > 32
            || serde_json::to_vec(self)?.len() > 512 * 1024
            || self.mentions.iter().any(|mention| {
                !self.catalog.iter().any(|agent| agent.name == mention.name)
                    || serde_json::to_vec(mention).map_or(true, |bytes| bytes.len() > 16 * 1024)
            })
        {
            return Err(Error::Invalid("invalid captured agent mentions".into()));
        }
        Ok(())
    }
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
        if let Some(policy) = &self.ordered_permissions {
            policy.compile()?;
        }
        if self.steps.is_some_and(|steps| steps == 0 || steps > 1000) {
            return Err(invalid("steps"));
        }
        if let Some(request) = &self.request {
            request
                .validate()
                .map_err(|error| Error::Invalid(error.to_string()))?;
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
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = write_tx(connection)?;
            let value = set_agent_tx(&tx, &session, &agent)?;
            tx.commit()?;
            Ok(value)
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

pub(crate) fn set_agent_tx(
    tx: &Transaction<'_>,
    session: &str,
    agent: &AgentManifest,
) -> Result<Value, Error> {
    agent.validate()?;
    let hash = agent.digest()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
        [session],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(Error::Invalid("Session does not exist".into()));
    }
    if selected(tx, session)?.is_some_and(|(_, recorded)| recorded == hash) {
        return Ok(json!({"agent_hash": hash, "changed": false}));
    }
    // A queued approval reply must not outlive the authority it was
    // requested under. Invalidate pending approvals in this same write
    // transaction, so a concurrent reply either resolves before the
    // switch or observes a resolved approval afterwards.
    let pending = {
        let mut statement =
            tx.prepare("SELECT id FROM engine_approval WHERE session_id=?1 AND state='pending'")?;
        let rows = statement.query_map([session], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for id in pending {
        tx.execute("UPDATE engine_approval SET state='deny' WHERE id=?1", [&id])?;
        append(
            tx,
            session,
            "approval.resolved",
            json!({
                "request_id":id,"state":"deny","reason":"agent_changed",
            }),
        )?;
    }
    append(
        tx,
        session,
        "session.agent.selected",
        json!({"agent": agent, "agent_hash": hash}),
    )?;
    Ok(json!({"agent_hash":hash,"changed":true}))
}

impl PartialEq for AgentManifest {
    fn eq(&self, other: &Self) -> bool {
        serde_json::to_value(self).expect("serializable agent manifest")
            == serde_json::to_value(other).expect("serializable agent manifest")
    }
}
impl Eq for AgentManifest {}

pub(crate) fn validate_references(agents: &[AgentManifest]) -> Result<(), Error> {
    if agents.len() > 64 || serde_json::to_vec(agents)?.len() > 512 * 1024 {
        return Err(Error::Invalid(
            "named agent references exceed their capture bound".into(),
        ));
    }
    let mut names = std::collections::HashSet::new();
    for agent in agents {
        agent.validate()?;
        if !names.insert(&agent.name) {
            return Err(Error::Invalid("duplicate named agent reference".into()));
        }
    }
    Ok(())
}

pub(crate) fn references_at(
    tx: &Transaction<'_>,
    session: &str,
    cursor: u64,
) -> Result<Vec<AgentManifest>, Error> {
    let data:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='session.agents.registered' AND seq<=?2 ORDER BY seq DESC LIMIT 1",rusqlite::params![session,cursor],|row|row.get(0)).optional()?;
    data.map(|data| {
        let data: Value = serde_json::from_str(&data)?;
        serde_json::from_value(data["agents"].clone()).map_err(Error::from)
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

pub(crate) fn register_references(
    tx: &Transaction<'_>,
    session: &str,
    agents: &[AgentManifest],
) -> Result<(), Error> {
    if agents.is_empty() {
        return Ok(());
    }
    validate_references(agents)?;
    let mut merged = references_at(tx, session, i64::MAX as u64)?
        .into_iter()
        .map(|agent| (agent.name.clone(), agent))
        .collect::<std::collections::BTreeMap<_, _>>();
    for agent in agents {
        merged.insert(agent.name.clone(), agent.clone());
    }
    let merged = merged.into_values().collect::<Vec<_>>();
    validate_references(&merged)?;
    append(
        tx,
        session,
        "session.agents.registered",
        json!({"agents":merged}),
    )?;
    Ok(())
}

pub(crate) fn input_references(
    tx: &Transaction<'_>,
    session: &str,
    input: &str,
) -> Result<AgentReferences, Error> {
    let data:Option<String>=tx.query_row("SELECT e.data FROM engine_input i JOIN engine_event e ON e.session_id=i.session_id AND e.seq=i.admitted_seq WHERE i.session_id=?1 AND i.id=?2",rusqlite::params![session,input],|row|row.get(0)).optional()?;
    data.map(|data| {
        let data: Value = serde_json::from_str(&data)?;
        serde_json::from_value(
            data.get("agent_references")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )
        .map_err(Error::from)
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

impl Store {
    pub(crate) async fn named_agents(&self, session: &str) -> Result<Vec<AgentManifest>, Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = connection.transaction()?;
            references_at(&tx, &session, i64::MAX as u64)
        })
        .await
    }
}

impl Store {
    pub(crate) async fn inherit_delegation_profile(
        &self,
        session: &str,
        agent: Option<AgentManifest>,
        model: Option<Binding>,
        account: Option<crate::session_account::Selection>,
        receipt: Option<Binding>,
    ) -> Result<(), Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx = write_tx(connection)?;
            if let Some(agent) = &agent {
                set_agent_tx(&tx, &session, agent)?;
            }
            if let Some(model) = &model {
                crate::session_model::select_model_tx(&tx, &session, Some(model))?;
            }
            if let Some(account) = account {
                append(
                    &tx,
                    &session,
                    "session.account.selected",
                    json!({"account":account,"binding":receipt,"inherited":true}),
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
}
