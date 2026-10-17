//! Explicit deployment/model assertions for optional Responses cache controls.
//! No capability is inferred from a model name or a compatible URL alone.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Authentication {
    Api,
    Subscription,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Profile {
    Legacy,
    Breakpoints,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    #[default]
    Implicit,
    Explicit,
    Disabled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum Ttl {
    #[serde(rename = "30m")]
    Minutes30,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum Retention {
    #[serde(rename = "in_memory")]
    InMemory,
    #[serde(rename = "24h")]
    Day,
}
fn system_default() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub model: String,
    pub endpoint: String,
    pub authentication: Authentication,
    pub profile: Profile,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub ttl: Option<Ttl>,
    #[serde(default)]
    pub retention: Option<Retention>,
    #[serde(default = "system_default")]
    pub system: bool,
    #[serde(default)]
    pub prewarm: Option<bool>,
}
impl Contract {
    pub fn from_wire(value: &str) -> Result<Self, String> {
        let contract: Self = serde_json::from_str(value)
            .map_err(|_| "invalid Responses cache contract".to_owned())?;
        if contract.prewarm == Some(true) {
            return Err("prewarming cannot be a normal model default".into());
        }
        Ok(contract)
    }
    pub(crate) fn validate(
        &self,
        model: &str,
        endpoint: &reqwest::Url,
        subscription: bool,
    ) -> Result<(), String> {
        if self.prewarm == Some(true) {
            return Err("prewarming cannot be a normal model default".into());
        }
        let bound = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| "invalid cache contract endpoint".to_owned())?;
        if self.model != model
            || &bound != endpoint
            || (self.authentication == Authentication::Subscription) != subscription
        {
            return Err("cache contract does not match the selected endpoint, model or authentication profile".into());
        }
        match self.profile {
            Profile::Legacy if self.ttl.is_some() || self.mode != Mode::Implicit => {
                Err("legacy cache contracts only support retention controls".into())
            }
            Profile::Breakpoints if self.retention.is_some() => {
                Err("breakpoint cache contracts cannot use legacy retention".into())
            }
            _ => Ok(()),
        }
    }
    pub(crate) fn project(&self, body: &mut Value, system: &str) -> Result<(), String> {
        match self.profile {
            Profile::Legacy => {
                if let Some(retention) = self.retention {
                    body["prompt_cache_retention"] = json!(retention);
                }
            }
            Profile::Breakpoints => {
                let mark = self.mode != Mode::Disabled && self.system && !system.is_empty();
                if self.mode == Mode::Explicit && !mark {
                    return Err(
                        "explicit Responses caching requires a stable system breakpoint".into(),
                    );
                }
                if mark {
                    let items = body["input"]
                        .as_array_mut()
                        .ok_or_else(|| "invalid Responses input for cache projection".to_owned())?;
                    items.insert(0,json!({"role":"developer","content":[{"type":"input_text","text":system,"prompt_cache_breakpoint":{"mode":"explicit"}}]}));
                    body.as_object_mut()
                        .ok_or_else(|| "invalid Responses body".to_owned())?
                        .remove("instructions");
                }
                let mode = if self.mode == Mode::Implicit {
                    "implicit"
                } else {
                    "explicit"
                };
                body["prompt_cache_options"] = json!({"mode":mode});
                if let Some(ttl) = self.ttl {
                    body["prompt_cache_options"]["ttl"] = json!(ttl);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Authentication, Contract, Mode, Retention, Ttl};
    use serde_json::json;
    fn contract(profile: &str) -> Contract {
        Contract::from_wire(&json!({"model":"m","endpoint":"https://api.example/responses","authentication":"api","profile":profile}).to_string()).unwrap()
    }
    #[test]
    fn binding_and_profile_controls_are_explicit() {
        let endpoint = reqwest::Url::parse("https://api.example/responses").unwrap();
        let mut policy = contract("breakpoints");
        policy.validate("m", &endpoint, false).unwrap();
        assert!(policy.validate("different", &endpoint, false).is_err());
        assert!(policy.validate("m", &endpoint, true).is_err());
        assert!(policy
            .validate(
                "m",
                &reqwest::Url::parse("https://api.example/responses?deployment=other").unwrap(),
                false
            )
            .is_err());
        let mut subscription = policy.clone();
        subscription.authentication = Authentication::Subscription;
        subscription.validate("m", &endpoint, true).unwrap();
        assert!(policy
            .validate(
                "m",
                &reqwest::Url::parse("https://other.example/responses").unwrap(),
                false
            )
            .is_err());
        policy.retention = Some(Retention::Day);
        assert!(policy.validate("m", &endpoint, false).is_err());
        let mut policy = contract("legacy");
        policy.ttl = Some(Ttl::Minutes30);
        assert!(policy.validate("m", &endpoint, false).is_err());
        for unsupported in ["1h", "24h", "5m"] {
            let mut raw = serde_json::to_value(contract("breakpoints")).unwrap();
            raw["ttl"] = json!(unsupported);
            assert!(Contract::from_wire(&raw.to_string()).is_err());
        }
        let mut raw = serde_json::to_value(contract("breakpoints")).unwrap();
        raw["prewarm"] = json!(true);
        assert!(
            Contract::from_wire(&raw.to_string()).is_err(),
            "generation-free prewarming is not a normal model default"
        );
    }
    #[test]
    fn modern_projection_preserves_history_and_implicit_tail_while_disabled_has_no_marker() {
        let original = json!({"model":"m","instructions":"stable","tools":[{"name":"read"}],"input":[{"role":"user","content":"question"}]});
        let mut policy = contract("breakpoints");
        policy.ttl = Some(Ttl::Minutes30);
        let mut body = original.clone();
        policy.project(&mut body, "stable").unwrap();
        assert!(body.get("instructions").is_none());
        assert_eq!(
            body["prompt_cache_options"],
            json!({"mode":"implicit","ttl":"30m"})
        );
        assert_eq!(body["tools"], original["tools"]);
        assert_eq!(body["input"][1], original["input"][0]);
        assert_eq!(body["input"][0]["content"][0]["text"], "stable");
        assert_eq!(
            body["input"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
            "explicit"
        );
        policy.mode = Mode::Disabled;
        let mut body = original.clone();
        policy.project(&mut body, "stable").unwrap();
        assert_eq!(body["input"], original["input"]);
        assert_eq!(body["instructions"], original["instructions"]);
        assert_eq!(body["prompt_cache_options"]["mode"], "explicit");
        policy.mode = Mode::Explicit;
        assert!(policy.project(&mut original.clone(), "").is_err());
    }
}
