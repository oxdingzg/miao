//! Human-facing session recap (roadmap CTX-03).
//!
//! A recap answers "what happened here, and where did we stop" for a person
//! coming back to a Session. It is derived from durable records only: no
//! provider call, no summarizer pass, and no checkpoint. Compaction is the
//! opposite operation — it spends a provider call and writes a checkpoint that
//! replaces the prefix the next request sends — so keeping the two verbs apart
//! is what makes "compact frees context, recap only helps a person" checkable
//! rather than a claim.
//!
//! The event this module appends is a review artifact. It is not a message, so
//! it never enters provider history, and [`Store::selected_history`] returns
//! the same value before and after a recap.

use crate::{
    context_trigger::{bounded, durable_state_block},
    protocol::{Error, Message},
    store::{append, write_tx, Store},
};
use chrono::TimeZone;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The whole recap is bounded: a review request must not turn a long Session
/// into an unbounded payload.
pub const MAX_RECAP_CHARS: usize = 16_384;
/// A checkpoint summary can be 32 KiB; a recap shows the part a reader can use.
const COMPACTED_CHARS: usize = 8_192;
const PROMPT_CHARS: usize = 200;
const REPLY_CHARS: usize = 1_000;
const LISTED_FILES_CHARS: usize = 2_000;
const PROMPTS: usize = 3;

/// One Session at one instant, split the way a returning reader needs it: the
/// history the provider no longer sees (the latest checkpoint) and the window
/// it still sees.
pub struct Recap {
    pub checkpoint: Option<(u64, String)>,
    pub total_messages: u64,
    pub window: Vec<(u64, Message)>,
    pub state: Value,
    pub recorded_at_ms: Option<u64>,
}

impl Store {
    /// Record one recap and return its text and event sequence.
    ///
    /// Reading and recording share a transaction so a drain writing
    /// concurrently yields one consistent snapshot instead of a torn one.
    pub async fn recap(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx = write_tx(conn)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
                [&session],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(Error::Invalid("Session does not exist".into()));
            }
            let inputs = read(&tx, &session)?;
            let text = render(&inputs);
            let through = inputs.checkpoint.as_ref().map(|(through, _)| *through);
            let event = append(
                &tx,
                &session,
                "recap.created",
                json!({
                    "text": text,
                    "through_message_seq": through,
                    "messages_after_checkpoint": inputs.window.len(),
                }),
            )?;
            tx.commit()?;
            Ok(json!({
                "seq": event.seq,
                "text": text,
                "through_message_seq": through,
                "messages_after_checkpoint": inputs.window.len(),
                "total_messages": inputs.total_messages,
            }))
        })
        .await
    }
}

