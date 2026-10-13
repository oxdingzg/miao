//! Standalone credential daemon.
//!
//! The daemon is the single refresh writer for the credential rows it owns:
//! one process, one implementation of the read-refresh-write critical region,
//! with every consumer (the engine, tools, the legacy TS broker during
//! migration) reduced to a client. The SQLite row remains the shared source of
//! truth; readers keep re-reading it each turn exactly as before.

pub mod login;
pub mod profile;
pub mod protocol;
pub mod store;

// The daemon and its client speak a unix-socket protocol; on platforms
// without unix sockets the storage/protocol/profile layers still compile so
// the crate and its tests build everywhere.
#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod daemon;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Error {
    #[error("credential was not found")]
    Missing,
    #[error("invalid or unsupported credential data")]
    Invalid,
    #[error("credential integration does not match the requested binding")]
    Integration,
    #[error("credential cannot be refreshed in this state")]
    NotRefreshable,
    #[error("token endpoint rejected the refresh")]
    RefreshRejected,
    #[error("token endpoint is unreachable")]
    RefreshUnavailable,
    #[error("credential source IO failed")]
    Io,
    #[error("unsupported or unavailable credential database")]
    Database,
    #[error("device authorization failed or expired")]
    LoginRejected,
    #[error("daemon protocol violation")]
    Protocol,
}

impl Error {
    /// Wire code for a protocol frame. Codes are stable strings; clients must
    /// treat unknown codes as `invalid`.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Missing => "missing",
            Error::Invalid => "invalid",
            Error::Integration => "integration",
            Error::NotRefreshable => "not_refreshable",
            Error::RefreshRejected => "refresh_rejected",
            Error::RefreshUnavailable => "refresh_unavailable",
            Error::Io => "io",
            Error::Database => "database",
            Error::Protocol => "protocol",
            Error::LoginRejected => "login_rejected",
        }
    }
}

/// A credential row becomes eligible for refresh this long before its stored
/// expiry, so a provider turn never starts with a token that dies mid-turn.
pub const REFRESH_MARGIN_MS: u64 = 5 * 60 * 1000;
