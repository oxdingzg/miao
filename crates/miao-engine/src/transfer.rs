//! Durable, inactive semantic imports. Staging retains the exact source bundle;
//! it grants no execution authority. Activation belongs to the separate host
//! cutover protocol after projection/provider-history verification.
use crate::provider::Identity;
use crate::{
    approval::now_ms,
    protocol::Error,
    store::{append, write_tx, Store},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;

pub const MAX_BYTES: usize = 64 * 1024 * 1024;

/// The trusted host supplies a private immutable bundle file rather than
/// placing up to 64 MiB inside the engine's 1 MiB control-frame limit.
pub async fn read_bundle_file(path: std::path::PathBuf, expected: &str) -> Result<String, Error> {
    if !path.is_absolute() {
        return Err(Error::Invalid(
            "transfer bundle path must be absolute".into(),
        ));
    }
    let expected = expected.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut bundle = String::new();
        std::fs::File::open(path)?
            .take(MAX_BYTES as u64 + 1)
            .read_to_string(&mut bundle)?;
        if bundle.len() > MAX_BYTES {
            return Err(Error::Invalid("transfer bundle size limit".into()));
        }
        if format!("{:x}", Sha256::digest(bundle.as_bytes())) != expected {
            return Err(Error::Conflict);
        }
        Ok(bundle)
    })
    .await
    .map_err(|_| Error::Invalid("bundle reader stopped".into()))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedImport {
    pub id: String,
    pub session_id: String,
    pub bundle_sha256: String,
    pub bundle: String,
    pub state: String,
    pub created_ms: u64,
}

