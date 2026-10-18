use crate::{approval::Response, question::Answer};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    #[default]
    Steer,
    Queue,
}

/// Collaboration mode of a Session. `Build` is the default; `Plan` is a
/// read-only planning mode: file writes, command execution and background work
/// are denied even when the permission policy would otherwise allow them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationMode {
    #[default]
    Build,
    Plan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub session_id: String,
    pub input_id: String,
    pub prompt: String,
    #[serde(default)]
    pub delivery: Delivery,
}

/// An inline media attachment carried on a prompt. `data` is base64 without a
/// `data:` prefix; `mime` is the media type (for example `image/png`). The
/// canonical message part has type `image` or `file`; providers normalize a
/// request copy according to protocol and host-declared model input modalities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub mime: String,
    pub data: String,
    /// Presentation metadata belongs to admission identity, not model instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, Value>>,
}

impl Attachment {
    pub fn validate(&self) -> Result<(), Error> {
        if self.metadata.as_ref().is_some_and(|metadata| {
            serde_json::to_vec(metadata).map_or(true, |bytes| bytes.len() > 64 * 1024)
        }) {
            return Err(Error::Invalid("attachment metadata exceeds 64 KiB".into()));
        }
        if !matches!(
            self.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf"
        ) && !(self.mime.starts_with("text/")
            && self.mime.len() <= 128
            && self.mime.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'+' | b'.')
            }))
        {
            return Err(Error::Invalid("unsupported attachment media type".into()));
        }
        if (self.data.is_empty() && !self.mime.starts_with("text/"))
            || self.data.len() > 8 * 1024 * 1024
        {
            return Err(Error::Invalid("attachment data must be 1..8 MiB".into()));
        }
        if !self
            .data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return Err(Error::Invalid("attachment data must be base64".into()));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&self.data)
            .map_err(|_| Error::Invalid("attachment data must be canonical base64".into()))?;
        if self.mime.starts_with("text/") && std::str::from_utf8(&bytes).is_err() {
            return Err(Error::Invalid("text attachment must be UTF-8".into()));
        }
        if self.mime == "application/pdf" && !bytes.starts_with(b"%PDF-") {
            return Err(Error::Invalid("PDF attachment has no PDF header".into()));
        }
        Ok(())
    }

    pub fn part(&self) -> Value {
        let mut part = serde_json::json!({"type":if self.mime.starts_with("image/") {"image"} else {"file"},"mime":self.mime,"data":self.data});
        if let Some(metadata) = &self.metadata {
            part["metadata"] = serde_json::json!(metadata);
        }
        part
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub session_id: String,
    pub seq: u64,
    pub kind: String,
    pub data: Value,
    /// Persisted UNIX milliseconds; null means unknown on pre-timestamp data.
    #[serde(default)]
    pub recorded_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Value,
    /// Stable checkpoint UUID for a promoted user message; None on assistant and
    /// tool-result projections. Providers ignore it and map only role/content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    /// Original commit time, preserved through replay and fork.
    #[serde(default)]
    pub recorded_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Admission {
    pub input_id: String,
    pub admitted_seq: u64,
    pub duplicate: bool,
    pub pending: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("input id conflicts with an existing admission")]
    Conflict,
    #[error("runtime already owns this store")]
    Busy,
    #[error("session lease was superseded by another owner")]
    Fenced,
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("storage: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("runtime has stopped")]
    Closed,
    #[error("approval identity or authority does not match")]
    ApprovalMismatch,
    #[error("approval is already resolved or no longer active")]
    ApprovalResolved,
    #[error("approval has expired")]
    ApprovalExpired,
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Conflict => "input_conflict",
            Self::Busy => "store_busy",
            Self::Fenced => "store_fenced",
            Self::Invalid(_) => "invalid_request",
            Self::Closed => "runtime_closed",
            Self::ApprovalMismatch => "approval_mismatch",
            Self::ApprovalResolved => "approval_resolved",
            Self::ApprovalExpired => "approval_expired",
            _ => "storage_error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// The core contract carries messages and capabilities, not provider URLs,
/// auth, Session identity or provider-specific transport options.
#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextBundle {
    pub system: String,
    pub fingerprint: String,
    pub sources: Vec<Value>,
}

/// A framed host request: a client-supplied `id` plus the command vocabulary.
/// The stdio adapter parses this from JSONL; other transports map their own
/// envelope onto the same [`Command`] values.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: Value,
    #[serde(flatten)]
    pub command: Command,
}

