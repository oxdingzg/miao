//! Layered permission rule evaluation (S6 step 1): the pattern-rule model the
//! host's permission service applies, mirrored from
//! `packages/core/src/permission.ts` `PermissionV2.decide`. This is the rule
//! evaluator, not the exact-call grant cache (`crate::permission_grant`):
//! grants answer "was this call approved", rules answer "does policy allow a
//! shape of call". Semantics are pinned by
//! `tests/differential/permission_decide.json`, generated from the TypeScript
//! reference; diverging from it is a security bug, not a refactor.
use crate::{
    permission::{digest, Decision},
    protocol::Error,
    wildcard::Wildcard,
};
use serde::{Deserialize, Serialize};

/// One ordered rule. Rules carry the host's Wildcard grammar (separators
/// normalize, `*` crosses directories, `?` consumes one UTF-16 unit, trailing
/// `" *"` allows no args).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub action: String,
    pub resource: String,
    pub effect: Decision,
}

/// The evaluation request. `configured` absent means the agent declares no
/// ruleset at all, which supplies a catch-all deny (`missingAgentPermissions` on the
/// host), filtered for explicit actions like any other catch-all. A present but
/// empty ruleset falls through to ask. Scope priority
/// (session > project > global) is the caller's rule order: later rules win.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub configured: Option<Vec<Rule>>,
    #[serde(default)]
    pub saved: Option<Vec<Rule>>,
}

/// The decision plus the effective ruleset the host would report, and the
/// authority revision any grant derived from it must be bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub effect: Decision,
    pub rules: Vec<Rule>,
    pub authority_revision: String,
}

/// Host bounds, mirrored from the ordered policy compiler: oversized input is
/// refused instead of half-evaluated, so callers fail closed.
pub(crate) const MAX_RULES: usize = 256;
const MAX_ACTION_BYTES: usize = 256;
const MAX_RESOURCE_BYTES: usize = 4096;
const MAX_ACTIONS: usize = 64;
const MAX_RESOURCES: usize = 64;
const MAX_INPUT_RESOURCE_BYTES: usize = 8192;

/// `configured: undefined` on the host means a rule-less agent: deny all.
fn missing_agent_permissions() -> Vec<Rule> {
    vec![Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: Decision::Deny,
    }]
}

pub fn evaluate(request: &Request) -> Result<Outcome, Error> {
    if !bounded(&request.actions, MAX_ACTIONS, MAX_ACTION_BYTES)
        || !bounded(&request.resources, MAX_RESOURCES, MAX_INPUT_RESOURCE_BYTES)
        || !request
            .configured
            .iter()
            .flatten()
            .chain(request.saved.iter().flatten())
            .all(bounded_rule)
    {
        return Err(Error::Invalid(
            "permission rule evaluation exceeds wire bounds".into(),
        ));
    }
    let authority_revision = digest(&serde_json::to_vec(&serde_json::json!({
        "semantics": "configured-deny-first-then-last-match-v1",
        "explicit": request.explicit,
        "configured": request.configured,
        "saved": request.saved,
    }))?);
    // A bare `*` action rule never decides an explicit action: leaving the OS
    // sandbox must not be granted (or denied) by a catch-all.
    let configured_rules = match &request.configured {
        Some(rules) => rules
            .iter()
            .filter(|rule| !request.explicit || rule.action != "*")
            .cloned()
            .collect::<Vec<_>>(),
        None => missing_agent_permissions()
            .into_iter()
            .filter(|rule| !request.explicit || rule.action != "*")
            .collect(),
    };
    let configured = compile(&configured_rules)?;
    if denied(&request.actions, &request.resources, &configured) {
        return Ok(Outcome {
            effect: Decision::Deny,
            rules: configured_rules,
            authority_revision,
        });
    }
    // Saved approvals join only after the configured deny sweep, so a
    // configured deny beats a later saved allow.
    let mut all_rules = configured_rules;
    all_rules.extend(request.saved.iter().flatten().cloned());
    let all = compile(&all_rules)?;
    let mut asks = false;
    for resource in &request.resources {
        match last_match(&all, &request.actions, resource) {
            Decision::Deny => {
                return Ok(Outcome {
                    effect: Decision::Deny,
                    rules: all_rules,
                    authority_revision,
                })
            }
            Decision::Ask => asks = true,
            Decision::Allow => {}
        }
    }
    Ok(Outcome {
        effect: if asks { Decision::Ask } else { Decision::Allow },
        rules: all_rules,
        authority_revision,
    })
}

fn bounded(items: &[String], count: usize, bytes: usize) -> bool {
    items.len() <= count
        && items
            .iter()
            .all(|item| !item.contains('\0') && item.len() <= bytes)
}

