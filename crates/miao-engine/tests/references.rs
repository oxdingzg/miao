use miao_engine::{
    context::{self, Reference},
    permission::{Config, Decision, Mode, Policy, Rule},
    tools::{ToolError, Tools},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

#[tokio::test]
async fn references_are_listed_and_readable_but_not_writable() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let doc = external.path().join("doc.md");
    std::fs::write(&doc, "external doc content").unwrap();

    let tools = Tools::new(workspace.path())
        .await
        .unwrap()
        .with_references(vec![Reference {
            path: external.path().to_string_lossy().into_owned(),
            description: "External docs".into(),
        }])
        .unwrap();

    // The system context lists the reference and its path.
    let bundle = context::assemble(&tools, &policy(), CancellationToken::new())
        .await
        .unwrap();
    assert!(
        bundle.system.contains("<available-references>"),
        "{}",
        bundle.system
    );
    assert!(bundle.system.contains("External docs"));
    assert!(bundle.system.contains(external.path().to_str().unwrap()));
    assert!(bundle
        .sources
        .iter()
        .any(|source| source["type"] == "reference" && source["status"] == "authorized"));

    // A file under the reference is readable by its absolute path.
    let read = tools
        .execute(
            "read_file",
            json!({"path": doc.to_string_lossy()}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read["text"], "external doc content");

    // A path outside the workspace and outside every reference stays rejected.
    let stranger = tempfile::tempdir().unwrap();
    let es = stranger.path().join("secret.txt");
    std::fs::write(&es, "no").unwrap();
    assert!(matches!(
        tools
            .execute(
                "read_file",
                json!({"path": es.to_string_lossy()}),
                CancellationToken::new(),
            )
            .await,
        Err(ToolError::OutsideWorkspace)
    ));
}

#[tokio::test]
async fn a_reference_does_not_grant_writes() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let target = external.path().join("new.txt");
    let tools = Tools::new(workspace.path())
        .await
        .unwrap()
        .with_references(vec![Reference {
            path: external.path().to_string_lossy().into_owned(),
            description: "External docs".into(),
        }])
        .unwrap()
        .with_writes(true);
    // Preparing a write to the reference directory is refused: references are
    // read-only roots, not writable ones.
    assert!(tools
        .prepare(
            "write_file",
            json!({"path": target.to_string_lossy(), "text": "x", "expected_sha256": null}),
        )
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_references_are_rejected() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = Tools::new(workspace.path()).await.unwrap();
    assert!(tools
        .with_references(vec![Reference {
            path: workspace.path().to_string_lossy().into_owned(),
            description: "  ".into(),
        }])
        .is_err());
}