/// The transport-agnostic host command vocabulary. Every adapter maps its
/// envelope onto these commands and dispatches them through
/// [`crate::host::Host`], so the domain operations and controller authority are
/// shared instead of reimplemented per transport.
#[derive(Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Command {
    /// Create an idle Session without admitting a prompt or invoking a model.
    Initialize {
        session_id: String,
        title: String,
    },
    Admit {
        input: Input,
        #[serde(default = "yes")]
        resume: bool,
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    Inject {
        session_id: String,
        #[serde(default)]
        input_id: Option<String>,
        text: String,
        source: String,
    },
    /// Advisory wake: drain eligible inbox work without forcing continuation.
    Wake {
        session_id: String,
    },
    Resume {
        session_id: String,
    },
    /// Drop one durably admitted input before promotion. The admission row is
    /// retained as cancelled evidence, so an exact retry cannot resurrect a
    /// prompt the operator dropped; an unknown or already promoted input is
    /// reported as not accepted instead.
    CancelInput {
        session_id: String,
        input_id: String,
    },
    ModelCatalog,
    SelectModel {
        session_id: String,
        binding: Option<crate::session_model::Binding>,
    },
    SelectAccount {
        session_id: String,
        credential_id: Option<String>,
    },
    Recoveries {
        session_id: String,
        #[serde(default)]
        after: String,
    },
    /// Sessions with unresolved timers whose engine is gone; the supervisor
    /// re-owns them so the child's startup re-arm can fire.
    TimerSessions,
    ResolveRecovery {
        session_id: String,
        call_id: String,
        operation_id: String,
        decision: crate::recovery::Decision,
        #[serde(default)]
        resume: bool,
    },
    Mode {
        session_id: String,
        mode: CollaborationMode,
    },
    Rename {
        session_id: String,
        title: String,
    },
    /// Set or clear a Session's archive timestamp. Archiving is a catalog fact:
    /// it changes no message, run or inbox row, so a Session can be archived
    /// while a drain is active and un-archived later.
    Archive {
        session_id: String,
        archived: bool,
    },
    /// Delete everything a Session owns. Not a tombstone: the conversation,
    /// inbox, runs, approvals, jobs and schedules are gone and the identity can
    /// be re-created. Children keep their Sessions; only their lineage rows are
    /// dropped, matching the product rule that removing a Session does not
    /// delete its forks.
    Remove {
        session_id: String,
    },
    /// Ask for one compaction at the next settled assistant boundary, even when
    /// the automatic trigger's budget gate is under its threshold. The request is
    /// durable and idempotent; one attempt answers it, either way.
    RequestCompact {
        session_id: String,
    },
    /// Apply a host-resolved agent manifest to this Session's subsequent
    /// provider turns (ADR-0017). Resolution stays with the host; the engine
    /// records the manifest and applies it at the turn boundary.
    SelectAgent {
        session_id: String,
        agent: Box<crate::session_agent::AgentManifest>,
    },
    Cancel {
        session_id: String,
    },
    CancelIf {
        session_id: String,
        run_id: String,
    },
    Compact {
        session_id: String,
        compaction_id: String,
        through_message_seq: u64,
        summary: String,
    },
    Recall {
        session_id: String,
        query: String,
        #[serde(default = "recall_limit")]
        limit: usize,
        #[serde(default)]
        before_message_seq: Option<u64>,
    },
    Crons {
        session_id: String,
    },
    CancelCron {
        session_id: String,
        cron_id: String,
    },
    Wakeups {
        session_id: String,
    },
    CancelWakeup {
        session_id: String,
        timer_id: String,
    },
    Questions {
        session_id: String,
    },
    AnswerQuestion {
        session_id: String,
        answer: Answer,
    },
    RejectQuestion {
        session_id: String,
        rejection: crate::question::Rejection,
    },
    State {
        session_id: String,
    },
    Usage {
        session_id: String,
    },
    UpdateState {
        session_id: String,
        operation_id: String,
        tool: String,
        input: Value,
    },
    History {
        session_id: String,
        #[serde(default)]
        selected: bool,
    },
    Job {
        session_id: String,
        job_id: String,
    },
    Jobs {
        session_id: String,
    },
    CancelJob {
        session_id: String,
        job_id: String,
    },
    Context {
        session_id: String,
        #[serde(default)]
        epoch: Option<u64>,
    },
    Snapshot {
        session_id: String,
    },
    Sessions,
    Fork {
        session_id: String,
        target_session_id: String,
        #[serde(default)]
        message_seq: Option<u64>,
    },
    Revert {
        session_id: String,
        checkpoint: String,
    },
    Unrevert {
        session_id: String,
    },
    Events {
        session_id: String,
        #[serde(default)]
        after: u64,
    },
    Subscribe {
        session_id: String,
        #[serde(default)]
        after: u64,
    },
    Unsubscribe {
        session_id: String,
    },
    Approve {
        session_id: String,
        response: Response,
    },
    ApprovePersistent {
        session_id: String,
        response: Response,
    },
    Shutdown,
}

fn recall_limit() -> usize {
    10
}

fn yes() -> bool {
    true
}
