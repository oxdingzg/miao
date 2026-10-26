//! Golden alignment for the derived product policy (S5, step 2).
//!
//! Every case in `tests/fixtures/config-golden` is one config directory plus
//! the environment the host forwards; the expected policy is what the engine
//! must derive. The TypeScript suite reads the same directories with its own
//! parser, so both implementations are pinned to one set of samples.

use miao_engine::config_derive;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn golden_cases() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config-golden");
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|case| case.join("expected-policy.json").exists())
        .collect();
    cases.sort();
    cases
}

#[test]
fn derived_policy_matches_every_golden_case() {
    let cases = golden_cases();
    assert!(
        cases.len() >= 5,
        "expected the shared golden cases, found {}: {:?}",
        cases.len(),
        cases
    );
    for case in cases {
        let environment: Value =
            serde_json::from_str(&std::fs::read_to_string(case.join("env.json")).unwrap()).unwrap();
        let sandbox = environment.get("MIAO_SANDBOX").and_then(Value::as_str);
        let derived = config_derive::policy_from_directory(&case.join("global"), sandbox)
            .unwrap_or_else(|error| panic!("{}: {error}", case.display()));
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(case.join("expected-policy.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&derived).unwrap(),
            expected,
            "{} drifted from the shared golden policy",
            case.display()
        );
    }
}
