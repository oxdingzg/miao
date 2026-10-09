use crate::protocol::Error;
use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    ReadOnly,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    Execute,
    Background,
    External,
    SessionState,
    Schedule,
    Cron,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub tool: String,
    pub path: String,
    pub decision: Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub allow_process: bool,
    #[serde(default)]
    pub allow_background: bool,
    #[serde(default)]
    pub allow_mcp: bool,
    #[serde(default)]
    pub allow_wakeup: bool,
    #[serde(default)]
    pub allow_cron: bool,
    #[serde(default)]
    pub process_network: bool,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default = "approval_timeout")]
    pub approval_timeout_ms: u64,
}
fn approval_timeout() -> u64 {
    60_000
}
impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::ReadOnly,
            allow_process: false,
            allow_background: false,
            allow_mcp: false,
            allow_wakeup: false,
            allow_cron: false,
            process_network: false,
            rules: vec![],
            approval_timeout_ms: approval_timeout(),
        }
    }
}

/// Where a decision came from. `Rule` names a configured rule's patterns;
/// `Default`, `Capability` and `Boundary` are built-in outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchSource {
    Rule,
    Default,
    Capability,
    Boundary,
}

/// The matcher semantics behind a decision, carried on approval messages so a
/// controller sees which rule or built-in produced the result rather than a
/// bare allow/deny boolean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleMatch {
    pub tool: String,
    pub path: String,
    pub decision: Decision,
    pub source: MatchSource,
}

#[derive(Clone)]
struct CompiledMatcher {
    tool_pattern: String,
    path_pattern: String,
    tool: GlobMatcher,
    path: GlobMatcher,
    decision: Decision,
}

#[derive(Clone)]
pub struct Policy {
    config: Config,
    revision: String,
    matchers: Vec<CompiledMatcher>,
}
impl Policy {
    pub fn new(config: Config) -> Result<Self, Error> {
        if !(1..=600_000).contains(&config.approval_timeout_ms) || config.rules.len() > 256 {
            return Err(Error::Invalid("invalid permission limits".into()));
        }
        let revision = digest(&serde_json::to_vec(&config)?);
        let matchers = config
            .rules
            .iter()
            .map(|rule| {
                if rule.tool.is_empty()
                    || rule.path.is_empty()
                    || rule.path.starts_with('/')
                    || rule.path.split('/').any(|p| p == "..")
                {
                    return Err(Error::Invalid(
                        "permission patterns must be workspace relative".into(),
                    ));
                }
                let tool = GlobBuilder::new(&rule.tool)
                    .literal_separator(true)
                    .build()
                    .map_err(|_| Error::Invalid("invalid tool matcher".into()))?
                    .compile_matcher();
                let path = GlobBuilder::new(&rule.path)
                    .literal_separator(true)
                    .build()
                    .map_err(|_| Error::Invalid("invalid path matcher".into()))?
                    .compile_matcher();
                Ok(CompiledMatcher {
                    tool_pattern: rule.tool.clone(),
                    path_pattern: rule.path.clone(),
                    tool,
                    path,
                    decision: rule.decision,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(Self {
            config,
            revision,
            matchers,
        })
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn timeout_ms(&self) -> u64 {
        self.config.approval_timeout_ms
    }
    pub fn process_enabled(&self) -> bool {
        self.config.mode == Mode::Workspace && self.config.allow_process
    }
    pub fn background_enabled(&self) -> bool {
        self.process_enabled() && self.config.allow_background
    }

    pub fn cron_enabled(&self) -> bool {
        self.config.allow_cron
    }

    pub fn wakeup_enabled(&self) -> bool {
        self.config.allow_wakeup
    }

    pub fn mcp_enabled(&self) -> bool {
        self.config.mode == Mode::Workspace && self.config.allow_mcp
    }

    pub fn process_network(&self) -> bool {
        self.config.process_network
    }

    pub fn writes_enabled(&self) -> bool {
        self.config.mode == Mode::Workspace
    }

    /// The mode is an upper bound. Explicit deny dominates ask and allow;
    /// absent matching rules, reads allow and workspace writes ask.
    pub fn evaluate(&self, tool: &str, path: &str, access: Access) -> Decision {
        self.assess(tool, path, access).0
    }

    /// Like [`Policy::evaluate`] but also returns the matcher that produced the
    /// decision, so callers can carry it on approval messages.
    pub fn assess(&self, tool: &str, path: &str, access: Access) -> (Decision, RuleMatch) {
        let bare = |decision| RuleMatch {
            tool: tool.into(),
            path: path.into(),
            decision,
            source: MatchSource::Default,
        };
        if (access == Access::Cron && !self.cron_enabled())
            || (access == Access::Schedule && !self.wakeup_enabled())
            || (access == Access::Execute && !self.process_enabled())
            || (access == Access::Background && !self.background_enabled())
            || (access == Access::External && !self.mcp_enabled())
            || (access == Access::Write && self.config.mode == Mode::ReadOnly)
        {
            return (
                Decision::Deny,
                RuleMatch {
                    source: MatchSource::Capability,
                    ..bare(Decision::Deny)
                },
            );
        }
        if path.starts_with('/') || path.split('/').any(|p| p == "..") {
            return (
                Decision::Deny,
                RuleMatch {
                    source: MatchSource::Boundary,
                    ..bare(Decision::Deny)
                },
            );
        }
        let mut result = None;
        for matcher in &self.matchers {
            if !matcher.tool.is_match(tool) || !matcher.path.is_match(path) {
                continue;
            }
            if matcher.decision == Decision::Deny {
                return (
                    Decision::Deny,
                    RuleMatch {
                        tool: matcher.tool_pattern.clone(),
                        path: matcher.path_pattern.clone(),
                        decision: Decision::Deny,
                        source: MatchSource::Rule,
                    },
                );
            }
            if matcher.decision == Decision::Ask || result.is_none() {
                result = Some(RuleMatch {
                    tool: matcher.tool_pattern.clone(),
                    path: matcher.path_pattern.clone(),
                    decision: matcher.decision,
                    source: MatchSource::Rule,
                });
            }
        }
        match result {
            Some(matched) => (matched.decision, matched),
            None => {
                let decision = if access == Access::Read || access == Access::SessionState {
                    Decision::Allow
                } else {
                    Decision::Ask
                };
                (decision, bare(decision))
            }
        }
    }
}

/// Canonical serde_json maps are ordered (preserve_order is not enabled).
/// Include Location and resolved resource, not just model-provided arguments.
pub fn input_digest(
    location: &str,
    tool: &str,
    resource: &str,
    input: &Value,
) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(
        &serde_json::json!({"location":location,"tool":tool,"resource":resource,"input":input}),
    )?))
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn context_digest(system: &str, sources: &[Value]) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(
        &serde_json::json!({"version":1,"system":system,"sources":sources}),
    )?))
}
