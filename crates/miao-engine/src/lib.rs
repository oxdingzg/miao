pub mod acp;
pub mod approval;
mod cache_affinity;
pub mod context;
pub mod context_trigger;
pub mod credential;
pub mod cron;
pub mod doctor;
mod edit_recovery;
pub mod events;
pub mod export;
mod file_mutation;
pub mod formatter;
pub mod gemini;
mod history;
pub mod hooks;
pub mod host;
pub mod http;
mod jobs;
pub mod knowledge;
pub mod lsp;
pub mod mcp;
mod media;
pub mod openai_chat;
pub mod openai_responses;
pub mod patch;
pub mod permission;
pub mod process;
pub mod protocol;
pub mod provider;
pub mod question;
pub mod recall;
pub mod recovery;
pub mod request_options;
pub mod responses_cache;
pub mod responses_websocket;
pub mod roles;
pub mod routing;
pub mod runtime;
mod search;
pub mod session_model;
pub mod state;
pub mod store;

/// Engine-host contract version. A product build requires at least the protocol
/// it was written against; older engines report nothing and are refused.
pub const PROTOCOL: u32 = 2;
pub mod subagent;
pub mod terminal;
pub mod tool_replay;
pub mod tools;
pub mod usage;
mod verification;
pub mod wakeup;
pub mod web;
pub mod worker;

pub mod tool_catalog;
mod tool_input;

mod first_event;

mod delta;
mod runtime_profile;

pub mod model_catalog;
pub mod model_routes;
mod monitor;
pub mod product;
