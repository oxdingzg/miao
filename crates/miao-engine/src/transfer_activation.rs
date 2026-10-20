//! Prepared authority and state for the native side of a product cutover.
use crate::{
    protocol::{Error, Message},
    provider::Identity,
    session_account::Selection,
    session_agent::AgentManifest,
    session_model::Binding,
    state::Mutation,
    store::{append, write_tx, Store},
    transfer_history::PreparedMessage,
};
use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub kind: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetainedSnapshot {
    pub id: String,
    pub boundary_message_id: Option<String>,
    /// Position of the referencing assistant in the source timeline; manifests
    /// without any referencing assistant cannot be ordered for first-touch
    /// assembly and are excluded from imported revert.
    pub order_index: Option<usize>,
    pub files: Vec<Value>,
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
    pub snapshots: Vec<RetainedSnapshot>,
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
    let inventory = crate::transfer_history::artifacts(&source)?;
    let mut snapshots: Vec<RetainedSnapshot> = Vec::new();
    for manifest in source["snapshots"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let id = manifest["id"]
            .as_str()
            .ok_or_else(|| invalid("snapshot identity"))?
            .to_owned();
        if !regex_check_id(&id) || snapshots.iter().any(|kept| kept.id == id) {
            return Err(invalid("snapshot identity"));
        }
        let timeline = source["timeline"]
            .as_array()
            .ok_or_else(|| invalid("missing timeline"))?;
        let reference = timeline.iter().position(|message| {
            message["type"].as_str() == Some("assistant")
                && [
                    message["snapshot"]["start"].as_str(),
                    message["snapshot"]["end"].as_str(),
                ]
                .into_iter()
                .flatten()
                .any(|referenced| referenced == id)
        });
        let boundary =
            reference.and_then(|index| timeline[index]["id"].as_str().map(str::to_owned));

        let mut files = Vec::new();
        for file in manifest["files"]
            .as_array()
            .ok_or_else(|| invalid("snapshot manifest"))?
        {
            let path = file["path"]
                .as_str()
                .ok_or_else(|| invalid("snapshot path"))?;
            let source_path = file["source_path"]
                .as_str()
                .ok_or_else(|| invalid("snapshot source path"))?;
            if crate::snapshot::valid_path(path).is_none()
                || crate::snapshot::valid_path(source_path).is_none()
            {
                return Err(invalid("snapshot path"));
            }
            let mode = file["mode"].as_str();
            if mode.is_some_and(|mode| !matches!(mode, "100644" | "100755" | "120000")) {
                return Err(invalid("snapshot mode"));
            }
            if let Some(hash) = file["hash"].as_str() {
                if !regex_check_digest(hash) {
                    return Err(invalid("snapshot content identity"));
                }
                let encoded = inventory.get(hash).ok_or_else(|| {
                    invalid("snapshot content is missing from the artifact inventory")
                })?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("snapshot content encoding"))?;
                if format!("{:x}", Sha256::digest(&bytes)) != hash {
                    return Err(invalid("snapshot content identity"));
                }
            }
            files.push(file.clone());
        }
        snapshots.push(RetainedSnapshot {
            id,
            boundary_message_id: boundary,
            order_index: reference,
            files,
        });
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
        snapshots,
    })
}

