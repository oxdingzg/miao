//! Captured command intent is part of admission identity, not reconstructed
//! from the rendered prompt on replay (ADR-0018).
use crate::{protocol::Error, session_agent::AgentManifest, session_model::Binding};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authority {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Binding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub name: String,
    pub arguments: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ProductModel>,
    #[serde(default)]
    pub subtask: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<Authority>,
}
impl Reference {
    pub fn validate(&self) -> Result<(), Error> {
        if self.name.is_empty()
            || self.name.len() > 128
            || self.name.chars().any(char::is_control)
            || self.arguments.len() > 32768
            || self
                .source
                .as_ref()
                .is_some_and(|source| source.len() > 1024 || source.chars().any(char::is_control))
            || serde_json::to_vec(self)?.len() > 512 * 1024
        {
            return Err(Error::Invalid("invalid captured command reference".into()));
        }
        if let Some(authority) = &self.authority {
            if authority.default_agent.as_ref().is_some_and(|name| {
                name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
            }) || self.model.is_some() != authority.model.is_some()
            {
                return Err(Error::Invalid(
                    "invalid captured command execution defaults".into(),
                ));
            }

            if let Some(agent) = &authority.agent {
                agent.validate()?;
                if self.agent.as_deref() != Some(&agent.name) {
                    return Err(Error::Invalid(
                        "command agent identity does not match its authority".into(),
                    ));
                }
            } else if self.agent.is_some() {
                return Err(Error::Invalid(
                    "command agent requires a captured manifest".into(),
                ));
            }
            if let Some(binding) = &authority.model {
                binding.validate()?;
            }
        } else if self.agent.is_some() || self.model.is_some() {
            return Err(Error::Invalid(
                "command execution defaults require captured authority".into(),
            ));
        }
        if self.model.as_ref().is_some_and(|model| {
            model.provider_id.is_empty()
                || model.provider_id.len() > 256
                || model.id.is_empty()
                || model.id.len() > 256
                || model.provider_id.chars().any(char::is_control)
                || model.id.chars().any(char::is_control)
        }) {
            return Err(Error::Invalid("invalid command model reference".into()));
        }
        Ok(())
    }
}

pub(crate) fn for_input(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    input: &str,
) -> Result<Option<Reference>, Error> {
    use rusqlite::OptionalExtension;
    let data:Option<String>=tx.query_row("SELECT e.data FROM engine_input i JOIN engine_event e ON e.session_id=i.session_id AND e.seq=i.admitted_seq WHERE i.session_id=?1 AND i.id=?2",rusqlite::params![session,input],|row|row.get(0)).optional()?;
    data.map(|data| {
        let data: serde_json::Value = serde_json::from_str(&data)?;
        serde_json::from_value(data["command"].clone()).map_err(Error::from)
    })
    .transpose()
    .map(Option::flatten)
}

impl PartialEq for Reference {
    fn eq(&self, other: &Self) -> bool {
        serde_json::to_value(self).expect("serializable command reference")
            == serde_json::to_value(other).expect("serializable command reference")
    }
}
impl Eq for Reference {}

#[derive(Debug, Clone)]
pub(crate) struct Pending {
    pub input_id: String,
    pub seq: u64,
    pub text: String,
    pub command: Reference,
    pub started: bool,
    pub attachments: Vec<crate::protocol::Attachment>,
    pub agent_references: crate::session_agent::AgentReferences,
}

pub(crate) struct Completion {
    pub text: String,
    pub attachments: Vec<crate::protocol::Attachment>,
    pub agents: Vec<crate::session_agent::AgentMention>,
    pub error: Option<String>,
}

impl crate::store::Store {
    pub(crate) async fn pending_commands(&self, session: &str) -> Result<Vec<Pending>, Error> {
        let session = session.to_owned();
        self.call(move |connection| {
            let tx=connection.transaction()?;
            let mut statement=tx.prepare("SELECT e.seq,e.data,m.content,EXISTS(SELECT 1 FROM engine_event s WHERE s.session_id=e.session_id AND s.kind='command.started' AND json_extract(s.data,'$.input_id')=json_extract(e.data,'$.input_id')) FROM engine_event e JOIN engine_message m ON m.session_id=e.session_id AND m.seq=e.seq WHERE e.session_id=?1 AND e.kind='input.promoted' AND m.reverted=0 AND json_type(e.data,'$.command')='object' AND NOT EXISTS(SELECT 1 FROM engine_event f WHERE f.session_id=e.session_id AND f.kind IN ('command.completed','command.failed') AND json_extract(f.data,'$.input_id')=json_extract(e.data,'$.input_id')) ORDER BY e.seq LIMIT 65")?;
            let mut rows=statement.query([&session])?;
            let mut pending=Vec::new();
            while let Some(row)=rows.next()? {
                let data:serde_json::Value=serde_json::from_str(&row.get::<_,String>(1)?)?;
                pending.push(Pending {input_id:data["input_id"].as_str().ok_or_else(||Error::Invalid("command input identity is missing".into()))?.into(),seq:row.get(0)?,text:data["prompt"].as_str().unwrap_or("").into(),command:serde_json::from_value(data["command"].clone())?,started:row.get(3)?,attachments:serde_json::from_value(data.get("attachments").cloned().unwrap_or_else(||serde_json::json!([])))?,agent_references:serde_json::from_value(data.get("agent_references").cloned().unwrap_or_else(||serde_json::json!({})))?});
            }
            if pending.len()>64 {return Err(Error::Invalid("too many pending commands".into()));}
            Ok(pending)
        }).await
    }

