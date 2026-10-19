//! Prepared authority and state for the native side of a product cutover.
use crate::{
    protocol::Error,
    provider::Identity,
    session_account::Selection,
    session_agent::AgentManifest,
    session_model::Binding,
    state::Mutation,
    store::{append, write_tx, Store},
    transfer_history::PreparedMessage,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub kind: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preparation {
    pub directory: std::path::PathBuf,
    pub identity: Identity,
    pub route_id: Option<String>,
    pub binding: Binding,
    pub agent: Option<AgentManifest>,
    pub account: Option<Selection>,
    pub messages: Vec<PreparedMessage>,
    pub operations: Vec<Operation>,
}

pub fn prepare(
    bundle: &str,
    identity: Identity,
    route_id: Option<String>,
    agent: Option<AgentManifest>,
) -> Result<Preparation, Error> {
    let messages = crate::transfer_history::prepare(bundle, &identity, route_id.as_deref())?;
    let source: Value = serde_json::from_str(bundle)?;
    let source_agent = source["session"]["agent"].as_str();
    if source_agent != agent.as_ref().map(|agent| agent.name.as_str()) {
        return Err(invalid(
            "source agent requires the same trusted host manifest",
        ));
    }
    if let Some(agent) = &agent {
        agent.validate()?;
    }
    if source["session"]["model"]["id"]
        .as_str()
        .is_some_and(|model| model != identity.model)
    {
        return Err(invalid("source model does not match target route"));
    }
    let binding = Binding {
        protocol: identity.protocol.clone(),
        model: identity.model.clone(),
        route_id: route_id.clone(),
        variant: source["session"]["model"]["variant"]
            .as_str()
            .map(str::to_owned),
    };
    binding.validate()?;
    let account = source["session"]["credentialID"]
        .as_str()
        .map(|id| Selection {
            credential_id: Some(id.into()),
        });
    for message in source["timeline"]
        .as_array()
        .ok_or_else(|| invalid("missing timeline"))?
    {
        if message["snapshot"]["start"].is_string() || message["snapshot"]["end"].is_string() {
            return Err(invalid("snapshot objects need native transfer preparation"));
        }
    }
    let mut operations = Vec::new();
    if !source["operational"]["goal"].is_null() {
        let mutation = Mutation::parse("goal", source["operational"]["goal"].clone())
            .map_err(|_| invalid("goal cannot be represented natively"))?;
        operations.push(Operation {
            kind: mutation.kind.into(),
            value: mutation.value,
        });
    }
    if let Some(rows) = source["operational"]["todos"].as_array() {
        let todos=rows.iter().map(|row|json!({"id":row["task_id"],"depends_on":row["depends_on"],"content":row["content"],"status":row["status"],"priority":row["priority"]})).collect::<Vec<_>>();
        let mutation = Mutation::parse("todowrite", json!({"todos":todos}))
            .map_err(|_| invalid("todo graph cannot be represented natively"))?;
        operations.push(Operation {
            kind: mutation.kind.into(),
            value: mutation.value,
        });
    }
    let directory = source["session"]["location"]["directory"]
        .as_str()
        .ok_or_else(|| invalid("source directory"))?
        .into();
    Ok(Preparation {
        directory,
        identity,
        route_id,
        binding,
        agent,
        account,
        messages,
        operations,
    })
}

impl Store {
    /// Read the product's actual durable CAS, not a caller's claimed receipt.
    /// Native activation is retryable after process death, never an abort of
    /// the source authority. A reverse transfer must freeze this native copy
    /// before it is permitted to change the product placement again.
    pub async fn activate_session_transfer(
        &self,
        id: &str,
        expected: &str,
        product_database: &Path,
    ) -> Result<Value, Error> {
        let id = id.to_owned();
        let expected = expected.to_owned();
        let product_database = product_database.to_owned();
        let target = self.path().to_owned();
        self.call(move |conn| {
            let tx=write_tx(conn)?;
            let current:Option<(String,String,String,String)>=tx.query_row("SELECT session_id,bundle_sha256,state,bundle FROM engine_transfer_import WHERE id=?1",[&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
            let (session,digest,state,bundle)=current.ok_or(Error::Conflict)?;
            if digest!=expected || !matches!(state.as_str(),"staged"|"active") {return Err(Error::Conflict);}
            let source:Value=serde_json::from_str(&bundle)?;
            let source_storage=source["source"]["storage"].as_str().ok_or_else(||invalid("source product storage"))?;
            if product_database.canonicalize()? != Path::new(source_storage).canonicalize()? {return Err(Error::Conflict);}
            let product=rusqlite::Connection::open_with_flags(product_database,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            product.busy_timeout(std::time::Duration::from_secs(5))?;
            let placement:Option<(String,String,String,String,String)>=product.query_row(
                "SELECT m.state,m.native_storage,p.native_storage,m.location,p.location FROM session_migration m JOIN session_engine_placement p ON p.session_id=m.session_id WHERE m.id=?1 AND m.session_id=?2 AND m.bundle_sha256=?3 AND p.engine='rust'",
                params![id,session,digest],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?;
            let Some((product_state,planned,placed,planned_location,placed_location))=placement else {return Err(Error::Conflict)};
            if !matches!(product_state.as_str(),"switched"|"completed") || Path::new(&planned).canonicalize()?!=target || Path::new(&placed).canonicalize()?!=target
                || serde_json::from_str::<Value>(&planned_location)?!=source["session"]["location"] || serde_json::from_str::<Value>(&placed_location)?!=source["session"]["location"] {return Err(Error::Conflict);}
            if state=="active" {return Ok(json!({"id":id,"session_id":session,"bundle_sha256":digest,"state":"active"}));}
            let prepared:String=tx.query_row("SELECT data FROM engine_transfer_preparation WHERE import_id=?1",[&id],|row|row.get(0)).optional()?.ok_or(Error::Conflict)?;
            let prepared:Preparation=serde_json::from_str(&prepared)?;
            // Validate every stored field again before changing the durable gate.
            let validated=prepare(&bundle,prepared.identity.clone(),prepared.route_id.clone(),prepared.agent.clone())?;
            if serde_json::to_value(&validated)?!=serde_json::to_value(&prepared)? {return Err(Error::Conflict);}
            tx.execute("UPDATE engine_transfer_import SET state='active' WHERE id=?1 AND state='staged'",[&id])?;
            for message in prepared.messages {
                let event=append(&tx,&session,"session.transfer.history",json!({"import_id":id,"source_message_id":message.source_message_id}))?;
                tx.execute("INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",params![session,event.seq,message.message.role,serde_json::to_string(&message.message.content)?,message.message.checkpoint,message.message.recorded_at_ms])?;
                tx.execute("INSERT INTO engine_transfer_message(import_id,source_message_id,seq) VALUES(?1,?2,?3)",params![id,message.source_message_id,event.seq])?;
            }
            crate::session_model::select_model_tx(&tx,&session,Some(&prepared.binding))?;
            if let Some(account)=prepared.account {append(&tx,&session,"session.account.selected",json!({"account":account,"binding":prepared.binding}))?;}
            if let Some(agent)=prepared.agent {crate::session_agent::set_agent_tx(&tx,&session,&agent)?;}
            for operation in prepared.operations {
                append(&tx,&session,"session.state.updated",json!({"operation_id":format!("transfer:{id}:{}",operation.kind),"kind":operation.kind,"value":operation.value,"expected_revision":null}))?;
            }
            append(&tx,&session,"session.transfer.activated",json!({"import_id":id,"bundle_sha256":digest}))?;
            tx.commit()?;
            Ok(json!({"id":id,"session_id":session,"bundle_sha256":digest,"state":"active"}))
        }).await
    }
}

fn invalid(detail: &str) -> Error {
    Error::Invalid(format!("unsupported semantic transfer: {detail}"))
}
