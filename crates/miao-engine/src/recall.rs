use crate::{protocol::Error, store::Store, tools::ToolError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

/// One window of an archived tool output: pruning names the handle in its
/// elision marker, so a model restores what was removed without redoing work.
const ARCHIVE_WINDOW: usize = 32768;
/// Bounded backward scan, matching the search mode's page contract.
const SCAN_LIMIT: usize = 1000;
const MAX_HANDLE: usize = 128;
const MAX_OFFSET: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub before_message_seq: Option<u64>,
    /// Restore one archived tool result by the handle its marker named.
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub offset: usize,
}
fn default_limit() -> usize {
    10
}
impl Query {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let query: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if query.query.len() > 512
            || query.query.contains('\0')
            || query.offset > MAX_OFFSET
            || query
                .before_message_seq
                .is_some_and(|seq| seq > i64::MAX as u64)
        {
            return Err(ToolError::InvalidInput);
        }
        match query.tool_use_id.as_deref() {
            Some(handle) => {
                // One handle restores one output; the search fields belong to
                // the other mode, so mixing them is ambiguous.
                if handle.is_empty()
                    || handle.len() > MAX_HANDLE
                    || handle.contains('\0')
                    || !query.query.is_empty()
                    || query.before_message_seq.is_some()
                {
                    return Err(ToolError::InvalidInput);
                }
            }
            None => {
                if query.query.is_empty() || query.limit == 0 || query.limit > 20 {
                    return Err(ToolError::InvalidInput);
                }
            }
        }
        Ok(query)
    }
}
impl Store {
    /// One window of an archived tool output of `session`, addressed by handle.
    /// Delegation reads the delegating Session's archive through this too, so a
    /// child never needs access to the parent's messages.
    pub async fn archived_output(
        &self,
        session: &str,
        tool_use_id: &str,
        offset: usize,
    ) -> Result<Value, Error> {
        let (session, tool_use_id) = (session.to_owned(), tool_use_id.to_owned());
        self.call(move |conn| archived_window(conn, &session, &tool_use_id, offset))
            .await
    }

    /// Search immutable messages, never a generated compaction summary. A scan
    /// page has an explicit cursor even if its bounded window has no matches.
    /// With a handle instead of a query, one archived tool output comes back.
    pub async fn recall(&self, session: &str, query: Query) -> Result<Value, Error> {
        // Public callers follow the same validation as the model tool boundary.
        let query=Query::parse(json!({"query":query.query,"limit":query.limit,"before_message_seq":query.before_message_seq,"tool_use_id":query.tool_use_id,"offset":query.offset})).map_err(|_|Error::Invalid("invalid recall query".into()))?;
        let session = session.to_owned();
        let handle = query.tool_use_id.clone();
        self.call(move |conn| match handle.as_deref() {
            Some(handle) => archived_window(conn, &session, handle, query.offset),
            None => search_history(conn, &session, &query),
        })
        .await
    }
}

fn search_history(conn: &Connection, session: &str, query: &Query) -> Result<Value, Error> {
    let before = query.before_message_seq.unwrap_or(i64::MAX as u64);
    let mut stmt=conn.prepare("SELECT seq,role,CASE WHEN length(CAST(content AS BLOB))<=2097152 THEN content ELSE NULL END FROM engine_message WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 1001")?;
    let mut rows = stmt.query(params![session, before])?;
    let mut matches = Vec::new();
    let mut skipped = Vec::new();
    let mut scanned = 0;
    let mut bytes = 0;
    let mut cursor = None;
    let mut exhausted = true;
    while let Some(row) = rows.next()? {
        let seq: u64 = row.get(0)?;
        if scanned >= SCAN_LIMIT || matches.len() >= query.limit {
            exhausted = false;
            break;
        }
        let content: Option<String> = row.get(2)?;
        let Some(content) = content else {
            scanned += 1;
            cursor = Some(seq);
            skipped.push(seq);
            continue;
        };
        if bytes + content.len() > 2 * 1024 * 1024 {
            exhausted = false;
            break;
        }
        scanned += 1;
        bytes += content.len();
        cursor = Some(seq);
        let content: Value = serde_json::from_str(&content)?;
        let text = visible_text(&content);
        if let Some(at) = text.find(&query.query) {
            // Character boundaries keep previews valid for Chinese and
            // other multibyte text. Search still examines the full text.
            let start = text[..at]
                .char_indices()
                .rev()
                .nth(100)
                .map(|(index, _)| index)
                .unwrap_or(0);
            let end = text[at..]
                .char_indices()
                .nth(400)
                .map(|(index, _)| at + index)
                .unwrap_or(text.len());
            matches.push(json!({"message_seq":seq,"role":row.get::<_,String>(1)?,"preview":&text[start..end],"preview_truncated":start!=0||end!=text.len()}));
        }
    }
    Ok(
        json!({"matches":matches,"scanned_messages":scanned,"skipped_oversized_message_seqs":skipped,"exhausted":exhausted,"next_before_message_seq":if exhausted{None}else{cursor}}),
    )
}

