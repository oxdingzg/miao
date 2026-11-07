//! Report the Session's run state to mtty, the terminal that started us.
//!
//! mtty badges a tab from the `agent.state` map: working, waiting for the
//! operator, or finished, and it routes queued prompts on those transitions.
//! The JavaScript client reported through `mtty-cli state`; the native TUI
//! replaced it without that report, so panes stayed blank. This is the same
//! contract, fed from the phase the TUI already computes for its own title.

use std::process::{Command, Stdio};

/// The states mtty understands (`agent.state.set`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Idle,
    Processing,
    Awaiting,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Processing => "processing",
            State::Awaiting => "awaiting",
        }
    }

    /// What a Session's run looks like from outside: a blocking approval or
    /// question outranks a running turn, and no turn at all is idle.
    pub fn of(blocking: bool, running: bool) -> Self {
        match (blocking, running) {
            (true, _) => State::Awaiting,
            (false, true) => State::Processing,
            (false, false) => State::Idle,
        }
    }
}

/// The pane mtty spawned us in and the CLI that reaches it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    pane: String,
    exe: String,
}

impl Target {
    /// `None` outside mtty, where there is nothing to report to.
    fn from_env() -> Option<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Read the environment through `lookup` so the naming rules are testable.
    /// The `miaotty` names are the pre-rename ones an older host still sets.
    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let named = |name: &str| lookup(name).filter(|value| !value.is_empty());
        let modern = named("MTTY_PANE_ID");
        let pane = modern.clone().or_else(|| named("MIAOTTY_PANE_ID"))?;
        let exe = named("MTTY_CLI")
            .or_else(|| named("MIAOTTY_CLI"))
            .unwrap_or_else(|| match modern {
                Some(_) => "mtty-cli".to_string(),
                None => "miaotty-cli".to_string(),
            });
        Some(Target { pane, exe })
    }
}

/// The `mtty-cli` arguments for one report.
fn arguments(target: &Target, state: State, session: Option<&str>) -> Vec<String> {
    let mut args = [
        "state",
        "miao",
        "--state",
        state.name(),
        "--pane",
        target.pane.as_str(),
    ]
    .map(str::to_string)
    .to_vec();
    if let Some(session) = session.filter(|session| !session.is_empty()) {
        args.push("--session".to_string());
        args.push(session.to_string());
    }
    args
}

/// Forwards state changes to mtty, once each.
#[derive(Debug, Default)]
pub struct Reporter {
    target: Option<Target>,
    session: Option<String>,
    last: Option<State>,
}

impl Reporter {
    pub fn from_env() -> Self {
        Self {
            target: Target::from_env(),
            session: None,
            last: None,
        }
    }

    pub fn set_session(&mut self, session: Option<&str>) {
        self.session = session
            .filter(|session| !session.is_empty())
            .map(str::to_string);
    }

    /// Report `state` when it changed since the last report. Outside mtty this
    /// is one environment lookup at construction and nothing per frame.
    pub fn update(&mut self, state: State) {
        if self.last == Some(state) {
            return;
        }
        self.last = Some(state);
        self.send(state);
    }

    /// The TUI is leaving: an idle report stops the tab claiming a run that
    /// ended with this process.
    pub fn clear(&mut self) {
        self.update(State::Idle);
    }

    fn send(&self, state: State) {
        let Some(target) = &self.target else {
            return;
        };
        let mut command = Command::new(&target.exe);
        command.args(arguments(target, state, self.session.as_deref()));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let Ok(mut child) = command.spawn() else {
            return;
        };
        // Reap off the UI thread: a long Session changes state many times and
        // must not leave a zombie per turn.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{arguments, Reporter, State, Target};

    #[test]
    fn state_follows_the_blocking_and_run_signals() {
        assert_eq!(
            State::of(true, true),
            State::Awaiting,
            "a question outranks a run"
        );
        assert_eq!(State::of(true, false), State::Awaiting);
        assert_eq!(State::of(false, true), State::Processing);
        assert_eq!(State::of(false, false), State::Idle);
        assert_eq!(State::Awaiting.name(), "awaiting");
    }

    #[test]
    fn target_prefers_the_mtty_names_and_falls_back() {
        let env = |pairs: &[(&str, &str)]| {
            let pairs: Vec<(String, String)> = pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect();
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            }
        };
        let target = Target::from_lookup(env(&[
            ("MTTY_PANE_ID", "pane-1"),
            ("MTTY_CLI", "/opt/mtty-cli"),
        ]))
        .expect("inside mtty");
        assert_eq!(target.pane, "pane-1");
        assert_eq!(target.exe, "/opt/mtty-cli");

        // An older host sets only the pre-rename names.
        let target = Target::from_lookup(env(&[("MIAOTTY_PANE_ID", "old")])).expect("old host");
        assert_eq!(target.exe, "miaotty-cli");

        // A modern pane without MTTY_CLI uses the installer's name.
        let target = Target::from_lookup(env(&[("MTTY_PANE_ID", "pane-2")])).expect("pane");
        assert_eq!(target.exe, "mtty-cli");

        // Empty values count as unset, and no pane means no reporting.
        assert_eq!(Target::from_lookup(env(&[("MTTY_PANE_ID", "")])), None);
        assert_eq!(Target::from_lookup(env(&[])), None);
    }

    #[test]
    fn arguments_name_the_pane_and_session() {
        let target = Target {
            pane: "p1".into(),
            exe: "mtty-cli".into(),
        };
        assert_eq!(
            arguments(&target, State::Processing, Some("s1")),
            vec![
                "state",
                "miao",
                "--state",
                "processing",
                "--pane",
                "p1",
                "--session",
                "s1"
            ]
        );
        assert_eq!(
            arguments(&target, State::Idle, None),
            vec!["state", "miao", "--state", "idle", "--pane", "p1"]
        );
    }

    #[test]
    fn only_changes_are_reported() {
        let mut reporter = Reporter::default();
        reporter.update(State::Processing);
        assert_eq!(reporter.last, Some(State::Processing));
        reporter.update(State::Processing);
        assert_eq!(reporter.last, Some(State::Processing));
        reporter.update(State::Idle);
        assert_eq!(reporter.last, Some(State::Idle));
        reporter.clear();
        assert_eq!(reporter.last, Some(State::Idle));
    }
}
