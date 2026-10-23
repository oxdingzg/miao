mod command_reference;
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
    sync::{Arc, RwLock as StdRwLock},
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
    #[error("file is {0} bytes, above the 32768-byte whole-file bound; pass a 1-based offset and a line limit to read one window")]
    TooLarge(usize),
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
    offset: Option<usize>,
    limit: Option<usize>,
    /// PDF only: a 1-based selection such as `1-3,5`. Omit for the first ten.
    pages: Option<String>,
}

/// A ranged read returns at most this many lines, and never more than the
/// whole-file byte bound, so one window cannot flood the context.
const MAX_READ_LINES: usize = 2000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillInput {
    name: String,
}

impl SkillInput {
    fn parse(input: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if input.name.is_empty()
            || input.name.len() > 64
            || input.name.chars().any(|character| character.is_control())
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(input)
    }
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
    batchable_read: bool,
    select: Option<Vec<String>>,
}
impl Prepared {
    pub fn batchable_read(&self) -> bool {
        self.batchable_read
    }
    pub(crate) fn resolved_path(&self) -> &std::path::Path {
        &self.path
    }

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
    product_tools: Arc<StdRwLock<Vec<ToolDefinition>>>,
    wakeup_enabled: bool,
    cron_enabled: bool,
    process_network: bool,
    runner: Option<Arc<PathBuf>>,
    protected: Vec<PathBuf>,
    private_store: Option<PathBuf>,
    mcp: Option<Arc<mcp::Registry>>,
    web: Option<Arc<crate::web::Client>>,
    worker: Option<Arc<crate::worker::Registry>>,
    lsp: Option<Arc<crate::lsp::Registry>>,
    formatter: Option<Arc<crate::formatter::Registry>>,
    context_sources: Arc<Vec<crate::context::Source>>,
    workspace_instructions: bool,
    skill_directories: Arc<Vec<crate::context::SkillDirectory>>,
    references: Arc<Vec<crate::context::Reference>>,
    read_roots: Arc<Vec<std::path::PathBuf>>,
    hooks: Arc<Vec<crate::hooks::Hook>>,
    edit_snapshots: Arc<std::sync::Mutex<Snapshots>>,
    edit_recovery: bool,
    lsp_diagnostics: bool,
    compact_disclosure: bool,
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
            web: None,
            worker: None,
            lsp: None,
            formatter: None,
            context_sources: Arc::new(vec![]),
            workspace_instructions: true,
            skill_directories: Arc::new(vec![]),
            references: Arc::new(vec![]),
            read_roots: Arc::new(vec![]),
            hooks: Arc::new(vec![]),
            edit_snapshots: Arc::new(std::sync::Mutex::new(Snapshots::new())),
            edit_recovery: true,
            lsp_diagnostics: true,
            compact_disclosure: false,
            product_tools: Arc::new(StdRwLock::new(Vec::new())),
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
    /// The sandbox runner executable; background tools fail closed without it.
    pub(crate) fn process_runner(&self) -> Option<&std::path::Path> {
        self.runner.as_ref().map(|path| path.as_path())
    }
    pub(crate) fn process_network_allowed(&self) -> bool {
        self.process_network
    }
    /// A product host can supply its resolved aggregate without standalone
    /// discovery reintroducing disabled sources or duplicating instructions.
    pub fn with_workspace_instructions(mut self, enabled: bool) -> Self {
        self.workspace_instructions = enabled;
        self
    }
    pub(crate) fn workspace_instructions(&self) -> bool {
        self.workspace_instructions
    }
    pub fn with_context_sources(
        mut self,
        sources: Vec<crate::context::Source>,
    ) -> Result<Self, ToolError> {
        crate::context::validate(&sources)?;
        self.context_sources = Arc::new(sources);
        Ok(self)
    }

