//! Branch discipline for the actions that land work on a remote: a push or a
//! pull request that would move the protected branch itself is refused, and no
//! approval prompt can talk the engine into it.
//!
//! Every target here is observed, never claimed. It comes from the tokens the
//! shell will actually execute and, only when the command names no branch, from
//! the checkout's own `HEAD`. A target the engine cannot observe stays an
//! ordinary ask, so a linked worktree — whose `.git` is a file pointing outside
//! the workspace — never turns into a fabricated refusal.

use crate::agent_classifier::words;
use cap_std::fs::Dir;
use serde_json::Value;
use std::io::Read;

/// The branches a change reaches only through review.
pub const PROTECTED: [&str; 2] = ["main", "master"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Push,
    PullRequest,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Push => "push",
            Action::PullRequest => "pull_request",
        }
    }
}

/// Where an action would put the work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Named by the command, or the branch `HEAD` is on.
    Branch(String),
    /// Every branch at once (`--all`, `--mirror`), which includes the protected one.
    EveryBranch,
    /// Nothing names a branch and the checkout could not be read.
    Unresolved,
}

impl Target {
    pub fn as_str(&self) -> &str {
        match self {
            Target::Branch(branch) => branch,
            Target::EveryBranch => "<all branches>",
            Target::Unresolved => "<unresolved>",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub action: Action,
    pub target: Target,
}

impl Finding {
    /// Whether this action would move the protected branch itself.
    pub fn lands_on_protected(&self) -> bool {
        match &self.target {
            Target::Branch(branch) => PROTECTED.contains(&branch.as_str()),
            Target::EveryBranch => true,
            Target::Unresolved => false,
        }
    }
}

/// The branch the workspace checkout is on, as the checkout records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Head {
    Branch(String),
    /// Detached, or a checkout whose `.git` the workspace cannot read.
    Unreadable,
}

impl Head {
    pub fn observe(directory: &Dir) -> Head {
        let Ok(mut file) = directory.open(".git/HEAD") else {
            return Head::Unreadable;
        };
        let mut content = String::new();
        if file.read_to_string(&mut content).is_err() {
            return Head::Unreadable;
        }
        match content.trim().strip_prefix("ref: refs/heads/") {
            Some(branch) if !branch.is_empty() => Head::Branch(branch.to_owned()),
            _ => Head::Unreadable,
        }
    }

