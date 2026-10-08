use miao_engine::tools::{ToolError, Tools};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn directory_catalog_and_execution_have_bounded_workspace_scope() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("subdir")).unwrap();
    std::fs::write(root.join("file"), "hello").unwrap();
    let tools = Tools::new(&root).await.unwrap();
    assert_eq!(
        tools
            .definitions()
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        vec!["read_file", "list_files", "glob", "grep", "recall"]
    );
    let result = tools
        .execute("list_files", json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 2);
    assert_eq!(result["truncated"], false);
    assert_eq!(result["entries"][0]["name"], "file");
    let result = tools
        .execute("list_files", json!({"limit":1}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["truncated"], true);
    assert!(matches!(
        tools
            .execute("list_files", json!({"path":".."}), CancellationToken::new())
            .await,
        Err(ToolError::OutsideWorkspace)
    ));
    assert!(matches!(
        tools
            .execute("list_files", json!({"limit":501}), CancellationToken::new())
            .await,
        Err(ToolError::InvalidInput)
    ));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path(), root.join("outside")).unwrap();
        let result = tools
            .execute("list_files", json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert!(result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "outside" && e["kind"] == "symlink"));
        assert!(matches!(
            tools
                .execute(
                    "list_files",
                    json!({"path":"outside"}),
                    CancellationToken::new()
                )
                .await,
            Err(ToolError::OutsideWorkspace)
        ));
    }
}
