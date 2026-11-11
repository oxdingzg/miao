//! COST-02: cost, time, and turn budgets with warning and stop behaviour.
//!
//! A budget is declared for the Session (the product's `budget` section, which
//! also carries the documented `cost.budget_usd` figure) or for one Goal
//! (`goal.budget`, AGT-04). The two scopes keep separate accounting windows: the
//! Session counts every turn it ever ran, while a Goal counts the turns since
//! the model recorded it, so a budget stated for a stretch of work is not
//! charged with the work that prompted it. The run loop evaluates both at every
//! provider-turn boundary and the stricter one wins: four fifths spent asks the
//! model to close the operation in progress, and a spent limit ends the drain
//! with a visible history fact. Every admitted input survives that stop in the
//! durable inbox, so raising the budget and sending the next message continues
//! the Session, and enforcement never changes the model.
//!
//! Money is only what a provider stood behind. A gateway that billed the turn
//! reports its charge, a turn priced from our rate table is an estimate at list
//! price, and a turn with neither stays unpriced. Estimates and unpriced turns
//! are counted and disclosed, because a budget that read an unpriced turn as
//! free would report more remaining money than the operator has left.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The share of a limit at which the run is asked to wrap up: four fifths spent
/// leaves the operation in progress room to close instead of being cut off.
pub const WARNING_SHARE: u64 = 8;
pub const WARNING_SCALE: u64 = 10;

/// A stated bound past these is a typo rather than a budget. An unbounded
/// Session is expressed by omitting the declaration, never by a huge number.
pub const COST_CEILING_USD: f64 = 100_000.0;
pub const TOKEN_CEILING: u64 = 2_000_000_000;
pub const TURN_CEILING: u64 = 10_000;
pub const WALLCLOCK_CEILING_MS: u64 = 86_400_000;

/// One budget declaration, in the units the run can actually observe. Every
/// axis is optional, but a declaration states at least one: an empty one would
/// read as "no limit" while looking like a bound the operator set.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Declaration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallclock_ms: Option<u64>,
}

impl Declaration {
    pub fn is_empty(&self) -> bool {
        self.cost_usd.is_none()
            && self.tokens.is_none()
            && self.turns.is_none()
            && self.wallclock_ms.is_none()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.is_empty() {
            return Err(
                "budget states no limit: set cost_usd, tokens, turns, or wallclock_ms".into(),
            );
        }
        if self
            .cost_usd
            .is_some_and(|limit| !limit.is_finite() || limit <= 0.0 || limit > COST_CEILING_USD)
        {
            return Err(format!(
                "cost_usd must be greater than 0 and at most {COST_CEILING_USD}"
            ));
        }
        if self
            .tokens
            .is_some_and(|limit| limit == 0 || limit > TOKEN_CEILING)
        {
            return Err(format!("tokens must be between 1 and {TOKEN_CEILING}"));
        }
        if self
            .turns
            .is_some_and(|limit| limit == 0 || limit > TURN_CEILING)
        {
            return Err(format!("turns must be between 1 and {TURN_CEILING}"));
        }
        if self
            .wallclock_ms
            .is_some_and(|limit| limit == 0 || limit > WALLCLOCK_CEILING_MS)
        {
            return Err(format!(
                "wallclock_ms must be between 1 and {WALLCLOCK_CEILING_MS}"
            ));
        }
        Ok(())
    }

    /// What each stated limit has left. An undeclared axis stays absent rather
    /// than reporting an infinite remainder.
    pub fn remaining(&self, observed: &Observed) -> Value {
        let mut remaining = Map::new();
        if let Some(limit) = self.cost_usd {
            remaining.insert(
                "cost_usd".into(),
                json!(micro_usd((limit - observed.cost_usd).max(0.0))),
            );
        }
        if let Some(limit) = self.tokens {
            remaining.insert(
                "tokens".into(),
                json!(limit.saturating_sub(observed.tokens)),
            );
        }
        if let Some(limit) = self.turns {
            remaining.insert("turns".into(), json!(limit.saturating_sub(observed.turns)));
        }
        if let Some(limit) = self.wallclock_ms {
            remaining.insert(
                "wallclock_ms".into(),
                json!(limit.saturating_sub(observed.elapsed_ms)),
            );
        }
        Value::Object(remaining)
    }

