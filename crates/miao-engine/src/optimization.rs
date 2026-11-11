//! VAL-04: every optimization mechanism has one named switch, so an arm can
//! remove exactly one of them and measure what it was worth.
//!
//! The engine trades model work for less work in several places: a budget gate
//! that stops a drain, a Goal window charged beside the Session's, tool output
//! elided from the outgoing request, automatic compaction, and duplicate-read
//! suppression. Counting those as progress measures shipped features; proving
//! one pays for itself needs the same model and the same tasks run with that one
//! mechanism removed. This module is the registry those arms name, and the
//! single place that answers "is this mechanism on?".
//!
//! Defaults keep every mechanism enabled, which is how the engine behaved
//! before the switches existed. `docs/acceptance/2026-11-11-val04-ablation.md`
//! records which mechanism has a measured net gain; until an arm shows one, a
//! mechanism stays optional rather than being counted as an improvement.
//!
//! The wire form is one object from a mechanism key to a boolean:
//! `{"cost_stop": false}` runs the same Session with the cost/time/turn stop
//! gate off. An unknown key is refused instead of ignored, because a typo that
//! silently left every mechanism on would report an arm that never ran.

use serde_json::{json, Map, Value};

/// One mechanism an ablation arm can remove. The order is the registry's own:
/// bit position, listing order, and the order [`Optimizations::state`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Mechanism {
    /// COST-02: the warning and stop gate over the Session's and the active
    /// Goal's declared budgets.
    CostStop = 0,
    /// AGT-04: the Goal's own budget window, charged from the turn that
    /// recorded the Goal instead of from the Session's first turn.
    GoalBudget = 1,
    /// TOOL-05 gate ④: oversized tool-result payloads elided from the outgoing
    /// request only, with the stored history left whole.
    ToolOutputBudget = 2,
    /// CTX-02: automatic compaction at a settled provider-turn boundary.
    AutoCompaction = 3,
    /// TOOL-01: an exact repeat read of unchanged content answers with the
    /// fingerprint and the earlier read instead of shipping the payload again.
    MinimalReads = 4,
}

impl Mechanism {
    /// Every mechanism, in listing order.
    pub const ALL: [Mechanism; 5] = [
        Mechanism::CostStop,
        Mechanism::GoalBudget,
        Mechanism::ToolOutputBudget,
        Mechanism::AutoCompaction,
        Mechanism::MinimalReads,
    ];

    /// The key an ablation arm names on the wire and in a report row.
    pub fn key(self) -> &'static str {
        match self {
            Mechanism::CostStop => "cost_stop",
            Mechanism::GoalBudget => "goal_budget",
            Mechanism::ToolOutputBudget => "tool_output_budget",
            Mechanism::AutoCompaction => "auto_compaction",
            Mechanism::MinimalReads => "minimal_reads",
        }
    }

    /// What removing the mechanism is expected to give back, in the words a
    /// report row and the acceptance record quote.
    pub fn description(self) -> &'static str {
        match self {
            Mechanism::CostStop => {
                "budget warning and stop gate; removed, a drain keeps spending past its limit"
            }
            Mechanism::GoalBudget => {
                "Goal budget window; removed, the Session's budget is the only limit"
            }
            Mechanism::ToolOutputBudget => {
                "tool-output elision from the outgoing request; removed, payloads ship whole"
            }
            Mechanism::AutoCompaction => {
                "automatic compaction; removed, the transcript never checkpoints"
            }
            Mechanism::MinimalReads => {
                "duplicate-read suppression; removed, a repeated read ships the payload again"
            }
        }
    }

    pub fn from_key(key: &str) -> Option<Mechanism> {
        Mechanism::ALL
            .into_iter()
            .find(|mechanism| mechanism.key() == key)
    }

    fn bit(self) -> u8 {
        1 << (self as u8)
    }
}

/// Which mechanisms are switched off. Copy and cheap: a run loop reads it at
/// every gate instead of carrying a clone around.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Optimizations {
    ablated: u8,
}

impl Optimizations {
    /// The environment variable an ablation arm sets, read by the engine's
    /// launcher exactly like `MIAO_CONTEXT_LIMITS` is.
    pub const ENVIRONMENT: &'static str = "MIAO_OPTIMIZATIONS";

    /// Every mechanism enabled: the behaviour before the switches existed.
    pub fn defaults() -> Self {
        Self::default()
    }

    /// The same configuration with one mechanism removed: the ablation arm's
    /// configuration, and what the tests drive.
    pub fn without(self, mechanism: Mechanism) -> Self {
        Self {
            ablated: self.ablated | mechanism.bit(),
        }
    }

