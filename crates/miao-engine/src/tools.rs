use crate::{
    edit_recovery::Snapshots,
    file_mutation::{apply, Mutation},
    mcp,
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
    #[error("external tool: {0}")]
    External(String),
    #[error("context exceeds 64 KiB budget")]
    ContextBudget,
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
    #[error("the file drifted since the read and recovery was {0}")]
    StaleEditRecovery(&'static str),
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
struct SkillInput {
    name: String,
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
    /// Workspace-relative paths a multi-file tool touches. Every entry is
    /// evaluated against policy; a single deny rejects the whole call.
    targets: Vec<String>,
    access: Access,
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
    pub fn targets(&self) -> &[String] {
        &self.targets
    }
    pub fn access(&self) -> Access {
        self.access
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
    delegation_enabled: bool,
    wakeup_enabled: bool,
    cron_enabled: bool,
    process_network: bool,
    runner: Option<Arc<PathBuf>>,
    protected: Vec<PathBuf>,
    private_store: Option<PathBuf>,
    mcp: Option<Arc<mcp::Registry>>,
    worker: Option<Arc<crate::worker::Registry>>,
    lsp: Option<Arc<crate::lsp::Registry>>,
    context_sources: Arc<Vec<crate::context::Source>>,
    skill_directories: Arc<Vec<crate::context::SkillDirectory>>,
    references: Arc<Vec<crate::context::Reference>>,
    read_roots: Arc<Vec<std::path::PathBuf>>,
    hooks: Arc<Vec<crate::hooks::Hook>>,
    edit_snapshots: Arc<std::sync::Mutex<Snapshots>>,
    edit_recovery: bool,
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
            delegation_enabled: false,
            wakeup_enabled: false,
            cron_enabled: false,
            process_network: false,
            runner: None,
            protected: vec![],
            private_store: None,
            mcp: None,
            worker: None,
            lsp: None,
            context_sources: Arc::new(vec![]),
            skill_directories: Arc::new(vec![]),
            references: Arc::new(vec![]),
            read_roots: Arc::new(vec![]),
            hooks: Arc::new(vec![]),
            edit_snapshots: Arc::new(std::sync::Mutex::new(Snapshots::new())),
            edit_recovery: true,
        })
    }

    pub fn with_process_runner(mut self, path: PathBuf) -> Self {
        self.runner = Some(Arc::new(path));
        self
    }
    pub(crate) async fn start_terminal(
        &self,
        registry: &crate::terminal::Registry,
        session: &str,
        prepared: Prepared,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let _lease = tokio::select! { _ = cancel.cancelled() => return Err(ToolError::Interrupted), lease = self.gate.write() => lease };
        let current = self
            .prepare(prepared.name(), prepared.input().clone())
            .await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        registry
            .start(
                session,
                self.runner.as_deref().ok_or(ToolError::Unsupported)?,
                &self.root,
                &prepared.path,
                crate::terminal::Start::parse(prepared.input)?,
                self.process_network,
            )
            .await
    }
    pub(crate) fn with_process(mut self, enabled: bool, network: bool) -> Self {
        self.process_enabled = enabled && self.runner.is_some() && process::enforced();
        self.process_network = network;
        self
    }
    pub fn with_context_sources(
        mut self,
        sources: Vec<crate::context::Source>,
    ) -> Result<Self, ToolError> {
        crate::context::validate(&sources)?;
        self.context_sources = Arc::new(sources);
        Ok(self)
    }
    fn patch_input(name: &str, input: Value) -> Result<crate::patch::Input, ToolError> {
        if name != "apply_patch" {
            return Err(ToolError::Unsupported);
        }
        serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)
    }
    pub fn with_hooks(mut self, hooks: Vec<crate::hooks::Hook>) -> Result<Self, ToolError> {
        crate::hooks::validate(&hooks)?;
        self.hooks = Arc::new(hooks);
        Ok(self)
    }
    pub(crate) fn hooks(&self) -> &[crate::hooks::Hook] {
        &self.hooks
    }
    pub(crate) async fn run_hook(
        &self,
        hook: &crate::hooks::Hook,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let runner = self.runner.as_deref().ok_or(ToolError::Unsupported)?;
        let mut input = hook.input()?;
        input.cwd = ".".into();
        process::execute(runner, &self.root, &self.root, input, false, cancel).await
    }

    pub fn with_skill_directories(
        mut self,
        directories: Vec<crate::context::SkillDirectory>,
    ) -> Result<Self, ToolError> {
        crate::context::validate_skills(&directories)?;
        self.skill_directories = Arc::new(directories);
        Ok(self)
    }

    pub fn with_references(
        mut self,
        references: Vec<crate::context::Reference>,
    ) -> Result<Self, ToolError> {
        crate::context::validate_references(&references)?;
        let mut roots = Vec::new();
        for reference in &references {
            let canonical =
                std::fs::canonicalize(&reference.path).map_err(|_| ToolError::InvalidInput)?;
            let root = if canonical.is_dir() {
                canonical
            } else {
                canonical
                    .parent()
                    .ok_or(ToolError::InvalidInput)?
                    .to_owned()
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        self.references = Arc::new(references);
        self.read_roots = Arc::new(roots);
        Ok(self)
    }

    /// Snapshot the immutable capability/boundary closure used by prepare and
    /// dispatch, not a caller-supplied declaration of intended permissions.
    pub(crate) fn authority_descriptor(&self) -> Value {
        json!({"semantics":"native-tool-boundary-v1","workspace":self.root,"protected":self.protected.iter().map(|path| {
                // The native database and its companions have explicit private
                // storage identities. Replay changes their filenames, not the
                // authority to access them. Other protected paths remain exact.
                if let Some(store) = &self.private_store {
                    if path == store { return json!({"privateStorage":"database"}); }
                    if path == &store.with_extension("engine-lock") { return json!({"privateStorage":"lock"}); }
                    for suffix in ["-wal", "-shm"] {
                        let mut name = store.as_os_str().to_owned(); name.push(suffix);
                        if path == &PathBuf::from(name) { return json!({"privateStorage":suffix}); }
                    }
                }
                json!({"path":path})
            }).collect::<Vec<_>>(),
            "readRoots":self.read_roots.as_ref(),"writes":self.writes,"process":self.process_enabled,
            "background":self.background_enabled,"delegation":self.delegation_enabled,
            "wakeup":self.wakeup_enabled,"cron":self.cron_enabled,"processNetwork":self.process_network,
            "processRunnerConfigured":self.runner.is_some(),"mcpAttached":self.mcp.is_some(),
            "workerAttached":self.worker.is_some(),"lspAttached":self.lsp.is_some()})
    }
    pub(crate) fn references(&self) -> &[crate::context::Reference] {
        &self.references
    }

    pub(crate) fn skill_directories(&self) -> &[crate::context::SkillDirectory] {
        &self.skill_directories
    }

    pub(crate) fn context_sources(&self) -> std::slice::Iter<'_, crate::context::Source> {
        self.context_sources.iter()
    }

    pub fn with_mcp(mut self, registry: Arc<mcp::Registry>) -> Self {
        self.mcp = Some(registry);
        self
    }
    pub fn with_lsp(mut self, registry: Arc<crate::lsp::Registry>) -> Self {
        self.lsp = Some(registry);
        self
    }
    pub(crate) fn has_mcp(&self) -> bool {
        self.mcp.is_some()
    }
    pub fn with_worker(mut self, registry: Arc<crate::worker::Registry>) -> Self {
        self.worker = Some(registry);
        self
    }
    pub(crate) async fn shutdown_extensions(&self) {
        if let Some(registry) = &self.mcp {
            registry.shutdown().await;
        }
        if let Some(registry) = &self.worker {
            registry.shutdown().await;
        }
        if let Some(registry) = &self.lsp {
            registry.shutdown().await;
        }
    }

    pub(crate) fn with_cron(mut self, enabled: bool) -> Self {
        self.cron_enabled = enabled;
        self
    }

    pub(crate) fn with_wakeup(mut self, enabled: bool) -> Self {
        self.wakeup_enabled = enabled;
        self
    }

    pub(crate) fn with_background(mut self, enabled: bool) -> Self {
        self.background_enabled = enabled && self.process_enabled;
        self
    }

    pub(crate) fn with_delegation(mut self, enabled: bool) -> Self {
        self.delegation_enabled = enabled;
        self
    }

    pub fn with_protected_resource(self, path: &Path) -> Self {
        self.protect_resource(path)
    }
    pub(crate) fn protect_store(mut self, path: &Path) -> Self {
        self.private_store = Some(path.to_owned());
        self.protect_resource(path)
    }
    fn protect_resource(mut self, path: &Path) -> Self {
        self.protected.push(path.to_owned());
        self.protected.push(path.with_extension("engine-lock"));
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            self.protected.push(name.into());
        }
        self
    }

    pub fn with_writes(mut self, enabled: bool) -> Self {
        self.writes = enabled;
        self
    }

    /// Evaluation ablation switch: `false` disables stale-edit recovery while
    /// keeping every other path identical.
    pub fn with_edit_recovery(mut self, enabled: bool) -> Self {
        self.edit_recovery = enabled;
        self
    }

    pub fn location(&self) -> &str {
        self.root.to_str().expect("validated UTF-8 Location")
    }

    pub async fn prepare(&self, name: &str, input: Value) -> Result<Prepared, ToolError> {
        if let Some(registry) = &self.mcp {
            if let Some(resource) = registry.resource(name) {
                registry.validate(name, &input)?;
                return Ok(Prepared {
                    name: name.into(),
                    input,
                    path: self.root.clone(),
                    resource,
                    targets: Vec::new(),
                    access: Access::External,
                });
            }
        }
        if let Some(registry) = &self.worker {
            if let Some(resource) = registry.resource(name) {
                registry.validate(name, &input)?;
                return Ok(Prepared {
                    name: name.into(),
                    input,
                    path: self.root.clone(),
                    resource,
                    targets: Vec::new(),
                    access: Access::External,
                });
            }
        }
        let path = match name {
            "read_file" | "read_image" => {
                serde_json::from_value::<ReadInput>(input.clone())
                    .map_err(|_| ToolError::InvalidInput)?
                    .path
            }
            "load_skill" => {
                let parsed: SkillInput =
                    serde_json::from_value(input.clone()).map_err(|_| ToolError::InvalidInput)?;
                if parsed.name != "media-observe" {
                    return Err(ToolError::InvalidInput);
                }
                ".".into()
            }
            "list_files" => {
                let parsed = serde_json::from_value::<ListInput>(input.clone())
                    .map_err(|_| ToolError::InvalidInput)?;
                if !(1..=500).contains(&parsed.limit) {
                    return Err(ToolError::InvalidInput);
                }
                parsed.path
            }
            "cron_create" if self.cron_enabled => {
                crate::cron::Input::parse(input.clone())?;
                ".".into()
            }
            "cron_delete" if self.cron_enabled => {
                crate::cron::Selector::parse(input.clone())?;
                ".".into()
            }
            "cron_list" if self.cron_enabled => {
                if input != json!({}) {
                    return Err(ToolError::InvalidInput);
                }
                ".".into()
            }
            "schedule_wakeup" if self.wakeup_enabled => {
                crate::wakeup::Input::parse(input.clone())?;
                ".".into()
            }
            "cancel_wakeup" if self.wakeup_enabled => {
                crate::wakeup::Selector::parse(input.clone())?;
                ".".into()
            }
            "question" => {
                crate::question::Input::parse(input.clone())?;
                ".".into()
            }
            "session_state" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Empty {}
                let _: Empty =
                    serde_json::from_value(input.clone()).map_err(|_| ToolError::InvalidInput)?;
                ".".into()
            }
            "todowrite" | "goal" => {
                crate::state::Mutation::parse(name, input.clone())?;
                ".".into()
            }
            "recall" => {
                crate::recall::Query::parse(input.clone())?;
                ".".into()
            }
            "lsp_diagnostics"
            | "lsp_definition"
            | "lsp_references"
            | "lsp_hover"
            | "lsp_implementation"
            | "lsp_document_symbols"
            | "lsp_workspace_symbols"
            | "lsp_call_hierarchy"
            | "lsp_incoming_calls"
            | "lsp_outgoing_calls"
                if self.lsp.is_some() =>
            {
                crate::lsp::Query::parse(name, input.clone())?.path
            }
            "task" if self.delegation_enabled => {
                crate::subagent::Input::parse(input.clone())?;
                ".".into()
            }
            "glob" | "grep" => search::Query::parse(name, input.clone())?.path,
            "terminal_start" if self.background_enabled && crate::terminal::supported() => {
                crate::terminal::Start::parse(input.clone())?.cwd
            }
            "terminal_read" | "terminal_write" | "terminal_resize" | "terminal_stop"
                if self.background_enabled && crate::terminal::supported() =>
            {
                crate::terminal::Control::parse(name, input.clone())?;
                ".".into()
            }
            "terminal_list" if self.background_enabled && crate::terminal::supported() => {
                if input != json!({}) {
                    return Err(ToolError::InvalidInput);
                }
                ".".into()
            }
            "start_job" if self.background_enabled => process::Input::parse(input.clone())?.cwd,
            "job_status" | "cancel_job" if self.background_enabled => {
                crate::jobs::Selector::parse(input.clone())?;
                ".".into()
            }
            "run_command" if self.process_enabled => process::Input::parse(input.clone())?.cwd,
            "bash" if self.process_enabled => process::BashInput::parse(input.clone())?.cwd,
            "write_file" | "edit_file" if self.writes => {
                Mutation::parse(name, input.clone())?.path().to_owned()
            }
            "apply_patch" if self.writes => {
                crate::patch::parse(&Self::patch_input(name, input.clone())?)?;
                ".".into()
            }
            _ => return Err(ToolError::Unsupported),
        };
        let path = if name == "apply_patch" {
            for operation in crate::patch::parse(&Self::patch_input(name, input.clone())?)? {
                let candidate = self.contained_target(&operation.path).await?;
                if self.protected.contains(&candidate) {
                    return Err(ToolError::ProtectedResource);
                }
            }
            self.root.clone()
        } else if name == "write_file" || name == "edit_file" {
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
        if matches!(
            name,
            "run_command" | "bash" | "start_job" | "terminal_start" | "glob" | "grep"
        ) && !tokio::fs::metadata(&path).await?.is_dir()
        {
            return Err(ToolError::InvalidInput);
        }
        let external = !path.starts_with(&self.root);
        let relative = path
            .strip_prefix(&self.root)
            .unwrap_or(std::path::Path::new(""));
        let parts = if external {
            Vec::new()
        } else {
            relative
                .components()
                .map(|p| p.as_os_str().to_str().ok_or(ToolError::InvalidInput))
                .collect::<Result<Vec<_>, _>>()?
        };
        let resource = if name == "load_skill" {
            "@builtin/skill/media-observe".into()
        } else if external {
            // Authorized external reads use a namespaced resource: an absolute
            // path would be rejected by `permission::assess`'s boundary check, so
            // the resource is `@reference/<path>` and policy can target
            // `@reference/**`.
            format!("@reference{}", path.to_string_lossy().replace('\\', "/"))
        } else if name == "cron_create" || name == "cron_list" {
            "@session/cron".into()
        } else if name == "cron_delete" {
            format!(
                "@session/cron/{}",
                crate::cron::Selector::parse(input.clone())?.id
            )
        } else if name == "schedule_wakeup" {
            "@session/wakeup".into()
        } else if name == "cancel_wakeup" {
            format!(
                "@session/wakeup/{}",
                crate::wakeup::Selector::parse(input.clone())?.timer_id
            )
        } else if name == "question" {
            "@session/question".into()
        } else if name == "session_state" || name == "todowrite" || name == "goal" {
            format!("@session/state/{name}")
        } else if name == "recall" {
            "@session/history".into()
        } else if name == "task" {
            "@subagent".into()
        } else if name.starts_with("terminal_")
            && name != "terminal_start"
            && name != "terminal_list"
        {
            format!(
                "@terminals/{}",
                crate::terminal::Control::parse(name, input.clone())?.id
            )
        } else if name == "job_status" || name == "cancel_job" {
            format!(
                "@jobs/{}",
                crate::jobs::Selector::parse(input.clone())?.job_id
            )
        } else if parts.is_empty() {
            ".".into()
        } else {
            parts.join("/")
        };
        let access = if name == "cron_create" {
            Access::Cron
        } else if name == "schedule_wakeup" {
            Access::Schedule
        } else if matches!(name, "cancel_wakeup" | "todowrite" | "goal" | "cron_delete") {
            Access::SessionState
        } else if name == "start_job" || name.starts_with("terminal_") {
            Access::Background
        } else if name == "task" {
            Access::Delegate
        } else if matches!(name, "run_command" | "bash") {
            Access::Execute
        } else if matches!(name, "write_file" | "edit_file" | "apply_patch") {
            Access::Write
        } else {
            Access::Read
        };
        let targets = if name == "apply_patch" {
            crate::patch::parse(&Self::patch_input(name, input.clone())?)?
                .into_iter()
                .map(|operation| operation.path)
                .collect()
        } else {
            Vec::new()
        };
        Ok(Prepared {
            access,
            name: name.into(),
            input,
            path,
            resource,
            targets,
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
        if prepared.access() == Access::External {
            if let Some(registry) = &self.worker {
                if crate::worker::owns(prepared.name()) {
                    let name = prepared.name().to_owned();
                    return registry.call(&name, prepared.input, cancel).await;
                }
            }
            return self
                .mcp
                .as_ref()
                .ok_or(ToolError::Unsupported)?
                .call(&prepared.name, prepared.input, cancel)
                .await;
        }
        if prepared.access() == Access::Execute {
            let _lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().write_owned()=>guard};
            let current = self
                .prepare(prepared.name(), prepared.input().clone())
                .await?;
            if current.path != prepared.path || current.resource != prepared.resource {
                return Err(ToolError::ResourceChanged);
            }
            let runner = self.runner.as_deref().ok_or(ToolError::Unsupported)?;
            let input = if prepared.name() == "bash" {
                let bash = process::BashInput::parse(prepared.input)?;
                process::Input {
                    argv: bash.argv(),
                    cwd: bash.cwd,
                    timeout_ms: bash.timeout_ms,
                    pty: bash.pty,
                }
            } else {
                process::Input::parse(prepared.input)?
            };
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
            // A started commit is not dropped on cancellation. Its actual result
            // settles durably before the coordinator announces interruption.
            if prepared.name == "apply_patch" {
                let input = crate::patch::Input::parse(prepared.input)?;
                let operations = crate::patch::parse(&input)?;
                return tokio::task::spawn_blocking(move || {
                    let _lease = lease;
                    crate::patch::apply(&directory, &operations)
                })
                .await
                .map_err(|_| ToolError::Io(std::io::Error::other("file commit worker failed")))?;
            }
            let mutation = Mutation::parse(&prepared.name, prepared.input.clone())?;
            let anchor = prepared.input["old_string"].as_str().map(str::to_owned);
            let snapshot = if self.edit_recovery && prepared.name == "edit_file" {
                self.edit_snapshots.lock().ok().and_then(|snapshots| {
                    snapshots
                        .lookup(&prepared.path.to_string_lossy())
                        .map(str::to_owned)
                })
            } else {
                None
            };
            let applied = tokio::task::spawn_blocking(move || {
                let _lease = lease;
                apply(&directory, &relative, mutation, snapshot)
            })
            .await
            .map_err(|_| ToolError::Io(std::io::Error::other("file commit worker failed")))?;
            // A rejected conditional write returns the current fingerprint and
            // anchor statistics so one retry with corrected expectations can
            // succeed without a separate read turn.
            if prepared.name != "apply_patch"
                && matches!(
                    applied,
                    Err(ToolError::StaleFile
                        | ToolError::StaleEditRecovery(_)
                        | ToolError::AmbiguousEdit)
                )
            {
                if let Ok(current) = tokio::fs::read(&prepared.path).await {
                    let stale = json!({
                        "error": applied.unwrap_err().to_string(),
                        "current_sha256": digest(&current),
                        "old_string_occurrences": anchor.as_ref()
                            .map(|needle| String::from_utf8_lossy(&current).matches(needle.as_str()).count()),
                    });
                    return Ok(stale);
                }
            }
            return applied;
        }
        let read_lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().read_owned()=>guard};
        let current = self
            .prepare(prepared.name(), prepared.input().clone())
            .await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        if matches!(
            prepared.name.as_str(),
            "lsp_diagnostics"
                | "lsp_definition"
                | "lsp_references"
                | "lsp_hover"
                | "lsp_implementation"
                | "lsp_document_symbols"
                | "lsp_workspace_symbols"
                | "lsp_call_hierarchy"
                | "lsp_incoming_calls"
                | "lsp_outgoing_calls"
        ) {
            let registry = self.lsp.as_ref().ok_or(ToolError::Unsupported)?;
            let query = crate::lsp::Query::parse(&prepared.name, prepared.input)?;
            let _lease = read_lease;
            return match prepared.name.as_str() {
                "lsp_diagnostics" => registry.diagnostics(&prepared.path).await,
                "lsp_definition" => {
                    registry
                        .definition(&prepared.path, query.line, query.character)
                        .await
                }
                "lsp_references" => {
                    registry
                        .references(&prepared.path, query.line, query.character)
                        .await
                }
                _ => registry.query(&prepared.name, &prepared.path, query).await,
            };
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

    fn delegation_definitions(&self) -> Vec<ToolDefinition> {
        if !self.delegation_enabled {
            return Vec::new();
        }
        vec![ToolDefinition{name:"task".into(),description:"Delegate a self-contained task to a child Session and return its final message. The child inherits this Session's workspace and permission policy, has its own run and cancellation, and is bounded by a subagent depth and concurrency limit. Requires explicit subagent authority.".into(),input_schema:json!({"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":65536},"session_id":{"type":"string","maxLength":256}},"required":["prompt"],"additionalProperties":false})}]
    }

    fn lsp_definitions(&self) -> Vec<ToolDefinition> {
        if self.lsp.is_none() {
            return Vec::new();
        }
        [
            ("lsp_diagnostics", "Return current language-server diagnostics for a workspace file."),
            ("lsp_definition", "Return definition locations at a 0-based line and UTF-16 character."),
            ("lsp_references", "Return reference locations, including the declaration, at a 0-based line and UTF-16 character."),
            ("lsp_hover", "Return type and documentation at a 0-based line and UTF-16 character."),
            ("lsp_implementation", "Return implementation locations at a 0-based line and UTF-16 character."),
            ("lsp_document_symbols", "Return symbols in a workspace file."),
            ("lsp_workspace_symbols", "Search workspace symbols using a query; path selects the language server."),
            ("lsp_call_hierarchy", "Prepare call hierarchy at a 0-based line and UTF-16 character."),
            ("lsp_incoming_calls", "Return incoming calls at a 0-based line and UTF-16 character."),
            ("lsp_outgoing_calls", "Return outgoing calls at a 0-based line and UTF-16 character."),
        ].into_iter().map(|(name, description)| {
            let mut properties = json!({"path":{"type":"string","minLength":1,"maxLength":4096}});
            let mut required = vec!["path"];
            if !matches!(name, "lsp_diagnostics" | "lsp_document_symbols" | "lsp_workspace_symbols") {
                properties["line"] = json!({"type":"integer","minimum":0,"maximum":10000000});
                properties["character"] = json!({"type":"integer","minimum":0,"maximum":10000000});
                required.extend(["line", "character"]);
            }
            if name == "lsp_workspace_symbols" {
                properties["query"] = json!({"type":"string","maxLength":4096,"default":""});
            }
            ToolDefinition {
                name: name.into(),
                description: format!("{description} Read-only, bounded and time-limited. File content is synchronized before queries."),
                input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
            }
        }).collect()
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
        definitions.extend(self.delegation_definitions());
        definitions.extend(self.lsp_definitions());
        if self.background_enabled && crate::terminal::supported() {
            definitions.push(ToolDefinition {
                name: "terminal_start".into(),
                description: "Start a Session-owned interactive PTY for a program or REPL. Supply argv, such as [\"bash\"]. Requires process/background authority, confined to the workspace. Survives turn cancellation, killed on engine shutdown/owner loss; maximum lifetime one day. Up to eight retained terminals per Session; stop to release.".into(),
                input_schema: json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128},"cwd":{"type":"string","default":"."},"rows":{"type":"integer","minimum":1,"maximum":500,"default":24},"cols":{"type":"integer","minimum":1,"maximum":500,"default":80}},"required":["argv"],"additionalProperties":false}),
            });
            for (name, description) in [
                ("terminal_write", "Write exact keystrokes to a running terminal, including newline to submit. Up to 32768 bytes; partial writes on timeout are reported."),
                ("terminal_read", "Read up to 32768 bytes from a terminal. Omit cursor to continue; explicit absolute byte cursor allows replay. A 1 MiB output ring reports dropped bytes and truncation. Output is raw PTY text, including terminal escape sequences."),
                ("terminal_resize", "Resize a running terminal's rows and columns."),
                ("terminal_stop", "Stop and reap a terminal's process tree, return unread output and release its retained slot."),
                ("terminal_list", "List this Session's retained terminals and exit status."),
            ] {
                let mut properties = json!({});
                let mut required = Vec::new();
                if name != "terminal_list" { properties["id"] = json!({"type":"string","minLength":1,"maxLength":128}); required.push("id"); }
                if name == "terminal_write" { properties["input"] = json!({"type":"string","maxLength":32768}); required.push("input"); }
                if name == "terminal_read" { properties["cursor"] = json!({"type":"integer","minimum":0}); }
                if name == "terminal_resize" {
                    properties["rows"] = json!({"type":"integer","minimum":1,"maximum":500});
                    properties["cols"] = json!({"type":"integer","minimum":1,"maximum":500});
                    required.extend(["rows", "cols"]);
                }
                definitions.push(ToolDefinition { name:name.into(), description:description.into(), input_schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}) });
            }
        }
        definitions.push(ToolDefinition {
            name: "read_image".into(),
            description: "Read a local PNG/JPEG/GIF/WebP image (up to 4 MiB) for visual understanding. The committed tool result attaches image pixels to the next provider turn; base64 is not text context. Use after extracting video frames/contact sheets with Bash, or for screenshots. Uses read permission and path boundaries.".into(),
            input_schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
        });
        definitions.push(ToolDefinition {
            name: "load_skill".into(),
            description: "Load the built-in media-observe skill for timestamped video/audio inspection through Bash, ffmpeg/ffprobe, and read_image. Project skill bodies remain available through their listed read_file paths.".into(),
            input_schema: json!({"type":"object","properties":{"name":{"type":"string","enum":["media-observe"]}},"required":["name"],"additionalProperties":false}),
        });
        definitions.push(ToolDefinition{name:"recall".into(),description:"Search this Session's raw immutable messages, including history before compaction. Literal case-sensitive substring; opaque provider state excluded. Bounded scan pages may contain no matches; follow next_before_message_seq until exhausted.".into(),input_schema:json!({"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":512},"limit":{"type":"integer","minimum":1,"maximum":20,"default":10},"before_message_seq":{"type":"integer","minimum":0}},"required":["query"],"additionalProperties":false})});
        definitions.extend([
            ToolDefinition{name:"session_state".into(),description:"Read this Session's durable todo list and goal with optimistic revisions, including after compaction/restart.".into(),input_schema:json!({"type":"object","properties":{},"additionalProperties":false})},
            ToolDefinition{name:"todowrite".into(),description:"Replace this Session's durable todo list (max 128). Stable id and depends_on express prerequisites; waiting jobs block only their dependents, not independent work. Optional expected_revision=0 for first write, or the revision from session_state, prevents stale updates.".into(),input_schema:json!({"type":"object","properties":{"todos":{"type":"array","maxItems":128,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1},"depends_on":{"type":"array","items":{"type":"string"}},"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","waiting","blocked","completed","cancelled"]},"priority":{"type":"string","enum":["high","medium","low"]}},"required":["content","status","priority"],"additionalProperties":false}},"expected_revision":{"type":"integer","minimum":0}},"required":["todos"],"additionalProperties":false})},
            ToolDefinition{name:"goal".into(),description:"Record this Session's durable objective/status/evidence/budget. done and blocked require evidence. Optional expected_revision protects against stale writes; evidence is recorded, not independently verified. autonomous records explicit user authorization and grants no additional permissions.".into(),input_schema:json!({"type":"object","properties":{"autonomous":{"type":"boolean"},"objective":{"type":"string"},"status":{"type":"string","enum":["active","paused","blocked","done"]},"evidence":{"type":"string"},"budget":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}},"required":["objective","status"],"additionalProperties":false})},
        ]);
        definitions.push(ToolDefinition{name:"question".into(),description:"Ask 1..4 bounded choice questions. Answers arrive through the authenticated local controller. Waiting is interruptible; no automatic replay after crash. multiSelect permits multiple labels; custom permits a typed answer.".into(),input_schema:json!({"type":"object","properties":{"questions":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"question":{"type":"string"},"header":{"type":"string","maxLength":12},"options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label"],"additionalProperties":false}},"multiSelect":{"type":"boolean","default":false},"custom":{"type":"boolean","default":true}},"required":["question","options"],"additionalProperties":false}},"timeout_ms":{"type":"integer","minimum":1,"maximum":600000,"default":60000}},"required":["questions"],"additionalProperties":false})});
        if self.wakeup_enabled {
            definitions.extend([
                ToolDefinition{name:"schedule_wakeup".into(),description:"Schedule one prompt for this Session in 60..3600 seconds. Default delivery=queue. Survives turn cancel, but timers stop on process shutdown/restart. Durable admission is atomic at fire; no automatic timer replay.".into(),input_schema:json!({"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":8192},"delaySeconds":{"type":"integer","minimum":60,"maximum":3600},"delivery":{"type":"string","enum":["queue","steer"],"default":"queue"}},"required":["prompt","delaySeconds"],"additionalProperties":false})},
                ToolDefinition{name:"cancel_wakeup".into(),description:"Cancel this Session's pending wakeup. A fired timer has already admitted its prompt and cannot be cancelled by this operation.".into(),input_schema:json!({"type":"object","properties":{"timer_id":{"type":"string"}},"required":["timer_id"],"additionalProperties":false})},
            ]);
        }
        if self.cron_enabled {
            definitions.extend([
                ToolDefinition{name:"cron_create".into(),description:"Schedule prompts for this Session using a numeric standard 5-field local-time cron expression. Process lifetime only, max seven days. Default recurring=true and delivery=queue. Missed ticks are not replayed; pending inputs coalesce.".into(),input_schema:json!({"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":8192},"cron":{"type":"string","maxLength":256},"recurring":{"type":"boolean","default":true},"delivery":{"type":"string","enum":["queue","steer"],"default":"queue"}},"required":["prompt","cron"],"additionalProperties":false})},
                ToolDefinition{name:"cron_list".into(),description:"List this Session's recent cron schedules, next occurrence, fired/skipped counts and terminal state.".into(),input_schema:json!({"type":"object","properties":{},"additionalProperties":false})},
                ToolDefinition{name:"cron_delete".into(),description:"Cancel future occurrences of this Session's cron schedule. Already admitted prompts remain durable.".into(),input_schema:json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false})},
            ]);
        }
        if self.writes {
            definitions.extend([
                ToolDefinition{name:"write_file".into(),description:"Write UTF-8 text (max 32768 bytes) under workspace. expected_sha256=null creates only; existing files require the current SHA-256 from read_file. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"text":{"type":"string"},"expected_sha256":{"type":["string","null"]}},"required":["path","text","expected_sha256"],"additionalProperties":false})},
                ToolDefinition{name:"apply_patch".into(),description:"Apply a strict V4A multi-file patch (Add/Update/Delete File sections with @@ hunks) as one transaction: all-or-nothing, context must match exactly, BOM/CRLF preserved, max 32 files/256 KiB patch/32 KiB per file. Requires permission approval for the whole patch.".into(),input_schema:json!({"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"],"additionalProperties":false})},
                        ToolDefinition{name:"edit_file".into(),description:"Conditionally replace an exact text match using the SHA-256 from read_file. Ambiguous matches fail unless replace_all=true. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"expected_sha256":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string","expected_sha256"],"additionalProperties":false})},
            ]);
        }
        if self.process_enabled {
            definitions.push(ToolDefinition{name:"run_command".into(),description:"Run an explicit argv in a workspace-write sandbox. Timeout 1..120000 ms; stdout/stderr bounded to 32768 bytes each. No implicit shell and no background lifetime. pty merges stdout/stderr behind a terminal. Requires process permission.".into(),input_schema:json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128},"cwd":{"type":"string","default":"."},"timeout_ms":{"type":"integer","minimum":1,"maximum":120000,"default":10000},"pty":{"type":"boolean","default":false}},"required":["argv"],"additionalProperties":false})});
            definitions.push(ToolDefinition{name:"bash".into(),description:"Run a shell command line (bash -c) in a workspace-write sandbox. Timeout 1..120000 ms; output bounded to 32768 bytes. pty merges stdout/stderr behind a terminal. Requires process permission.".into(),input_schema:json!({"type":"object","properties":{"command":{"type":"string","minLength":1},"cwd":{"type":"string","default":"."},"timeout_ms":{"type":"integer","minimum":1,"maximum":120000,"default":10000},"pty":{"type":"boolean","default":false}},"required":["command"],"additionalProperties":false})});
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
        if let Some(registry) = &self.mcp {
            definitions.extend(registry.definitions());
        }
        if let Some(registry) = &self.worker {
            definitions.extend(registry.definitions());
        }
        definitions
    }

    async fn contained(&self, path: &str) -> Result<PathBuf, ToolError> {
        let path = tokio::fs::canonicalize(self.root.join(path)).await?;
        if path.starts_with(&self.root) || self.read_roots.iter().any(|root| path.starts_with(root))
        {
            return Ok(path);
        }
        Err(ToolError::OutsideWorkspace)
    }

    /// Patch targets may not exist yet (Add File). Canonicalize the nearest
    /// existing ancestor for the boundary check and re-append the missing tail.
    async fn contained_target(&self, path: &str) -> Result<PathBuf, ToolError> {
        let joined = self.root.join(path);
        let mut existing = joined.as_path();
        while tokio::fs::symlink_metadata(existing).await.is_err() {
            existing = existing.parent().ok_or(ToolError::OutsideWorkspace)?;
        }
        let base = tokio::fs::canonicalize(existing).await?;
        if !base.starts_with(&self.root) {
            return Err(ToolError::OutsideWorkspace);
        }
        let tail = joined
            .strip_prefix(existing)
            .map_err(|_| ToolError::OutsideWorkspace)?;
        Ok(base.join(tail))
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
                "load_skill" => {
                    let input: SkillInput =
                        serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                    if input.name != "media-observe" {
                        return Err(ToolError::InvalidInput);
                    }
                    Ok(
                        json!({"name":input.name,"content":crate::context::MEDIA_OBSERVE,"sha256":digest(crate::context::MEDIA_OBSERVE.as_bytes()),"tool_mapping":{"bash":"bash","read_images":"read_image","read_text":"read_file"}}),
                    )
                }
                "read_image" => {
                    use base64::Engine;
                    let input: ReadInput =
                        serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                    let path = self.contained(&input.path).await?;
                    let file = tokio::fs::File::open(&path).await?;
                    let metadata = file.metadata().await?;
                    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
                        return Err(ToolError::External(
                            "image must be a regular PNG/JPEG/GIF/WebP file of at most 4 MiB"
                                .into(),
                        ));
                    }
                    let mut bytes = Vec::new();
                    file.take(4 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .await?;
                    if bytes.len() > 4 * 1024 * 1024 {
                        return Err(ToolError::InvalidFile);
                    }
                    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                        "image/png"
                    } else if bytes.starts_with(b"\xff\xd8\xff") {
                        "image/jpeg"
                    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
                        "image/gif"
                    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                        "image/webp"
                    } else {
                        return Err(ToolError::External("unsupported image format".into()));
                    };
                    Ok(
                        json!({"path":input.path,"mime":mime,"bytes":bytes.len(),"sha256":digest(&bytes),"image":{"mime":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}),
                    )
                }
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
                    if let Ok(mut snapshots) = self.edit_snapshots.lock() {
                        snapshots.register(path.to_string_lossy().into_owned(), text.clone());
                    }
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