/// The native-move variant of [`prepare`]: the bundle timeline is verbatim
/// engine message rows stamped by `export_session_move`, so every row becomes
/// exactly one prepared message and snapshots and state pass through without
/// product-shape translation. Integrity checks that staging re-runs anyway
/// (duplicate identities, context membership) stay with staging.
pub fn prepare_native(
    serialized: &str,
    identity: Identity,
    route_id: Option<String>,
    agent: Option<AgentManifest>,
) -> Result<Preparation, Error> {
    if serialized.len() > crate::transfer::MAX_BYTES {
        return Err(invalid("bundle size limit"));
    }
    let source: Value = serde_json::from_str(serialized)?;
    if source["format"] != "miao.session.transfer.v1" || source["source"]["engine"] != "rust" {
        return Err(invalid("bundle format"));
    }
    let timeline = source["timeline"]
        .as_array()
        .ok_or_else(|| invalid("canonical timeline"))?;
    let mut messages = Vec::new();
    let mut seen = HashSet::new();
    let mut order = HashMap::new();
    for (index, entry) in timeline.iter().enumerate() {
        let id = entry["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("message identity"))?;
        if !seen.insert(id) {
            return Err(invalid("duplicate message identity"));
        }
        order.insert(id.to_owned(), index);
        messages.push(PreparedMessage {
            source_message_id: id.to_owned(),
            message: Message {
                role: entry["role"]
                    .as_str()
                    .ok_or_else(|| invalid("message role"))?
                    .to_owned(),
                content: entry["content"].clone(),
                checkpoint: entry["checkpoint"].as_str().map(str::to_owned),
                recorded_at_ms: entry["recorded_at_ms"].as_u64(),
            },
        });
    }
    let mut snapshots = Vec::new();
    for snapshot in source["snapshots"].as_array().unwrap_or(&Vec::new()) {
        let id = snapshot["id"]
            .as_str()
            .ok_or_else(|| invalid("snapshot identity"))?;
        let boundary = snapshot["boundary_message_id"].as_str();
        let files = snapshot["files"]
            .as_array()
            .ok_or_else(|| invalid("snapshot files"))?
            .clone();
        snapshots.push(RetainedSnapshot {
            id: id.to_owned(),
            boundary_message_id: boundary.map(str::to_owned),
            order_index: boundary.and_then(|id| order.get(id).copied()),
            files,
        });
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
        let todos = rows
            .iter()
            .map(|row| {
                json!({"id":row["task_id"],"depends_on":row["depends_on"],"content":row["content"],"status":row["status"],"priority":row["priority"]})
            })
            .collect::<Vec<_>>();
        let mutation = Mutation::parse("todowrite", json!({"todos": todos}))
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
    let binding: Binding = if source["session"]["model"].is_null() {
        // An unbound source adopts the destination binding the host supplies.
        Binding {
            protocol: identity.protocol.clone(),
            model: identity.model.clone(),
            route_id: route_id.clone(),
            variant: None,
        }
    } else {
        serde_json::from_value(source["session"]["model"].clone())
            .map_err(|_| invalid("model binding"))?
    };
    let account: Option<Selection> = if source["session"]["account"].is_null() {
        None
    } else {
        Some(
            serde_json::from_value(source["session"]["account"].clone())
                .map_err(|_| invalid("account selection"))?,
        )
    };
    Ok(Preparation {
        directory,
        identity,
        route_id,
        binding,
        agent,
        account,
        messages,
        operations,
        snapshots,
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
            // Validate every stored field again before changing the durable
            // gate. Native-move bundles re-validate through the verbatim-row
            // parser; the product-shape translation never sees them.
            let validated=if source["source"]["engine"]=="rust" {
                prepare_native(&bundle,prepared.identity.clone(),prepared.route_id.clone(),prepared.agent.clone())?
            } else {
                prepare(&bundle,prepared.identity.clone(),prepared.route_id.clone(),prepared.agent.clone())?
            };
            if serde_json::to_value(&validated)?!=serde_json::to_value(&prepared)? {return Err(Error::Conflict);}
            tx.execute("UPDATE engine_transfer_import SET state='active' WHERE id=?1 AND state='staged'",[&id])?;
            let mut seq_by_source=std::collections::HashMap::<String,u64>::new();
            for message in prepared.messages {
                let event=append(&tx,&session,"session.transfer.history",json!({"import_id":id,"source_message_id":message.source_message_id}))?;
                tx.execute("INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",params![session,event.seq,message.message.role,serde_json::to_string(&message.message.content)?,message.message.checkpoint,message.message.recorded_at_ms])?;
                tx.execute("INSERT INTO engine_transfer_message(import_id,source_message_id,seq) VALUES(?1,?2,?3)",params![id,message.source_message_id,event.seq])?;
                seq_by_source.insert(message.source_message_id,event.seq);
            }
            // Native-move compactions re-anchor onto the imported rows: the
            // bundle carries through-message identities, activation remaps
            // them to the fresh sequences. TS bundles have no such field and
            // keep encoding summaries as timeline messages.
            for compaction in source["compactions"].as_array().unwrap_or(&Vec::new()) {
                let compaction_id=compaction["id"].as_str().ok_or_else(||invalid("compaction identity"))?;
                let through_id=compaction["through_message_id"].as_str().ok_or_else(||invalid("compaction boundary"))?;
                let through=*seq_by_source.get(through_id).ok_or(Error::Conflict)?;
                let summary=compaction["summary"].as_str().ok_or_else(||invalid("compaction summary"))?;
                let event=append(&tx,&session,"history.compacted",json!({"compaction_id":compaction_id,"through_message_seq":through,"summary":summary,"inherited":true}))?;
                tx.execute("INSERT INTO engine_compaction VALUES(?1,?2,?3,?4,?5)",params![compaction_id,session,through,summary,event.seq])?;
            }
            crate::session_model::select_model_tx(&tx,&session,Some(&prepared.binding))?;
            if let Some(account)=prepared.account {append(&tx,&session,"session.account.selected",json!({"account":account,"binding":prepared.binding}))?;}
            if let Some(agent)=prepared.agent {crate::session_agent::set_agent_tx(&tx,&session,&agent)?;}
            for operation in prepared.operations {
                append(&tx,&session,"session.state.updated",json!({"operation_id":format!("transfer:{id}:{}",operation.kind),"kind":operation.kind,"value":operation.value,"expected_revision":null}))?;
            }
            let inventory = crate::transfer_history::artifacts(&source)?;
            for snapshot in prepared.snapshots {
                for file in snapshot.files.iter().filter(|file|file["hash"].is_string()) {
                    let hash=file["hash"].as_str().unwrap();
                    let bytes=base64::engine::general_purpose::STANDARD
                        .decode(inventory.get(hash).ok_or(Error::Conflict)?)
                        .map_err(|_|Error::Conflict)?;
                    crate::snapshot::write_blob(&target,&session,&bytes)?;
                }
                tx.execute(
                    "INSERT INTO engine_transfer_snapshot(import_id,snapshot_id,boundary_message_id,manifest,order_index) VALUES(?1,?2,?3,?4,?5)",
                    params![
                        id,
                        snapshot.id,
                        snapshot.boundary_message_id,
                        serde_json::to_string(&snapshot.files)?,
                        snapshot.order_index.map(|index| index as i64)
                    ],
                )?;
            }
            append(&tx,&session,"session.transfer.activated",json!({"import_id":id,"bundle_sha256":digest}))?;
            tx.commit()?;
            Ok(json!({"id":id,"session_id":session,"bundle_sha256":digest,"state":"active"}))
        }).await
    }
}

fn regex_check_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (40..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn regex_check_digest(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn invalid(detail: &str) -> Error {
    Error::Invalid(format!("unsupported semantic transfer: {detail}"))
}
