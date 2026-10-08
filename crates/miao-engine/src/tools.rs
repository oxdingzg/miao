use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("interrupted")]
    Interrupted,
    #[error("invalid tool input")]
    InvalidInput,
    #[error("tool is not available")]
    Unsupported,
    #[error("path is outside the configured workspace")]
    OutsideWorkspace,
    #[error("file must be regular UTF-8 text of at most 32768 bytes")]
    InvalidFile,
    #[error("file IO failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    path: String,
}

#[derive(Clone)]
pub struct Tools {
    root: PathBuf,
}

impl Tools {
    pub async fn new(root: impl AsRef<Path>) -> Result<Self, ToolError> {
        let root = tokio::fs::canonicalize(root).await?;
        if !tokio::fs::metadata(&root).await?.is_dir() {
            return Err(ToolError::InvalidInput);
        }
        Ok(Self { root })
    }

    /// M0 only exposes read_file. No shell or filesystem mutation is silently
    /// authorized. Canonical containment handles ordinary traversal/symlinks,
    /// not adversarial concurrent filesystem replacement (OS isolation is M1).
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if name != "read_file" {
            return Err(ToolError::Unsupported);
        }
        let input: ReadInput =
            serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        let read = async {
            let path = tokio::fs::canonicalize(self.root.join(&input.path)).await?;
            if !path.starts_with(&self.root) {
                return Err(ToolError::OutsideWorkspace);
            }
            let file = tokio::fs::File::open(&path).await?;
            let metadata = file.metadata().await?;
            if !metadata.is_file() || metadata.len() > 32768 {
                return Err(ToolError::InvalidFile);
            }
            let mut bytes = Vec::new();
            file.take(32769).read_to_end(&mut bytes).await?;
            if bytes.len() > 32768 {
                return Err(ToolError::InvalidFile);
            }
            let text = String::from_utf8(bytes).map_err(|_| ToolError::InvalidFile)?;
            Ok(json!({"text":text}))
        };
        tokio::select! {
            _ = cancel.cancelled() => Err(ToolError::Interrupted),
            result=read => result,
        }
    }
}
