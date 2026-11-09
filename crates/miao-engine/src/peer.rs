//! Cross-Session peer mail: durable receipts, reply linkage, and loop budgets
//! (AGT-05).
//!
//! A peer message is an attributed input in the recipient's durable inbox. Who
//! sent it and which receipt it answers live in columns beside the prompt, so
//! a thread is structured data instead of prompt text to re-parse, and the
//! reply-loop budget is a counted query rather than a string match. Delivery
//! stays durable: an admitted row survives a restart exactly once and a
//! promoted one never re-delivers, because the inbox row is the only truth.
//!
//! Same-project identity is the shared `engine_location` root. Mail between
//! Sessions anchored to different roots is refused here, at the store
//! boundary, so no caller can deliver across projects even by skipping the
//! tool's own resolution.
use crate::{
    protocol::{Admission, Error, Input},
    store::{admit_input, append, write_tx, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;

/// Why a send was refused, recorded durably beside the sender's ledger so the
/// stop reason outlives the turn that produced it. The strings are the product
/// vocabulary: a loop stops because its budget is spent, mail stops because
/// the recipient's boundary is full.
pub const STOP_REPLY_BUDGET: &str = "reply_budget_exhausted";
pub const STOP_INBOUND_FULL: &str = "inbound_queue_full";

impl Store {
    /// Admit one peer message into the recipient's inbox with its sender and
    /// reply linkage as durable columns. The recipient must exist and share
    /// the sender's project anchor; an exact retry reconciles the whole
    /// admission, including the linkage, so a lost ack cannot duplicate mail.
    pub async fn admit_peer_message(
        &self,
        sender: &str,
        reply_to: Option<&str>,
        input: Input,
    ) -> Result<Admission, Error> {
        let (sender, reply_to) = (sender.to_owned(), reply_to.map(str::to_owned));
        self.call(move |conn| {
            let tx = write_tx(conn)?;
            let admission = admit_peer(&tx, &sender, reply_to.as_deref(), &input)?;
            tx.commit()?;
            Ok(admission)
        })
        .await
    }

    /// Whether `receipt` names a message `sender` actually sent to the Session
    /// whose inbox this is. A reply to a fabricated id would read as a thread
    /// that never happened, so the check is exact: the durable sender column
    /// for current mail, and the prompt attribution for mail admitted before
    /// the column existed.
    pub async fn peer_receipt_exists(
        &self,
        sender: &str,
        inbox: &str,
        receipt: &str,
    ) -> Result<bool, Error> {
        let (sender, inbox, receipt) = (sender.to_owned(), inbox.to_owned(), receipt.to_owned());
        self.call(move |conn| {
            let exact: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_input WHERE session_id=?1 AND id=?2 AND sender=?3)",
                params![inbox, receipt, sender],
                |row| row.get(0),
            )?;
            if exact {
                return Ok(true);
            }
            // Legacy attribution lives in the prompt. The prefixes are matched
            // with substr, never LIKE, because Session ids are caller-chosen
            // strings and a `%` in one must not turn into a wildcard.
            let fresh = format!("Message from Session {sender}:");
            let reply = format!("Message from Session {sender} (reply to ");
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_input WHERE session_id=?1 AND id=?2 \
                 AND sender IS NULL AND (substr(prompt,1,length(?3))=?3 OR substr(prompt,1,length(?4))=?4))",
                params![inbox, receipt, fresh, reply],
                |row| row.get(0),
            )?)
        })
        .await
    }

    /// How many replies one receipt has already received in this inbox. The
    /// count is what bounds a reply loop: the budget refuses a reply when it
    /// is already spent, which is durable state, not a per-turn observation.
    pub async fn peer_reply_count(&self, inbox: &str, receipt: &str) -> Result<u64, Error> {
        let (inbox, receipt) = (inbox.to_owned(), receipt.to_owned());
        self.call(move |conn| {
            // Replies carry the receipt as a column; replies admitted before
            // the column existed carry it in the prompt. `instr` is a literal
            // substring search, so a receipt id cannot widen the match.
            let marker = format!("(reply to {receipt})");
            Ok(conn.query_row(
                "SELECT count(*) FROM engine_input WHERE session_id=?1 \
                 AND (reply_to=?2 OR (reply_to IS NULL AND instr(prompt,?3)>0))",
                params![inbox, receipt, marker],
                |row| row.get::<_, u64>(0),
            )?)
        })
        .await
    }

    /// Record a refused send on the sender's ledger. The refusal is the
    /// loop's stop reason made durable: the model that sent it reads the
    /// explanation in its tool result, and the ledger keeps why the thread
    /// stopped after the turn is gone.
    pub async fn record_peer_refusal(
        &self,
        session: &str,
        target: &str,
        receipt: Option<&str>,
        stop_reason: &str,
        detail: &str,
    ) -> Result<u64, Error> {
        let (session, target, receipt, stop_reason, detail) = (
            session.to_owned(),
            target.to_owned(),
            receipt.map(str::to_owned),
            stop_reason.to_owned(),
            detail.to_owned(),
        );
        self.call(move |conn| {
            let tx = write_tx(conn)?;
            let mut data = json!({
                "target": target,
                "stop_reason": stop_reason,
                "detail": detail,
            });
            if let Some(receipt) = receipt {
                data["receipt"] = json!(receipt);
            }
            let event = append(&tx, &session, "peer.message.refused", data)?;
            tx.commit()?;
            Ok(event.seq)
        })
        .await
    }
}

/// The store-side guard behind [`Store::admit_peer_message`]. Runs inside one
/// write transaction so the identity check and the admission commit together.
fn admit_peer(
    tx: &rusqlite::Transaction<'_>,
    sender: &str,
    reply_to: Option<&str>,
    input: &Input,
) -> Result<Admission, Error> {
    let sender_root: Option<String> = tx
        .query_row(
            "SELECT root FROM engine_location WHERE session_id=?1",
            [sender],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sender_root) = sender_root else {
        return Err(Error::Invalid(
            "peer message sender has no project anchor".into(),
        ));
    };
    let recipient_root: Option<String> = tx
        .query_row(
            "SELECT root FROM engine_location WHERE session_id=?1",
            [&input.session_id],
            |row| row.get(0),
        )
        .optional()?;
    // A recipient without an anchor has no project identity, so the
    // shared-project test cannot pass; refuse rather than guess. This also
    // keeps `admit_input` from auto-creating a Session the sender only
    // misspelled.
    if recipient_root.as_deref() != Some(sender_root.as_str()) {
        return Err(Error::Invalid(format!(
            "peer message recipient {} does not share this Session's project",
            input.session_id
        )));
    }
    let admission = admit_input(tx, input, None, &[])?;
    let existing: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT sender,reply_to FROM engine_input WHERE id=?1",
            [&input.input_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((stored_sender, stored_reply)) = existing {
        // A retry reconciles the linkage too: the same id answering a
        // different receipt is a conflict, not a silent rewrite. A legacy row
        // (no sender column yet) stays lenient, because stamping it is the
        // upgrade path rather than a rewrite of attributed mail.
        if stored_sender.is_some() {
            if stored_sender.as_deref() != Some(sender) {
                return Err(Error::Conflict);
            }
            if stored_reply.as_deref() != reply_to {
                return Err(Error::Conflict);
            }
        }
    }
    // Stamp the columns on the fresh row, or upgrade a legacy row whose
    // attribution lived only in the prompt; a stamped row is left alone.
    tx.execute(
        "UPDATE engine_input SET sender=?2, reply_to=?3 WHERE id=?1 AND sender IS NULL",
        params![input.input_id, sender, reply_to],
    )?;
    Ok(admission)
}
