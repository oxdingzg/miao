use cap_std::{ambient_authority, fs::Dir};
use miao_engine::patch::{apply, parse, Input};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Case {
    name: String,
    files: BTreeMap<String, String>,
    patch: String,
    reference: BTreeMap<String, String>,
    contract: Option<Contract>,
}
#[derive(Deserialize)]
struct Contract {
    #[serde(default)]
    reject: bool,
    result: Option<BTreeMap<String, String>>,
    reason: String,
}

#[test]
fn patch_matches_reference_or_explicit_product_contract() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("differential/patch_corpus.json")).unwrap();
    for case in cases {
        let workspace = tempfile::tempdir().unwrap();
        for (path, text) in &case.files {
            let target = workspace.path().join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, text).unwrap();
        }
        let root = Dir::open_ambient_dir(workspace.path(), ambient_authority()).unwrap();
        let actual = parse(&Input { patch: case.patch }).and_then(|ops| apply(&root, &ops));
        let reject = case
            .contract
            .as_ref()
            .is_some_and(|contract| contract.reject);
        if reject {
            assert!(
                actual.is_err(),
                "{}: unsupported syntax was accepted",
                case.name
            );
        } else {
            actual.unwrap_or_else(|error| panic!("{}: {error}", case.name));
        }
        let mut files = BTreeMap::new();
        collect(workspace.path(), workspace.path(), &mut files);
        let expected = if reject {
            &case.files
        } else {
            case.contract
                .as_ref()
                .and_then(|contract| contract.result.as_ref())
                .unwrap_or(&case.reference)
        };
        if let Some(contract) = &case.contract {
            assert!(
                !contract.reason.trim().is_empty(),
                "{}: unnamed difference",
                case.name
            );
        }
        assert_eq!(&files, expected, "{}: observable file outcome", case.name);
    }
}

fn collect(
    root: &std::path::Path,
    directory: &std::path::Path,
    files: &mut BTreeMap<String, String>,
) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            collect(root, &entry.path(), files);
            continue;
        }
        files.insert(
            entry
                .path()
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/"),
            std::fs::read_to_string(entry.path()).unwrap(),
        );
    }
}

#[test]
fn rejected_patches_leave_the_workspace_unchanged() {
    for text in [
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new",
        "*** Begin Patch\n*** Add File: ../escape.txt\n+escape\n*** End Patch",
        "*** Begin Patch\n*** Add File: /escape.txt\n+escape\n*** End Patch",
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
        "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: a.txt\n@@\n-does-not-match\n+new\n*** End Patch",
        "*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: a.txt\n*** End Patch",
    ] {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("a.txt"), "old\n").unwrap();
        let root = Dir::open_ambient_dir(workspace.path(), ambient_authority()).unwrap();
        assert!(parse(&Input { patch: text.into() }).and_then(|ops| apply(&root, &ops)).is_err());
        let mut actual = BTreeMap::new();
        collect(workspace.path(), workspace.path(), &mut actual);
        assert_eq!(actual, BTreeMap::from([("a.txt".into(), "old\n".into())]), "partial effect from {text}");
    }
}