fn read(conn: &Connection, session: &str) -> Result<Recap, Error> {
    let checkpoint: Option<(u64, String)> = conn
        .query_row(
            "SELECT through_seq,summary FROM engine_compaction WHERE session_id=?1 ORDER BY created_seq DESC LIMIT 1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let through = checkpoint
        .as_ref()
        .map(|(through, _)| *through)
        .unwrap_or(0);
    let total_messages: u64 = conn.query_row(
        "SELECT COUNT(*) FROM engine_message WHERE session_id=?1 AND reverted=0 AND quarantined=0",
        [session],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT seq,role,content,recorded_at_ms FROM engine_message WHERE session_id=?1 AND reverted=0 AND quarantined=0 AND seq>?2 ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![session, through], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<u64>>(3)?,
        ))
    })?;
    let window = rows
        .map(|row| {
            let (seq, role, content, recorded_at_ms) = row?;
            Ok((
                seq,
                Message {
                    role,
                    content: serde_json::from_str(&content)?,
                    checkpoint: None,
                    recorded_at_ms,
                },
            ))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(Recap {
        recorded_at_ms: window.iter().rev().find_map(|(_, m)| m.recorded_at_ms),
        checkpoint,
        total_messages,
        window,
        state: crate::state::projection(conn, session, i64::MAX as u64)?,
    })
}

/// The recap text. Sections a Session does not have are omitted rather than
/// printed empty, so a short Session reads as short instead of hollow.
pub fn render(recap: &Recap) -> String {
    let mut sections = vec![header(recap)];
    if let Some((through, summary)) = &recap.checkpoint {
        sections.push(format!(
            "## Compacted history (through message {through})\n{}",
            bounded(summary.trim(), COMPACTED_CHARS)
        ));
    }
    let durable = durable_state_block(&recap.state);
    if !durable.is_empty() {
        sections.push(durable);
    }
    let prompts = recent_prompts(&recap.window);
    if !prompts.is_empty() {
        sections.push(format!("## Recent prompts\n{prompts}"));
    }
    let reply = last_reply(&recap.window);
    if !reply.is_empty() {
        sections.push(format!("## Last reply\n{reply}"));
    }
    let activity = tool_activity(&recap.window);
    if !activity.is_empty() {
        sections.push(format!("## Tool activity\n{activity}"));
    }
    bounded(&sections.join("\n\n"), MAX_RECAP_CHARS)
}

fn header(recap: &Recap) -> String {
    let mut lines = vec!["## Session recap".to_owned()];
    match &recap.checkpoint {
        Some((through, _)) => lines.push(format!(
            "- messages: {} total, {} since the checkpoint at message {through}",
            recap.total_messages,
            recap.window.len()
        )),
        None => lines.push(format!("- messages: {}", recap.total_messages)),
    }
    if let Some(at) = recap.recorded_at_ms {
        lines.push(format!("- latest message: {}", local_time(at)));
    }
    lines.join("\n")
}

fn recent_prompts(window: &[(u64, Message)]) -> String {
    let mut lines = window
        .iter()
        .rev()
        .filter(|(_, message)| message.role == "user")
        .filter_map(|(seq, message)| {
            let text = text_of(&message.content);
            (!text.trim().is_empty())
                .then(|| format!("- message {seq}: {}", bounded(text.trim(), PROMPT_CHARS)))
        })
        .take(PROMPTS)
        .collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

/// The newest assistant message that actually said something: a tool-only turn
/// has no text and is not what a returning reader is looking for.
fn last_reply(window: &[(u64, Message)]) -> String {
    window
        .iter()
        .rev()
        .filter(|(_, message)| message.role == "assistant")
        .find_map(|(_, message)| {
            let text = text_of(&message.content);
            (!text.trim().is_empty()).then(|| bounded(text.trim(), REPLY_CHARS))
        })
        .unwrap_or_default()
}

/// Counts and paths rather than a narrative: what ran, what failed, what
/// changed. Deterministic, so the test can pin it.
fn tool_activity(window: &[(u64, Message)]) -> String {
    let mut calls = 0usize;
    let mut failures = 0usize;
    let mut patches = 0usize;
    let mut files: BTreeMap<&str, usize> = BTreeMap::new();
    for part in window
        .iter()
        .flat_map(|(_, message)| message.content.as_array().into_iter().flatten())
    {
        match part["type"].as_str() {
            Some("tool_use") => {
                calls += 1;
                match part["name"].as_str() {
                    Some("write_file" | "edit_file") => {
                        if let Some(path) = part["input"]["path"].as_str() {
                            *files.entry(path).or_default() += 1;
                        }
                    }
                    Some("apply_patch") => patches += 1,
                    _ => {}
                }
            }
            Some("tool_result") if part["is_error"] == true => failures += 1,
            _ => {}
        }
    }
    if calls == 0 {
        return String::new();
    }
    let mut lines = vec![format!("- {calls} calls, {failures} failed")];
    if !files.is_empty() {
        let listed = files
            .iter()
            .map(|(path, count)| format!("{path} x{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "- files changed: {}",
            bounded(&listed, LISTED_FILES_CHARS)
        ));
    }
    if patches > 0 {
        lines.push(format!("- apply_patch: {patches}"));
    }
    lines.join("\n")
}

fn text_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn local_time(ms: u64) -> String {
    chrono::Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(|at| at.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| format!("{ms} ms"))
}
