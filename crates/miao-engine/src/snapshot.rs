//! Session-owned file snapshots and the three-phase revert (ADR-0019).
//!
//! Capture is limited to paths the Session's mutating tools touched. A manifest
//! maps a workspace-relative path to a content hash, or `null` for a path the
//! last touch removed. Blobs live beside the engine database and are shared by
//! snapshots and staged pre-images.
use crate::{
    protocol::Error,
    store::{append, write_tx, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

const RETAINED_SNAPSHOTS: i64 = 20;
const MAX_BLOB_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn blob_dir(database: &Path, session: &str) -> PathBuf {
    database.with_extension("snapshots").join(session)
}

pub(crate) fn valid_path(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then(|| path.to_path_buf())
}

fn within(root: &Path, path: &Path) -> Result<PathBuf, Error> {
    let root = fs::canonicalize(root)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("snapshot path has no parent".into()))?;
    let resolved = if parent.exists() {
        fs::canonicalize(parent)?.join(
            path.file_name()
                .ok_or_else(|| Error::Invalid("snapshot path has no name".into()))?,
        )
    } else {
        // New directories are created below the already checked parent chain.
        let mut existing = parent;
        while !existing.exists() {
            existing = existing
                .parent()
                .ok_or_else(|| Error::Invalid("snapshot path escapes the workspace".into()))?;
        }
        if !fs::canonicalize(existing)?.starts_with(&root) {
            return Err(Error::Invalid("snapshot path escapes the workspace".into()));
        }
        root.join(
            path.strip_prefix(&root)
                .map_err(|_| Error::Invalid("snapshot path escapes the workspace".into()))?,
        )
    };
    if !resolved.starts_with(&root) {
        return Err(Error::Invalid("snapshot path escapes the workspace".into()));
    }
    Ok(resolved)
}

fn read_manifest(text: &str) -> Result<BTreeMap<String, Option<String>>, Error> {
    Ok(serde_json::from_str(text)?)
}

fn encode_manifest(manifest: &BTreeMap<String, Option<String>>) -> Result<String, Error> {
    Ok(serde_json::to_string(manifest)?)
}

pub(crate) fn write_blob(database: &Path, session: &str, bytes: &[u8]) -> Result<String, Error> {
    let hash = crate::permission::digest(bytes);
    let dir = blob_dir(database, session);
    fs::create_dir_all(&dir)?;
    let path = dir.join(&hash);
    if !path.exists() {
        let staging = dir.join(format!(".{hash}.{}", std::process::id()));
        fs::write(&staging, bytes)?;
        fs::rename(&staging, &path)?;
    }
    Ok(hash)
}

fn read_blob(database: &Path, session: &str, hash: &str) -> Result<Vec<u8>, Error> {
    fs::read(blob_dir(database, session).join(hash))
        .map_err(|_| Error::Invalid("file snapshot data is no longer available".into()))
}

/// A staged snapshot identity as text. Native captures store a numeric row id
/// and assembled imports store a transfer identity, so both representations
/// are legal in one column; a history-only stage stores no identity at all.
pub(crate) fn id_text(value: rusqlite::types::Value) -> Result<String, rusqlite::Error> {
    match value {
        rusqlite::types::Value::Text(id) => Ok(id),
        rusqlite::types::Value::Integer(id) => Ok(id.to_string()),
        other => Err(rusqlite::Error::InvalidColumnType(
            0,
            "snapshot_id".into(),
            other.data_type(),
        )),
    }
}

fn retain(conn: &rusqlite::Connection, database: &Path, session: &str) -> Result<(), Error> {
    let staged_id: Option<String> = conn
        .query_row(
            "SELECT snapshot_id FROM engine_staged_revert WHERE session_id=?1",
            [session],
            |row| id_text(row.get(0)?),
        )
        .optional()?;
    let staged_id = staged_id.and_then(|id| id.parse::<i64>().ok());
    let mut statement = conn.prepare(
        "SELECT id,manifest FROM engine_file_snapshot WHERE session_id=?1 ORDER BY boundary_seq DESC, id DESC",
    )?;
    let rows = statement
        .query_map([session], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut keep = std::collections::BTreeSet::new();
    for (index, (id, manifest)) in rows.iter().enumerate() {
        let referenced = index < RETAINED_SNAPSHOTS as usize || staged_id == Some(*id);
        if referenced {
            if let Ok(manifest) = read_manifest(manifest) {
                keep.extend(manifest.into_values().flatten());
            }
        } else {
            conn.execute("DELETE FROM engine_file_snapshot WHERE id=?1", [id])?;
        }
    }
    if let Some((previous, ..)) = staged(conn, session)? {
        if let Ok(previous) = serde_json::from_str::<BTreeMap<String, Option<String>>>(&previous) {
            keep.extend(previous.into_values().flatten());
        }
    }
    if let Ok(entries) = fs::read_dir(blob_dir(database, session)) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !keep.contains(name.to_string_lossy().as_ref()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

impl Store {
    pub async fn record_file_touch(&self, session: &str, path: &str) -> Result<(), Error> {
        if valid_path(path).is_none() {
            return Err(Error::Invalid("invalid snapshot path".into()));
        }
        let (session, path) = (session.to_owned(), path.to_owned());
        self.call(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO engine_file_touch(session_id,path) VALUES(?1,?2)",
                params![session, path],
            )?;
            Ok(())
        })
        .await
    }

    /// Capture the paths touched since the previous boundary, merging them into
    /// the previous manifest so a later restore also recovers untouched files.
    pub async fn capture_file_snapshot(
        &self,
        session: &str,
        boundary_seq: u64,
    ) -> Result<Value, Error> {
        let (session, database) = (session.to_owned(), self.path().to_owned());
        self.call(move |conn| {
            let root: Option<String> = conn
                .query_row(
                    "SELECT root FROM engine_location WHERE session_id=?1",
                    [&session],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(root) = root else {
                return Ok(json!({"available":false,"reason":"no-location"}));
            };
            let touched = {
                let mut statement =
                    conn.prepare("SELECT path FROM engine_file_touch WHERE session_id=?1 ORDER BY path")?;
                let rows = statement
                    .query_map([&session], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            if touched.is_empty() {
                return Ok(json!({"available":false,"reason":"no-touches"}));
            }
            let previous: Option<String> = conn
                .query_row(
                    "SELECT manifest FROM engine_file_snapshot WHERE session_id=?1 ORDER BY boundary_seq DESC, id DESC LIMIT 1",
                    [&session],
                    |row| row.get(0),
                )
                .optional()?;
            let mut manifest = previous
                .as_deref()
                .map(read_manifest)
                .transpose()?
                .unwrap_or_default();
            for path in touched {
                let Some(relative) = valid_path(&path) else {
                    continue;
                };
                let absolute = Path::new(&root).join(&relative);
                match fs::metadata(&absolute) {
                    Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_BLOB_BYTES => {
                        let bytes = fs::read(&absolute)?;
                        manifest.insert(path, Some(write_blob(&database, &session, &bytes)?));
                    }
                    Ok(metadata) if metadata.is_file() => {
                        // Oversized files cannot be restored; the snapshot says so
                        // instead of silently keeping a stale copy.
                        manifest.insert(path, None);
                    }
                    _ => {
                        manifest.insert(path, None);
                    }
                }
            }
            let tx = write_tx(conn)?;
            tx.execute("DELETE FROM engine_file_touch WHERE session_id=?1", [&session])?;
            tx.execute(
                "INSERT INTO engine_file_snapshot(session_id,boundary_seq,kind,manifest) VALUES(?1,?2,'paths',?3)",
                params![session, boundary_seq as i64, encode_manifest(&manifest)?],
            )?;
            let id = tx.last_insert_rowid();
            retain(&tx, &database, &session)?;
            tx.commit()?;
            Ok(json!({"available":true,"id":id,"boundary_seq":boundary_seq,"paths":manifest.len()}))
        })
        .await
    }

    /// Assemble a provider-facing manifest from retained imported snapshots.
    /// Imported rows have no native boundary sequence; their order is the
    /// restored sequence of the referencing assistant, with unreferenced
    /// manifests last. First touch per path wins, including deletions.
    /// Symlink entries cannot be represented by native manifests and are
    /// skipped (counted) instead of being written as regular files.
    fn imported_manifest(
        conn: &rusqlite::Connection,
        session: &str,
        boundary_seq: u64,
    ) -> Result<Option<AssembledImport>, Error> {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(t.seq, -1), s.snapshot_id, s.manifest
             FROM engine_transfer_snapshot s
             JOIN engine_transfer_import i ON i.id = s.import_id AND i.session_id = ?1 AND i.state = 'active'
             LEFT JOIN engine_transfer_message t ON t.import_id = s.import_id AND t.source_message_id = s.boundary_message_id
             WHERE s.order_index IS NOT NULL OR t.seq IS NOT NULL
             ORDER BY COALESCE(t.seq, 9223372036854775807), s.order_index",
        )?;
        let rows = stmt.query_map(params![session], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut manifest = BTreeMap::new();
        let mut identity: Option<String> = None;
        for row in rows {
            let (seq, snapshot_id, raw) = row?;
            if seq >= 0 && seq as u64 > boundary_seq {
                continue;
            }
            let files: Vec<Value> = serde_json::from_str(&raw)?;
            for file in files {
                let path = file["path"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("retained snapshot path is missing".into()))?
                    .to_owned();
                if file["mode"].as_str() == Some("120000") {
                    continue;
                }
                let hash = file["hash"].as_str().map(str::to_owned);
                manifest.entry(path).or_insert(hash);
            }
            if identity.is_none() {
                identity = Some(format!("transfer:{snapshot_id}"));
            }
        }
        Ok(identity.map(|id| (id, manifest)))
    }

    pub async fn snapshot_at(&self, session: &str, boundary_seq: u64) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let found: Option<(i64, i64, String)> = conn
                .query_row(
                    "SELECT id,boundary_seq,manifest FROM engine_file_snapshot WHERE session_id=?1 AND boundary_seq<=?2 ORDER BY boundary_seq DESC, id DESC LIMIT 1",
                    params![session, boundary_seq as i64],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            match found {
                Some((id, boundary, manifest)) => {
                    let manifest: BTreeMap<String, Option<String>> = read_manifest(&manifest)?;
                    let available = manifest.values().filter_map(|hash| hash.as_deref()).all(|hash| blob_dir(Path::new(conn.path().unwrap_or_default()), &session).join(hash).exists());
                    Ok(json!({"id":id,"boundary_seq":boundary,"available":available}))
                }
                None => match Self::imported_manifest(conn, &session, boundary_seq)? {
                    Some((id, manifest)) => {
                        let available = manifest.values().filter_map(|hash| hash.as_deref()).all(|hash| blob_dir(Path::new(conn.path().unwrap_or_default()), &session).join(hash).exists());
                        Ok(json!({"id":id,"boundary_seq":boundary_seq,"available":available,"assembled":true}))
                    }
                    None => Ok(Value::Null),
                },
            }
        })
        .await
    }
}

type Restored = (Vec<String>, Vec<String>, Vec<String>);

fn restore_manifest(
    database: &Path,
    session: &str,
    root: &Path,
    manifest: &BTreeMap<String, Option<String>>,
) -> Result<Restored, Error> {
    let mut restored = Vec::new();
    let mut created = Vec::new();
    let mut removed = Vec::new();
    for (path, hash) in manifest {
        let Some(relative) = valid_path(path) else {
            continue;
        };
        let absolute = root.join(&relative);
        match hash {
            Some(hash) => {
                let bytes = read_blob(database, session, hash)?;
                if fs::read(&absolute).ok().as_deref() == Some(bytes.as_slice()) {
                    continue;
                }
                let existed = absolute.exists();
                let target = within(root, &absolute)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                let staging = target.with_extension(format!("snapshot-{}", std::process::id()));
                fs::write(&staging, bytes)?;
                fs::rename(&staging, &target)?;
                restored.push(path.clone());
                if !existed {
                    created.push(path.clone());
                }
            }
            None => {
                if absolute.exists() {
                    let target = within(root, &absolute)?;
                    fs::remove_file(target)?;
                    removed.push(path.clone());
                }
            }
        }
    }
    Ok((restored, created, removed))
}

fn preimage(
    database: &Path,
    session: &str,
    root: &Path,
    manifest: &BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<String>>, Error> {
    let mut previous = BTreeMap::new();
    for path in manifest.keys() {
        let Some(relative) = valid_path(path) else {
            continue;
        };
        let absolute = root.join(relative);
        match fs::read(&absolute) {
            Ok(bytes) if bytes.len() as u64 <= MAX_BLOB_BYTES => {
                previous.insert(path.clone(), Some(write_blob(database, session, &bytes)?));
            }
            _ => {
                previous.insert(path.clone(), None);
            }
        }
    }
    Ok(previous)
}

/// The file set a boundary restores, and the identity of the snapshot it came
/// from. `None` means the Session has no recorded file state at or before the
/// boundary, which is a history-only revert, not a failure.
type Resolved = (BTreeMap<String, Option<String>>, i64, String);

fn resolve(
    conn: &rusqlite::Connection,
    session: &str,
    boundary_seq: u64,
) -> Result<Option<Resolved>, Error> {
    let found: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT id,boundary_seq,manifest FROM engine_file_snapshot WHERE session_id=?1 AND boundary_seq<=?2 ORDER BY boundary_seq DESC, id DESC LIMIT 1",
            params![session, boundary_seq as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((snapshot_id, boundary, manifest)) = found else {
        let Some((id, manifest)) = Store::imported_manifest(conn, session, boundary_seq)? else {
            return Ok(None);
        };
        // An assembled import has no native row id; its identity is the
        // transfer snapshot it was projected from.
        return Ok(Some((manifest, boundary_seq as i64, id)));
    };
    Ok(Some((
        read_manifest(&manifest)?,
        boundary,
        snapshot_id.to_string(),
    )))
}

impl Store {
    pub async fn revert_stage(
        &self,
        session: &str,
        boundary_seq: u64,
        files: bool,
    ) -> Result<Value, Error> {
        let (session, database) = (session.to_owned(), self.path().to_owned());
        self.call(move |conn| {
            if conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",
                [&session],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(Error::Invalid("revert requires an idle Session".into()));
            }
            let root: String = conn
                .query_row(
                    "SELECT root FROM engine_location WHERE session_id=?1",
                    [&session],
                    |row| row.get(0),
                )
                .map_err(|_| Error::Invalid("Session has no workspace location".into()))?;
            // A history-only stage deliberately skips the file record: the
            // caller asked to rewind the conversation and leave the workspace
            // alone, so a Session that never touched a file can still undo.
            let (manifest, boundary, snapshot_id) = match (files, resolve(conn, &session, boundary_seq)?) {
                (false, _) => (BTreeMap::new(), boundary_seq as i64, String::new()),
                (true, Some(resolved)) => resolved,
                (true, None) => {
                    return Err(Error::Invalid("no file snapshot at this boundary".into()))
                }
            };
            // One intent at a time: undo the previous staged restore first.
            if let Some((previous, ..)) = staged(conn, &session)? {
                let previous: BTreeMap<String, Option<String>> = serde_json::from_str(&previous)?;
                restore_manifest(&database, &session, Path::new(&root), &previous)?;
                conn.execute("DELETE FROM engine_staged_revert WHERE session_id=?1", [&session])?;
            }
            let previous = preimage(&database, &session, Path::new(&root), &manifest)?;
            let (restored, created, removed) =
                restore_manifest(&database, &session, Path::new(&root), &manifest)?;
            let tx = write_tx(conn)?;
            tx.execute(
                "INSERT INTO engine_staged_revert(session_id,boundary_seq,snapshot_id,restored,created,removed,previous) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    session,
                    boundary,
                    snapshot_id,
                    serde_json::to_string(&restored)?,
                    serde_json::to_string(&created)?,
                    serde_json::to_string(&removed)?,
                    serde_json::to_string(&previous)?
                ],
            )?;
            append(
                &tx,
                &session,
                "revert.staged",
                json!({"boundary_seq":boundary,"snapshot_id":snapshot_id,"restored":restored,"created":created,"removed":removed}),
            )?;
            tx.commit()?;
            Ok(json!({"boundary_seq":boundary,"snapshot_id":snapshot_id,"restored":restored,"created":created,"removed":removed}))
        })
        .await
    }

    pub async fn revert_clear(&self, session: &str) -> Result<Value, Error> {
        let (session, database) = (session.to_owned(), self.path().to_owned());
        self.call(move |conn| {
            let staged = staged(conn, &session)?
                .ok_or_else(|| Error::Invalid("no staged revert".into()))?;
            let root: String = conn.query_row(
                "SELECT root FROM engine_location WHERE session_id=?1",
                [&session],
                |row| row.get(0),
            )?;
            let previous: BTreeMap<String, Option<String>> = serde_json::from_str(&staged.0)?;
            let (restored, created, removed) =
                restore_manifest(&database, &session, Path::new(&root), &previous)?;
            let tx = write_tx(conn)?;
            tx.execute("DELETE FROM engine_staged_revert WHERE session_id=?1", [&session])?;
            append(
                &tx,
                &session,
                "revert.cleared",
                json!({"boundary_seq":staged.1,"restored":restored,"created":created,"removed":removed}),
            )?;
            tx.commit()?;
            Ok(json!({"boundary_seq":staged.1,"restored":restored,"created":created,"removed":removed}))
        })
        .await
    }

    pub async fn revert_commit(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let staged = staged(conn, &session)?
                .ok_or_else(|| Error::Invalid("no staged revert".into()))?;
            if conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",
                [&session],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(Error::Invalid("revert requires an idle Session".into()));
            }
            let tx = write_tx(conn)?;
            let reverted = tx.execute(
                "UPDATE engine_message SET reverted=1 WHERE session_id=?1 AND seq>=?2 AND reverted=0",
                params![session, staged.1],
            )?;
            tx.execute(
                "DELETE FROM engine_compaction WHERE session_id=?1 AND through_seq>=?2",
                params![session, staged.1],
            )?;
            let event = append(
                &tx,
                &session,
                "revert.committed",
                json!({"boundary_seq":staged.1,"snapshot_id":staged.2,"reverted":reverted}),
            )?;
            tx.execute("DELETE FROM engine_staged_revert WHERE session_id=?1", [&session])?;
            tx.commit()?;
            Ok(json!({"boundary_seq":staged.1,"snapshot_id":staged.2,"reverted":reverted,"seq":event.seq}))
        })
        .await
    }

    pub async fn staged_revert(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| match staged(conn, &session)? {
            Some((previous, boundary, snapshot_id)) => Ok(json!({
                "boundary_seq":boundary,
                "snapshot_id":snapshot_id,
                "paths":read_manifest(&previous)?.len(),
            })),
            None => Ok(Value::Null),
        })
        .await
    }

    /// What a revert to `boundary_seq` would do to the workspace, without doing
    /// it. A path the Session never recorded has no entry, so the preview lists
    /// only real writes and removals; a path whose current content matches
    /// neither the restore target nor the newest content the Session recorded
    /// changed outside the Session and is reported as a conflict so the caller
    /// can confirm before it is overwritten.
    pub async fn revert_preview(&self, session: &str, boundary_seq: u64) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            if conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",
                [&session],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(Error::Invalid("revert requires an idle Session".into()));
            }
            let Some(root) = conn
                .query_row(
                    "SELECT root FROM engine_location WHERE session_id=?1",
                    [&session],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(json!({"available":false,"reason":"no-location"}));
            };
            let Some((manifest, boundary, snapshot_id)) = resolve(conn, &session, boundary_seq)?
            else {
                return Ok(json!({"available":false,"reason":"no-file-snapshot"}));
            };
            let recorded = recorded_hashes(conn, &session)?;
            let root = Path::new(&root);
            let (mut restore, mut remove, mut conflicts) = (Vec::new(), Vec::new(), Vec::new());
            for (path, target) in &manifest {
                let Some(relative) = valid_path(path) else {
                    continue;
                };
                let disk = disk_hash(&root.join(relative));
                if disk.as_deref() == target.as_deref() {
                    continue;
                }
                let action = if target.is_some() {
                    "restore"
                } else {
                    "remove"
                };
                if action == "restore" {
                    restore.push(path.clone());
                } else {
                    remove.push(path.clone());
                }
                // A path the engine still believes holds the content it last
                // recorded changed by this Session's own work, which a revert
                // is meant to undo. Anything else is an outside edit.
                if recorded.get(path) != Some(&disk) {
                    conflicts.push(json!({
                        "path": path,
                        "action": action,
                        "disk": if disk.is_some() { "modified" } else { "missing" },
                    }));
                }
            }
            Ok(json!({
                "available": true,
                "boundary_seq": boundary,
                "snapshot_id": snapshot_id,
                "restore": restore,
                "remove": remove,
                "conflicts": conflicts,
            }))
        })
        .await
    }
}

