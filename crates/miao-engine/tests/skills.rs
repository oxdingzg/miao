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
    assert!(absolute.is_err());
}