impl Store {
    /// Page original canonical messages without rewriting their IDs, timestamps,
    /// tool correlations or metadata into native event-derived identities.
    /// `after` is the immutable source timeline offset, not a native event seq.
    pub async fn transfer_messages(
        &self,
        session: &str,
        after: usize,
        selected: bool,
        cursor: u64,
    ) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let header: Option<(String,String)> = tx.query_row(
                "SELECT id,bundle_sha256 FROM engine_transfer_import WHERE session_id=?1",
                [&session], |row| Ok((row.get(0)?,row.get(1)?)),
            ).optional()?;
            let (id,digest) = header.ok_or_else(|| Error::Invalid("Session has no semantic import".into()))?;
            let mut stmt = tx.prepare(
                "SELECT t.key,t.value FROM engine_transfer_import i,json_each(i.bundle,'$.timeline') t
                 WHERE i.session_id=?1 AND t.key>=?2 AND (?3=0 OR (json_extract(t.value,'$.id') IN
                    (SELECT value FROM json_each(i.bundle,'$.context_ids'))
                    AND (NOT EXISTS(SELECT 1 FROM engine_compaction c WHERE c.session_id=i.session_id AND c.created_seq<=?4)
                    OR EXISTS(SELECT 1 FROM engine_transfer_message m WHERE m.import_id=i.id AND m.source_message_id=json_extract(t.value,'$.id')
                        AND m.seq>(SELECT c.through_seq FROM engine_compaction c WHERE c.session_id=i.session_id AND c.created_seq<=?4 ORDER BY c.created_seq DESC LIMIT 1)))))
                 ORDER BY t.key LIMIT 101"
            )?;
            let rows = stmt.query_map(params![session,after,selected,cursor.min(i64::MAX as u64)], |row| Ok((row.get::<_,usize>(0)?,row.get::<_,String>(1)?)))?;
            let mut messages = Vec::new();
            let mut bytes = 0;
            let mut next = None;
            for row in rows {
                let (offset,raw) = row?;
                // A single canonical message remains indivisible. Its maximum
                // size is already bounded by the validated source bundle.
                if !messages.is_empty() && (messages.len()==100 || bytes+raw.len()>2*1024*1024) {
                    next = Some(offset);
                    break;
                }
                bytes += raw.len();
                messages.push(serde_json::from_str::<Value>(&raw)?);
            }
            drop(stmt);
            tx.commit()?;
            Ok(json!({"id":id,"bundle_sha256":digest,"after":after,"next":next,"messages":messages}))
        }).await
    }

    /// Exact retries adopt the original inactive import, including after a
    /// process restart. A Session already present at the destination is never
    /// overwritten, even when its human-readable title happens to match.
    pub async fn stage_session_transfer(
        &self,
        id: &str,
        bundle: String,
        bundle_sha256: &str,
    ) -> Result<StagedImport, Error> {
        self.stage_transfer_impl(id, bundle, bundle_sha256, None)
            .await
    }

    pub async fn stage_prepared_session_transfer(
        &self,
        id: &str,
        bundle: String,
        bundle_sha256: &str,
        identity: Identity,
        route_id: Option<String>,
    ) -> Result<StagedImport, Error> {
        self.stage_transfer_with_agent(id, bundle, bundle_sha256, identity, route_id, None)
            .await
    }

    /// Stage with an already-prepared native bundle: the rust-to-rust move
    /// path builds its `Preparation` from verbatim engine rows, so it never
    /// passes through the product-shape translation.
    pub async fn stage_transfer_with_preparation(
        &self,
        id: &str,
        bundle: String,
        bundle_sha256: &str,
        preparation: crate::transfer_activation::Preparation,
    ) -> Result<StagedImport, Error> {
        self.stage_transfer_impl(
            id,
            bundle,
            bundle_sha256,
            Some(serde_json::to_value(preparation)?),
        )
        .await
    }

    pub async fn stage_transfer_with_agent(
        &self,
        id: &str,
        bundle: String,
        bundle_sha256: &str,
        identity: Identity,
        route_id: Option<String>,
        agent: Option<crate::session_agent::AgentManifest>,
    ) -> Result<StagedImport, Error> {
        let preparation = crate::transfer_activation::prepare(&bundle, identity, route_id, agent)?;
        self.stage_transfer_impl(
            id,
            bundle,
            bundle_sha256,
            Some(serde_json::to_value(preparation)?),
        )
        .await
    }

    async fn stage_transfer_impl(
        &self,
        id: &str,
        bundle: String,
        bundle_sha256: &str,
        preparation: Option<Value>,
    ) -> Result<StagedImport, Error> {
        if id.is_empty() || id.len() > 128 || bundle.len() > MAX_BYTES {
            return Err(Error::Invalid(
                "invalid semantic import identity or size".into(),
            ));
        }
        let digest = format!("{:x}", Sha256::digest(bundle.as_bytes()));
        if digest != bundle_sha256 {
            return Err(Error::Conflict);
        }
        let source: Value = serde_json::from_str(&bundle)?;
        if source["format"] != "miao.session.transfer.v1"
            || !matches!(
                source["source"]["engine"].as_str(),
                Some("ts") | Some("rust")
            )
        {
            return Err(Error::Invalid(
                "unsupported semantic transfer format".into(),
            ));
        }
        let session = field(&source["session"], "id")?.to_owned();
        let root = field(&source["session"]["location"], "directory")?.to_owned();
        let title = source["session"]["title"]
            .as_str()
            .ok_or_else(|| Error::Invalid("missing original Session title".into()))?
            .to_owned();
        let created = source["session"]["time"]["created"]
            .as_u64()
            .ok_or_else(|| Error::Invalid("missing original Session timestamp".into()))?;
        let updated = source["session"]["time"]["updated"]
            .as_u64()
            .ok_or_else(|| Error::Invalid("missing original Session timestamp".into()))?;
        let timeline = source["timeline"]
            .as_array()
            .ok_or_else(|| Error::Invalid("missing canonical timeline".into()))?;
        let mut identities = HashSet::new();
        for message in timeline {
            if !identities.insert(field(message, "id")?.to_owned()) {
                return Err(Error::Invalid(
                    "duplicate canonical message identity".into(),
                ));
            }
        }
        let context = source["context_ids"]
            .as_array()
            .ok_or_else(|| Error::Invalid("missing selected context".into()))?;
        let mut selected = HashSet::new();
        for message in context {
            let message = message
                .as_str()
                .ok_or_else(|| Error::Invalid("invalid context identity".into()))?;
            if !identities.contains(message) || !selected.insert(message) {
                return Err(Error::Invalid(
                    "selected context does not match canonical timeline".into(),
                ));
            }
        }
        let id = id.to_owned();
        self.call(move |conn| {
            let tx = write_tx(conn)?;
            let existing = tx.query_row(
                "SELECT id,session_id,bundle_sha256,bundle,state,created_ms FROM engine_transfer_import WHERE id=?1",
                [&id], decode,
            ).optional()?;
            if let Some(existing) = existing {
                if existing.session_id != session || existing.bundle != bundle || existing.bundle_sha256 != digest || existing.state != "staged" {
                    return Err(Error::Conflict);
                }
                if let Some(preparation) = &preparation {
                    let recorded:Option<String> = tx.query_row("SELECT data FROM engine_transfer_preparation WHERE import_id=?1",[&id],|row|row.get(0)).optional()?;
                    if let Some(recorded) = recorded {
                        if serde_json::from_str::<Value>(&recorded)? != *preparation { return Err(Error::Conflict); }
                    } else {
                        tx.execute("INSERT INTO engine_transfer_preparation(import_id,data) VALUES(?1,?2)",params![id,serde_json::to_string(preparation)?])?;
                    }
                }
                tx.commit()?;
                return Ok(existing);
            }
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)", [&session], |row| row.get(0))?;
            if exists {
                return Err(Error::Conflict);
            }
            tx.execute(
                "INSERT INTO engine_session(id,title,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4)",
                params![session,title,created,updated],
            )?;
            tx.execute("INSERT INTO engine_location(session_id,root) VALUES(?1,?2)", params![session,root])?;
            append(&tx, &session, "session.transfer.staged", json!({"id":id,"bundle_sha256":digest}))?;
            let created_ms = now_ms();
            tx.execute(
                "INSERT INTO engine_transfer_import(id,session_id,bundle_sha256,bundle,state,created_ms) VALUES(?1,?2,?3,?4,'staged',?5)",
                params![id,session,digest,bundle,created_ms],
            )?;
            if let Some(preparation) = preparation {
                tx.execute("INSERT INTO engine_transfer_preparation(import_id,data) VALUES(?1,?2)",params![id,serde_json::to_string(&preparation)?])?;
            }
            tx.commit()?;
            Ok(StagedImport { id, session_id: session, bundle_sha256: digest, bundle, state: "staged".into(), created_ms })
        }).await
    }

    pub async fn session_transfer_preparation(&self, id: &str) -> Result<Option<Value>, Error> {
        let id = id.to_owned();
        self.call(move |conn| {
            let data: Option<String> = conn
                .query_row(
                    "SELECT data FROM engine_transfer_preparation WHERE import_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            data.map(|data| serde_json::from_str(&data).map_err(Error::from))
                .transpose()
        })
        .await
    }

    pub async fn session_transfer_import(&self, id: &str) -> Result<Option<StagedImport>, Error> {
        let id = id.to_owned();
        self.call(move |conn| Ok(conn.query_row(
            "SELECT id,session_id,bundle_sha256,bundle,state,created_ms FROM engine_transfer_import WHERE id=?1",
            [&id], decode,
        ).optional()?)).await
    }

    /// Export the exact retained payload of an active import to a private
    /// file for reverse migration. The digest is re-verified on every export,
    /// so a damaged row can never become a restored Session.
    pub async fn export_session_transfer_import(
        &self,
        id: &str,
        path: std::path::PathBuf,
    ) -> Result<Value, Error> {
        if !path.is_absolute() {
            return Err(Error::Invalid(
                "transfer export path must be absolute".into(),
            ));
        }
        let id = id.to_owned();
        let key = id.clone();
        let export = self
            .call(move |conn| {
                let row: Option<(String, String, String, String)> = conn
                    .query_row(
                        "SELECT session_id,bundle_sha256,bundle,state FROM engine_transfer_import WHERE id=?1",
                        [&key],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let (session, digest, bundle, state) = row.ok_or(Error::Conflict)?;
                if state != "active" || format!("{:x}", Sha256::digest(bundle.as_bytes())) != digest {
                    return Err(Error::Conflict);
                }
                Ok((session, digest, bundle))
            })
            .await?;
        let (session, digest, bundle) = export;
        let temporary = path.with_extension("tmp");
        // The reverse-migration path writes into a directory beside the native
        // database that nothing else creates.
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&temporary, bundle.as_bytes()).await?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(json!({
            "id": id,
            "session_id": session,
            "bundle_sha256": digest,
            "state": "active",
            "path": path,
            "bytes": bundle.len(),
        }))
    }

    /// Export the native-era messages (anything after the retained import's
    /// highest restored sequence) as a reverse delta: TS canonical messages
    /// with stable synthesized identities. Only plain text conversations can
    /// be represented today; tool calls, media and opaque reasoning must be
    /// explicit refusals rather than silently dropped turns.
    pub async fn export_session_transfer_delta(
        &self,
        id: &str,
        path: std::path::PathBuf,
    ) -> Result<Value, Error> {
        if !path.is_absolute() {
            return Err(Error::Invalid(
                "transfer export path must be absolute".into(),
            ));
        }
        let id = id.to_owned();
        let key = id.clone();
        let payload = self
            .call(move |conn| {
                let row: Option<(String, String, String, String)> = conn
                    .query_row(
                        "SELECT session_id,bundle_sha256,bundle,state FROM engine_transfer_import WHERE id=?1",
                        [&key],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let (session, digest, bundle, state) = row.ok_or(Error::Conflict)?;
                // The delta is only trustworthy when the retained payload it
                // derives from still matches its recorded digest.
                if state != "active" || format!("{:x}", Sha256::digest(bundle.as_bytes())) != digest {
                    return Err(Error::Conflict);
                }
                let baseline: i64 = conn.query_row(
                    "SELECT COALESCE(MAX(seq),0) FROM engine_transfer_message WHERE import_id=?1",
                    [&key],
                    |row| row.get(0),
                )?;
                let mut stmt = conn.prepare(
                    "SELECT seq,role,content,recorded_at_ms FROM engine_message
                     WHERE session_id=?1 AND seq>?2 AND reverted=0 ORDER BY seq",
                )?;
                let rows = stmt
                    .query_map(params![session, baseline], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut timeline = Vec::new();
                for (seq, role, content, recorded) in rows {
                    let parts: Vec<Value> = serde_json::from_str(&content)?;
                    let id = format!("msg_native_{seq}");
                    let time = json!({"created": recorded.unwrap_or(0)});
                    let mut texts = Vec::new();
                    for part in &parts {
                        let kind = part["type"].as_str().unwrap_or_default();
                        if kind == "text" {
                            texts.push(part["text"].as_str().unwrap_or_default().to_owned());
                        } else {
                            return Err(Error::Invalid(format!(
                                "native message {seq} carries unsupported part {kind}; the reverse delta cannot represent it yet"
                            )));
                        }
                    }
                    let text = texts.join("\n\n");
                    let message = if role == "user" {
                        json!({"id":id,"type":"user","text":text,"time":time})
                    } else if role == "assistant" {
                        json!({"id":id,"type":"assistant","model":{"id":"transferred","providerID":"transferred"},
                            "content":[{"type":"text","text":text}],"time":{"created":recorded.unwrap_or(0),"completed":recorded.unwrap_or(0)}})
                    } else {
                        return Err(Error::Invalid(format!("native message {seq} has unsupported role {role}")));
                    };
                    timeline.push(message);
                }
                Ok(json!({
                    "id": id,
                    "session_id": session,
                    "bundle_sha256": digest,
                    "baseline_seq": baseline,
                    "timeline": timeline,
                }))
            })
            .await?;
        let encoded = serde_json::to_vec(&payload)?;
        // The receipt carries the delta file's own digest: the reverse
        // migration verifies the exact bytes it reads back, which the forward
        // bundle's digest could never prove.
        let delta_sha256 = format!("{:x}", Sha256::digest(encoded.as_slice()));
        let temporary = path.with_extension("tmp");
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&temporary, encoded.as_slice()).await?;
        tokio::fs::rename(&temporary, &path).await?;
        let mut receipt = payload;
        receipt["delta_sha256"] = json!(delta_sha256);
        Ok(receipt)
    }

    /// Serialize a live native Session for a same-engine move into a new
    /// Location (the worktree bridge). The bundle keeps the transfer v1
    /// envelope with `source.engine == "rust"` and a native timeline of
    /// verbatim engine message rows, which the destination stages without
    /// product-shape translation. The location stamped into the bundle is the
    /// DESTINATION directory, so staging creates the identity at its new root
    /// and the activation placement equality holds unchanged. Snapshot file
    /// contents are inlined as artifacts so the destination store can restore
    /// reverts without the source blob directory. The Session must be
    /// drained: an active run is refused.
    pub async fn export_session_move(
        &self,
        session: &str,
        product_storage: &Path,
        target_directory: &str,
        path: std::path::PathBuf,
    ) -> Result<Value, Error> {
        use base64::Engine as _;
        if !path.is_absolute() {
            return Err(Error::Invalid(
                "transfer export path must be absolute".into(),
            ));
        }
        if !std::path::Path::new(target_directory).is_absolute() {
            return Err(Error::Invalid(
                "transfer move target must be an absolute directory".into(),
            ));
        }
        let session = session.to_owned();
        let target = target_directory.to_owned();
        let product_storage = product_storage.to_owned();
        let blob_dir = crate::snapshot::blob_dir(self.path(), &session);
        let payload = self
            .call(move |conn| {
                if conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",
                    [&session],
                    |row| row.get::<_, bool>(0),
                )? {
                    return Err(Error::Conflict);
                }
                let tx = write_tx(conn)?;
                let row: Option<(String, Option<i64>, Option<i64>)> = tx.query_row(
                    "SELECT title,created_at_ms,updated_at_ms FROM engine_session WHERE id=?1",
                    [&session],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
                // Lazily created rows carry NULL timestamps; the bundle needs
                // concrete u64s, so an absent time falls back to the epoch.
                let (title, created, updated) = match row {
                    Some((title, created, updated)) => {
                        (title, created.unwrap_or(0).max(0) as u64, updated.unwrap_or(0).max(0) as u64)
                    }
                    None => return Err(Error::Conflict),
                };
                let watermark_i64: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq),0) FROM engine_message WHERE session_id=?1",
                    [&session],
                    |row| row.get(0),
                )?;
                let watermark = watermark_i64.max(0) as u64;
                let agent = crate::session_agent::selected_at(&tx, &session, watermark)?;
                let binding = crate::session_model::selected_at(&tx, &session, watermark)?;
                let account = crate::session_account::selected_at(&tx, &session, watermark)?;
                let state = crate::state::projection(&tx, &session, watermark)?;
                let mut timeline = Vec::new();
                let mut ids = Vec::new();
                {
                    let mut stmt = tx.prepare(
                        "SELECT seq,role,content,checkpoint,recorded_at_ms FROM engine_message WHERE session_id=?1 AND reverted=0 ORDER BY seq",
                    )?;
                    let rows = stmt.query_map(params![session], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                        ))
                    })?.collect::<Result<Vec<_>, _>>()?;
                    for (seq, role, content, checkpoint, recorded) in rows {
                        let id = format!("msg_{seq}");
                        ids.push(id.clone());
                        timeline.push(json!({
                            "id":id,
                            "role":role,
                            "content":serde_json::from_str::<Value>(&content)?,
                            "checkpoint":checkpoint,
                            "recorded_at_ms":recorded,
                        }));
                    }
                }
                let mut snapshots = Vec::new();
                let mut artifacts = std::collections::HashMap::<String, String>::new();
                {
                    let mut stmt = tx.prepare(
                        "SELECT id,boundary_seq,manifest FROM engine_file_snapshot WHERE session_id=?1 ORDER BY id",
                    )?;
                    let rows = stmt.query_map(params![session], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?.collect::<Result<Vec<_>, _>>()?;
                    for (id, boundary, manifest) in rows {
                        let files: Value = serde_json::from_str(&manifest)?;
                        if let Some(entries) = files.as_array() {
                            for file in entries {
                                if let Some(hash) = file["hash"].as_str() {
                                    if hash.is_empty() || artifacts.contains_key(hash) {
                                        continue;
                                    }
                                    let bytes = std::fs::read(blob_dir.join(hash))
                                        .map_err(|_| Error::Conflict)?;
                                    artifacts.insert(
                                        hash.to_owned(),
                                        base64::engine::general_purpose::STANDARD.encode(&bytes),
                                    );
                                }
                            }
                        }
                        snapshots.push(json!({
                            "id":format!("snap_{id}"),
                            "boundary_message_id":format!("msg_{boundary}"),
                            "files":files,
                        }));
                    }
                }
                let mut compactions = Vec::new();
                {
                    let mut stmt = tx.prepare(
                        "SELECT created_seq,through_seq,summary FROM engine_compaction WHERE session_id=?1 ORDER BY created_seq",
                    )?;
                    let rows = stmt.query_map(params![session], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?.collect::<Result<Vec<_>, _>>()?;
                    for (created_seq, through, summary) in rows {
                        compactions.push(json!({
                            "id":format!("compaction_{created_seq}"),
                            "through_message_id":format!("msg_{through}"),
                            "summary":summary,
                        }));
                    }
                }
                let model = binding.map(serde_json::to_value).transpose()?;
                let account_value = account.map(serde_json::to_value).transpose()?;
                let agent_value = agent
                    .map(|(item, _hash)| serde_json::to_value(item))
                    .transpose()?;
                let bundle_payload = json!({
                    "format":"miao.session.transfer.v1",
                    "source":{"engine":"rust","storage":product_storage,"moved":true,"location":{"directory":target}},
                    "session":{
                        "id":session,
                        "title":title,
                        "time":{"created":created,"updated":updated},
                        "location":{"directory":target},
                        "model":model,
                        "account":account_value,
                        "agent":agent_value,
                    },
                    "timeline":timeline,
                    "context_ids":ids,
                    "operational":{"goal":state["goal"]["value"],"todos":state["todos"]["value"]},
                    "snapshots":snapshots,
                    "artifacts":artifacts.into_iter().map(|(hash,base64)|json!({"hash":hash,"base64":base64})).collect::<Vec<_>>(),
                    "compactions":compactions,
                });
                tx.commit()?;
                Ok(bundle_payload)
            })
            .await?;
        let encoded = serde_json::to_vec(&payload)?;
        if encoded.len() > MAX_BYTES {
            return Err(Error::Invalid("transfer bundle size limit".into()));
        }
        let digest = format!("{:x}", Sha256::digest(&encoded));
        let temporary = path.with_extension("tmp");
        tokio::fs::write(&temporary, &encoded).await?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(json!({
            "session_id": payload["session"]["id"],
            "bundle_sha256": digest,
            "path": path,
            "bytes": encoded.len(),
            "timeline": payload["timeline"].as_array().map(Vec::len).unwrap_or(0),
            "binding": payload["session"]["model"],
            "route_id": payload["session"]["model"]["route_id"],
            "agent": payload["session"]["agent"],
        }))
    }

    /// Aborting an import keeps it inactive forever. It cannot turn the copied
    /// Session into an ordinary native Session or reuse a stale transfer token.
    pub async fn abort_session_transfer_import(&self, id: &str) -> Result<(), Error> {
        let id = id.to_owned();
        self.call(move |conn| {
            let tx = write_tx(conn)?;
            if tx.execute("UPDATE engine_transfer_import SET state='aborted' WHERE id=?1 AND state IN ('staged','aborted')", [&id])? != 1 {
                return Err(Error::Conflict);
            }
            tx.commit()?;
            Ok(())
        }).await
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::Invalid(format!("missing semantic import {key}")))
}

fn decode(row: &rusqlite::Row<'_>) -> rusqlite::Result<StagedImport> {
    Ok(StagedImport {
        id: row.get(0)?,
        session_id: row.get(1)?,
        bundle_sha256: row.get(2)?,
        bundle: row.get(3)?,
        state: row.get(4)?,
        created_ms: row.get(5)?,
    })
}
