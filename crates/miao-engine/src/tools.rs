use crate::{
    file_mutation::{apply, Mutation},
    permission::{digest, Access, Policy},
    process,
    protocol::ToolDefinition,
    search,
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
    #[error("engine storage is a protected resource")]
    ProtectedResource,
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
        if self.name == "start_job" {
            Access::Background
        } else if self.name == "run_command" {
            Access::Execute
        } else if self.name == "write_file" || self.name == "edit_file" {
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
    process_enabled: bool,
    background_enabled: bool,
    process_network: bool,
    runner: Option<Arc<PathBuf>>,
    protected: Vec<PathBuf>,
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
            process_enabled: false,
            background_enabled: false,
            process_network: false,
            runner: None,
            protected: vec![],
        })
    }

    pub fn with_process_runner(mut self, path: PathBuf) -> Self {
        self.runner = Some(Arc::new(path));
        self
    }
    pub(crate) fn with_process(mut self, enabled: bool, network: bool) -> Self {
        self.process_enabled = enabled && self.runner.is_some() && miao_sandbox::supported();
        self.process_network = network;
        self
    }
    pub(crate) fn with_background(mut self, enabled: bool) -> Self {
        self.background_enabled = enabled && self.process_enabled;
        self
    }

    pub fn with_protected_resource(self, path: &Path) -> Self {
        self.protect_store(path)
    }
    pub(crate) fn protect_store(mut self, path: &Path) -> Self {
        self.protected.push(path.to_owned());
        self.protected.push(path.with_extension("engine-lock"));
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            self.protected.push(name.into());
        }
        self
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
            "glob" | "grep" => search::Query::parse(name, input.clone())?.path,
            "start_job" if self.background_enabled => process::Input::parse(input.clone())?.cwd,
            "job_status" | "cancel_job" if self.background_enabled => {
                crate::jobs::Selector::parse(input.clone())?;
                ".".into()
            }
            "run_command" if self.process_enabled => process::Input::parse(input.clone())?.cwd,
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
        if self.protected.contains(&path) {
            return Err(ToolError::ProtectedResource);
        }
        if matches!(name, "run_command" | "start_job" | "glob" | "grep")
            && !tokio::fs::metadata(&path).await?.is_dir()
        {
            return Err(ToolError::InvalidInput);
        }
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| ToolError::OutsideWorkspace)?;
        let parts = relative
            .components()
            .map(|p| p.as_os_str().to_str().ok_or(ToolError::InvalidInput))
            .collect::<Result<Vec<_>, _>>()?;
        let resource = if name == "job_status" || name == "cancel_job" {
            format!(
                "@jobs/{}",
                crate::jobs::Selector::parse(input.clone())?.job_id
            )
        } else if parts.is_empty() {
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

    pub(crate) async fn execute_background(
        &self,
        prepared: Prepared,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if !self.background_enabled || prepared.name != "start_job" {
            return Err(ToolError::Unsupported);
        }
        let current = self
            .prepare(prepared.name(), prepared.input().clone())
            .await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        let runner = self.runner.as_deref().ok_or(ToolError::Unsupported)?;
        process::execute(
            runner,
            &self.root,
            &prepared.path,
            process::Input::parse(prepared.input)?,
            self.process_network,
            cancel,
        )
        .await
    }

    pub(crate) async fn execute_prepared(
        &self,
        prepared: Prepared,
        policy: &Policy,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if prepared.access() == Access::Execute {
            let _lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().write_owned()=>guard};
            let current = self
                .prepare(prepared.name(), prepared.input().clone())
                .await?;
            if current.path != prepared.path || current.resource != prepared.resource {
                return Err(ToolError::ResourceChanged);
            }
            let runner = self.runner.as_deref().ok_or(ToolError::Unsupported)?;
            let input = process::Input::parse(prepared.input)?;
            return process::execute(
                runner,
                &self.root,
                &prepared.path,
                input,
                self.process_network,
                cancel,
            )
            .await;
        }
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
        let read_lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().read_owned()=>guard};
        let current = self
            .prepare(prepared.name(), prepared.input().clone())
            .await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        if prepared.name == "glob" || prepared.name == "grep" {
            let directory = self.directory.clone();
            let workspace = self.root.clone();
            let protected = self.protected.clone();
            let policy = policy.clone();
            let relative = prepared
                .path
                .strip_prefix(&self.root)
                .map_err(|_| ToolError::OutsideWorkspace)?
                .to_owned();
            let query = search::Query::parse(&prepared.name, prepared.input)?;
            return tokio::task::spawn_blocking(move || {
                let _lease = read_lease;
                search::apply(
                    search::Scope {
                        root: &directory,
                        workspace: &workspace,
                        policy: &policy,
                        protected: &protected,
                    },
                    &relative,
                    &prepared.name,
                    query,
                    &cancel,
                )
            })
            .await
            .map_err(|_| ToolError::Io(std::io::Error::other("search worker failed")))?;
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
        definitions.extend([
            ToolDefinition{name:"glob".into(),description:"Find workspace-relative file paths by glob under a directory. No symlink following; generated directories excluded. Per-file permissions and output/traversal budgets apply; truncated reports partial results.".into(),input_schema:json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string","default":"."},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100},"include_hidden":{"type":"boolean"}},"required":["pattern"],"additionalProperties":false})},
            ToolDefinition{name:"grep".into(),description:"Find regex matches in permitted UTF-8 workspace files under a directory. Returns paths, 1-based lines and bounded previews. Optional workspace-relative glob filter. No shell or symlink traversal.".into(),input_schema:json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string","default":"."},"glob":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100},"case_sensitive":{"type":"boolean","default":true},"include_hidden":{"type":"boolean"}},"required":["pattern"],"additionalProperties":false})},
        ]);
        if self.writes {
            definitions.extend([
                ToolDefinition{name:"write_file".into(),description:"Write UTF-8 text (max 32768 bytes) under workspace. expected_sha256=null creates only; existing files require the current SHA-256 from read_file. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"text":{"type":"string"},"expected_sha256":{"type":["string","null"]}},"required":["path","text","expected_sha256"],"additionalProperties":false})},
                ToolDefinition{name:"edit_file".into(),description:"Conditionally replace an exact text match using the SHA-256 from read_file. Ambiguous matches fail unless replace_all=true. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"expected_sha256":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string","expected_sha256"],"additionalProperties":false})},
            ]);
        }
        if self.process_enabled {
            definitions.push(ToolDefinition{name:"run_command".into(),description:"Run an explicit argv in a workspace-write sandbox. Timeout 1..120000 ms; stdout/stderr bounded to 32768 bytes each. No implicit shell and no background lifetime. Requires process permission.".into(),input_schema:json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128},"cwd":{"type":"string","default":"."},"timeout_ms":{"type":"integer","minimum":1,"maximum":120000,"default":10000}},"required":["argv"],"additionalProperties":false})});
        }
        if self.background_enabled {
            let mut start = definitions
                .iter()
                .find(|tool| tool.name == "run_command")
                .expect("background requires process")
                .clone();
            start.name = "start_job".into();
            start.description="Admit a sandboxed foreground-sized command as a background job. Returns queued job_id; the job survives turn cancel, but runtime shutdown cancels it. Existing-file edits must account for external-writer races.".into();
            definitions.push(start);
            for name in ["job_status", "cancel_job"] {
                definitions.push(ToolDefinition{name:name.into(),description:if name=="job_status"{"Inspect this Session's job state and bounded terminal output.".into()}else{"Request cancellation of this Session's active background job.".into()},input_schema:json!({"type":"object","properties":{"job_id":{"type":"string"}},"required":["job_id"],"additionalProperties":false})});
            }
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