/// The newest content each path is recorded to have, across the Session's
/// retained snapshots. Manifests are cumulative, so the newest record is the
/// state the engine believes the workspace is in.
fn recorded_hashes(
    conn: &rusqlite::Connection,
    session: &str,
) -> Result<BTreeMap<String, Option<String>>, Error> {
    let mut statement = conn.prepare(
        "SELECT manifest FROM engine_file_snapshot WHERE session_id=?1 ORDER BY boundary_seq DESC, id DESC",
    )?;
    let rows = statement
        .query_map([session], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut newest: BTreeMap<String, Option<String>> = BTreeMap::new();
    for row in rows {
        for (path, hash) in read_manifest(&row)? {
            newest.entry(path).or_insert(hash);
        }
    }
    Ok(newest)
}

/// The content hash of a workspace path, mirroring how capture hashes a blob.
/// An unreadable or oversized file has no comparable content, so it reports
/// `None` and reads as missing, which can only make the preview more cautious.
fn disk_hash(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    (bytes.len() as u64 <= MAX_BLOB_BYTES).then(|| crate::permission::digest(&bytes))
}

type AssembledImport = (String, BTreeMap<String, Option<String>>);

/// `(previous manifest, boundary_seq, snapshot_id)`
fn staged(
    conn: &rusqlite::Connection,
    session: &str,
) -> Result<Option<(String, i64, String)>, Error> {
    Ok(conn
        .query_row(
            "SELECT previous,boundary_seq,snapshot_id FROM engine_staged_revert WHERE session_id=?1",
            [session],
            // Native captures store a numeric row id; assembled imports store
            // the transfer identity, so accept either stored representation.
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    id_text(row.get(2)?)?,
                ))
            },
        )
        .optional()?)
}
