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
    Delegate,
    External,
    Web,
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
    pub allow_subagents: bool,
    #[serde(default)]
    pub allow_mcp: bool,
    #[serde(default)]
    pub allow_web: bool,
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
    #[serde(default = "provider_turns")]
    pub max_provider_turns: u32,
}
fn provider_turns() -> u32 {
    25
}
fn approval_timeout() -> u64 {
    60_000
}
impl Config {
    /// Entry-point default. An interactive editor (ACP) is the approval
    /// surface: it needs write tools registered so the client can grant or
    /// reject each write, while reads stay silent and process tools stay off.
    /// A headless runner keeps the conservative read-only default.
    pub fn for_entry(interactive: bool) -> Self {
        Self {
            mode: if interactive {
                Mode::Workspace
            } else {
                Mode::ReadOnly
            },
            ..Self::default()
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::ReadOnly,
            allow_process: false,
            allow_background: false,
            allow_subagents: false,
            allow_mcp: false,
            allow_web: false,
            allow_wakeup: false,
            allow_cron: false,
            process_network: false,
            rules: vec![],
            approval_timeout_ms: approval_timeout(),
            max_provider_turns: provider_turns(),
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
    ordered: Option<crate::agent_policy::Compiled>,
    auto: bool,
}
impl Policy {
    /// Derive an immutable policy for one agent turn. Capability limits and all
    /// configured denials remain authoritative; agent rules use the same
    /// deny > ask > allow ordering as the base policy. Bind the revision to the
    /// whole manifest so approvals cannot cross an agent identity change.
    pub(crate) fn for_agent(
        &self,
        agent: Option<&crate::session_agent::AgentManifest>,
    ) -> Result<Self, Error> {
        let Some(agent) = agent else {
            return Ok(self.clone());
        };
        agent.validate()?;
        let mut config = self.config.clone();
        if let Some(steps) = agent.steps {
            config.max_provider_turns = config.max_provider_turns.min(steps);
        }
        if let Some(rules) = &agent.permissions {
            config.rules.extend(rules.iter().cloned());
        }
        let mut policy = Self::new(config)?;
        policy.ordered = agent
            .ordered_permissions
            .as_ref()
            .map(|policy| policy.compile())
            .transpose()?;
        policy.auto = agent.permission_mode.is_some();
        policy.revision = digest(&serde_json::to_vec(&serde_json::json!({
            "policy": policy.revision, "agent": agent.digest()?,
        }))?);
        Ok(policy)
    }

    pub fn max_provider_turns(&self) -> u32 {
        self.config.max_provider_turns
    }

    pub fn new(config: Config) -> Result<Self, Error> {
        if !(1..=600_000).contains(&config.approval_timeout_ms)
            || !(1..=10_000).contains(&config.max_provider_turns)
            || config.rules.len() > 256
        {
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
            ordered: None,
            auto: false,
        })
    }
    /// Snapshot the same immutable Config whose matchers enforce each tool.
    pub(crate) fn descriptor(&self) -> Value {
        let mut descriptor = serde_json::json!({"semantics":"native-policy-v1","revision":self.revision,"config":self.config,"collaboration_mode":"checked_at_tool_dispatch"});
        if let Some(ordered) = &self.ordered {
            descriptor["ordered"] =
                serde_json::to_value(ordered.descriptor()).expect("serializable agent policy");
        }
        descriptor
    }
    pub(crate) fn tool_visible(&self, tool: &str) -> bool {
        self.ordered
            .as_ref()
            .is_none_or(|policy| policy.visible(tool))
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
    pub fn subagents_enabled(&self) -> bool {
        self.config.mode == Mode::Workspace && self.config.allow_subagents
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

    pub fn web_enabled(&self) -> bool {
        self.config.allow_web
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
        self.assess_input(tool, path, access, None)
    }

    pub(crate) fn assess_input(
        &self,
        tool: &str,
        path: &str,
        access: Access,
        input: Option<&Value>,
    ) -> (Decision, RuleMatch) {
        let base = self.assess_base(tool, path, access);
        // The host's ordered rules never remove a capability/boundary denial
        // or an explicit operator deny/ask. Default workspace ask may be
        // decided by the agent's resolved rules.
        if base.0 == Decision::Deny
            || (base.0 == Decision::Ask && base.1.source == MatchSource::Rule)
        {
            return base;
        }
        self.ordered
            .as_ref()
            .map_or(base, |policy| policy.assess(tool, path, input))
    }

    /// Whether the agent's `auto` mode settles this ask without a prompt. Only
    /// asks the default or the agent's own ordered rules raise qualify: an
    /// operator ask rule in the base config stays authoritative, the same way
    /// the ordered overlay can never lift one.
    pub(crate) fn auto_settles(
        &self,
        tool: &str,
        path: &str,
        access: Access,
        input: Option<&Value>,
        targets: &[String],
    ) -> bool {
        if !self.auto {
            return false;
        }
        let base = self.assess_base(tool, path, access);
        if base.0 == Decision::Deny
            || (base.0 == Decision::Ask && base.1.source == MatchSource::Rule)
        {
            return false;
        }
        let action = self
            .ordered
            .as_ref()
            .and_then(|policy| policy.descriptor().bindings.get(tool))
            .map_or(tool, |binding| binding.action.as_str());
        match action {
            "edit" => {
                crate::agent_classifier::edit(targets) == crate::agent_classifier::Verdict::Safe
            }
            "bash" => input
                .filter(|input| input.get("stdin").is_none())
                .and_then(|input| input["command"].as_str())
                .is_some_and(|command| {
                    crate::agent_classifier::bash(command) == crate::agent_classifier::Verdict::Safe
                }),
            _ => false,
        }
    }

    fn assess_base(&self, tool: &str, path: &str, access: Access) -> (Decision, RuleMatch) {
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
            || (access == Access::Delegate && !self.subagents_enabled())
            || (access == Access::External && !self.mcp_enabled())
            || (access == Access::Web && !self.web_enabled())
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

#[cfg(test)]
mod auto_mode_tests {
    use super::*;

    fn policy_with(mode: Option<crate::session_agent::PermissionMode>, ordered: Value) -> Policy {
        let base = Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            ..Config::default()
        })
        .unwrap();
        let agent: crate::session_agent::AgentManifest =
            serde_json::from_value(serde_json::json!({
                "name": "auto",
                "permission_mode": mode,
                "ordered_permissions": ordered,
            }))
            .unwrap();
        base.for_agent(Some(&agent)).unwrap()
    }

    fn ordered_ask() -> Value {
        serde_json::json!({
            "semantics": "ordered-wildcard-v1",
            "rules": [
                {"action": "bash", "resource": "*", "effect": "ask"},
                {"action": "edit", "resource": "*", "effect": "ask"}
            ],
            "bindings": {
                "bash": {"action": "bash", "resource": "command"},
                "write_file": {"action": "edit", "resource": "native"}
            }
        })
    }

    #[test]
    fn auto_settles_classifier_proven_asks_only() {
        let policy = policy_with(
            Some(crate::session_agent::PermissionMode::Auto),
            ordered_ask(),
        );
        let bash_input = serde_json::json!({"command": "ls -la"});
        assert!(policy.auto_settles(
            "bash",
            ".",
            Access::Execute,
            Some(&bash_input),
            &[".".to_owned()]
        ));
        let dangerous = serde_json::json!({"command": "rm -rf scratch"});
        assert!(!policy.auto_settles(
            "bash",
            ".",
            Access::Execute,
            Some(&dangerous),
            &[".".to_owned()]
        ));
        assert!(
            policy.auto_settles(
                "write_file",
                "src/a.ts",
                Access::Write,
                None,
                &["src/a.ts".to_owned()]
            ),
            "an edit target inside the workspace settles"
        );
        assert!(
            !policy.auto_settles(
                "write_file",
                ".env",
                Access::Write,
                None,
                &[".env".to_owned()]
            ),
            "a protected target stays an ask"
        );
        assert!(
            !policy.auto_settles("glob", "**", Access::Read, None, &["**".to_owned()]),
            "an unbound action never settles"
        );
    }

    #[test]
    fn without_the_mode_every_ask_stays_a_prompt() {
        let policy = policy_with(None, ordered_ask());
        let bash_input = serde_json::json!({"command": "ls -la"});
        assert!(!policy.auto_settles(
            "bash",
            ".",
            Access::Execute,
            Some(&bash_input),
            &[".".to_owned()]
        ));
    }

    #[test]
    fn operator_ask_rules_stay_authoritative_under_auto() {
        let base = Policy::new(Config {
            mode: Mode::Workspace,
            allow_process: true,
            rules: vec![Rule {
                tool: "bash".into(),
                path: "**".into(),
                decision: Decision::Ask,
            }],
            ..Config::default()
        })
        .unwrap();
        let agent: crate::session_agent::AgentManifest =
            serde_json::from_value(serde_json::json!({
                "name": "auto",
                "permission_mode": "auto",
                "ordered_permissions": ordered_ask(),
            }))
            .unwrap();
        let policy = base.for_agent(Some(&agent)).unwrap();
        let bash_input = serde_json::json!({"command": "ls -la"});
        assert_eq!(
            policy
                .assess_input("bash", ".", Access::Execute, Some(&bash_input))
                .0,
            Decision::Ask
        );
        assert!(!policy.auto_settles(
            "bash",
            ".",
            Access::Execute,
            Some(&bash_input),
            &[".".to_owned()]
        ));
    }

    #[test]
    fn default_asks_settle_without_any_ordered_rule() {
        let policy = policy_with(
            Some(crate::session_agent::PermissionMode::Auto),
            serde_json::json!({
                "semantics": "ordered-wildcard-v1",
                "rules": [{"action": "*", "resource": "*", "effect": "allow"}],
                "bindings": {"bash": {"action": "bash", "resource": "command"}}
            }),
        );
        let bash_input = serde_json::json!({"command": "cat report.md"});
        assert!(policy.auto_settles(
            "bash",
            ".",
            Access::Execute,
            Some(&bash_input),
            &[".".to_owned()]
        ));
    }
}

#[cfg(test)]
mod entry_defaults {
    use super::*;

    #[test]
    fn entry_points_default_to_the_mode_their_client_can_drive() {
        let acp = Config::for_entry(true);
        assert_eq!(acp.mode, Mode::Workspace);
        assert!(!acp.allow_process);
        assert!(Policy::new(acp).unwrap().writes_enabled());

        let serve = Config::for_entry(false);
        assert_eq!(serve.mode, Mode::ReadOnly);
        assert!(!Policy::new(serve).unwrap().writes_enabled());
    }
}

#[cfg(test)]
mod agent_policy_tests {
    use super::*;

    #[test]
    fn overlay_cannot_lift_base_denial_and_revision_binds_agent_identity() {
        let base = Policy::new(Config {
            mode: Mode::Workspace,
            rules: vec![Rule {
                tool: "write_file".into(),
                path: "private/**".into(),
                decision: Decision::Deny,
            }],
            ..Config::default()
        })
        .unwrap();
        let agent: crate::session_agent::AgentManifest =
            serde_json::from_value(serde_json::json!({
                "name":"first", "permissions":[{"tool":"write_file","path":"**","decision":"allow"}]
            }))
            .unwrap();
        let policy = base.for_agent(Some(&agent)).unwrap();
        assert_eq!(
            policy.evaluate("write_file", "private/a", Access::Write),
            Decision::Deny
        );
        assert_eq!(
            policy.evaluate("write_file", "public/a", Access::Write),
            Decision::Allow
        );
        assert_ne!(base.revision(), policy.revision());
        let mut other = agent;
        other.name = "second".into();
        assert_ne!(
            policy.revision(),
            base.for_agent(Some(&other)).unwrap().revision()
        );
        assert_eq!(base.revision(), base.for_agent(None).unwrap().revision());
    }

    #[test]
    fn context_enumeration_resolves_ordered_input_bindings() {
        let base = Policy::new(Config {
            mode: Mode::Workspace,
            ..Config::default()
        })
        .unwrap();
        let agent: crate::session_agent::AgentManifest =
            serde_json::from_value(serde_json::json!({
                "name": "build",
                "ordered_permissions": {
                    "semantics": "ordered-wildcard-v1",
                    "rules": [{"action": "*", "resource": "*", "effect": "allow"}],
                    "bindings": {"glob": {"action": "glob", "resource": {"input": "pattern"}}}
                }
            }))
            .unwrap();
        let policy = base.for_agent(Some(&agent)).unwrap();
        let input = serde_json::json!({"pattern": "**/SKILL.md"});
        assert_eq!(
            policy
                .assess_input("glob", "@reference/host-skills", Access::Read, Some(&input))
                .0,
            Decision::Allow
        );
        assert_eq!(
            policy
                .assess_input("glob", "@reference/host-skills", Access::Read, None)
                .0,
            Decision::Ask
        );
    }
}