    fn target(&self) -> Target {
        match self {
            Head::Branch(branch) => Target::Branch(branch.clone()),
            Head::Unreadable => Target::Unresolved,
        }
    }
}

/// The landing action a tool input describes, when it describes one.
pub fn inspect(input: &Value, head: &Head) -> Option<Finding> {
    let commands = match input.get("command").and_then(Value::as_str) {
        Some(command) => words(command)?,
        None => vec![input
            .get("argv")?
            .as_array()?
            .iter()
            .map(|word| word.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()?],
    };
    // `cd sub && git push` and `pushd sub; git push` leave the branch somewhere
    // this observation cannot see, so those targets stay unresolved.
    let elsewhere = commands.len() > 1
        || commands
            .iter()
            .any(|words| matches!(words.first().map(String::as_str), Some("cd" | "pushd")));
    let unreadable = Head::Unreadable;
    let head = if elsewhere { &unreadable } else { head };
    commands.iter().find_map(|words| finding(words, head))
}

/// The refusal for a tool input whose landing action would move the protected
/// branch. A rule or saved grant that already allowed the call never reaches
/// here: that is the operator's own authorization.
pub fn refusal(input: &Value, head: &Head) -> Option<Finding> {
    inspect(input, head).filter(Finding::lands_on_protected)
}

fn finding(words: &[String], head: &Head) -> Option<Finding> {
    match (words.first(), words.get(1)) {
        (Some(first), _) if first == "git" => git(&words[1..], head),
        (Some(first), Some(second)) if first == "gh" && second == "pr" => match words.get(2) {
            Some(create) if create == "create" => pull_request(&words[3..], head),
            _ => None,
        },
        _ => None,
    }
}

/// Git's own global options come before the subcommand and some of them name a
/// different checkout, which no longer says where a bare push would land.
fn git(args: &[String], head: &Head) -> Option<Finding> {
    let mut index = 0;
    let mut elsewhere = false;
    while let Some(word) = args.get(index) {
        match word.as_str() {
            "-C" | "--git-dir" | "--work-tree" | "--namespace" | "--super-prefix" => {
                elsewhere = true;
                index += 2;
            }
            "-c" | "--exec-path" => index += 2,
            _ if word.starts_with('-') => index += 1,
            _ => break,
        }
    }
    let unreadable = Head::Unreadable;
    let head = if elsewhere { &unreadable } else { head };
    match args.get(index).map(String::as_str)? {
        "push" => push(&args[index + 1..], head),
        _ => None,
    }
}

/// Push flags that consume the word after them, so the positional walk — remote
/// first, refspecs after — stays aligned.
const PUSH_VALUED: [&str; 4] = ["--repo", "--receive-pack", "--exec", "-o"];

fn push(args: &[String], head: &Head) -> Option<Finding> {
    let mut every = false;
    let mut tags_only = false;
    let mut dry_run = false;
    let mut positional = Vec::new();
    let mut index = 0;
    while let Some(word) = args.get(index) {
        index += 1;
        match word.as_str() {
            "--all" | "--mirror" | "--branches" => every = true,
            "--tags" => tags_only = true,
            "--dry-run" | "-n" => dry_run = true,
            value if PUSH_VALUED.contains(&value) => index += 1,
            value if value.starts_with('-') => {}
            value => positional.push(value),
        }
    }
    // A dry run moves nothing, and a tag-only push moves no branch unless a
    // refspec says otherwise.
    if dry_run || (tags_only && positional.len() <= 1) {
        return None;
    }
    if every {
        return Some(Finding {
            action: Action::Push,
            target: Target::EveryBranch,
        });
    }
    if positional.len() <= 1 {
        return Some(Finding {
            action: Action::Push,
            target: head.target(),
        });
    }
    let mut target = None;
    for branch in positional.iter().skip(1).filter_map(|spec| refspec(spec)) {
        if PROTECTED.contains(&branch.as_str()) {
            target = Some(Target::Branch(branch));
            break;
        }
        target = target.or(Some(Target::Branch(branch)));
    }
    Some(Finding {
        action: Action::Push,
        target: target.unwrap_or(Target::Unresolved),
    })
}

/// The branch a refspec lands on: `+main`, `refs/heads/main`, `HEAD:main` and
/// `:main` all name `main`. Anything that names no branch lands nowhere this
/// module can read.
fn refspec(spec: &str) -> Option<String> {
    let spec = spec.trim_start_matches('+');
    let destination = spec
        .rsplit_once(':')
        .map_or(spec, |(_, destination)| destination);
    let branch = destination
        .strip_prefix("refs/heads/")
        .unwrap_or(destination)
        .trim();
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }
    Some(branch.to_owned())
}

fn pull_request(args: &[String], head: &Head) -> Option<Finding> {
    let mut explicit = None;
    let mut index = 0;
    while let Some(word) = args.get(index) {
        index += 1;
        match word.as_str() {
            "--head" | "-H" => {
                explicit = args.get(index).map(String::as_str);
                index += 1;
            }
            "--base" | "-B" => index += 1,
            value => {
                if let Some(branch) = value.strip_prefix("--head=") {
                    explicit = Some(branch);
                }
            }
        }
    }
    let target = match explicit {
        Some(branch) => Target::Branch(branch.to_owned()),
        None => head.target(),
    };
    Some(Finding {
        action: Action::PullRequest,
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn head(branch: &str) -> Head {
        Head::Branch(branch.to_owned())
    }

    fn refuses(command: &str, on: &Head) -> Option<(Action, String)> {
        let finding = refusal(&json!({"command":command}), on)?;
        Some((finding.action, finding.target.as_str().to_owned()))
    }

    #[test]
    fn a_push_that_names_the_protected_branch_is_refused() {
        assert_eq!(
            refuses("git push origin main", &head("feat/x")),
            Some((Action::Push, "main".into()))
        );
        assert_eq!(
            refuses("git push origin master", &head("feat/x")),
            Some((Action::Push, "master".into()))
        );
        // Every spelling of the same destination resolves to the branch.
        for command in [
            "git push origin HEAD:main",
            "git push origin refs/heads/main",
            "git push -u origin +main",
            "git push --force-with-lease origin main",
            "git push origin feat/x main",
            "git push -d origin main",
            "git push --delete origin refs/heads/main",
        ] {
            assert_eq!(
                refuses(command, &head("feat/x")),
                Some((Action::Push, "main".into())),
                "{command}"
            );
        }
        // `--all` moves every branch, the protected one included.
        assert_eq!(
            refuses("git push --all origin", &head("feat/x")),
            Some((Action::Push, "<all branches>".into()))
        );
        assert_eq!(
            refuses("git push --mirror origin", &head("feat/x")),
            Some((Action::Push, "<all branches>".into()))
        );
    }

    #[test]
    fn a_push_with_no_refspec_is_judged_by_the_branch_head_is_on() {
        for command in [
            "git push",
            "git push origin",
            "git push --force-with-lease",
            "git push -u origin",
        ] {
            assert_eq!(
                refuses(command, &head("main")),
                Some((Action::Push, "main".into())),
                "{command}"
            );
            assert_eq!(refuses(command, &head("feat/x")), None, "{command}");
        }
        // A push from a topic branch is a landing action, but not a refusal.
        assert!(!inspect(
            &json!({"command":"git push origin feat/x"}),
            &head("feat/x")
        )
        .unwrap()
        .lands_on_protected());
    }

    #[test]
    fn a_target_the_engine_cannot_observe_stays_an_ask() {
        // A detached checkout, or a linked worktree whose `.git` is a file.
        assert_eq!(refuses("git push", &Head::Unreadable), None);
        assert_eq!(refuses("git push origin", &Head::Unreadable), None);
        // The command runs somewhere else, so the workspace's own HEAD says
        // nothing about where it lands.
        assert_eq!(refuses("cd sub && git push", &head("main")), None);
        assert_eq!(refuses("cd sub; git push origin", &head("main")), None);
        assert_eq!(refuses("git -C sub push", &head("main")), None);
        assert_eq!(refuses("git --work-tree sub push", &head("main")), None);
        // A refspec still names its destination from anywhere.
        assert_eq!(
            refuses("cd sub && git push origin main", &head("feat/x")),
            Some((Action::Push, "main".into()))
        );
    }

    #[test]
    fn a_push_that_moves_nothing_is_not_a_landing_action() {
        assert_eq!(
            refuses("git push --dry-run origin main", &head("main")),
            None
        );
        assert_eq!(refuses("git push -n origin main", &head("main")), None);
        assert_eq!(refuses("git push --tags origin", &head("main")), None);
        assert_eq!(
            refuses("git push origin feat/x:feat/x", &head("main")),
            None
        );
    }

    #[test]
    fn a_pull_request_from_the_protected_branch_is_refused() {
        assert_eq!(
            refuses("gh pr create --base main", &head("main")),
            Some((Action::PullRequest, "main".into()))
        );
        assert_eq!(
            refuses("gh pr create --head main --base main", &head("feat/x")),
            Some((Action::PullRequest, "main".into()))
        );
        assert_eq!(
            refuses("gh pr create --head=main", &head("feat/x")),
            Some((Action::PullRequest, "main".into()))
        );
        assert_eq!(refuses("gh pr create --base main", &head("feat/x")), None);
        assert_eq!(refuses("gh pr list", &head("main")), None);
        assert_eq!(refuses("gh pr merge 42 --squash", &head("main")), None);
    }

    #[test]
    fn an_argv_command_is_judged_by_the_words_it_will_execute() {
        assert_eq!(
            refusal(
                &json!({"argv":["git","push","origin","main"]}),
                &head("feat/x")
            ),
            Some(Finding {
                action: Action::Push,
                target: Target::Branch("main".into())
            })
        );
        assert_eq!(
            refusal(
                &json!({"argv":["git","push","origin","feat/x"]}),
                &head("feat/x")
            ),
            None
        );
        assert_eq!(
            refusal(&json!({"argv":["git","status"]}), &head("main")),
            None
        );
        assert_eq!(refusal(&json!({"argv":["ls"]}), &head("main")), None);
    }

    #[test]
    fn commands_that_land_nothing_are_not_findings() {
        for command in [
            "git commit -m work",
            "git branch feat/x",
            "git log --oneline",
            "ls -la",
            "gh pr view 1",
        ] {
            assert_eq!(
                inspect(&json!({"command":command}), &head("main")),
                None,
                "{command}"
            );
        }
        // A line the classifier cannot parse claims nothing either way.
        assert_eq!(
            inspect(&json!({"command":"git push origin main )"}), &head("main")),
            None
        );
        assert_eq!(inspect(&json!({}), &head("main")), None);
    }
}
