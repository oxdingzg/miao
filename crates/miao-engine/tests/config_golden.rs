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
        let derived = match read_sources(&case) {
            Some(sources) => config_derive::policy_from_sources(&sources, sandbox),
            None => config_derive::policy_from_directory(&case.join("global"), sandbox),
        }
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

#[test]
fn normalized_config_matches_every_golden_case() {
    let cases = golden_cases("expected-config.json");
    assert!(
        cases.len() >= 4,
        "expected the shared golden config cases, found {}: {:?}",
        cases.len(),
        cases
    );
    for case in cases {
        let sources = match read_sources(&case) {
            Some(sources) => sources,
            None => vec![config_derive::Source::Dir(case.join("global"))],
        };
        let normalized = config_derive::normalized_from_sources(&sources)
            .unwrap_or_else(|error| panic!("{}: {error}", case.display()));
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(case.join("expected-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            normalized,
            expected,
            "{} drifted from the shared golden config",
            case.display()
        );
    }
}

#[test]
fn a_document_without_an_object_root_fails_the_normalized_read() {
    let case = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/config-golden/config-invalid-root");
    let sources = vec![config_derive::Source::Dir(case.join("global"))];
    let error = config_derive::normalized_from_sources(&sources)
        .expect_err("an array root must fail the normalized read");
    assert!(
        error.contains("config-invalid-root") || error.contains("miao.json"),
        "the error should name the offending source: {error}"
    );
}

/// A case with a `sources.json` plan drives the ordered multi-source loader
/// the host forwards as `--config-sources`; paths are relative to the case.
fn read_sources(case: &Path) -> Option<Vec<config_derive::Source>> {
    let text = std::fs::read_to_string(case.join("sources.json")).ok()?;
    let value: Value = serde_json::from_str(&text).unwrap();
    Some(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                if let Some(dir) = entry.get("dir").and_then(Value::as_str) {
                    config_derive::Source::Dir(case.join(dir))
                } else if let Some(file) = entry.get("file").and_then(Value::as_str) {
                    config_derive::Source::File(case.join(file))
                } else {
                    config_derive::Source::Content(
                        entry
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap()
                            .to_string(),
                    )
                }
            })
            .collect(),
    )
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
        // The samples are shared with the TypeScript reference and captured with
        // POSIX separators, so the fake install path is composed the same way on
        // every host instead of letting Path::join pick the native separator.
        Some(PathBuf::from(format!("/tools/{command}")))
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

/// Origins arrive as absolute paths; the samples are shared with the TypeScript
/// reference, so every reader reports them relative to its own case directory.
/// Compare path components instead of a string prefix so a Windows origin
/// (`D:\...\case\project\miao.json`) matches on either separator, and emit the
/// separators the samples use.
fn relativize(value: &Value, case: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(
            Path::new(text)
                .strip_prefix(case)
                .map(|rest| rest.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| text.clone()),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| relativize(item, case)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), relativize(item, case)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `serde_json` keeps object keys sorted while the TypeScript reader preserves
/// document order, so both sides sort by key path before comparing.
fn sort_keys(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(Value::Array(keys)) = object.get_mut("keys") {
        if keys.first().is_some_and(Value::is_object) {
            keys.sort_by(|left, right| {
                left.get("path")
                    .unwrap_or(&Value::Null)
                    .to_string()
                    .cmp(&right.get("path").unwrap_or(&Value::Null).to_string())
            });
        }
    }
    for item in object.values_mut() {
        sort_keys(item);
    }
}

#[test]
fn explained_provenance_matches_every_golden_case() {
    let cases = golden_cases("expected-explain.json");
    assert!(
        !cases.is_empty(),
        "expected a shared golden provenance case, found none"
    );
    for case in cases {
        let sources = read_sources(&case).expect("an explain case carries a sources plan");
        let documents = config_derive::load(&sources)
            .unwrap_or_else(|error| panic!("{}: {error}", case.display()));
        let mut derived = relativize(&config_derive::explain(&documents), &case);
        sort_keys(&mut derived);
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(case.join("expected-explain.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            derived,
            expected,
            "{} drifted from the shared golden provenance",
            case.display()
        );
    }
}