    pub fn with_web(mut self, client: crate::web::Client) -> Self {
        self.web = Some(Arc::new(client));
        self
    }
    pub(crate) fn enable_web(self, enabled: bool) -> Result<Self, ToolError> {
        if !enabled && self.web.is_some() {
            return Err(ToolError::InvalidInput);
        }
        if enabled && self.web.is_none() {
            return Ok(self.with_web(crate::web::Client::new(
                crate::web::SearchConfig::from_env()?,
            )?));
        }
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
            // A file reference authorizes that exact file, not its siblings.
            // Directory references retain their explicitly granted subtree.
            if !roots.contains(&canonical) {
                roots.push(canonical);
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
            "workerAttached":self.worker.is_some(),"lspAttached":self.lsp.is_some(),"formatter":self.formatter.as_ref().map(|registry| registry.descriptor()),"web":self.web.as_ref().map(|client|client.descriptor())})
    }
    /// Grants bind host registration identity without changing replay's tool
    /// boundary vocabulary. Caller-owned IO transports have a per-instance id.
    pub(crate) fn grant_authority_descriptor(&self) -> Value {
        json!({"boundary":self.authority_descriptor(),
            "mcp":self.mcp.as_ref().map(|registry|registry.authority()),
            "worker":self.worker.as_ref().map(|registry|registry.authority()),
            "lsp":self.lsp.as_ref().map(|registry|registry.authority()),"processRunner":self.runner,
            "hooks":self.hooks.iter().map(|hook|json!({"event":hook.event.name(),"tool":hook.tool,"argv":hook.argv,"timeout_ms":hook.timeout_ms})).collect::<Vec<_>>()})
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

    pub fn with_formatter(mut self, registry: Arc<crate::formatter::Registry>) -> Self {
        self.formatter = Some(registry);
        self
    }

    async fn format_mutation(&self, path: &Path, value: &mut Value, cancel: &CancellationToken) {
        let (Some(registry), Some(runner)) = (&self.formatter, &self.runner) else {
            return;
        };
        // The mutation was committed already. Formatting failures must not
        // make its side effects look uncommitted or safe to repeat.
        if tokio::fs::canonicalize(path).await.ok().as_deref() != Some(path) {
            return;
        }
        let Ok(before) = tokio::fs::read(path).await else {
            return;
        };
        if value["sha256"] != digest(&before) {
            value["formatters"] = json!([{"status":"skipped_external_change"}]);
            return;
        }
        let reports = registry.file(path, runner, cancel).await;
        if reports.is_empty() {
            return;
        }
        value["formatters"] = json!(reports);
        if let Ok(after) = tokio::fs::read(path).await {
            value["sha256"] = json!(digest(&after));
            value["bytes"] = json!(after.len());
        }
    }

    pub fn with_compact_disclosure(mut self, enabled: bool) -> Self {
        self.compact_disclosure = enabled;
        self
    }

    async fn knowledge_source(
        &self,
        path: &str,
        policy: &Policy,
        spent: &mut usize,
        store_resource: &str,
    ) -> Result<(crate::knowledge::Source, Vec<u8>), ToolError> {
        if !crate::knowledge::source_path(path)
            || policy.evaluate("read_file", path, Access::Read)
                != crate::permission::Decision::Allow
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "knowledge access denied",
            )
            .into());
        }
        let prepared = self.prepare("read_file", json!({"path":path})).await?;
        if prepared.resource == store_resource
            || !prepared.path.starts_with(&self.root)
            || policy.evaluate("read_file", &prepared.resource, Access::Read)
                != crate::permission::Decision::Allow
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "knowledge access denied",
            )
            .into());
        }
        if *spent >= 8 * 1024 * 1024 {
            return Err(ToolError::External(
                "knowledge source budget exhausted".into(),
            ));
        }
        let relative = prepared
            .path
            .strip_prefix(&self.root)
            .map_err(|_| ToolError::OutsideWorkspace)?
            .to_owned();
        let directory = self.directory.clone();
        let bound = (8 * 1024 * 1024 - *spent).min(1024 * 1024);
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ToolError> {
            use std::io::Read;
            let file = directory.open(relative)?;
            if !file.metadata()?.is_file() {
                return Err(ToolError::InvalidInput);
            }
            let mut bytes = vec![];
            file.take(bound as u64 + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .await
        .map_err(|_| ToolError::External("knowledge source worker failed".into()))??;
        *spent += bytes.len();
        if bytes.len() > bound {
            return Err(ToolError::External(
                "knowledge source exceeds its bounded read".into(),
            ));
        }
        Ok((
            crate::knowledge::Source {
                path: prepared.resource,
                sha256: digest(&bytes),
            },
            bytes,
        ))
    }

    async fn knowledge_status(
        &self,
        note: &crate::knowledge::Note,
        policy: &Policy,
        spent: &mut usize,
        cache: &mut std::collections::BTreeMap<
            String,
            Result<crate::knowledge::Source, &'static str>,
        >,
        store_resource: &str,
    ) -> &'static str {
        let mut status = "current";
        for source in &note.sources {
            if !cache.contains_key(&source.path) {
                let observed = match self
                    .knowledge_source(&source.path, policy, spent, store_resource)
                    .await
                {
                    Ok((source, _)) => Ok(source),
                    Err(
                        ToolError::OutsideWorkspace
                        | ToolError::ProtectedResource
                        | ToolError::ResourceChanged,
                    ) => Err("restricted"),
                    Err(ToolError::Io(error))
                        if error.kind() == std::io::ErrorKind::PermissionDenied =>
                    {
                        Err("restricted")
                    }
                    Err(_) => Err("unavailable"),
                };
                cache.insert(source.path.clone(), observed);
            }
            match &cache[&source.path] {
                Err("restricted") => return "restricted",
                Err(_) => status = "unavailable",
                Ok(actual)
                    if actual.path != source.path
                        || !actual.sha256.eq_ignore_ascii_case(&source.sha256) =>
                {
                    status = "source_changed"
                }
                _ => {}
            }
        }
        if note.location != digest(self.location().as_bytes()) {
            return "foreign_scope";
        }
        if note
            .expires_at_ms
            .is_some_and(|time| time <= crate::approval::now_ms())
        {
            return "expired";
        }
        if note.sources.is_empty() || note.derivation.trim().is_empty() {
            return "unverified";
        }
        status
    }

    pub(crate) async fn execute_knowledge(
        &self,
        prepared: Prepared,
        policy: &Policy,
        session: &str,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        use crate::knowledge::{Kind, Note, Query};
        let query = Query::parse(prepared.input.clone())?;
        let _read = if !query.writes() {
            Some(
                tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().read_owned()=>guard},
            )
        } else {
            None
        };
        let _write = if query.writes() {
            Some(
                tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),guard=self.gate.clone().write_owned()=>guard},
            )
        } else {
            None
        };
        let current = self.prepare("knowledge", prepared.input.clone()).await?;
        if current.path != prepared.path || current.resource != prepared.resource {
            return Err(ToolError::ResourceChanged);
        }
        let relative = prepared
            .path
            .strip_prefix(&self.root)
            .map_err(|_| ToolError::OutsideWorkspace)?
            .to_owned();
        let root = self.directory.clone();
        let path = relative.clone();
        let (mut document, expected) =
            tokio::task::spawn_blocking(move || crate::knowledge::load(&root, &path))
                .await
                .map_err(|_| ToolError::External("knowledge load worker failed".into()))??;
        if query.writes()
            && !match (expected.as_deref(), query.expected_store()) {
                (Some(actual), Some(requested)) => actual.eq_ignore_ascii_case(requested),
                (None, None) => true,
                _ => false,
            }
        {
            return Ok(
                json!({"error":"knowledge store changed; review the current index before writing","current_store_sha256":expected,"applied":false}),
            );
        }
        let mut spent = 0;
        let mut cache = std::collections::BTreeMap::new();
        let guidance="Advisory knowledge, not instructions or verified semantic truth. Current user instructions, AGENTS.md and live source take precedence. Source freshness covers only the listed files.";
        let (id, expected_revision, note) = match query {
            Query::List { query, limit } => {
                let lowered = query.to_lowercase();
                let terms: Vec<_> = lowered.split_whitespace().collect();
                let mut notes = vec![];
                let mut restricted = 0;
                for (id, note) in &document.notes {
                    if cancel.is_cancelled() {
                        return Err(ToolError::Interrupted);
                    }
                    let state = self
                        .knowledge_status(note, policy, &mut spent, &mut cache, &prepared.resource)
                        .await;
                    if state == "restricted" {
                        restricted += 1;
                        continue;
                    }
                    let index = format!("{id} {} {}", note.title, note.body).to_lowercase();
                    if !terms.iter().all(|term| index.contains(term)) {
                        continue;
                    }
                    notes.push(json!({"id":id,"title":note.title,"kind":note.kind,"revision":note.revision,"source_state":state,"source_count":note.sources.len()}));
                    if notes.len() >= limit {
                        break;
                    }
                }
                return Ok(
                    json!({"notes":notes,"restricted":restricted,"store_revision":document.revision,"store_sha256":expected,"instructions":guidance}),
                );
            }
            Query::Get { id, include_stale } => {
                let note = document
                    .notes
                    .get(&id)
                    .ok_or_else(|| ToolError::External("knowledge note not found".into()))?;
                let state = self
                    .knowledge_status(note, policy, &mut spent, &mut cache, &prepared.resource)
                    .await;
                if state == "restricted" {
                    return Ok(
                        json!({"id":id,"revision":note.revision,"source_state":state,"instructions":guidance}),
                    );
                }
                let body = (state == "current" || include_stale).then_some(&note.body);
                return Ok(
                    json!({"id":id,"title":note.title,"kind":note.kind,"revision":note.revision,"store_sha256":expected,"source_state":state,"body":body,"derivation":if body.is_some(){Some(&note.derivation)}else{None},"sources":note.sources,"origin_session":note.origin_session,"updated_at_ms":note.updated_at_ms,"expires_at_ms":note.expires_at_ms,"instructions":guidance}),
                );
            }
            Query::Delete {
                id,
                expected_revision,
                ..
            } => (id, expected_revision, None),
            Query::Put {
                id,
                expected_revision,
                title,
                kind,
                body,
                derivation,
                sources,
                ttl_seconds,
                ..
            } => {
                let mut verified = vec![];
                for source in sources {
                    let (actual, _) = self
                        .knowledge_source(&source.path, policy, &mut spent, &prepared.resource)
                        .await?;
                    if !actual.sha256.eq_ignore_ascii_case(&source.sha256) {
                        return Err(ToolError::StaleFile);
                    }
                    verified.push(actual);
                }
                let ttl = ttl_seconds.or_else(|| {
                    matches!(kind, Kind::Preference | Kind::Constraint).then_some(7 * 24 * 3600)
                });
                let now = crate::approval::now_ms();
                (
                    id,
                    expected_revision,
                    Some(Note {
                        revision: 0,
                        title,
                        kind,
                        body,
                        derivation,
                        sources: verified,
                        location: digest(self.location().as_bytes()),
                        origin_session: session.into(),
                        updated_at_ms: now,
                        expires_at_ms: ttl.map(|ttl| now.saturating_add(ttl * 1000)),
                    }),
                )
            }
            Query::IndexFile {
                id,
                path,
                expected_revision,
                ..
            } => {
                let (source, bytes) = self
                    .knowledge_source(&path, policy, &mut spent, &prepared.resource)
                    .await?;
                let body = crate::knowledge::index(&source.path, &bytes)?;
                (id,expected_revision,Some(Note {revision:0,title:source.path.chars().take(40).collect(),kind:Kind::FileIndex,body,derivation:"Bounded lexical declaration candidates from exact source bytes; semantic completeness is unknown.".into(),sources:vec![source],location:digest(self.location().as_bytes()),origin_session:session.into(),updated_at_ms:crate::approval::now_ms(),expires_at_ms:None}))
            }
        };
        let revision = document.notes.get(&id).map_or(0, |note| note.revision);
        if revision != expected_revision || (note.is_none() && revision == 0) {
            return Ok(
                json!({"error":"knowledge revision conflict","id":id,"current_revision":revision,"applied":false}),
            );
        }
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        document.revision = document
            .revision
            .checked_add(1)
            .ok_or(ToolError::InvalidInput)?;
        let deleted = note.is_none();
        if let Some(mut note) = note {
            note.revision = document.revision;
            document.notes.insert(id.clone(), note);
        } else {
            document.notes.remove(&id);
        }
        let revision = document.revision;
        let root = self.directory.clone();
        // The blocking commit is joined even if cancellation follows dispatch.
        let applied = tokio::task::spawn_blocking(move || {
            crate::knowledge::save(&root, &relative, &document, expected)
        })
        .await
        .map_err(|_| ToolError::External("knowledge commit worker failed".into()))??;
        Ok(
            json!({"id":id,"revision":revision,"store_sha256":applied["sha256"],"deleted":deleted,"applied":true,"storage":applied,"instructions":guidance}),
        )
    }

    /// Hooks use the actual extension name; the provider still sees the stable bridge name.
    pub(crate) fn effective_name<'a>(&self, name: &'a str, input: &'a Value) -> &'a str {
        if self.compact_disclosure && name == "tool_call" {
            if let Some(target) = input["name"].as_str() {
                if self
                    .mcp
                    .as_ref()
                    .and_then(|registry| registry.resource(target))
                    .is_some()
                    || self
                        .worker
                        .as_ref()
                        .and_then(|registry| registry.resource(target))
                        .is_some()
                {
                    return target;
                }
            }
        }
        name
    }
    /// Evaluation ablation switch: `false` disables the read warm-up and the
    /// post-edit diagnostics report while every other path stays identical.
    pub fn with_lsp_diagnostics(mut self, enabled: bool) -> Self {
        self.lsp_diagnostics = enabled;
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

    /// Register host-provided tool definitions. The list is shared with the
    /// runtime so a manifest loaded after `Tools` construction is advertised
    /// and authorized by the same instance that dispatches it.
    pub fn with_product_tools(&self, tools: Vec<ToolDefinition>) {
        *self.product_tools.write().unwrap() = tools;
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

    fn is_product(&self, name: &str) -> bool {
        self.product_tools
            .read()
            .unwrap()
            .iter()
            .any(|tool| tool.name == name)
    }

    pub fn location(&self) -> &str {
        self.root.to_str().expect("validated UTF-8 Location")
    }

    pub(crate) async fn verification_source(&self, scope: &crate::verification::Scope) -> Value {
        let directory = self.directory.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || scope.snapshot(&directory)).await
            .unwrap_or_else(|_| json!({"coverage":"native-write-targets","complete":false,"error":"source snapshot worker failed"}))
    }

    pub async fn prepare(&self, name: &str, input: Value) -> Result<Prepared, ToolError> {
        if matches!(name, "webfetch" | "websearch") {
            let resource = self
                .web
                .as_ref()
                .ok_or(ToolError::Unsupported)?
                .prepare(name, input.clone())?;
            return Ok(Prepared {
                name: name.into(),
                input,
                path: self.root.clone(),
                resource,
                targets: vec![],
                access: Access::Web,
                select: None,
                batchable_read: false,
            });
        }
        let invocation = if self.compact_disclosure && name == "tool_call" {
            Some(crate::tool_catalog::Invocation::parse(input.clone())?)
        } else {
            None
        };
        let name = invocation.as_ref().map_or(name, |call| call.name.as_str());
        let input = invocation
            .as_ref()
            .map_or(input, |call| call.arguments.clone());
        let select = invocation.as_ref().and_then(|call| call.select.clone());
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
                    batchable_read: false,
                    select,
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
                    batchable_read: false,
                    select,
                });
            }
        }
        if invocation.is_some() {
            return Err(ToolError::Unsupported);
        }
        let path = match name {
            "knowledge" => {
                let query = crate::knowledge::Query::parse(input.clone())?;
                if query.writes() && !self.writes {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "knowledge access denied",
                    )
                    .into());
                }
                crate::knowledge::PATH.into()
            }
            "tool_search" if self.compact_disclosure => {
                crate::tool_catalog::Search::parse(input.clone())?;
                ".".into()
            }
            "read_file" | "read_image" => {
                serde_json::from_value::<ReadInput>(input.clone())
                    .map_err(|_| ToolError::InvalidInput)?
                    .path
            }
            "load_skill" => {
                SkillInput::parse(input.clone())?;
                ".".into()
            }
            "task_list" if self.delegation_enabled => {
                if input != json!({}) {
                    return Err(ToolError::InvalidInput);
                }
                ".".into()
            }
            "task_result" | "task_cancel" if self.delegation_enabled => {
                crate::subagent::Selector::parse(input.clone())?;
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
            "monitor" if self.background_enabled => ".".into(),
            _ if self.is_product(name) => ".".into(),
            "start_job" if self.background_enabled => process::Input::parse(input.clone())?.cwd,
            "job_status" | "cancel_job" if self.background_enabled => {
                crate::jobs::Selector::parse(input.clone())?;
                ".".into()
            }
            "job_list" if self.background_enabled => {
                if input != json!({}) {
                    return Err(ToolError::InvalidInput);
                }
                ".".into()
            }
            "job_wait" if self.background_enabled => {
                crate::jobs::Wait::parse(input.clone())?;
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
        } else if name == "knowledge" {
            self.contained_target(&path).await?
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
            "run_command" | "bash" | "start_job" | "monitor" | "terminal_start" | "glob" | "grep"
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
            let parsed = SkillInput::parse(input.clone())?;
            if parsed.name == "media-observe" {
                "@builtin/skill/media-observe".into()
            } else {
                format!("@skills/{}", parsed.name)
            }
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
            input
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("@subagent")
                .to_owned()
        } else if name == "task_list" {
            "@subagents".into()
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
        } else if name == "job_wait" {
            format!("@jobs/{}", crate::jobs::Wait::parse(input.clone())?.job_id)
        } else if name == "task_result" || name == "task_cancel" {
            format!(
                "@subagents/{}",
                crate::subagent::Selector::parse(input.clone())?.id
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
        } else if matches!(
            name,
            "cancel_wakeup" | "todowrite" | "goal" | "cron_delete" | "task_list" | "task_result"
        ) || self.is_product(name)
        {
            Access::SessionState
        } else if name == "start_job" || name == "monitor" || name.starts_with("terminal_") {
            Access::Background
        } else if matches!(name, "task" | "task_cancel") {
            Access::Delegate
        } else if matches!(name, "run_command" | "bash") {
            Access::Execute
        } else if matches!(name, "write_file" | "edit_file" | "apply_patch")
            || (name == "knowledge"
                && matches!(input["op"].as_str(), Some("put" | "index_file" | "delete")))
        {
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
            // Runtime-owned operations cannot run through the local filesystem/LSP executor.
            batchable_read: access == Access::Read
                && !matches!(
                    name,
                    "question"
                        | "recall"
                        | "cron_list"
                        | "job_status"
                        | "job_list"
                        | "job_wait"
                        | "cancel_job"
                        | "task_list"
                        | "task_result"
                        | "task_cancel"
                ),
            access,
            name: name.into(),
            input,
            path,
            resource,
            targets,
            select: None,
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

    pub(crate) async fn prepare_command_reference(
        &self,
        path: &str,
    ) -> Result<Prepared, ToolError> {
        command_reference::prepare(self, path).await
    }

    pub(crate) async fn read_command_reference(
        &self,
        prepared: Prepared,
        policy: &Policy,
        cancel: CancellationToken,
    ) -> Result<crate::protocol::Attachment, ToolError> {
        command_reference::read(self, prepared, policy, cancel).await
    }

    pub(crate) async fn execute_prepared(
        &self,
        prepared: Prepared,
        policy: &Policy,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        self.execute_prepared_with_progress(prepared, policy, cancel, None)
            .await
    }

    pub(crate) async fn execute_prepared_with_progress(
        &self,
        prepared: Prepared,
        policy: &Policy,
        cancel: CancellationToken,
        progress: Option<process::Progress>,
    ) -> Result<Value, ToolError> {
        if prepared.name() == "knowledge" && prepared.access() == Access::Read {
            return self.execute_knowledge(prepared, policy, "", cancel).await;
        }
        if prepared.access() == Access::Web {
            return self
                .web
                .as_ref()
                .ok_or(ToolError::Unsupported)?
                .execute(&prepared.name, prepared.input, policy, cancel)
                .await;
        }
        if prepared.access() == Access::External {
            let output = if crate::worker::owns(prepared.name()) {
                self.worker
                    .as_ref()
                    .ok_or(ToolError::Unsupported)?
                    .call(&prepared.name, prepared.input, cancel)
                    .await?
            } else {
                self.mcp
                    .as_ref()
                    .ok_or(ToolError::Unsupported)?
                    .call(&prepared.name, prepared.input, cancel)
                    .await?
            };
            return Ok(crate::tool_catalog::project(output, prepared.select));
        }
        if prepared.name() == "tool_search" && self.compact_disclosure {
            let tools = self
                .extension_definitions()
                .into_iter()
                .filter(|tool| {
                    let resource = self
                        .mcp
                        .as_ref()
                        .and_then(|registry| registry.resource(&tool.name))
                        .or_else(|| {
                            self.worker
                                .as_ref()
                                .and_then(|registry| registry.resource(&tool.name))
                        });
                    resource.is_some_and(|resource| {
                        policy.evaluate(&tool.name, &resource, Access::External)
                            != crate::permission::Decision::Deny
                    })
                })
                .collect();
            return Ok(crate::tool_catalog::Search::parse(prepared.input)?.run(tools));
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
            return process::execute_with_progress(
                runner,
                &self.root,
                &prepared.path,
                input,
                self.process_network,
                cancel,
                progress,
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
                let (applied, _lease) = tokio::task::spawn_blocking(move || {
                    (crate::patch::apply(&directory, &operations), lease)
                })
                .await
                .map_err(|_| ToolError::Io(std::io::Error::other("file commit worker failed")))?;
                let mut applied = applied?;
                if let Some(files) = applied["files"].as_array_mut() {
                    for file in files {
                        if file["action"] == "delete" {
                            continue;
                        }
                        if let Some(path) = file["path"].as_str().map(|path| self.root.join(path)) {
                            self.format_mutation(&path, file, &cancel).await;
                        }
                    }
                }
                return Ok(applied);
            }
            let mutation = Mutation::parse(&prepared.name, prepared.input.clone())?;
            // The rebase statistics describe the text the model asked to
            // replace, whichever form named it.
            let anchor = match &mutation {
                Mutation::Edit(edit) => Some(edit.old_string.clone()),
                Mutation::Write(_) => None,
            };
            let snapshot = if self.edit_recovery && prepared.name == "edit_file" {
                self.edit_snapshots.lock().ok().and_then(|snapshots| {
                    snapshots
                        .lookup(&prepared.path.to_string_lossy())
                        .map(str::to_owned)
                })
            } else {
                None
            };
            let (mut applied, _lease) = tokio::task::spawn_blocking(move || {
                (apply(&directory, &relative, mutation, snapshot), lease)
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
            if let Ok(value) = applied.as_mut() {
                self.format_mutation(&prepared.path, value, &cancel).await;
            }
            // Errors and warnings from the file the mutation just changed, so
            // the model can repair them in the same turn instead of discovering
            // them a query later. Bounded: a noisy server cannot flood context.
            if self.lsp_diagnostics && matches!(prepared.name.as_str(), "edit_file" | "write_file")
            {
                if let (Ok(value), Some(registry)) = (applied.as_mut(), self.lsp.clone()) {
                    if let Ok(result) = registry.diagnostics(&prepared.path).await {
                        let matches = result["source"]["sha256"] == value["sha256"];
                        let mut source = result["source"].clone();
                        source["matches_applied_revision"] = json!(matches);
                        if let Value::Object(fields) = value {
                            fields.insert("diagnostics_source".into(), source);
                            if matches && result["source"]["stale"] == false {
                                if let Some(report) = report_diagnostics(&result) {
                                    fields.insert("diagnostics".into(), report);
                                }
                            }
                        }
                    }
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
        vec![
            ToolDefinition{name:"task".into(),description:"Delegate a self-contained task to a child Session. By default wait and return its final message; with background true, return as soon as the child is scheduled so it survives this turn. The child inherits this Session's workspace and permission policy, has its own run and cancellation, and is bounded by a subagent depth and concurrency limit. A child starts without this Session's history, so pass references (at most four) naming archived tool outputs by tool_use_id, with an optional offset, instead of restating their content. Requires explicit subagent authority.".into(),input_schema:json!({"type":"object","properties":{"agent":{"type":"string","minLength":1,"maxLength":128},"prompt":{"type":"string","minLength":1,"maxLength":65536},"session_id":{"type":"string","maxLength":256},"background":{"type":"boolean"},"references":{"type":"array","maxItems":4,"items":{"type":"object","properties":{"tool_use_id":{"type":"string","maxLength":128},"offset":{"type":"integer","minimum":0}},"required":["tool_use_id"],"additionalProperties":false}}},"required":["prompt"],"additionalProperties":false})},
            ToolDefinition{name:"task_list".into(),description:"List this Session's background subagent tasks, with child Session IDs and durable status.".into(),input_schema:json!({"type":"object","properties":{},"additionalProperties":false})},
            ToolDefinition{name:"task_result".into(),description:"Read a background task's durable report by the child Session ID returned from task. Does not wait or restart it.".into(),input_schema:json!({"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":256}},"required":["id"],"additionalProperties":false})},
            ToolDefinition{name:"task_cancel".into(),description:"Cancel an owned background subagent task. Interrupting the parent alone does not cancel background children.".into(),input_schema:json!({"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":256}},"required":["id"],"additionalProperties":false})},
        ]
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
            description:"Read a UTF-8 file or PDF under the configured workspace. Text reads are limited to 32768 bytes; for larger files pass a 1-based line offset and a line limit (up to 2000 lines) to read one window. PDF reads return page text and page images; pass pages such as 1-3,5 (at most 20 pages) to select pages.".into(),
            input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":2000},"pages":{"type":"string"}},"required":["path"],"additionalProperties":false}),
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
            description: "Load a skill by name from the available skills list in the system context. Returns its instructions plus the skill directory and sampled files, so relative script and reference paths can be resolved.".into(),
            input_schema: json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64}},"required":["name"],"additionalProperties":false}),
        });
        definitions.push(ToolDefinition {
            name:"knowledge".into(),
            description:"Reviewable workspace knowledge in .miao/knowledge.json. list(query?,limit?) returns a short source-freshness index; get(id,include_stale?) returns current sourced notes, or stale/unverified notes for explicit review. Writes also use expected_store_sha256 from list/get/write results (null creates the store). put requires id, expected_revision (0=create note), title, kind, body; repo_fact/file_index also require sources[{path,sha256}] and derivation. index_file(id,path,expected_revision) builds bounded lexical declaration candidates from one file; delete(id,expected_revision) removes a note. Sources must be readable workspace files. Preference/constraint notes expire after seven days by default. Writes use ordinary workspace write permission. Notes are advisory: current instructions, AGENTS.md and live source win.".into(),
            input_schema:json!({"type":"object","properties":{"op":{"type":"string","enum":["list","get","put","index_file","delete"]},"id":{"type":"string","maxLength":128},"query":{"type":"string","maxLength":256},"limit":{"type":"integer","minimum":1,"maximum":20},"include_stale":{"type":"boolean"},"expected_revision":{"type":"integer","minimum":0},"expected_store_sha256":{"type":["string","null"],"pattern":"^[a-fA-F0-9]{64}$"},"title":{"type":"string","maxLength":160},"kind":{"type":"string","enum":["repo_fact","preference","constraint","file_index"]},"body":{"type":"string","maxLength":8192},"derivation":{"type":"string","maxLength":2048},"sources":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"path":{"type":"string"},"sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"}},"required":["path","sha256"],"additionalProperties":false}},"ttl_seconds":{"type":"integer","minimum":1,"maximum":2592000},"path":{"type":"string"}},"required":["op"],"additionalProperties":false}),
        });
        definitions.push(ToolDefinition{name:"recall".into(),description:"Search this Session's raw immutable messages, including history before compaction. Literal case-sensitive substring; opaque provider state excluded. Pass tool_use_id instead of query to restore the elided middle of one tool output that context pruning replaced. Bounded scan pages may contain no matches; follow next_before_message_seq until exhausted.".into(),input_schema:json!({"type":"object","properties":{"query":{"type":"string","maxLength":512},"tool_use_id":{"type":"string","maxLength":128},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":20,"default":10},"before_message_seq":{"type":"integer","minimum":0}},"additionalProperties":false})});
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
                ToolDefinition{name:"apply_patch".into(),description:"Apply a strict V4A multi-file patch (Add/Update/Delete File sections with @@ hunks) as one transaction: all-or-nothing, context must match exactly, BOM/CRLF preserved, max 32 files/256 KiB patch/1 MiB per file. Requires permission approval for the whole patch.".into(),input_schema:json!({"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"],"additionalProperties":false})},
                        ToolDefinition{name:"edit_file".into(),description:"Conditionally replace an exact text match using the SHA-256 from read_file. Ambiguous matches fail unless replace_all=true. Requires permission approval.".into(),input_schema:json!({"type":"object","properties":{"path":{"type":"string"},"anchor":{"type":"string"},"new_text":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"expected_sha256":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","expected_sha256"],"additionalProperties":false})},
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
            definitions.push(ToolDefinition {
                name: "job_list".into(),
                description: "List this Session's managed background jobs and their status.".into(),
                input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
            });
            definitions.push(ToolDefinition{name:"job_wait".into(),description:"Wait for one of this Session's background jobs to finish (max 600000 ms).".into(),input_schema:json!({"type":"object","properties":{"job_id":{"type":"string"},"timeout_ms":{"type":"integer","minimum":0,"maximum":600000}},"required":["job_id"],"additionalProperties":false})});
            definitions.push(ToolDefinition{name:"monitor".into(),description:"Run a shell command in the background and stream stdout lines as monitor.notice progress events. Optional regex pattern filters delivered lines (batched ~200ms, max 200 lines/8KiB each, 64 notices then suppressed). Default timeout 600000 ms, max 3600000 ms kills the command. Cancel with cancel_job.".into(),input_schema:json!({"type":"object","properties":{"command":{"type":"string","minLength":1},"description":{"type":"string","maxLength":256},"pattern":{"type":"string","maxLength":512},"timeout_ms":{"type":"integer","minimum":1,"maximum":3600000}},"required":["command"],"additionalProperties":false})});
        }
        // Host-dispatched product tools do not need process or background
        // authority; keep their definitions available whenever the bridge is
        // attached.
        definitions.extend(self.product_tools.read().unwrap().iter().cloned());
        if let Some(web) = &self.web {
            definitions.extend(web.definitions());
        }
        definitions.extend(if self.compact_disclosure {
            crate::tool_catalog::definitions()
        } else {
            self.extension_definitions()
        });
        definitions
    }

    fn extension_definitions(&self) -> Vec<ToolDefinition> {
        self.mcp
            .iter()
            .flat_map(|registry| registry.definitions())
            .chain(
                self.worker
                    .iter()
                    .flat_map(|registry| registry.definitions()),
            )
            .collect()
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
                    let input = SkillInput::parse(input)?;
                    if input.name == "media-observe" {
                        return Ok(
                            json!({"name":input.name,"content":crate::context::MEDIA_OBSERVE,"sha256":digest(crate::context::MEDIA_OBSERVE.as_bytes()),"tool_mapping":{"bash":"bash","read_images":"read_image","read_text":"read_file"}}),
                        );
                    }
                    let skill = crate::context::find_skill(self, &input.name).ok_or_else(|| {
                        ToolError::External(format!("unknown skill: {}", input.name))
                    })?;
                    Ok(json!({
                        "name":skill.name,
                        "content":skill.content,
                        "sha256":digest(skill.content.as_bytes()),
                        "directory":skill.directory,
                        "files":skill.files,
                    }))
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
                    let metadata = tokio::fs::metadata(&path).await?;
                    if !metadata.is_file() {
                        return Err(ToolError::InvalidFile);
                    }
                    if path
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
                    {
                        return crate::pdf::read(&input.path, &path, input.pages.as_deref()).await;
                    }
                    // A line range makes a large file readable; the whole-file
                    // path keeps its historical 32 KiB bound.
                    let ranged = input.offset.is_some() || input.limit.is_some();
                    if ranged {
                        if input.offset == Some(0) || input.limit == Some(0) {
                            return Err(ToolError::InvalidInput);
                        }
                        if metadata.len() > 1024 * 1024 {
                            return Err(ToolError::InvalidFile);
                        }
                    } else if metadata.len() > 32768 {
                        // Guide the model to the window instead of a bare
                        // refusal: without it a large file looks unreadable.
                        return Err(ToolError::TooLarge(metadata.len() as usize));
                    }
                    let mut bytes = Vec::new();
                    tokio::fs::File::open(&path)
                        .await?
                        .take(1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .await?;
                    if bytes.len() > 1024 * 1024 || (!ranged && bytes.len() > 32768) {
                        return Err(ToolError::InvalidFile);
                    }
                    let sha256 = digest(&bytes);
                    let text = String::from_utf8(bytes).map_err(|_| ToolError::InvalidFile)?;
                    if let Some(registry) = self.lsp.clone() {
                        if self.lsp_diagnostics {
                            // Fire-and-forget: a read must never wait on a
                            // language server, and warming never fails it.
                            let warmed = path.clone();
                            tokio::spawn(async move {
                                registry.warm(&warmed).await;
                            });
                        }
                    }
                    let (visible, window) = if ranged {
                        let offset = input.offset.unwrap_or(1);
                        let limit = input.limit.unwrap_or(MAX_READ_LINES).min(MAX_READ_LINES);
                        let total = text.lines().count();
                        let mut window = String::new();
                        let mut lines = 0usize;
                        for line in text.lines().skip(offset - 1).take(limit) {
                            let extra = line.len() + usize::from(!window.is_empty());
                            if lines > 0 && window.len() + extra > 32768 {
                                break;
                            }
                            if !window.is_empty() {
                                window.push('\n');
                            }
                            window.push_str(line);
                            lines += 1;
                        }
                        let truncated = offset.saturating_sub(1) + lines < total;
                        (
                            window,
                            json!({
                                "offset": offset,
                                "lines": lines,
                                "total_lines": total,
                                "truncated": truncated
                            }),
                        )
                    } else {
                        (text.clone(), Value::Null)
                    };
                    // The edit-rebase snapshot only records text the model
                    // actually saw: a full read, or a window that covered the
                    // whole file.
                    let covered_everything = !ranged
                        || (window["offset"] == json!(1) && window["truncated"] == json!(false));
                    if covered_everything {
                        if let Ok(mut snapshots) = self.edit_snapshots.lock() {
                            snapshots.register(path.to_string_lossy().into_owned(), text.clone());
                        }
                    }
                    if ranged {
                        let mut result = json!({"text": visible, "sha256": sha256});
                        if let (Value::Object(fields), Value::Object(window_fields)) =
                            (&mut result, window)
                        {
                            fields.extend(window_fields);
                        }
                        return Ok(result);
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

/// Bounded error/warning report from an LSP diagnostics payload.
fn report_diagnostics(value: &Value) -> Option<Value> {
    let entries = value.get("diagnostics")?.as_array()?;
    let report: Vec<Value> = entries
        .iter()
        .filter_map(|diagnostic| {
            let severity = diagnostic.get("severity")?.as_u64()?;
            if severity > 2 {
                return None;
            }
            let line = diagnostic
                .get("range")?
                .get("start")?
                .get("line")?
                .as_u64()?;
            let message = diagnostic.get("message")?.as_str()?;
            Some(json!({
                "line": line,
                "severity": severity,
                "message": message.chars().take(200).collect::<String>(),
            }))
        })
        .take(20)
        .collect();
    (!report.is_empty()).then(|| json!(report))
}
