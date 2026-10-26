//! Golden alignment for the derived product config (S5, step 2).
//!
//! Every case in `tests/fixtures/config-golden` is one config directory plus
//! the environment the host forwards; the expected policy or LSP config is
//! what the engine must derive. The TypeScript suite reads the same
//! directories with its own parser, so both implementations are pinned to one
//! set of samples.

use miao_engine::config_derive;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn golden_cases(expected: &str) -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config-golden");
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|case| case.join(expected).exists())
        .collect();
    cases.sort();
    cases
}

fn read_environment(case: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(case.join("env.json")).unwrap()).unwrap()
}

#[test]
fn derived_policy_matches_every_golden_case() {
    let cases = golden_cases("expected-policy.json");
    assert!(
        cases.len() >= 5,
        "expected the shared golden cases, found {}: {:?}",
        cases.len(),
        cases
    );
    for case in cases {
        let environment = read_environment(&case);
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

/// The injected lookup the golden cases assume: an absolute command resolves
/// as itself, anything else under `/tools`, mirroring how both sides fake the
/// executable search so the samples stay machine-independent.
fn golden_lookup(environment: &Value) -> impl Fn(&str) -> Option<PathBuf> {
    let installed: Vec<String> = environment
        .get("installed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    move |command: &str| {
        if !installed.iter().any(|name| name == command) {
            return None;
        }
        if command.starts_with('/') {
            return Some(PathBuf::from(command));
        }
        Some(PathBuf::from("/tools").join(command))
    }
}

#[test]
fn derived_lsp_matches_every_golden_case() {
    let cases = golden_cases("expected-lsp.json");
    assert!(
        cases.len() >= 3,
        "expected the shared golden LSP cases, found {}: {:?}",
        cases.len(),
        cases
    );
    for case in cases {
        let environment = read_environment(&case);
        let source = config_derive::Source::Dir(case.join("global"));
        let documents = config_derive::load(std::slice::from_ref(&source)).unwrap();
        let configured = config_derive::lsp_configured(&documents);
        let derived = config_derive::lsp_entries(
            configured.as_ref(),
            &config_derive::BUILTIN_SERVERS,
            &golden_lookup(&environment),
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case.display()));
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(case.join("expected-lsp.json")).unwrap())
                .unwrap();
        assert_eq!(
            serde_json::to_value(&derived).unwrap(),
            expected,
            "{} drifted from the shared golden LSP config",
            case.display()
        );
    }
}
