use crate::protocol::{Error, Event};
use rusqlite::{params, Connection, OpenFlags};
use std::{io::Write, path::Path};

/// A consistent, read-only JSONL export. SQLite remains authoritative; no
/// exporter acknowledgement is on the admission/settlement critical path.
/// The read transaction pins a committed high-watermark even while serving.
pub fn committed_events(
    path: impl AsRef<Path>,
    session: &str,
    after: u64,
    mut output: impl Write,
) -> Result<u64, Error> {
    let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let app_id: u32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    if app_id != 0x4d494145 {
        return Err(Error::Invalid("not a miao-engine database".into()));
    }
    let tx = conn.transaction()?;
    let high: u64 = tx.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM engine_event WHERE session_id=?1",
        [session],
        |r| r.get(0),
    )?;
    // Retention may have removed rows below a recorded cut. A cursor that far
    // back is asking for history that no longer exists; refusing is the honest
    // answer, a short read would look like the session ended early.
    if let Some(cut) = crate::retention::cut_for(&tx, session)? {
        if after < cut {
            return Err(Error::Invalid(format!(
                "cursor {after} is below the retention cut {cut} for this session; the removed range was snapshotted beside the ledger, resume from {cut}"
            )));
        }
    }
    {
        // Read-only exports must also support stores not yet migrated by serve.
        let has_time: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_event') WHERE name='recorded_at_ms')",
            [], |row| row.get(0),
        )?;
        let time = if has_time { "recorded_at_ms" } else { "NULL" };
        let mut stmt=tx.prepare(&format!("SELECT seq,kind,data,{time} FROM engine_event WHERE session_id=?1 AND seq>?2 AND seq<=?3 ORDER BY seq"))?;
        let mut rows = stmt.query(params![session, after, high])?;
        let blob_root = tx
            .path()
            .map(|path| crate::blob::root_for(std::path::Path::new(path)));
        while let Some(row) = rows.next()? {
            // An export carries whole payloads: anything the ledger holds by
            // blob reference is rehydrated here, so the transferred file is
            // self-contained and the importer never needs this directory.
            let mut data: serde_json::Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
            if let Some(root) = &blob_root {
                crate::blob::rehydrate(&mut data, root);
            }
            let event = Event {
                session_id: session.into(),
                seq: row.get(0)?,
                kind: row.get(1)?,
                recorded_at_ms: row.get(3)?,
                data,
            };
            serde_json::to_writer(&mut output, &event)?;
            output.write_all(b"\n")?;
        }
    }
    tx.commit()?;
    output.flush()?;
    Ok(high)
}

/// Credential-shaped strings a session's text can carry by accident: pasted
/// keys and auth headers travel inside prompts and tool calls, and a
/// diagnostic bundle is meant to travel. Replacing the match, not the whole
/// string, keeps enough shape to see where the secret sat.
fn redact_string(text: &str) -> (String, usize) {
    let patterns = [
        r"\bsk-[A-Za-z0-9_-]{16,}",
        r"\bghp_[A-Za-z0-9]{30,}\b",
        r"\bgithub_pat_[A-Za-z0-9_]{40,}\b",
        r"\bAKIA[0-9A-Z]{16}\b",
        r"\bBearer [A-Za-z0-9._~+/=-]{18,}",
        r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
        r"\bglpat-[A-Za-z0-9_-]{20,}",
        r"\bAIza[0-9A-Za-z_-]{35}",
    ];
    let mut redacted = text.to_owned();
    let mut count = 0;
    for pattern in patterns {
        let re = regex::Regex::new(pattern).expect("credential pattern compiles");
        count += re.find_iter(&redacted).count();
        redacted = re.replace_all(&redacted, "[redacted]").into_owned();
    }
    (redacted, count)
}

fn redact_value(value: &mut serde_json::Value) -> usize {
    use serde_json::Value;
    match value {
        Value::String(text) => {
            let (redacted, count) = redact_string(text);
            *text = redacted;
            count
        }
        Value::Array(items) => items.iter_mut().map(redact_value).sum(),
        Value::Object(map) => map
            .iter_mut()
            .map(|(key, item)| {
                let inner = redact_value(item);
                let sensitive = matches!(
                    key.to_ascii_lowercase().as_str(),
                    "authorization" | "api_key" | "apikey" | "secret" | "token"
                ) && item.is_string();
                if sensitive {
                    *item = Value::String("[redacted]".into());
                    inner + 1
                } else {
                    inner
                }
            })
            .sum(),
        _ => 0,
    }
}

/// Test access to the redaction walk.
#[doc(hidden)]
pub fn redact_for_tests(value: &mut serde_json::Value) -> usize {
    redact_value(value)
}

/// A redacted diagnostic bundle for one Session: the committed events from a
/// cursor, with credential-shaped strings replaced, wrapped in what a
/// supporter needs to place it — the wire protocol, the schema, the session
/// id and the cursor it starts from. Same read-only contract as
/// [`committed_events`]: the database stays authoritative, serving continues.
pub fn diagnostic_bundle(
    path: impl AsRef<Path>,
    session: &str,
    after: u64,
) -> Result<serde_json::Value, Error> {
    let mut sink = Vec::new();
    let high = committed_events(path.as_ref(), session, after, &mut sink)?;
    let text = String::from_utf8_lossy(&sink);
    let mut events = Vec::new();
    let mut redactions = 0;
    for line in text.lines() {
        let mut event: serde_json::Value = serde_json::from_str(line)?;
        redactions += redact_value(&mut event);
        events.push(event);
    }
    Ok(serde_json::json!({
        "session": session,
        "after": after,
        "through": high,
        "protocol": crate::PROTOCOL,
        "schema": crate::store::SCHEMA_VERSION,
        "event_count": events.len(),
        "redactions": redactions,
        "events": events,
    }))
}
