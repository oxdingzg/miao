#[path = "../../build-version.rs"]
mod build_version;

#[test]
fn the_same_reader_follows_each_checkout_root() {
    let tmp = tempfile::tempdir().unwrap();
    for (checkout, expected) in [("old", "0.3.15"), ("new", "0.3.16")] {
        let root = tmp.path().join(checkout);
        let manifest_dir = root.join("crates/miao-engine");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        std::fs::write(
            root.join("package.json"),
            format!(r#"{{"version":"{expected}"}}"#),
        )
        .unwrap();
        assert_eq!(
            build_version::version(&manifest_dir, None).unwrap(),
            expected
        );
        assert_eq!(
            build_version::version(&manifest_dir, Some(expected)).unwrap(),
            expected
        );
    }
}

#[test]
fn an_environment_version_only_asserts_the_root_value() {
    let tmp = tempfile::tempdir().unwrap();
    let manifest_dir = tmp.path().join("crates/miao-tui");
    std::fs::create_dir_all(&manifest_dir).unwrap();
    std::fs::write(tmp.path().join("package.json"), r#"{"version":"0.3.16"}"#).unwrap();
    assert!(build_version::version(&manifest_dir, Some("9.9.9"))
        .unwrap_err()
        .contains("differs from package.json 0.3.16"));
    assert!(build_version::version(&manifest_dir, Some("")).is_err());
}

#[test]
fn missing_or_invalid_root_versions_fail_explicitly() {
    let tmp = tempfile::tempdir().unwrap();
    let manifest_dir = tmp.path().join("crates/miao-engine");
    std::fs::create_dir_all(&manifest_dir).unwrap();
    assert!(build_version::version(&manifest_dir, None)
        .unwrap_err()
        .contains("cannot read"));
    for value in ["not json", r#"{}"#, r#"{"version":""}"#] {
        std::fs::write(tmp.path().join("package.json"), value).unwrap();
        assert!(build_version::version(&manifest_dir, None).is_err());
    }
}
