use crate::{
    file_mutation::{apply, Mutation},
    permission::{digest, Access},
    protocol::ToolDefinition,
};
use cap_std::{ambient_authority, fs::Dir};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;
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
    #[error("resource changed after authorization")]
    ResourceChanged,
    #[error("file content changed or expected fingerprint does not match")]
    StaleFile,
    #[error("old_string is absent or ambiguous; use an exact match or replace_all")]
    AmbiguousEdit,
    #[error("file IO failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {
    #[serde(default = "root_path")]
    path: String,
    #[serde(default = "list_limit")]
    limit: usize,
}
fn root_path() -> String {
    ".".into()
}
fn list_limit() -> usize {
    100
}

pub struct Prepared {
    name: String,
    input: Value,
    path: PathBuf,
    resource: String,
}
impl Prepared {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn input(&self) -> &Value {
        &self.input
    }
    pub fn resource(&self) -> &str {
        &self.resource
    }
    pub fn access(&self) -> Access {
        if self.name == "write_file" || self.name == "edit_file" {
            Access::Write
        } else {
            Access::Read
        }
    }
}

#[derive(Clone)]
pub struct Tools {
    root: PathBuf,
    directory: Arc<Dir>,
    gate: Arc<RwLock<()>>,
    writes: bool,
}

impl Tools {
    pub async fn new(root: impl AsRef<Path>) -> Result<Self, ToolError> {
        let root = tokio::fs::canonicalize(root).await?;
        if !tokio::fs::metadata(&root).await?.is_dir() {
            return Err(ToolError::InvalidInput);
        }
        if root.to_str().is_none() {
            return Err(ToolError::InvalidInput);
        }
        let path = root.clone();
        let directory =
            tokio::task::spawn_blocking(move || Dir::open_ambient_dir(path, ambient_authority()))
                .await
                .map_err(|_| ToolError::Io(std::io::Error::other("directory worker failed")))??;
        Ok(Self {
            root,
            directory: Arc::new(directory),
            gate: Arc::new(RwLock::new(())),
            writes: false,
        })
    }

    pub(crate) fn with_writes(mut self, enabled: bool) -> Self {
        self.writes = enabled;
        self
    }

    pub fn location(&self) -> &str {
        self.root.to_str().expect("validated UTF-8 Location")
    }

