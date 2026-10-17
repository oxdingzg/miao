//! Transport-only cache affinity. A provider can serve concurrent Sessions;
//! their routing keys must not live in shared provider state or model messages.

tokio::task_local! { static KEY: String; static SESSION: String; }

#[cfg(test)]
pub(crate) async fn scoped<F: std::future::Future>(session: String, future: F) -> F::Output {
    scoped_with(session.clone(), session, future).await
}

pub(crate) async fn scoped_with<F: std::future::Future>(
    affinity: String,
    session: String,
    future: F,
) -> F::Output {
    // Bound arbitrary host-supplied Session IDs to a header-safe, 64-byte key.
    // No run, step, process or context-epoch identity belongs in this key.
    let identity = crate::permission::digest(session.as_bytes());
    SESSION
        .scope(
            identity,
            KEY.scope(crate::permission::digest(affinity.as_bytes()), future),
        )
        .await
}

pub(crate) fn key() -> Option<String> {
    KEY.try_with(Clone::clone).ok()
}

/// Transport ownership is Session-bound even if a cache-routing hint is shared later.
pub(crate) fn session_key() -> Option<String> {
    SESSION.try_with(Clone::clone).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shared_affinity_does_not_share_exclusive_transport_ownership() {
        let observed = tokio::join!(
            scoped_with("root".into(), "parent".into(), async {
                (key(), session_key())
            }),
            scoped_with("root".into(), "child".into(), async {
                (key(), session_key())
            }),
        );
        assert_eq!(observed.0 .0, observed.1 .0);
        assert_ne!(observed.0 .1, observed.1 .1);
        assert_eq!(key(), None);
        assert_eq!(session_key(), None);
    }
}