/// One window of the newest stored tool result carrying `handle`, plus the
/// cursor a deeper page needs when the bounded scan did not reach it.
fn archived_window(
    conn: &Connection,
    session: &str,
    handle: &str,
    offset: usize,
) -> Result<Value, Error> {
    let shell:Option<(u64,String)>=conn.query_row("SELECT seq,data FROM engine_event WHERE session_id=?1 AND kind='shell.ended' AND json_extract(data,'$.call_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,handle],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    if let Some((seq, data)) = shell {
        let data: Value = serde_json::from_str(&data)?;
        let mut window = output_window(
            handle,
            seq,
            data["output"].as_str().unwrap_or(""),
            offset,
            data["exit_code"] != 0 || data["reason"] != "completed",
        );
        window["origin"] = json!("operator");
        return Ok(window);
    }
    let mut stmt = conn.prepare(
        "SELECT seq,content FROM engine_message WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 1001",
    )?;
    let mut rows = stmt.query(params![session, i64::MAX])?;
    let mut scanned = 0;
    let mut cursor = None;
    let mut exhausted = true;
    while let Some(row) = rows.next()? {
        if scanned >= SCAN_LIMIT {
            exhausted = false;
            break;
        }
        let seq: u64 = row.get(0)?;
        scanned += 1;
        cursor = Some(seq);
        let content: Option<String> = row.get(1)?;
        let Some(content) = content else { continue };
        let Ok(content) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let Some(part) = content
            .as_array()
            .into_iter()
            .flatten()
            .find(|part| part["type"] == "tool_result" && part["tool_use_id"] == handle)
        else {
            continue;
        };
        let text = match part["content"].as_str() {
            Some(text) => text.to_owned(),
            None => part["content"].to_string(),
        };
        return Ok(output_window(
            handle,
            seq,
            &text,
            offset,
            part["is_error"].as_bool().unwrap_or(false),
        ));
    }
    Ok(json!({
        "tool_use_id": handle,
        "message_seq": null,
        "text": null,
        "scanned_messages": scanned,
        "exhausted": exhausted,
        "next_before_message_seq": (!exhausted).then_some(cursor).flatten(),
    }))
}

/// The largest char boundary at or below `index`.
fn floor_boundary(text: &str, index: usize) -> usize {
    (0..=index.min(text.len()))
        .rev()
        .find(|at| text.is_char_boundary(*at))
        .unwrap_or(0)
}

/// The smallest char boundary at or above `index`.
fn ceil_boundary(text: &str, index: usize) -> usize {
    (index.min(text.len())..=text.len())
        .find(|at| text.is_char_boundary(*at))
        .unwrap_or(text.len())
}

fn visible_text(content: &Value) -> String {
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| match part["type"].as_str() {
            Some("text") => part["text"].as_str().map(str::to_owned),
            Some("tool_use") => Some(format!("{} {}", part["name"], part["input"])),
            Some("tool_result") => Some(
                part["content"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| part["content"].to_string()),
            ),
            // Opaque provider continuation is not searchable user-visible text.
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn output_window(handle: &str, seq: u64, text: &str, offset: usize, is_error: bool) -> Value {
    let start = floor_boundary(text, offset.min(text.len()));
    let end = ceil_boundary(text, (start + ARCHIVE_WINDOW).min(text.len()));
    let truncated = end < text.len();
    json!({"tool_use_id":handle,"message_seq":seq,"is_error":is_error,"offset":start,"text":&text[start..end],"total_bytes":text.len(),"truncated":truncated,"next_offset":truncated.then_some(end)})
}
