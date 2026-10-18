//! Host-declared ordered action/resource rules. This is a wire contract, not
//! product configuration: the host resolves tool-to-action bindings explicitly.
use crate::{
    permission::{Decision, MatchSource, RuleMatch},
    protocol::Error,
};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderedPolicy {
    pub semantics: Semantics,
    pub rules: Vec<ActionRule>,
    #[serde(default)]
    pub bindings: BTreeMap<String, ActionBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Semantics {
    #[serde(rename = "ordered-wildcard-v1")]
    OrderedWildcardV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRule {
    pub action: String,
    pub resource: String,
    pub effect: Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionBinding {
    pub action: String,
    #[serde(default)]
    pub resource: Resource,
    #[serde(default)]
    pub explicit: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    #[default]
    Native,
    Command,
    Program,
    Input(String),
    Literal(String),
}

#[derive(Clone)]
pub(crate) struct Compiled {
    wire: OrderedPolicy,
    rules: Vec<(Regex, Regex)>,
}

impl OrderedPolicy {
    pub(crate) fn compile(&self) -> Result<Compiled, Error> {
        let bounded = |text: &str, max: usize| text.len() <= max && !text.contains('\0');
        if self.rules.len() > 256
            || self.bindings.len() > 256
            || self
                .rules
                .iter()
                .any(|rule| !bounded(&rule.action, 256) || !bounded(&rule.resource, 4096))
            || self.bindings.iter().any(|(tool, binding)| {
                tool.is_empty()
                    || !bounded(tool, 256)
                    || binding.action.is_empty()
                    || !bounded(&binding.action, 256)
                    || match &binding.resource {
                        Resource::Input(field) => field.is_empty() || !bounded(field, 128),
                        Resource::Literal(value) => !bounded(value, 4096),
                        _ => false,
                    }
            })
        {
            return Err(Error::Invalid(
                "agent ordered policy exceeds wire bounds".into(),
            ));
        }
        let rules = self
            .rules
            .iter()
            .map(|rule| Ok((wildcard(&rule.action)?, wildcard(&rule.resource)?)))
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(Compiled {
            wire: self.clone(),
            rules,
        })
    }
}

impl Compiled {
    pub(crate) fn descriptor(&self) -> &OrderedPolicy {
        &self.wire
    }

    /// Hide a tool only when every resource is denied. A later allow/ask
    /// exception keeps it visible; dispatch remains authoritative either way.
    pub(crate) fn visible(&self, tool: &str) -> bool {
        let binding = self.wire.bindings.get(tool);
        let action = binding
            .map_or(tool, |binding| binding.action.as_str())
            .replace('\\', "/");
        let mut exception = false;
        for (rule, (matcher, _)) in self.wire.rules.iter().zip(&self.rules).rev() {
            if binding.is_some_and(|binding| binding.explicit) && rule.action == "*" {
                continue;
            }
            if !matcher.is_match(&action) {
                continue;
            }
            if rule.resource == "*" {
                return exception || rule.effect != Decision::Deny;
            }
            exception |= rule.effect != Decision::Deny;
        }
        true
    }

    pub(crate) fn assess(
        &self,
        tool: &str,
        resource: &str,
        input: Option<&Value>,
    ) -> (Decision, RuleMatch) {
        let binding = self.wire.bindings.get(tool);
        let action = binding.map_or(tool, |binding| binding.action.as_str());
        let selected = match binding.map(|binding| &binding.resource) {
            Some(Resource::Command) => {
                let Some(input) = input else {
                    return fallback(tool, resource);
                };
                if let Some(command) = input["command"].as_str() {
                    shell_resources(command).unwrap_or_else(|| vec![command.to_owned()])
                } else if let Some(argv) = input["argv"]
                    .as_array()
                    .and_then(|argv| argv.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
                {
                    vec![argv.join(" ")]
                } else {
                    return fallback(tool, resource);
                }
            }
            Some(Resource::Program) => {
                let Some(program) = input
                    .and_then(|input| input["argv"].as_array())
                    .and_then(|argv| argv.first())
                    .and_then(Value::as_str)
                else {
                    return fallback(tool, resource);
                };
                vec![program.to_owned()]
            }
            Some(Resource::Input(field)) => {
                let Some(value) = input
                    .and_then(|input| input.get(field))
                    .and_then(Value::as_str)
                else {
                    return fallback(tool, resource);
                };
                vec![value.to_owned()]
            }
            Some(Resource::Literal(value)) => vec![value.clone()],
            _ => vec![resource.to_owned()],
        };
        selected
            .iter()
            .map(|selected| {
                self.assess_resource(
                    tool,
                    action,
                    selected,
                    binding.is_some_and(|binding| binding.explicit),
                )
            })
            .reduce(|left, right| {
                if severity(right.0) > severity(left.0) {
                    right
                } else {
                    left
                }
            })
            .unwrap_or_else(|| fallback(tool, resource))
    }

    fn assess_resource(
        &self,
        tool: &str,
        action: &str,
        resource: &str,
        explicit: bool,
    ) -> (Decision, RuleMatch) {
        let action = action.replace('\\', "/");
        let selected = resource.replace('\\', "/");
        for (rule, (action_match, resource_match)) in self.wire.rules.iter().zip(&self.rules).rev()
        {
            if explicit && rule.action == "*" {
                continue;
            }
            if action_match.is_match(&action) && resource_match.is_match(&selected) {
                return (
                    rule.effect,
                    RuleMatch {
                        tool: rule.action.clone(),
                        path: rule.resource.clone(),
                        decision: rule.effect,
                        source: MatchSource::Rule,
                    },
                );
            }
        }
        fallback(tool, resource)
    }
}

fn severity(decision: Decision) -> u8 {
    match decision {
        Decision::Allow => 0,
        Decision::Ask => 1,
        Decision::Deny => 2,
    }
}

/// Match the host ShellApproval extraction: every command in document order,
/// including substitutions, with redirections widened to their statement.
fn shell_resources(command: &str) -> Option<Vec<String>> {
    if cfg!(windows) || command.len() > 65536 {
        return None;
    }
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(command, None)?;
    if tree.root_node().has_error() {
        return None;
    }
    let mut nodes = vec![tree.root_node()];
    let mut resources = Vec::new();
    while let Some(node) = nodes.pop() {
        if node.kind() == "command" {
            let mut cursor = node.walk();
            let head = node.children(&mut cursor).find(|child| {
                matches!(
                    child.kind(),
                    "command_name"
                        | "command_name_expr"
                        | "word"
                        | "string"
                        | "raw_string"
                        | "concatenation"
                )
            });
            if let Some(head) = head {
                let name = head.utf8_text(command.as_bytes()).ok()?;
                if !matches!(name, "cd" | "chdir" | "popd" | "pushd") {
                    let source = node
                        .parent()
                        .filter(|parent| parent.kind() == "redirected_statement")
                        .unwrap_or(node);
                    let source = source.utf8_text(command.as_bytes()).ok()?.trim().to_owned();
                    if !resources.contains(&source) {
                        resources.push(source);
                    }
                }
            }
        }
        let mut cursor = node.walk();
        let children = node.children(&mut cursor).collect::<Vec<_>>();
        nodes.extend(children.into_iter().rev());
    }
    (!resources.is_empty()).then_some(resources)
}

fn fallback(tool: &str, resource: &str) -> (Decision, RuleMatch) {
    (
        Decision::Ask,
        RuleMatch {
            tool: tool.into(),
            path: resource.into(),
            decision: Decision::Ask,
            source: MatchSource::Default,
        },
    )
}

/// Same bounded wildcard grammar as the host: separators normalize, * crosses
/// directories, ? consumes one character, and a trailing " *" allows no args.
fn wildcard(pattern: &str) -> Result<Regex, Error> {
    let normalized = pattern.replace('\\', "/");
    let optional_args = normalized.ends_with(" *");
    let prefix = if optional_args {
        &normalized[..normalized.len() - 2]
    } else {
        &normalized
    };
    let mut expression = String::from("^");
    for character in prefix.chars() {
        match character {
            '*' => expression.push_str(".*"),
            '?' => expression.push('.'),
            other => expression.push_str(&regex::escape(&other.to_string())),
        }
    }
    if optional_args {
        expression.push_str("( .*)?");
    }
    expression.push('$');
    RegexBuilder::new(&expression)
        .dot_matches_new_line(true)
        .case_insensitive(cfg!(windows))
        .build()
        .map_err(|_| Error::Invalid("invalid agent wildcard".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_decisions_match_the_host_reference_corpus() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/differential/agent_policy.json")).unwrap();
        let policy: OrderedPolicy = serde_json::from_value(serde_json::json!({
            "semantics":"ordered-wildcard-v1", "rules":fixture["rules"]
        }))
        .unwrap();
        let compiled = policy.compile().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let (decision, _) = compiled.assess(
                case["action"].as_str().unwrap(),
                case["resource"].as_str().unwrap(),
                None,
            );
            assert_eq!(
                serde_json::to_value(decision).unwrap(),
                case["expected"],
                "{case}"
            );
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn shell_resources_match_the_host_parser_and_every_command_is_checked() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/differential/agent_policy.json")).unwrap();
        for case in fixture["shells"].as_array().unwrap() {
            let command = case["command"].as_str().unwrap();
            assert_eq!(
                serde_json::to_value(
                    shell_resources(command).unwrap_or_else(|| vec![command.into()])
                )
                .unwrap(),
                case["resources"],
                "{case}"
            );
        }
        let policy: OrderedPolicy = serde_json::from_value(serde_json::json!({
            "semantics":"ordered-wildcard-v1", "rules":fixture["rules"],
            "bindings":{"bash":{"action":"bash","resource":"command"}}
        }))
        .unwrap();
        let policy = policy.compile().unwrap();
        assert_eq!(
            policy
                .assess(
                    "bash",
                    ".",
                    Some(&serde_json::json!({"command":"git status"}))
                )
                .0,
            Decision::Allow
        );
        assert_eq!(
            policy
                .assess(
                    "bash",
                    ".",
                    Some(&serde_json::json!({"command":"git status; rm -rf scratch"}))
                )
                .0,
            Decision::Deny
        );
    }

    #[test]
    fn pattern_resources_are_not_mistaken_for_workspace_paths() {
        let policy: OrderedPolicy = serde_json::from_value(serde_json::json!({
            "semantics":"ordered-wildcard-v1",
            "rules":[{"action":"*","resource":"*","effect":"allow"},
                     {"action":"grep","resource":"password","effect":"deny"}],
            "bindings":{"grep":{"action":"grep","resource":{"input":"pattern"}}}
        }))
        .unwrap();
        let policy = policy.compile().unwrap();
        assert_eq!(
            policy
                .assess(
                    "grep",
                    ".",
                    Some(&serde_json::json!({"pattern":"password"}))
                )
                .0,
            Decision::Deny
        );
        assert_eq!(policy.assess("grep", ".", None).0, Decision::Ask);
        assert_eq!(
            policy
                .assess("grep", ".", Some(&serde_json::json!({"pattern":"public"})))
                .0,
            Decision::Allow
        );
    }

    #[test]
    fn explicit_bindings_skip_catch_all_and_commands_never_match_a_directory() {
        let policy: OrderedPolicy = serde_json::from_value(serde_json::json!({
            "semantics":"ordered-wildcard-v1",
            "rules":[{"action":"*","resource":"*","effect":"allow"},
                     {"action":"bash","resource":"git status *","effect":"deny"}],
            "bindings":{"terminal_start":{"action":"bash","resource":"command","explicit":true}}
        }))
        .unwrap();
        let compiled = policy.compile().unwrap();
        assert_eq!(
            compiled.assess("terminal_start", "git status", None).0,
            Decision::Ask
        );
        assert_eq!(
            compiled
                .assess(
                    "terminal_start",
                    "workspace",
                    Some(&serde_json::json!({"command":"git status"}))
                )
                .0,
            Decision::Deny
        );
        assert_eq!(
            compiled
                .assess(
                    "terminal_start",
                    "workspace",
                    Some(&serde_json::json!({"command":"echo hi"}))
                )
                .0,
            Decision::Ask
        );
    }
}
