use miao_engine::tools::{ToolError, Tools};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn read_is_bounded_and_cannot_escape_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("file"), "hello").unwrap();
    std::fs::write(dir.path().join("outside"), "secret").unwrap();
    std::fs::write(root.join("large"), vec![b'x'; 32769]).unwrap();
    std::fs::write(root.join("binary"), [0xff]).unwrap();
    let tools = Tools::new(&root).await.unwrap();
    assert_eq!(
        tools
            .execute(
                "read_file",
                json!({"path":"file"}),
                CancellationToken::new()
            )
            .await
            .unwrap()["text"],
        "hello"
    );
    assert!(matches!(
        tools
            .execute(
                "read_file",
                json!({"path":"../outside"}),
                CancellationToken::new()
            )
            .await,
        Err(ToolError::OutsideWorkspace)
    ));
    for file in ["large", "binary"] {
        assert!(matches!(
            tools
                .execute("read_file", json!({"path":file}), CancellationToken::new())
                .await,
            Err(ToolError::InvalidFile)
        ));
    }
    assert!(matches!(
        tools
            .execute("bash", json!({}), CancellationToken::new())
            .await,
        Err(ToolError::Unsupported)
    ));
    assert!(matches!(
        tools
            .execute(
                "read_file",
                json!({"path":"file","extra":true}),
                CancellationToken::new()
            )
            .await,
        Err(ToolError::InvalidInput)
    ));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("outside"), root.join("link")).unwrap();
        assert!(matches!(
            tools
                .execute(
                    "read_file",
                    json!({"path":"link"}),
                    CancellationToken::new()
                )
                .await,
            Err(ToolError::OutsideWorkspace)
        ));
    }
}
