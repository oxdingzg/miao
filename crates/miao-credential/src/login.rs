//! OpenAI's device authorization flow. Login stays inside the daemon: clients
//! receive a verification URL/code and an opaque pending handle, never the
//! device secret or PKCE verifier.
use crate::{profile, Error};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct DeviceCode {
    device_auth_id: String,
    user_code: String,
    interval: String,
}

pub struct Pending {
    device_id: String,
    user_code: String,
    deadline: Instant,
    next_poll: Instant,
    interval: Duration,
}

impl Pending {
    pub fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

pub async fn begin(profile: &profile::Profile, agent: &str) -> Result<(Pending, Value), Error> {
    if profile.integration != "openai" {
        return Err(Error::Integration);
    }
    let response = profile::http_client()?
        .post(format!(
            "{}/api/accounts/deviceauth/usercode",
            profile.issuer
        ))
        .header("User-Agent", agent)
        .json(&json!({"client_id": profile.client_id}))
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?;
    if !response.status().is_success() {
        return Err(Error::LoginRejected);
    }
    let code: DeviceCode = response.json().await.map_err(|_| Error::LoginRejected)?;
    if code.device_auth_id.is_empty()
        || code.user_code.is_empty()
        || code.device_auth_id.len() > 4096
        || code.user_code.len() > 256
    {
        return Err(Error::LoginRejected);
    }
    // Same safety margin as the existing TS headless implementation.
    let interval = Duration::from_secs(code.interval.parse::<u64>().unwrap_or(5).clamp(1, 60) + 3);
    let public = json!({"url": format!("{}/codex/device", profile.issuer), "user_code": code.user_code, "interval_ms": interval.as_millis() as u64});
    Ok((
        Pending {
            device_id: code.device_auth_id,
            user_code: code.user_code,
            deadline: Instant::now() + Duration::from_secs(900),
            next_poll: Instant::now(),
            interval,
        },
        public,
    ))
}

pub async fn poll(
    pending: &mut Pending,
    profile: &profile::Profile,
    agent: &str,
) -> Result<Option<Value>, Error> {
    if pending.expired() {
        return Err(Error::LoginRejected);
    }
    if Instant::now() < pending.next_poll {
        return Ok(None);
    }
    pending.next_poll = Instant::now() + pending.interval;
    let response = profile::http_client()?
        .post(format!("{}/api/accounts/deviceauth/token", profile.issuer))
        .header("User-Agent", agent)
        .json(&json!({"device_auth_id": pending.device_id, "user_code": pending.user_code}))
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?;
    if matches!(response.status().as_u16(), 403 | 404) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(Error::LoginRejected);
    }
    #[derive(Deserialize)]
    struct Authorized {
        authorization_code: String,
        code_verifier: String,
    }
    let authorized: Authorized = response.json().await.map_err(|_| Error::LoginRejected)?;
    let response = profile::http_client()?
        .post(format!("{}/oauth/token", profile.issuer))
        .header("User-Agent", agent)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &authorized.authorization_code),
            ("code_verifier", &authorized.code_verifier),
            ("client_id", &profile.client_id),
            (
                "redirect_uri",
                &format!("{}/deviceauth/callback", profile.issuer),
            ),
        ])
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?;
    if !response.status().is_success() {
        return Err(Error::LoginRejected);
    }
    let tokens: profile::TokenResponse = response.json().await.map_err(|_| Error::LoginRejected)?;
    if tokens.access_token.is_empty() || tokens.refresh_token.as_deref().is_none_or(str::is_empty) {
        return Err(Error::LoginRejected);
    }
    let mut value = json!({"type":"oauth", "methodID":"chatgpt-headless"});
    profile::apply_tokens(&mut value, &tokens, crate::store::now_ms());
    if let Some(account) = tokens
        .id_token
        .as_deref()
        .and_then(account_id)
        .or_else(|| account_id(&tokens.access_token))
    {
        value["metadata"] = json!({"accountID":account});
    }
    Ok(Some(value))
}

// JWT claims are metadata, not an authentication decision; the token endpoint
// has already authenticated the exchange. Invalid claims leave metadata unset.
fn account_id(token: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?)
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("chatgpt_account_id")
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")?
                .get("chatgpt_account_id")
        })
        .or_else(|| claims.get("organizations")?.get(0)?.get("id"))?
        .as_str()
        .map(str::to_owned)
}
