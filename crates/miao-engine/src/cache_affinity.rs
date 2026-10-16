//! Transport-only cache affinity. A provider can serve concurrent Sessions;
//! their routing keys must not live in shared provider state or model messages.

tokio::task_local! { static KEY: String; static SESSION: String; }

pub(crate) async fn scoped<F: std::future::Future>(session: String, future: F) -> F::Output {
    // Bound arbitrary host-supplied Session IDs to a header-safe, 64-byte key.
    // No run, step, process or context-epoch identity belongs in this key.
    let identity = crate::permission::digest(session.as_bytes());
    SESSION
        .scope(identity.clone(), KEY.scope(identity, future))
        .await
}

pub(crate) fn key() -> Option<String> {
    KEY.try_with(Clone::clone).ok()
}

/// Transport ownership is Session-bound even if a cache-routing hint is shared later.
pub(crate) fn session_key() -> Option<String> {
    SESSION.try_with(Clone::clone).ok()
}
