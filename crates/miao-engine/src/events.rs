//! Frozen M0 lifecycle event vocabulary.
//!
//! These names are the engine's public protocol surface: hooks are configured
//! by them, the durable ledger records them as canonical events, and both the
//! stdio `event` notifications and the JSONL `export` reproduce them verbatim.
//! Additive variants and additive payload fields are backward compatible;
//! renaming or removing a name or a reserved payload field requires bumping
//! [`PROTOCOL_VERSION`].

use serde::{Deserialize, Serialize};

/// Revision of the stdio/JSONL protocol and this vocabulary. Clients pin it
/// from `miao-engine --version` and refuse an unknown major.
pub const PROTOCOL_VERSION: &str = "engine-stdio-0";

/// The ~13 core lifecycle events. Subagent events are reserved: the engine has
/// no subagent capability yet, so they are never emitted; they stay in the
/// vocabulary so a future producer does not have to rename the surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PermissionRequest,
    PermissionDenied,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    Stop,
    StopFailure,
    InstructionsLoaded,
}

impl Lifecycle {
    /// The complete frozen vocabulary. A test pins the order and names.
    pub const ALL: [Lifecycle; 13] = [
        Lifecycle::SessionStart,
        Lifecycle::UserPromptSubmit,
        Lifecycle::PreToolUse,
        Lifecycle::PostToolUse,
        Lifecycle::PermissionRequest,
        Lifecycle::PermissionDenied,
        Lifecycle::SubagentStart,
        Lifecycle::SubagentStop,
        Lifecycle::PreCompact,
        Lifecycle::PostCompact,
        Lifecycle::Stop,
        Lifecycle::StopFailure,
        Lifecycle::InstructionsLoaded,
    ];

    /// The wire name used in hook config, canonical events and JSONL export.
    pub fn name(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::UserPromptSubmit => "user_prompt_submit",
            Self::PreToolUse => "pre_tool_use",
            Self::PostToolUse => "post_tool_use",
            Self::PermissionRequest => "permission_request",
            Self::PermissionDenied => "permission_denied",
            Self::SubagentStart => "subagent_start",
            Self::SubagentStop => "subagent_stop",
            Self::PreCompact => "pre_compact",
            Self::PostCompact => "post_compact",
            Self::Stop => "stop",
            Self::StopFailure => "stop_failure",
            Self::InstructionsLoaded => "instructions_loaded",
        }
    }

    /// Reserved payload fields. A producer may add fields; it must not drop or
    /// repurpose one of these without a version bump.
    pub fn payload_fields(self) -> &'static [&'static str] {
        match self {
            Self::SessionStart => &["run_id"],
            Self::UserPromptSubmit => &["run_id", "input_id"],
            Self::PreToolUse | Self::PostToolUse => &["run_id", "call_id", "tool"],
            Self::PermissionRequest => &["run_id", "call_id", "tool", "resource"],
            Self::PermissionDenied => &["run_id", "call_id", "tool", "resource", "reason"],
            Self::SubagentStart | Self::SubagentStop => &["run_id", "subagent_id"],
            Self::PreCompact | Self::PostCompact => &["compaction_id", "through_message_seq"],
            Self::Stop => &["run_id", "reason"],
            Self::StopFailure => &["run_id", "reason"],
            Self::InstructionsLoaded => &["run_id", "sources"],
        }
    }

    /// Tool-scoped events match a configured hook by tool name; every other
    /// event only matches the `*` hook.
    pub fn tool_scoped(self) -> bool {
        matches!(self, Self::PreToolUse | Self::PostToolUse)
    }
}