    pub async fn prepare(&self, name: &str, input: Value) -> Result<Prepared, ToolError> {
        let path = match name {
            "read_file" => {
                serde_json::from_value::<ReadInput>(input.clone())
                    .map_err(|_| ToolError::InvalidInput)?
                    .path
            }
            "list_files" => {
                let parsed = serde_json::from_value::<ListInput>(input.clone())
                    .map_err(|_| ToolError::InvalidInput)?;
                if !(1..=500).contains(&parsed.limit) {
                    return Err(ToolError::InvalidInput);
                }
                parsed.path
            }
            "write_file" | "edit_file" if self.writes => {
                Mutation::parse(name, input.clone())?.path().to_owned()
            }
            _ => return Err(ToolError::Unsupported),
        };
        let path = if name == "write_file" || name == "edit_file" {
            let candidate = self.root.join(&path);
            if let Ok(metadata) = tokio::fs::symlink_metadata(&candidate).await {
                if metadata.file_type().is_symlink() {
                    return Err(ToolError::ResourceChanged);
                }
            }
            let parent =
                tokio::fs::canonicalize(candidate.parent().ok_or(ToolError::InvalidInput)?).await?;
            if !parent.starts_with(&self.root) {
                return Err(ToolError::OutsideWorkspace);
            }
            parent.join(candidate.file_name().ok_or(ToolError::InvalidInput)?)
        } else {
            self.contained(&path).await?
        };
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| ToolError::OutsideWorkspace)?;
        let parts = relative
            .components()
            .map(|p| p.as_os_str().to_str().ok_or(ToolError::InvalidInput))
            .collect::<Result<Vec<_>, _>>()?;
        let resource = if parts.is_empty() {
            ".".into()
        } else {
            parts.join("/")
        };
        Ok(Prepared {
            name: name.into(),
            input,
            path,
            resource,
        })
    }

    pub(crate) async fn execute_prepared(
        &self,
        prepared: Prepared,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if prepared.access() == Access::Write {
            let lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().write_owned()=>guard};
            let current = self
                .prepare(prepared.name(), prepared.input().clone())
                .await?;
            if current.path != prepared.path || current.resource != prepared.resource {
                return Err(ToolError::ResourceChanged);
            }
            if cancel.is_cancelled() {
                return Err(ToolError::Interrupted);
            }
            let directory = self.directory.clone();
            let relative = prepared
                .path
                .strip_prefix(&self.root)
                .map_err(|_| ToolError::OutsideWorkspace)?
                .to_owned();
            let mutation = Mutation::parse(&prepared.name, prepared.input)?;
            // A started commit is not dropped on cancellation. Its actual result
            // settles durably before the coordinator announces interruption.
            return tokio::task::spawn_blocking(move || {
                let _lease = lease;
                apply(&directory, &relative, mutation)
            })
            .await
            .map_err(|_| ToolError::Io(std::io::Error::other("file commit worker failed")))?;
        }
        let _lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().read_owned()=>guard};
        let current = self
            .prepare(prepared.name(), prepared.input().clone())
            .await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        self.execute(&prepared.name, prepared.input, cancel).await
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions=vec![ToolDefinition {
            name:"read_file".into(),
            description:"Read a UTF-8 file under the configured workspace. Maximum 32768 bytes.".into(),
            input_schema:json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
        },ToolDefinition {
            name:"list_files".into(),
            description:"List immediate entries of a workspace directory. Does not recurse or follow symlinks; output is bounded.".into(),
            input_schema:json!({"type":"object","properties":{"path":{"type":"string","default":"."},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}},"additionalProperties":false}),
        }];
        if self.writes {
            definitions.extend([
                ToolDefinition{name:"write_file".into(),description:"Write UTF-8 text (max 32768 bytes) under workspace. expected_sha256=null creates only; existing files require the current SHA-256 from read_file. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"text":{"type":"string"},"expected_sha256":{"type":["string","null"]}},"required":["path","text","expected_sha256"],"additionalProperties":false})},
                ToolDefinition{name:"edit_file".into(),description:"Conditionally replace an exact text match using the SHA-256 from read_file. Ambiguous matches fail unless replace_all=true. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"expected_sha256":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string","expected_sha256"],"additionalProperties":false})},
            ]);
        }
        definitions
    }

    async fn contained(&self, path: &str) -> Result<PathBuf, ToolError> {
        let path = tokio::fs::canonicalize(self.root.join(path)).await?;
        if !path.starts_with(&self.root) {
            return Err(ToolError::OutsideWorkspace);
        }
        Ok(path)
    }

    /// Read-only tools use canonical containment, not an OS sandbox. They do
    /// not promise safety against adversarial concurrent path replacement.
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let task = async {
            match name {
                "read_file" => {
                    let input: ReadInput =
                        serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                    let path = self.contained(&input.path).await?;
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
                    let sha256 = digest(&bytes);
                    let text = String::from_utf8(bytes).map_err(|_| ToolError::InvalidFile)?;
                    Ok(json!({"text":text,"sha256":sha256}))
                }
                "list_files" => {
                    let input: ListInput =
                        serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                    if !(1..=500).contains(&input.limit) {
                        return Err(ToolError::InvalidInput);
                    }
                    let path = self.contained(&input.path).await?;
                    let mut directory = tokio::fs::read_dir(path).await?;
                    let mut entries = Vec::new();
                    let mut truncated = false;
                    while let Some(entry) = directory.next_entry().await? {
                        if entries.len() == input.limit {
                            truncated = true;
                            break;
                        }
                        let kind = entry.file_type().await?;
                        entries.push(json!({"name":entry.file_name().to_string_lossy(),"kind":if kind.is_symlink(){"symlink"}else if kind.is_dir(){"directory"}else if kind.is_file(){"file"}else{"other"}}));
                    }
                    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                    Ok(json!({"entries":entries,"truncated":truncated}))
                }
                _ => Err(ToolError::Unsupported),
            }
        };
        tokio::select! {_=cancel.cancelled()=>Err(ToolError::Interrupted),result=task=>result}
    }
}
