use miao_engine::{
    permission::{input_digest, Access, Config, Decision, Mode, Policy, Rule},
    protocol::Error,
};
use serde_json::json;

#[test]
fn modes_and_rules_have_monotonic_deny_and_explicit_ask() {
    let policy = Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![
            Rule {
                tool: "*".into(),
                path: "**".into(),
                decision: Decision::Allow,
            },
            Rule {
                tool: "write_file".into(),
                path: "secrets/**".into(),
                decision: Decision::Deny,
            },
            Rule {
                tool: "read_file".into(),
                path: "private/**".into(),
                decision: Decision::Ask,
            },
        ],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        policy.evaluate("write_file", "src/a", Access::Write),
        Decision::Allow
    );
    assert_eq!(
        policy.evaluate("write_file", "secrets/key", Access::Write),
        Decision::Deny
    );
    assert_eq!(
        policy.evaluate("read_file", "private/key", Access::Read),
        Decision::Ask
    );
    assert_eq!(
        policy.evaluate("read_file", "../key", Access::Read),
        Decision::Deny
    );
    let upper = Policy::new(Config {
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        upper.evaluate("write_file", "src/a", Access::Write),
        Decision::Deny
    );
    let default = Policy::new(Config::default()).unwrap();
    assert_eq!(
        default.evaluate("read_file", "src/a", Access::Read),
        Decision::Allow
    );
    let workspace = Policy::new(Config {
        mode: Mode::Workspace,
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        workspace.evaluate("write_file", "src/a", Access::Write),
        Decision::Ask
    );
}

#[test]
fn approval_fingerprint_binds_location_resource_tool_and_entire_input() {
    let first = json!({"path":"file","text":"first"});
    let equivalent: serde_json::Value =
        serde_json::from_str("{\"text\":\"first\",\"path\":\"file\"}").unwrap();
    let hash = input_digest("root", "write_file", "file", &first).unwrap();
    assert_eq!(
        hash,
        input_digest("root", "write_file", "file", &equivalent).unwrap()
    );
    for (location, tool, resource, input) in [
        ("other", "write_file", "file", first.clone()),
        ("root", "read_file", "file", first.clone()),
        ("root", "write_file", "other", first.clone()),
        (
            "root",
            "write_file",
            "file",
            json!({"path":"file","text":"second"}),
        ),
    ] {
        assert_ne!(
            hash,
            input_digest(location, tool, resource, &input).unwrap()
        );
    }
    let a = Policy::new(Config::default()).unwrap();
    let b = Policy::new(Config {
        mode: Mode::Workspace,
        ..Config::default()
    })
    .unwrap();
    assert_ne!(a.revision(), b.revision());
}

#[test]
fn invalid_patterns_and_limits_are_rejected_at_startup() {
    for path in ["../*", "/absolute", "["] {
        assert!(matches!(
            Policy::new(Config {
                rules: vec![Rule {
                    tool: "read_file".into(),
                    path: path.into(),
                    decision: Decision::Allow
                }],
                ..Config::default()
            }),
            Err(Error::Invalid(_))
        ));
    }
    assert!(Policy::new(Config {
        approval_timeout_ms: 0,
        ..Config::default()
    })
    .is_err());
    assert!(Policy::new(Config {
        approval_timeout_ms: 600_001,
        ..Config::default()
    })
    .is_err());
}

#[test]
fn process_authority_requires_explicit_mode_and_capability() {
    let rule = Rule {
        tool: "*".into(),
        path: "**".into(),
        decision: Decision::Allow,
    };
    let readonly = Policy::new(Config {
        allow_process: true,
        rules: vec![rule.clone()],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        readonly.evaluate("run_command", ".", Access::Execute),
        Decision::Deny
    );
    let workspace = Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![rule],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        workspace.evaluate("run_command", ".", Access::Execute),
        Decision::Deny
    );
    let process = Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        process.evaluate("run_command", ".", Access::Execute),
        Decision::Ask
    );
    assert!(!process.process_network());
}
