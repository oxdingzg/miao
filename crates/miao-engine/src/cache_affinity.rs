//! Cache routing is advisory. Sharing requires an exact completed wire prefix;
//! exclusive WebSocket ownership always remains bound to the actual Session.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Proof {
    affinity_session: String,
    route_hash: String,
    parameters_hash: String,
    history_hash: String,
    message_count: usize,
}

tokio::task_local! {
    static KEY: String;
    static SESSION: String;
    static AFFINITY: String;
    static CANDIDATE: Option<Proof>;
}

#[cfg(test)]
pub(crate) async fn scoped<F: std::future::Future>(session: String, future: F) -> F::Output {
    scoped_with(session.clone(), session, future).await
}

pub(crate) async fn scoped_with<F: std::future::Future>(
    affinity: String,
    session: String,
    future: F,
) -> F::Output {
    SESSION
        .scope(
            crate::permission::digest(session.as_bytes()),
            KEY.scope(
                crate::permission::digest(affinity.as_bytes()),
                AFFINITY.scope(affinity, future),
            ),
        )
        .await
}

pub(crate) async fn scoped_candidate<F: std::future::Future>(
    session: String,
    candidate: Option<Proof>,
    future: F,
) -> F::Output {
    CANDIDATE
        .scope(candidate, scoped_with(session.clone(), session, future))
        .await
}

/// Compare the complete lowered prefix before assigning a parent routing hint.
/// The exact endpoint/query and credential generation are hashed into `route`.
pub(crate) fn select(
    body: &Value,
    route: &Value,
) -> Result<(Option<String>, Option<Proof>), crate::provider::ProviderError> {
    let Ok(affinity) = AFFINITY.try_with(Clone::clone) else {
        return Ok((None, None));
    };
    let hash = |value: &Value| {
        serde_json::to_vec(value)
            .map(|bytes| crate::permission::digest(&bytes))
            .map_err(|_| {
                crate::provider::ProviderError::Stream(
                    "cache prefix fingerprint could not be encoded".into(),
                )
            })
    };
    let mut parameters = body.as_object().cloned().ok_or_else(|| {
        crate::provider::ProviderError::Stream("cache prefix body must be an object".into())
    })?;
    parameters.remove("input");
    parameters.remove("prompt_cache_key");
    let parameters_hash = hash(
        &json!({"parameters":parameters,"permissions":crate::runtime_profile::permission_hash()}),
    )?;
    let route_hash = hash(route)?;
    let history = body["input"].as_array().ok_or_else(|| {
        crate::provider::ProviderError::Stream("cache prefix input must be an array".into())
    })?;
    let candidate = CANDIDATE.try_with(Clone::clone).ok().flatten();
    let matches = candidate
        .as_ref()
        .filter(|proof| proof.parameters_hash == parameters_hash && proof.route_hash == route_hash)
        .map(|proof| {
            history
                .get(..proof.message_count)
                .map(|prefix| hash(&json!(prefix)).map(|digest| digest == proof.history_hash))
                .transpose()
        })
        .transpose()?
        .flatten()
        .unwrap_or(false);
    let affinity = candidate
        .filter(|_| matches)
        .map_or(affinity, |proof| proof.affinity_session);
    let proof = Proof {
        affinity_session: affinity.clone(),
        route_hash,
        parameters_hash,
        history_hash: hash(&json!(history))?,
        message_count: history.len(),
    };
    Ok((
        Some(crate::permission::digest(affinity.as_bytes())),
        Some(proof),
    ))
}

#[cfg(test)]
pub(crate) fn key() -> Option<String> {
    KEY.try_with(Clone::clone).ok()
}

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

    #[tokio::test]
    async fn a_completed_parent_hint_requires_exact_route_parameters_and_full_prefix() {
        let body = json!({"model":"m","instructions":"private rules","tools":[{"name":"read"}],"input":[{"role":"user","content":"private prompt"}]});
        let route = json!({"endpoint":"https://example/responses?deployment=one","account":"account","generation":"private credential"});
        let (_, proof) = scoped("parent".into(), async { select(&body, &route).unwrap() }).await;
        let mut extended = body.clone();
        extended["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"assistant","content":"answer"}));
        let shared = scoped_candidate("child".into(), proof.clone(), async {
            select(&extended, &route).unwrap()
        })
        .await;
        assert_eq!(shared.0, Some(crate::permission::digest(b"parent")));
        for field in ["model", "instructions", "tools", "input"] {
            let mut changed = body.clone();
            changed[field] = match field {
                "tools" | "input" => json!([]),
                _ => json!("changed"),
            };
            let selected = scoped_candidate("child".into(), proof.clone(), async {
                select(&changed, &route).unwrap()
            })
            .await;
            assert_eq!(
                selected.0,
                Some(crate::permission::digest(b"child")),
                "changed {field}"
            );
        }
        let changed_route = json!({"endpoint":"https://example/responses?deployment=two","account":"account","generation":"private credential"});
        let selected = scoped_candidate("child".into(), proof.clone(), async {
            select(&body, &changed_route).unwrap()
        })
        .await;
        assert_eq!(selected.0, Some(crate::permission::digest(b"child")));
        let encoded = serde_json::to_string(&proof).unwrap();
        for private in [
            "private rules",
            "private prompt",
            "private credential",
            "deployment=one",
        ] {
            assert!(!encoded.contains(private));
        }
    }
}
