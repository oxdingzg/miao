use crate::{approval::Response, question::Answer};
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
/// canonical message part is `{"type":"image","mime":..,"data":..}`; providers
/// encode it in their own wire format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub mime: String,
    pub data: String,
}

impl Attachment {
    pub fn validate(&self) -> Result<(), Error> {
        if !matches!(
            self.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err(Error::Invalid("unsupported attachment media type".into()));
        }
        if self.data.is_empty() || self.data.len() > 8 * 1024 * 1024 {
            return Err(Error::Invalid("attachment data must be 1..8 MiB".into()));
        }
        if !self
            .data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return Err(Error::Invalid("attachment data must be base64".into()));
        }
        Ok(())
    }

    pub fn part(&self) -> Value {
        serde_json::json!({"type":"image","mime":self.mime,"data":self.data})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub session_id: String,
    pub seq: u64,
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Value,
    /// Stable checkpoint UUID for a promoted user message; None on assistant and
    /// tool-result projections. Providers ignore it and map only role/content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
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
    Admit {
        input: Input,
        #[serde(default = "yes")]
        resume: bool,
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    Resume {
        session_id: String,
    },
    Mode {
        session_id: String,
        mode: CollaborationMode,
    },
    Cancel {
        session_id: String,
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
    State {
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
    Shutdown,
}

fn recall_limit() -> usize {
    10
}

fn yes() -> bool {
    true
}