    /// The durable `budget.state` payload: the limits, what has been spent
    /// against them, what is left, and how close the run is. A client paints
    /// the remaining amount from this instead of re-deriving the budget.
    pub fn state(&self, observed: &Observed, level: Level) -> Value {
        json!({
            "level": level.name(),
            "axis": level.axis().map(Axis::name),
            "remaining": self.remaining(observed),
            "limit": {
                "cost_usd": self.cost_usd.map(micro_usd),
                "tokens": self.tokens,
                "turns": self.turns,
                "wallclock_ms": self.wallclock_ms,
            },
            "spent": {
                "cost_usd": micro_usd(observed.cost_usd),
                "tokens": observed.tokens,
                "turns": observed.turns,
                "wallclock_ms": observed.elapsed_ms,
            },
            "estimated_turns": observed.estimated_turns,
            "unpriced_turns": observed.unpriced_turns,
        })
    }

    /// The share of each stated limit already spent, in axis order. An
    /// undeclared axis never appears, so "not set" cannot read as "exhausted".
    fn shares(&self, observed: &Observed) -> Vec<(Axis, f64)> {
        [
            self.cost_usd
                .map(|limit| (Axis::Cost, observed.cost_usd / limit)),
            self.tokens
                .map(|limit| (Axis::Tokens, observed.tokens as f64 / limit as f64)),
            self.turns
                .map(|limit| (Axis::Turns, observed.turns as f64 / limit as f64)),
            self.wallclock_ms
                .map(|limit| (Axis::Time, observed.elapsed_ms as f64 / limit as f64)),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// The share of one axis's stated limit already spent, so two scopes can be
    /// ordered by how close they are to stopping. An undeclared axis has no
    /// share: it is not a limit that happens to be at zero.
    pub fn share(&self, axis: Axis, observed: &Observed) -> f64 {
        match self.limit_of(axis) {
            Some(limit) if limit > 0.0 => self.spent_of(axis, observed) / limit,
            _ => 0.0,
        }
    }

    pub fn evaluate(&self, observed: &Observed) -> Level {
        let shares = self.shares(observed);
        closest(&shares, Level::Exhausted, 1.0)
            .or_else(|| {
                closest(
                    &shares,
                    Level::Warning,
                    WARNING_SHARE as f64 / WARNING_SCALE as f64,
                )
            })
            .unwrap_or(Level::Within)
    }

    fn limit_of(&self, axis: Axis) -> Option<f64> {
        match axis {
            Axis::Cost => self.cost_usd,
            Axis::Tokens => self.tokens.map(|limit| limit as f64),
            Axis::Turns => self.turns.map(|limit| limit as f64),
            Axis::Time => self.wallclock_ms.map(|limit| limit as f64),
        }
    }

    fn spent_of(&self, axis: Axis, observed: &Observed) -> f64 {
        match axis {
            Axis::Cost => observed.cost_usd,
            Axis::Tokens => observed.tokens as f64,
            Axis::Turns => observed.turns as f64,
            Axis::Time => observed.elapsed_ms as f64,
        }
    }
}

/// The axis closest to (or past) a level, so a warning names the limit that is
/// actually filling up instead of whichever axis happens to be listed first.
fn closest(shares: &[(Axis, f64)], level: fn(Axis) -> Level, reached: f64) -> Option<Level> {
    shares
        .iter()
        .filter(|(_, share)| *share >= reached)
        .reduce(|worst, share| if share.1 > worst.1 { share } else { worst })
        .map(|(axis, _)| level(*axis))
}

/// What one run has spent so far.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Observed {
    pub turns: u64,
    pub tokens: u64,
    pub cost_usd: f64,
    /// Turns whose money came from our rate table instead of a provider charge.
    pub estimated_turns: u64,
    /// Turns with no money figure at all, so the accrued cost is a lower bound.
    pub unpriced_turns: u64,
    pub elapsed_ms: u64,
}

impl Observed {
    /// Fold one settled provider turn in. `cost` is the priced `usage.cost`
    /// object the ledger already stores: `amount` is the money, and `reported`
    /// says whether a provider stood behind it.
    pub fn spend(&mut self, usage: &Value, cost: Option<&Value>, elapsed_ms: u64) {
        self.turns += 1;
        self.tokens = self.tokens.saturating_add(billed_tokens(usage));
        self.elapsed_ms = elapsed_ms;
        match cost
            .and_then(|cost| cost.get("amount"))
            .and_then(Value::as_f64)
        {
            Some(amount) => {
                self.cost_usd += amount;
                if cost.is_some_and(|cost| cost["reported"].as_bool() != Some(true)) {
                    self.estimated_turns += 1;
                }
            }
            None => self.unpriced_turns += 1,
        }
    }
}

/// Tokens a turn is billed for: the inclusive prompt plus what it generated.
pub fn billed_tokens(usage: &Value) -> u64 {
    usage["inputTokens"]
        .as_u64()
        .unwrap_or_default()
        .saturating_add(usage["outputTokens"].as_u64().unwrap_or_default())
}

/// A window's recorded spend, summed from the ledger's own `usage` events and
/// then advanced turn by turn in memory. It is read once per window because a
/// whole-Session sum per turn would scan every turn the Session ever ran.
///
/// Retention removes old usage events, so a window that reaches past them
/// under-counts: that makes the budget more permissive, never silently stricter.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Spend {
    pub turns: u64,
    pub tokens: u64,
    pub cost_usd: f64,
    pub estimated_turns: u64,
    pub unpriced_turns: u64,
    /// When the window's first recorded turn settled, if it recorded a time.
    pub first_ms: Option<u64>,
}