pub(crate) fn bounded_rule(rule: &Rule) -> bool {
    !rule.action.contains('\0')
        && !rule.resource.contains('\0')
        && rule.action.len() <= MAX_ACTION_BYTES
        && rule.resource.len() <= MAX_RESOURCE_BYTES
}

/// The last matching rule decides; anything unresolved asks.
fn last_match(
    rules: &[(Wildcard, Wildcard, Decision)],
    actions: &[String],
    resource: &str,
) -> Decision {
    let resource = resource.replace('\\', "/");
    for (action, path, effect) in rules.iter().rev() {
        if actions
            .iter()
            .any(|item| action.is_match(&item.replace('\\', "/")))
            && path.is_match(&resource)
        {
            return *effect;
        }
    }
    Decision::Ask
}

fn denied(
    actions: &[String],
    resources: &[String],
    rules: &[(Wildcard, Wildcard, Decision)],
) -> bool {
    resources
        .iter()
        .any(|resource| last_match(rules, actions, resource) == Decision::Deny)
}

fn compile(rules: &[Rule]) -> Result<Vec<(Wildcard, Wildcard, Decision)>, Error> {
    if rules.len() > MAX_RULES {
        return Err(Error::Invalid(
            "permission rule evaluation exceeds wire bounds".into(),
        ));
    }
    rules
        .iter()
        .map(|rule| {
            Ok((
                Wildcard::compile(&rule.action)?,
                Wildcard::compile(&rule.resource)?,
                rule.effect,
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn rule(action: &str, resource: &str, effect: Decision) -> Rule {
        Rule {
            action: action.into(),
            resource: resource.into(),
            effect,
        }
    }

    #[test]
    fn layered_decisions_match_the_typescript_reference_corpus() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/differential/permission_decide.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let request: Request = serde_json::from_value(case["request"].clone()).unwrap();
            let mut outcome = evaluate(&request).unwrap();
            // A case that names a mode pins what the product does with an ask
            // once the agent runs in `auto`; the corpus stores the settled
            // effect, so the same transform the host applies has to run here.
            if case["mode"].as_str() == Some("auto") && outcome.effect == Decision::Ask {
                let settled = request
                    .resources
                    .first()
                    .is_some_and(|command| {
                        crate::agent_classifier::bash(command) == crate::agent_classifier::Verdict::Safe
                    });
                if settled {
                    outcome.effect = Decision::Allow;
                }
            }
            assert_eq!(
                serde_json::to_value(outcome.effect).unwrap(),
                case["expected"]["effect"],
                "{}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                serde_json::to_value(outcome.rules).unwrap(),
                case["expected"]["rules"],
                "{}",
                case["name"].as_str().unwrap()
            );
            assert!(!outcome.authority_revision.is_empty());
        }
    }

    #[test]
    fn authority_revision_binds_the_exact_effective_rulesets() {
        let base = Request {
            actions: vec!["read".into()],
            resources: vec!["a.ts".into()],
            configured: Some(vec![rule("read", "*", Decision::Allow)]),
            ..Default::default()
        };
        let same = evaluate(&base).unwrap();
        let saved = evaluate(&Request {
            saved: Some(vec![rule("read", "b.ts", Decision::Allow)]),
            ..base.clone()
        })
        .unwrap();
        let explicit = evaluate(&Request {
            explicit: true,
            ..base.clone()
        })
        .unwrap();
        assert_eq!(evaluate(&base).unwrap(), same);
        assert_ne!(same.authority_revision, saved.authority_revision);
        assert_ne!(same.authority_revision, explicit.authority_revision);
    }

    #[test]
    fn oversized_input_fails_closed_without_a_decision() {
        let long = "a".repeat(MAX_INPUT_RESOURCE_BYTES + 1);
        let request = Request {
            actions: vec!["read".into()],
            resources: vec![long],
            ..Default::default()
        };
        assert!(evaluate(&request).is_err());
        let rules = vec![rule("read", "*", Decision::Allow); MAX_RULES + 1];
        let request = Request {
            actions: vec!["read".into()],
            resources: vec!["a.ts".into()],
            configured: Some(rules),
            ..Default::default()
        };
        assert!(evaluate(&request).is_err());
    }

    #[test]
    fn wildcards_normalize_separators_and_cross_directories() {
        let request = Request {
            actions: vec!["read".into()],
            resources: vec!["nested\\secret.env".into(), "nested/secret.env".into()],
            configured: Some(vec![rule("read", "*.env", Decision::Ask)]),
            ..Default::default()
        };
        assert_eq!(evaluate(&request).unwrap().effect, Decision::Ask);
    }
}
