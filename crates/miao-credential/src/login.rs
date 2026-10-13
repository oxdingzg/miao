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
    standard: bool,
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
        return begin_standard(profile, agent).await;
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
            standard: false,
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
    if pending.standard {
        return poll_standard(pending, profile, agent).await;
    }
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

async fn begin_standard(
    profile: &profile::Profile,
    agent: &str,
) -> Result<(Pending, Value), Error> {
    let path = match profile.integration.as_str() {
        "opencode" => "/auth/device/code",
        "github-copilot" => "/login/device/code",
        _ => return Err(Error::Integration),
    };
    let response = profile::http_client()?
        .post(format!("{}{path}", profile.issuer))
        .header("User-Agent", agent)
        .header("Accept", "application/json")
        .json(&if profile.integration == "github-copilot" {
            json!({"client_id":profile.client_id,"scope":"read:user"})
        } else {
            json!({"client_id":profile.client_id})
        })
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?;
    if !response.status().is_success() {
        return Err(Error::LoginRejected);
    }
    let code: Value = response.json().await.map_err(|_| Error::LoginRejected)?;
    let device_id = code["device_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or(Error::LoginRejected)?
        .to_owned();
    let user_code = code["user_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or(Error::LoginRejected)?
        .to_owned();
    let verification = code
        .get("verification_uri_complete")
        .or_else(|| code.get("verification_uri"))
        .and_then(Value::as_str)
        .ok_or(Error::LoginRejected)?;
    let url = reqwest::Url::parse(&format!("{}/", profile.issuer))
        .and_then(|base| base.join(verification))
        .map_err(|_| Error::LoginRejected)?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(Error::LoginRejected);
    }
    let safety = if profile.integration == "github-copilot" {
        3
    } else {
        0
    };
    let interval =
        Duration::from_secs(code["interval"].as_u64().unwrap_or(5).clamp(1, 60) + safety);
    let public =
        json!({"url":url.as_str(),"user_code":user_code,"interval_ms":interval.as_millis() as u64});
    let next_poll = if profile.integration == "opencode" {
        Instant::now() + interval
    } else {
        Instant::now()
    };
    Ok((
        Pending {
            standard: true,
            device_id,
            user_code,
            deadline: Instant::now()
                + Duration::from_secs(code["expires_in"].as_u64().unwrap_or(900).clamp(1, 3600)),
            next_poll,
            interval,
        },
        public,
    ))
}

async fn poll_standard(
    pending: &mut Pending,
    profile: &profile::Profile,
    agent: &str,
) -> Result<Option<Value>, Error> {
    let path = match profile.integration.as_str() {
        "opencode" => "/auth/device/token",
        "github-copilot" => "/login/oauth/access_token",
        _ => return Err(Error::Integration),
    };
    let response = profile::http_client()?.post(format!("{}{path}",profile.issuer)).header("User-Agent",agent).header("Accept","application/json")
        .json(&json!({"grant_type":"urn:ietf:params:oauth:grant-type:device_code","client_id":profile.client_id,"device_code":pending.device_id}))
        .send().await.map_err(|_| Error::RefreshUnavailable)?;
    let success = response.status().is_success();
    let body: Value = response.json().await.map_err(|_| Error::LoginRejected)?;
    match body.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => return Ok(None),
        Some("slow_down") => {
            pending.interval += Duration::from_secs(5);
            pending.next_poll = Instant::now() + pending.interval;
            return Ok(None);
        }
        Some(_) => return Err(Error::LoginRejected),
        None => (),
    }
    if !success {
        return Err(Error::LoginRejected);
    }
    if profile.integration == "github-copilot" {
        let token = body["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(Error::LoginRejected)?;
        let mut value = json!({"type":"oauth","methodID":"github-copilot-device","access":token,"refresh":token,"expires":0});
        if profile.issuer != "https://github.com" {
            let url = reqwest::Url::parse(&profile.issuer).map_err(|_| Error::LoginRejected)?;
            value["metadata"] =
                json!({"enterpriseUrl":url.host_str().ok_or(Error::LoginRejected)?});
        }
        return Ok(Some(value));
    }
    let tokens: profile::TokenResponse =
        serde_json::from_value(body).map_err(|_| Error::LoginRejected)?;
    if tokens.access_token.is_empty() || tokens.refresh_token.as_deref().is_none_or(str::is_empty) {
        return Err(Error::LoginRejected);
    }
    let client = profile::http_client()?;
    let user: Value = client
        .get(format!("{}/api/user", profile.issuer))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?
        .error_for_status()
        .map_err(|_| Error::LoginRejected)?
        .json()
        .await
        .map_err(|_| Error::LoginRejected)?;
    let mut orgs: Vec<Value> = client
        .get(format!("{}/api/orgs", profile.issuer))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?
        .error_for_status()
        .map_err(|_| Error::LoginRejected)?
        .json()
        .await
        .map_err(|_| Error::LoginRejected)?;
    if !user["id"].is_string() || !user["email"].is_string() {
        return Err(Error::LoginRejected);
    }
    orgs.sort_by(|a, b| {
        a["name"]
            .as_str()
            .cmp(&b["name"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let mut value = json!({"type":"oauth","methodID":"device","metadata":{"server":profile.issuer,"accountID":user["id"],"email":user["email"]}});
    if let Some(org) = orgs.first() {
        value["metadata"]["orgID"] = org["id"].clone();
        value["metadata"]["orgName"] = org["name"].clone();
    }
    profile::apply_tokens(&mut value, &tokens, crate::store::now_ms());
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
