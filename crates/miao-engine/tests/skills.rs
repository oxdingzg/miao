use miao_engine::{
    context::{self, SkillDirectory},
    permission::{Config, Decision, Mode, Policy, Rule},
    tools::Tools,
};
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

async fn assemble(root: &std::path::Path) -> miao_engine::protocol::ContextBundle {
    let tools = Tools::new(root)
        .await
        .unwrap()
        .with_skill_directories(vec![SkillDirectory {
            path: ".miao/skills".into(),
        }])
        .unwrap();
    context::assemble(&tools, &policy(), CancellationToken::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn skills_are_listed_by_name_and_description_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".miao/skills/review")).unwrap();
    std::fs::write(
        root.join(".miao/skills/top.md"),
        "---\nname: top-skill\ndescription: Does top things\n---\nsecret body top\n",
    )
    .unwrap();
    std::fs::write(
        root.join(".miao/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Reviews code\n---\nsecret body review\n",
    )
    .unwrap();
    // A non-SKILL.md below the root is not a skill; a nested SKILL.md is.
    std::fs::write(
        root.join(".miao/skills/review/notes.md"),
        "no frontmatter\n",
    )
    .unwrap();

    let bundle = assemble(root).await;
    assert!(
        bundle.system.contains("<available-skills>"),
        "{}",
        bundle.system
    );
    assert!(bundle.system.contains("top-skill"));
    assert!(bundle.system.contains("Does top things"));
    assert!(bundle.system.contains("review"));
    assert!(bundle.system.contains("Reviews code"));
    // Bodies are not injected; only the metadata list is.
    assert!(!bundle.system.contains("secret body"));
    assert!(!bundle.system.contains("notes.md"));
    let registered = bundle
        .sources
        .iter()
        .filter(|source| source["type"] == "skill")
        .count();
    assert_eq!(registered, 2);
    assert!(bundle
        .sources
        .iter()
        .any(|source| source["type"] == "skill" && source["name"] == "review"));
}

#[tokio::test]
async fn a_skill_without_frontmatter_falls_back_to_its_directory_name() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".miao/skills/deploy")).unwrap();
    std::fs::write(root.join(".miao/skills/deploy/SKILL.md"), "just a body\n").unwrap();
    let bundle = assemble(root).await;
    assert!(
        bundle
            .system
            .contains("- deploy:  (.miao/skills/deploy/SKILL.md)"),
        "{}",
        bundle.system
    );
}

#[tokio::test]
async fn invalid_skill_directories_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let relative = Tools::new(dir.path())
        .await
        .unwrap()
        .with_skill_directories(vec![SkillDirectory {
            path: "../escape".into(),
        }]);
    assert!(relative.is_err());
    let absolute = Tools::new(dir.path())
        .await
        .unwrap()
        .with_skill_directories(vec![SkillDirectory {
            path: "/absolute".into(),
        }]);
    assert!(
        absolute.is_ok(),
        "absolute declarations are checked against reference authority during assembly"
    );
}

#[tokio::test]
async fn host_skill_metadata_requires_directory_authority_and_per_file_policy() {
    use miao_engine::context::Reference;
    let workspace = tempfile::tempdir().unwrap();
    let global = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(global.path().join("review")).unwrap();
    let file = global.path().join("review/SKILL.md");
    std::fs::write(
        &file,
        "---\nname: global-review\ndescription: Host authorized review\n---\nPRIVATE_SKILL_BODY\n",
    )
    .unwrap();
    for (grant, directory_rule, file_rule, expected) in [
        (None, Decision::Allow, Decision::Allow, false),
        (Some(file.clone()), Decision::Allow, Decision::Allow, false),
        (
            Some(global.path().to_owned()),
            Decision::Ask,
            Decision::Allow,
            false,
        ),
        (
            Some(global.path().to_owned()),
            Decision::Deny,
            Decision::Allow,
            false,
        ),
        (
            Some(global.path().to_owned()),
            Decision::Allow,
            Decision::Ask,
            false,
        ),
        (
            Some(global.path().to_owned()),
            Decision::Allow,
            Decision::Deny,
            false,
        ),
        (
            Some(global.path().to_owned()),
            Decision::Allow,
            Decision::Allow,
            true,
        ),
    ] {
        let tools = Tools::new(workspace.path())
            .await
            .unwrap()
            .with_skill_directories(vec![SkillDirectory {
                path: global.path().to_string_lossy().into_owned(),
            }])
            .unwrap();
        let tools = tools
            .with_references(
                grant
                    .into_iter()
                    .map(|path| Reference {
                        path: path.to_string_lossy().into_owned(),
                        description: "Host skill authority".into(),
                    })
                    .collect(),
            )
            .unwrap();
        let policy = Policy::new(Config {
            rules: vec![
                Rule {
                    tool: "glob".into(),
                    path: "@reference/**".into(),
                    decision: directory_rule,
                },
                Rule {
                    tool: "read_file".into(),
                    path: "@reference/**".into(),
                    decision: file_rule,
                },
            ],
            ..Config::default()
        })
        .unwrap();
        let bundle = context::assemble(&tools, &policy, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(bundle.system.contains("global-review"), expected);
        assert!(!bundle.system.contains("PRIVATE_SKILL_BODY"));
        if expected {
            let source = bundle
                .sources
                .iter()
                .find(|source| source["type"] == "skill" && source["name"] == "global-review")
                .unwrap();
            assert!(std::path::Path::new(source["path"].as_str().unwrap()).is_absolute());
            let body = tools
                .execute(
                    "read_file",
                    serde_json::json!({"path":source["path"]}),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert!(body["text"]
                .as_str()
                .unwrap()
                .contains("PRIVATE_SKILL_BODY"));
        }
    }
}

#[tokio::test]
async fn workspace_skill_file_denials_also_hide_frontmatter() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("skills")).unwrap();
    std::fs::write(
        root.path().join("skills/private.md"),
        "---\nname: hidden-skill\ndescription: hidden metadata\n---\nbody\n",
    )
    .unwrap();
    let tools = Tools::new(root.path())
        .await
        .unwrap()
        .with_skill_directories(vec![SkillDirectory {
            path: "skills".into(),
        }])
        .unwrap();
    let policy = Policy::new(Config {
        rules: vec![Rule {
            tool: "read_file".into(),
            path: "skills/**".into(),
            decision: Decision::Deny,
        }],
        ..Config::default()
    })
    .unwrap();
    let bundle = context::assemble(&tools, &policy, CancellationToken::new())
        .await
        .unwrap();
    assert!(!bundle.system.contains("hidden-skill"));
    assert!(!bundle.system.contains("hidden metadata"));
}
