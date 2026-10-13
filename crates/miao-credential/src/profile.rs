//! Refresh profiles: the per-provider facts of a token endpoint, kept apart
//! from the daemon's storage and locking so a provider is one declarative
//! entry plus this one request.
//!
//! The OpenAI profile mirrors the TS broker byte-for-byte: same endpoint, the
//! same `client_id`, form-encoded body, and the same `miao/<version>`
//! User-Agent, so the provider cannot tell the two writers apart.

use crate::Error;
use serde::Deserialize;

pub fn openai() -> Profile {
    Profile {
        integration: "openai".into(),
        issuer: "https://auth.openai.com".into(),
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann".into(),
    }
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub integration: String,
    pub issuer: String,
    pub client_id: String,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// Refreshes one credential against the profile's token endpoint. A missing
/// `refresh_token` in the response means the provider kept the old one; the
/// caller must then leave the stored value untouched.
pub async fn refresh(
    profile: &Profile,
    refresh_token: &str,
    user_agent: &str,
) -> Result<TokenResponse, Error> {
    if refresh_token.is_empty() || refresh_token.len() > 16384 {
        return Err(Error::NotRefreshable);
    }
    let url = format!("{}/oauth/token", profile.issuer);
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", profile.client_id.as_str()),
    ];
    let response = reqwest::Client::new()
        .post(&url)
        .header("User-Agent", user_agent)
        .form(&form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| Error::RefreshUnavailable)?;
    match response.status() {
        status if status.is_success() => response
            .json::<TokenResponse>()
            .await
            .map_err(|_| Error::RefreshRejected),
        // A rejected refresh (expired/rotated-away token, revoked grant) is
        // final for this refresh_token: re-login, not retry.
        status if status.as_u16() == 400 || status.as_u16() == 401 => Err(Error::RefreshRejected),
        _ => Err(Error::RefreshUnavailable),
    }
}

/// Patches a stored credential value in place from a token response. The
/// stored `refresh` is only replaced when the provider rotated it.
pub fn apply_tokens(value: &mut serde_json::Value, tokens: &TokenResponse, now_ms: u64) {
    let object = match value.as_object_mut() {
        Some(object) => object,
        None => return,
    };
    object.insert("access".into(), tokens.access_token.clone().into());
    let expires_in = tokens.expires_in.unwrap_or(3600);
    object.insert("expires".into(), (now_ms + expires_in * 1000).into());
    if let Some(refresh) = &tokens.refresh_token {
        object.insert("refresh".into(), refresh.clone().into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apply_tokens_rotates_refresh_only_when_returned() {
        let mut value = json!({"type":"oauth","access":"a1","refresh":"r1","expires":1});
        apply_tokens(
            &mut value,
            &TokenResponse {
                access_token: "a2".into(),
                refresh_token: Some("r2".into()),
                expires_in: Some(3600),
            },
            1_000,
        );
        assert_eq!(value["access"], "a2");
        assert_eq!(value["refresh"], "r2");
        assert_eq!(value["expires"], 1_000 + 3_600_000);

        let mut kept = json!({"type":"oauth","access":"a1","refresh":"r1","expires":1});
        apply_tokens(
            &mut kept,
            &TokenResponse {
                access_token: "a3".into(),
                refresh_token: None,
                expires_in: None,
            },
            1_000,
        );
        assert_eq!(kept["refresh"], "r1");
        assert_eq!(kept["expires"], 1_000 + 3_600_000);
    }

    #[tokio::test]
    async fn refresh_rejects_oversized_input_before_the_network() {
        let long = "x".repeat(20_000);
        assert_eq!(
            refresh(&openai(), &long, "miao-credential/0").await,
            Err(Error::NotRefreshable)
        );
    }
}
