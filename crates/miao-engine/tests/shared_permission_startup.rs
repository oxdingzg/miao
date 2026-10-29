use miao_engine::{permission_project::Authority, permission_source::Target, store::Store};
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn engine(args: &[&str], frames: &[Value]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_miao-engine"));
    command
        .args(args)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("GEMINI_API_KEY")
        .env_remove("OPENAI_API_KEY");
    if args.first() == Some(&"serve") {
        command.env("OPENAI_API_KEY", "fixture-only");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for frame in frames {
        writeln!(input, "{frame}").unwrap();
    }
    let output = child.wait_with_output().unwrap();
    drop(input);
    output
}

#[tokio::test]
async fn model_free_source_initialization_creates_no_session_or_provider_work() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("source.db");
    let output = engine(
        &[
            "permission-source-init",
            "--db",
            db.to_str().unwrap(),
            "--project",
            "fixture",
            "--directory",
            directory.path().to_str().unwrap(),
        ],
        &[
            json!({"id":1,"method":"binding"}),
            json!({"id":2,"method":"snapshot"}),
            json!({"id":3,"method":"shutdown"}),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames[0]["result"]["project"], "fixture");
    assert_eq!(frames[1]["result"], Value::Null);
    let store = Store::open(&db).await.unwrap();
    assert!(store.sessions().await.unwrap().is_empty());
    assert!(store
        .directory_permission_source(
            directory
                .path()
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .into()
        )
        .await
        .unwrap()
        .is_none());
    store.close().await.unwrap();
}

#[test]
fn existing_source_control_still_refuses_a_missing_file_and_invalid_bootstrap_creates_nothing() {
    let directory = tempfile::tempdir().unwrap();
    for (command, workspace) in [
        ("permission-source", directory.path().to_path_buf()),
        (
            "permission-source-init",
            directory.path().join("missing-directory"),
        ),
    ] {
        let db = directory.path().join(format!("{command}.db"));
        let output = engine(
            &[
                command,
                "--db",
                db.to_str().unwrap(),
                "--project",
                "fixture",
                "--directory",
                workspace.to_str().unwrap(),
            ],
            &[],
        );
        assert!(!output.status.success());
        assert!(!db.exists());
    }
}

#[tokio::test]
async fn explicit_cli_selection_opens_the_completed_pair_and_rejects_legacy_projection() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let db = directory.path().join("source.db");
    let root = directory.path().join("permissions.db");
    let store = Store::open(&db).await.unwrap();
    let project = Authority::open(&root)
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap();
    let identity = project.snapshot().await.unwrap().authority;
    project.handoff(identity.clone(), vec![]).await.unwrap();
    let context = project.context(&workspace, None).await.unwrap();
    let prepared = store
        .prepare_directory_permission_source(
            workspace.to_str().unwrap().into(),
            Target {
                authority: identity.clone(),
                project: "fixture".into(),
                directory: workspace.to_str().unwrap().into(),
                workspace_id: None,
            },
        )
        .await
        .unwrap();
    let imported = context
        .handoff(identity.clone(), prepared.patterns)
        .await
        .unwrap();
    store
        .complete_directory_permission_source(imported.directory.clone(), imported)
        .await
        .unwrap();
    let agent = directory.path().join("agent.json");
    std::fs::write(
        &agent,
        serde_json::to_vec(
            &json!({"name":"shared-startup-reviewer","semantics":"product-agent-v1"}),
        )
        .unwrap(),
    )
    .unwrap();
    let output = engine(
        &[
            "serve",
            "--db",
            db.to_str().unwrap(),
            "--workspace",
            workspace.to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            "http://127.0.0.1:9",
            "--agent-config",
            agent.to_str().unwrap(),
            "--permission-root-db",
            root.to_str().unwrap(),
            "--permission-project",
            "fixture",
        ],
        &[
            json!({"id":1,"method":"shared_permission_snapshot"}),
            json!({"id":2,"method":"permission_saved_snapshot","params":{"workspace":workspace,"rules":[]}}),
            json!({"id":3,"method":"admit","params":{"input":{"session_id":"startup","input_id":"startup-input","prompt":"admit only","delivery":"steer"},"resume":false}}),
            json!({"id":4,"method":"shutdown"}),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let snapshot = frames.iter().find(|frame| frame["id"] == 1).unwrap();
    assert_eq!(
        snapshot["result"]["snapshot"]["project"]["authority"], identity,
        "{frames:?}"
    );
    assert_eq!(snapshot["result"]["cursor"]["authority"], identity);
    assert!(
        frames
            .iter()
            .find(|frame| frame["id"] == 2)
            .unwrap()
            .get("error")
            .is_some(),
        "{frames:?}"
    );
    assert!(
        frames
            .iter()
            .find(|frame| frame["id"] == 3)
            .unwrap()
            .get("error")
            .is_none(),
        "{frames:?}"
    );
    assert_eq!(
        store.agent("startup").await.unwrap().unwrap().0.name,
        "shared-startup-reviewer"
    );
    assert!(store.active_run("startup").await.unwrap().is_none());
    assert!(!store
        .events("startup", 0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == "provider.request"));
    store.close().await.unwrap();
}

#[tokio::test]
async fn shared_cli_never_falls_back_to_an_uncompleted_legacy_source() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let db = directory.path().join("source.db");
    let root = directory.path().join("permissions.db");
    let store = Store::open(&db).await.unwrap();
    let project = Authority::open(&root)
        .await
        .unwrap()
        .project("fixture".into())
        .unwrap();
    let snapshot = project.snapshot().await.unwrap();
    project.handoff(snapshot.authority, vec![]).await.unwrap();
    let output = engine(
        &[
            "serve",
            "--db",
            db.to_str().unwrap(),
            "--workspace",
            workspace.to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            "http://127.0.0.1:9",
            "--permission-root-db",
            root.to_str().unwrap(),
            "--permission-project",
            "fixture",
        ],
        &[],
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("handoff is missing"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(store.sessions().await.unwrap().is_empty());
    store.close().await.unwrap();
}
