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
                 WHERE i.session_id=?1 AND t.key>=?2 AND (?3=0 OR json_extract(t.value,'$.id') IN
                    (SELECT value FROM json_each(i.bundle,'$.context_ids')))
                 ORDER BY t.key LIMIT 101"
            )?;
            let rows = stmt.query_map(params![session,after,selected], |row| Ok((row.get::<_,usize>(0)?,row.get::<_,String>(1)?)))?;
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
        let messages = crate::transfer_history::prepare(&bundle, &identity, route_id.as_deref())?;
        self.stage_transfer_impl(
            id,
            bundle,
            bundle_sha256,
            Some(json!({"identity":identity,"route_id":route_id,"messages":messages})),
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
        if source["format"] != "miao.session.transfer.v1" || source["source"]["engine"] != "ts" {
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