    pub fn enabled(&self, mechanism: Mechanism) -> bool {
        self.ablated & mechanism.bit() == 0
    }

    /// The mechanisms this configuration removes, in listing order.
    pub fn ablated(&self) -> Vec<&'static str> {
        Mechanism::ALL
            .into_iter()
            .filter(|mechanism| !self.enabled(*mechanism))
            .map(Mechanism::key)
            .collect()
    }

    /// The whole registry as enabled/disabled facts. A run records this so a
    /// measurement names the arm it was taken on instead of assuming the
    /// defaults.
    pub fn state(&self) -> Value {
        let mut state = Map::new();
        for mechanism in Mechanism::ALL {
            state.insert(mechanism.key().into(), json!(self.enabled(mechanism)));
        }
        Value::Object(state)
    }

    /// Parse the wire form: an object from a mechanism key to a boolean. An
    /// absent key keeps its default, and an unknown key is an error rather than
    /// a silent no-op arm.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let Some(map) = value.as_object() else {
            return Err("optimizations must be an object of mechanism keys to booleans".into());
        };
        let mut parsed = Self::defaults();
        for (key, value) in map {
            let Some(mechanism) = Mechanism::from_key(key) else {
                return Err(format!(
                    "unknown optimization mechanism `{key}`, expected one of {}",
                    Mechanism::ALL
                        .into_iter()
                        .map(Mechanism::key)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            };
            let Some(enabled) = value.as_bool() else {
                return Err(format!(
                    "optimization `{key}` must be true or false, the ablation arm states which side to run"
                ));
            };
            if !enabled {
                parsed = parsed.without(mechanism);
            }
        }
        Ok(parsed)
    }

    pub fn from_wire(json: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(json)
            .map_err(|error| format!("invalid --optimizations: {error}"))?;
        Self::from_json(&value).map_err(|error| format!("invalid --optimizations: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mechanism_is_enabled_by_default() {
        let defaults = Optimizations::defaults();
        for mechanism in Mechanism::ALL {
            assert!(
                defaults.enabled(mechanism),
                "{} must start enabled: the defaults are the shipped behaviour",
                mechanism.key()
            );
            assert_eq!(
                defaults.state()[mechanism.key()],
                json!(true),
                "the recorded state names every mechanism"
            );
        }
        assert!(defaults.ablated().is_empty());
    }

    #[test]
    fn a_named_mechanism_is_the_only_one_an_arm_removes() {
        let ablated = Optimizations::defaults().without(Mechanism::MinimalReads);
        assert!(!ablated.enabled(Mechanism::MinimalReads));
        for mechanism in Mechanism::ALL
            .into_iter()
            .filter(|mechanism| *mechanism != Mechanism::MinimalReads)
        {
            assert!(
                ablated.enabled(mechanism),
                "{} stays enabled",
                mechanism.key()
            );
        }
        assert_eq!(ablated.ablated(), vec!["minimal_reads"]);
        assert_eq!(ablated.state()["minimal_reads"], json!(false));
    }

    #[test]
    fn the_wire_form_removes_only_the_mechanisms_it_names() {
        let parsed =
            Optimizations::from_wire(r#"{"cost_stop":false,"auto_compaction":false}"#).unwrap();
        assert_eq!(parsed.ablated(), vec!["cost_stop", "auto_compaction"]);
        assert!(parsed.enabled(Mechanism::GoalBudget));
        assert_eq!(
            Optimizations::from_wire("{}").unwrap(),
            Optimizations::defaults(),
            "an empty object runs the baseline"
        );
    }

    #[test]
    fn an_unknown_or_unstated_mechanism_is_refused_rather_than_ignored() {
        let unknown = Optimizations::from_wire(r#"{"cost_stpo":false}"#).unwrap_err();
        assert!(
            unknown.contains("unknown optimization mechanism `cost_stpo`"),
            "{unknown}"
        );
        assert!(
            unknown.contains("cost_stop"),
            "the error lists the known keys: {unknown}"
        );
        let untyped = Optimizations::from_wire(r#"{"cost_stop":"off"}"#).unwrap_err();
        assert!(untyped.contains("must be true or false"), "{untyped}");
        let not_an_object = Optimizations::from_wire(r#"["cost_stop"]"#).unwrap_err();
        assert!(
            not_an_object.contains("must be an object"),
            "{not_an_object}"
        );
    }

    #[test]
    fn every_mechanism_key_round_trips() {
        for mechanism in Mechanism::ALL {
            assert_eq!(Mechanism::from_key(mechanism.key()), Some(mechanism));
        }
        assert_eq!(Mechanism::from_key("nope"), None);
    }
}