    pub(crate) async fn start_command(
        &self,
        session: &str,
        input: &Pending,
        run: &str,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let (session, input, run, lease) = (
            session.to_owned(),
            input.clone(),
            run.to_owned(),
            lease.clone(),
        );
        self.call(move |connection| {
            let tx = crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx, &session, &lease)?;
            crate::store::append(
                &tx,
                &session,
                "command.started",
                serde_json::json!({"input_id":input.input_id,"message_seq":input.seq,"run_id":run}),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn command_defaults(
        &self,
        session: &str,
        input_id: &str,
        authority: Authority,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let (session, input_id, lease) = (session.to_owned(), input_id.to_owned(), lease.clone());
        self.call(move |connection| {
            let tx = crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx, &session, &lease)?;
            if let Some(agent) = &authority.agent {
                crate::session_agent::set_agent_tx(&tx, &session, agent)?;
            }
            if let Some(model) = &authority.model {
                crate::session_model::select_model_tx(&tx, &session, Some(model))?;
            }
            crate::store::append(
                &tx,
                &session,
                "command.defaults.applied",
                serde_json::json!({"input_id":input_id,"authority":authority}),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn finish_command(
        &self,
        session: &str,
        input: &Pending,
        completion: Completion,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let Completion {
            text,
            attachments,
            agents,
            error,
        } = completion;
        for attachment in &attachments {
            attachment.validate()?;
        }
        if text.len() > 1024 * 1024 || attachments.len() > 8 || agents.len() > 32 {
            return Err(Error::Invalid(
                "prepared command exceeds input bounds".into(),
            ));
        }
        let (session, input, lease) = (session.to_owned(), input.clone(), lease.clone());
        self.call(move |connection| {
            let tx=crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx,&session,&lease)?;
            let mut parts=vec![serde_json::json!({"type":"text","text":text})];
            parts.extend(attachments.iter().map(crate::protocol::Attachment::part));
            parts.extend(agents.iter().map(|reference|serde_json::json!({"type":"agent_reference","name":reference.name,"metadata":{"source":reference.source}})));
            if text.is_empty() && attachments.is_empty() && agents.is_empty() {parts.push(serde_json::json!({"type":"command_reference","name":input.command.name,"arguments":input.command.arguments}));}
            let content=serde_json::to_string(&parts)?;
            if content.len()>2*1024*1024 {return Err(Error::Invalid("prepared command context exceeds two MiB".into()));}
            let event=crate::store::append(&tx,&session,if error.is_some() {"command.failed"} else {"command.completed"},serde_json::json!({"input_id":input.input_id,"message_seq":input.seq,"prompt":text,"attachments":attachments,"agents":agents,"error":error}))?;
            let changed=tx.execute("UPDATE engine_message SET content=?3 WHERE session_id=?1 AND seq=?2 AND reverted=0",rusqlite::params![session,input.seq,content])?;
            if changed!=1 {return Err(Error::Conflict);}
            // Projection mutation is backed by the immutable completion event.
            let _=event;
            tx.commit()?;Ok(())
        }).await
    }
}

impl crate::store::Store {
    pub(crate) async fn plan_command_call(
        &self,
        session: &str,
        run: &str,
        call: &str,
        operation: serde_json::Value,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let (session, run, call, lease) = (
            session.to_owned(),
            run.to_owned(),
            call.to_owned(),
            lease.clone(),
        );
        self.call(move |connection| {
            let tx = crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx, &session, &lease)?;
            let mut input = operation;
            input["origin"] = serde_json::json!("operator");
            input["type"] = serde_json::json!("command_operation");
            input["id"] = serde_json::json!(call);
            let name = input["name"]
                .as_str()
                .ok_or_else(|| Error::Invalid("command operation name missing".into()))?;
            tx.execute(
                "INSERT INTO engine_tool(id,run_id,name,input,state) VALUES(?1,?2,?3,?4,'planned')",
                rusqlite::params![
                    format!("{run}/{call}"),
                    run,
                    name,
                    serde_json::to_string(&input)?
                ],
            )?;
            crate::store::append(&tx, &session, "command.operation.started", input)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn dispatch_command_call(
        &self,
        session: &str,
        run: &str,
        call: &str,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let (session, run, call, lease) = (
            session.to_owned(),
            run.to_owned(),
            call.to_owned(),
            lease.clone(),
        );
        self.call(move |connection| {
            let tx = crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx, &session, &lease)?;
            if tx.execute(
                "UPDATE engine_tool SET state='dispatched' WHERE id=?1 AND state='planned'",
                [format!("{run}/{call}")],
            )? != 1
            {
                return Err(Error::Conflict);
            }
            crate::store::append(
                &tx,
                &session,
                "command.operation.dispatched",
                serde_json::json!({"call_id":call,"run_id":run,"origin":"operator"}),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn finish_command_call(
        &self,
        session: &str,
        run: &str,
        call: &str,
        error: Option<String>,
        lease: &crate::store::SessionLease,
    ) -> Result<(), Error> {
        let (session, run, call, lease) = (
            session.to_owned(),
            run.to_owned(),
            call.to_owned(),
            lease.clone(),
        );
        self.call(move |connection| {
            let tx = crate::store::write_tx(connection)?;
            crate::store::require_lease(&tx, &session, &lease)?;
            tx.execute(
                "UPDATE engine_tool SET state='completed' WHERE id=?1",
                [format!("{run}/{call}")],
            )?;
            crate::store::append(
                &tx,
                &session,
                "command.operation.ended",
                serde_json::json!({"call_id":call,"run_id":run,"error":error,"origin":"operator"}),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
}