impl Spend {
    /// Fold one recorded `usage` event in.
    pub fn observe(&mut self, event: &Value, at_ms: Option<u64>) {
        self.turns += 1;
        self.tokens = self.tokens.saturating_add(billed_tokens(&event["usage"]));
        match event["cost"]["amount"].as_f64() {
            Some(amount) => {
                self.cost_usd += amount;
                if event["cost"]["reported"].as_bool() != Some(true) {
                    self.estimated_turns += 1;
                }
            }
            None => self.unpriced_turns += 1,
        }
        if let Some(at) = at_ms {
            self.first_ms = Some(self.first_ms.map_or(at, |first| first.min(at)));
        }
    }

    pub fn observed(&self, opened_ms: Option<u64>, now_ms: u64) -> Observed {
        Observed {
            turns: self.turns,
            tokens: self.tokens,
            cost_usd: self.cost_usd,
            estimated_turns: self.estimated_turns,
            unpriced_turns: self.unpriced_turns,
            elapsed_ms: opened_ms.map_or(0, |opened| now_ms.saturating_sub(opened)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Axis {
    Cost,
    Tokens,
    Turns,
    Time,
}

impl Axis {
    pub fn name(self) -> &'static str {
        match self {
            Axis::Cost => "cost",
            Axis::Tokens => "tokens",
            Axis::Turns => "turns",
            Axis::Time => "time",
        }
    }

    fn amount(self, value: f64) -> String {
        match self {
            Axis::Cost => usd(value),
            Axis::Tokens => format!("{} tokens", value.round() as u64),
            Axis::Turns => format!("{} turns", value.round() as u64),
            Axis::Time => format!("{:.1}s", value / 1000.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Within,
    /// Four fifths spent: the model is asked to close the current operation.
    Warning(Axis),
    /// At or past the limit: the run stops at the next safe boundary.
    Exhausted(Axis),
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Within => "within",
            Level::Warning(_) => "warning",
            Level::Exhausted(_) => "exhausted",
        }
    }

    pub fn axis(self) -> Option<Axis> {
        match self {
            Level::Within => None,
            Level::Warning(axis) | Level::Exhausted(axis) => Some(axis),
        }
    }

    pub fn stopped(self) -> bool {
        matches!(self, Level::Exhausted(_))
    }
}

/// A Goal's budget (`goal.budget`, AGT-04) read from the Session's state
/// projection: `iterations` is the Goal's own name for the turn budget, which
/// is also the ceiling a delegation inherits from it.
pub fn from_goal(state: &Value) -> Option<Declaration> {
    let budget = state.get("goal")?.get("value")?.get("budget")?;
    let declaration = Declaration {
        cost_usd: budget.get("cost_usd").and_then(Value::as_f64),
        tokens: budget.get("tokens").and_then(Value::as_u64),
        turns: budget.get("iterations").and_then(Value::as_u64),
        wallclock_ms: budget.get("wallclock_ms").and_then(Value::as_u64),
    };
    (!declaration.is_empty()).then_some(declaration)
}

/// Why a money figure can lag the bill, or `None` when every turn carried a
/// provider's own charge.
pub fn cost_disclosure(observed: &Observed) -> Option<String> {
    match (observed.estimated_turns, observed.unpriced_turns) {
        (0, 0) => None,
        (estimated, 0) => Some(format!(
            "{estimated} turn(s) carry a list-price estimate rather than a charge the provider reported, so the money counted here can differ from the bill."
        )),
        (0, unpriced) => Some(format!(
            "{unpriced} turn(s) carry no price at all, so the money counted here is a lower bound."
        )),
        (estimated, unpriced) => Some(format!(
            "{estimated} turn(s) carry a list-price estimate and {unpriced} carry no price at all, so the money counted here is a lower bound until billing settles."
        )),
    }
}

/// The visible history fact for a warning: which limit is filling up, what is
/// left, and what happens when it is reached.
pub fn warning_note(
    scope: &str,
    axis: Axis,
    declaration: &Declaration,
    observed: &Observed,
) -> String {
    let share = declaration.share(axis, observed);
    format!(
        "Budget warning: the {scope} {name} budget is {percent}% used ({spent} of {limit}, {remaining} left). Close the operation in progress and summarize — the run stops when the limit is reached. The model stays as selected; a budget never switches it.{disclosure}",
        name = axis.name(),
        percent = (share * 100.0).round() as u64,
        spent = axis.amount(declaration.spent_of(axis, observed)),
        limit = axis.amount(declaration.limit_of(axis).unwrap_or_default()),
        remaining = axis.amount(
            declaration.limit_of(axis).unwrap_or_default()
                - declaration.spent_of(axis, observed)
        ),
        disclosure = disclosure_suffix(declaration, observed),
    )
}

/// The visible history fact for a stop: which limit was reached, that nothing
/// runs now, that nothing admitted was dropped, and how to continue.
pub fn stop_note(
    scope: &str,
    axis: Axis,
    declaration: &Declaration,
    observed: &Observed,
) -> String {
    format!(
        "Stopped: the {scope} {name} budget of {limit} is used up ({spent} spent). Nothing is running now and this run will not resume on its own; no message was dropped, so anything not yet processed waits in this Session's durable inbox. Raise the budget and send a message to continue. The model was left unchanged.{disclosure}",
        name = axis.name(),
        limit = axis.amount(declaration.limit_of(axis).unwrap_or_default()),
        spent = axis.amount(declaration.spent_of(axis, observed)),
        disclosure = disclosure_suffix(declaration, observed),
    )
}

/// The money caveat belongs only to a note that makes a money claim: a token or
/// turn budget saying "no price at all" would read as a billing problem in a
/// run that does not bill in money.
fn disclosure_suffix(declaration: &Declaration, observed: &Observed) -> String {
    if declaration.cost_usd.is_none() {
        return String::new();
    }
    cost_disclosure(observed).map_or(String::new(), |text| format!(" {text}"))
}

/// Money at ledger precision: the accumulator is floating point, and a note
/// that prints `0.30000000000000004` reads like a bug rather than a budget.
fn micro_usd(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

/// Money in the note that names it. Cents are what an operator reads ("$0.50
/// used up"), and four decimals only where a figure is below a cent, so a
/// sub-cent budget does not print as zero.
fn usd(value: f64) -> String {
    if micro_usd(value) >= 0.01 {
        format!("${value:.2}")
    } else {
        format!("${value:.4}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration(value: Value) -> Declaration {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_declaration_states_at_least_one_positive_bound_and_stays_decidable() {
        assert!(declaration(json!({})).validate().is_err());
        for invalid in [
            json!({"cost_usd": 0}),
            json!({"cost_usd": -1}),
            json!({"cost_usd": 1e12}),
            json!({"tokens": 0}),
            json!({"turns": 0}),
            json!({"wallclock_ms": 0}),
            json!({"wallclock_ms": WALLCLOCK_CEILING_MS + 1}),
        ] {
            assert!(
                declaration(invalid.clone()).validate().is_err(),
                "{invalid}"
            );
        }
        assert!(declaration(json!({"cost_usd": 5})).validate().is_ok());
        assert!(declaration(json!({"turns": 3, "wallclock_ms": 600000}))
            .validate()
            .is_ok());
        // A prose budget is not a bound: the shape refuses it outright.
        assert!(serde_json::from_value::<Declaration>(json!({"budget": "two hours"})).is_err());
    }

    #[test]
    fn a_goal_budget_is_read_off_the_state_projection_in_turn_units() {
        let state = json!({"goal": {"revision": 3, "value": {"objective": "go", "status": "active", "budget": {"iterations": 25, "tokens": 4000, "cost_usd": 1.5}}}});
        let goal = from_goal(&state).unwrap();
        assert_eq!(goal.turns, Some(25));
        assert_eq!(goal.tokens, Some(4000));
        assert_eq!(goal.cost_usd, Some(1.5));
        assert_eq!(goal.wallclock_ms, None);
        assert!(from_goal(&json!({"goal": null})).is_none());
        assert!(from_goal(
            &json!({"goal": {"revision": 1, "value": {"objective": "go", "status": "active"}}})
        )
        .is_none());
    }

    #[test]
    fn a_run_warns_at_four_fifths_and_stops_at_the_limit_on_the_fullest_axis() {
        let budget = declaration(json!({"cost_usd": 1.0, "tokens": 1000}));
        let mut observed = Observed::default();
        assert_eq!(budget.evaluate(&observed), Level::Within);
        observed.tokens = 800;
        assert_eq!(budget.evaluate(&observed), Level::Warning(Axis::Tokens));
        observed.tokens = 1000;
        assert_eq!(budget.evaluate(&observed), Level::Exhausted(Axis::Tokens));
        assert!(Level::Exhausted(Axis::Tokens).stopped());
        assert!(!Level::Warning(Axis::Tokens).stopped());
        // Money crosses the limit before the tokens do here, and the level names
        // the axis actually at the limit.
        observed.tokens = 900;
        observed.cost_usd = 1.0;
        assert_eq!(budget.evaluate(&observed), Level::Exhausted(Axis::Cost));
    }

    #[test]
    fn an_undeclared_axis_is_absent_from_the_remainder_instead_of_infinite() {
        let budget = declaration(json!({"tokens": 1000}));
        let observed = Observed {
            tokens: 250,
            turns: 3,
            cost_usd: 0.75,
            elapsed_ms: 5000,
            ..Observed::default()
        };
        let remaining = budget.remaining(&observed);
        assert_eq!(remaining, json!({"tokens": 750}));
        assert!(remaining.get("cost_usd").is_none());
        assert!(remaining.get("turns").is_none());
        // A spent limit reports zero rather than a negative remainder.
        let spent = Observed {
            tokens: 1200,
            ..Observed::default()
        };
        assert_eq!(budget.remaining(&spent), json!({"tokens": 0}));
    }

    #[test]
    fn one_turn_folds_into_the_observation_and_separates_reported_from_estimated_money() {
        let usage = json!({"inputTokens": 100, "outputTokens": 20});
        let mut observed = Observed::default();
        observed.spend(
            &usage,
            Some(&json!({"amount": 0.4, "reported": true})),
            1000,
        );
        observed.spend(
            &usage,
            Some(&json!({"amount": 0.1, "reported": false})),
            2500,
        );
        observed.spend(&usage, None, 3000);
        assert_eq!(observed.turns, 3);
        assert_eq!(observed.tokens, 360);
        assert!((observed.cost_usd - 0.5).abs() < 1e-9);
        assert_eq!(observed.estimated_turns, 1);
        assert_eq!(observed.unpriced_turns, 1);
        assert_eq!(observed.elapsed_ms, 3000);
    }

    /// A budget that read an unpriced turn as free would report more money left
    /// than the operator has, so the note says when the figure is a lower bound.
    #[test]
    fn missing_or_estimated_billing_is_disclosed_where_the_remaining_amount_is_read() {
        let budget = declaration(json!({"cost_usd": 1.0}));
        let settled = Observed {
            turns: 1,
            cost_usd: 0.9,
            ..Observed::default()
        };
        assert!(cost_disclosure(&settled).is_none());
        let note = warning_note("Session", Axis::Cost, &budget, &settled);
        assert!(note.contains("90% used"), "{note}");
        assert!(note.contains("$0.10 left"), "{note}");
        assert!(!note.contains("lower bound"), "{note}");

        let lagging = Observed {
            turns: 2,
            cost_usd: 0.9,
            estimated_turns: 1,
            unpriced_turns: 1,
            ..Observed::default()
        };
        let note = warning_note("Session", Axis::Cost, &budget, &lagging);
        assert!(
            note.contains("1 turn(s) carry a list-price estimate"),
            "{note}"
        );
        assert!(note.contains("1 carry no price at all"), "{note}");
        assert!(note.contains("lower bound"), "{note}");
    }

    #[test]
    fn a_stop_names_the_axis_the_remainder_and_how_to_continue() {
        let budget = declaration(json!({"turns": 2, "wallclock_ms": 60000}));
        let observed = Observed {
            turns: 2,
            elapsed_ms: 20_000,
            ..Observed::default()
        };
        assert_eq!(budget.evaluate(&observed), Level::Exhausted(Axis::Turns));
        let note = stop_note("Goal", Axis::Turns, &budget, &observed);
        assert!(note.contains("Goal turns budget of 2 turns"), "{note}");
        assert!(note.contains("2 turns spent"), "{note}");
        assert!(note.contains("Nothing is running now"), "{note}");
        assert!(note.contains("durable inbox"), "{note}");
        assert!(note.contains("The model was left unchanged"), "{note}");
    }

    /// The gate's baseline is the ledger, not an in-memory counter: a Session
    /// that already spent money keeps that spend against it across messages,
    /// and a window opened at a Goal's revision counts only what came after.
    #[test]
    fn a_ledger_window_sums_turns_money_and_its_own_starting_point() {
        let mut spend = Spend::default();
        for (data, at) in [
            (
                json!({"usage": {"inputTokens": 100, "outputTokens": 10}, "cost": {"amount": 0.2, "reported": true}}),
                Some(1_000),
            ),
            (
                json!({"usage": {"inputTokens": 50, "outputTokens": 5}, "cost": {"amount": 0.05, "reported": false}}),
                Some(2_000),
            ),
            (json!({"usage": {"outputTokens": 5}}), Some(1_500)),
        ] {
            spend.observe(&data, at);
        }
        assert_eq!(spend.turns, 3);
        assert_eq!(spend.tokens, 170);
        assert!((spend.cost_usd - 0.25).abs() < 1e-9);
        assert_eq!(spend.estimated_turns, 1);
        assert_eq!(spend.unpriced_turns, 1);
        assert_eq!(spend.first_ms, Some(1_000));
        let observed = spend.observed(spend.first_ms, 61_000);
        assert_eq!(observed.elapsed_ms, 60_000);
        assert_eq!(observed.tokens, 170);
        // A window that never recorded a time reports no elapsed time rather
        // than subtracting from zero.
        assert_eq!(Spend::default().observed(None, 61_000).elapsed_ms, 0);
    }

    #[test]
    fn the_state_payload_carries_limits_spent_and_remaining_together() {
        let budget = declaration(json!({"cost_usd": 2.0, "tokens": 500}));
        let observed = Observed {
            turns: 4,
            tokens: 100,
            cost_usd: 0.5,
            elapsed_ms: 900,
            estimated_turns: 1,
            unpriced_turns: 0,
        };
        let state = budget.state(&observed, Level::Warning(Axis::Cost));
        assert_eq!(state["level"], json!("warning"));
        assert_eq!(state["axis"], json!("cost"));
        assert_eq!(state["remaining"], json!({"cost_usd": 1.5, "tokens": 400}));
        assert_eq!(state["spent"]["turns"], json!(4));
        assert_eq!(state["limit"]["cost_usd"], json!(2.0));
        assert_eq!(state["estimated_turns"], json!(1));
        assert_eq!(budget.state(&observed, Level::Within)["axis"], json!(null));
    }
}
