//! Product config derivation inside the engine (S5, step 2).
//!
//! Step 1 (`config_scope`) reads the product config files; this module turns
//! the loaded documents into the configs the host used to materialize as temp
//! files (`product-policy.ts`, `product-lsp.ts`). Every rule here mirrors a
//! product-side derivation and is pinned by the shared golden fixtures in
//! `tests/fixtures/config-golden`, which the TypeScript suite also reads: two
//! implementations, one set of samples.

use crate::{config_scope, context, formatter, hooks, lsp, mcp, permission, tools};
use serde_json::Value;
use std::{path::Path, path::PathBuf, sync::Arc};

/// One ordered configuration source from the host, lowest priority first.
#[derive(Clone)]
pub enum Source {
    /// A directory: `config_scope::FILE_NAMES` inside it, in name order.
    Dir(PathBuf),
    /// A single config file read as one document.
    File(PathBuf),
    /// An inline document body (the host's `MIAO_CONFIG_CONTENT`).
    Content(String),
}

/// One loaded document: where it came from (for errors) and its parsed value.
pub struct Document {
    pub origin: String,
    pub value: Value,
}

/// Load every source in order. A missing file inside a directory is skipped;
/// an unreadable file or a malformed document is an error naming the source.
/// Sections the engine derives are validated with their key paths, so a
/// mistyped `sandbox` or `lsp` entry fails the way the product's schema
/// decode does instead of silently falling back to the default.
/// The S5 unified read model: load the same ordered sources the host
/// forwards, migrate each V1-shaped document the way the product's decode
/// does, filter unknown top-level keys, and merge lowest to highest. The
/// result is the normalized document both engines must agree on, pinned by
/// the shared golden samples.
pub fn normalized_from_sources(sources: &[Source]) -> Result<Value, String> {
    let documents = load(sources)?;
    let mut values = Vec::with_capacity(documents.len());
    for document in &documents {
        values.push(if crate::config_v1::is_v1(&document.value) {
            crate::config_v1::migrate(&document.value)
        } else {
            crate::config_v1::normalize(&document.value)
        });
    }
    Ok(crate::config_scope::merge_values(&values))
}

pub fn load(sources: &[Source]) -> Result<Vec<Document>, String> {
    let mut documents = Vec::new();
    for source in sources {
        match source {
            Source::Dir(directory) => {
                for (path, value) in config_scope::documents(std::slice::from_ref(directory))? {
                    let origin = path.display().to_string();
                    validate(&origin, &value)?;
                    documents.push(Document { origin, value });
                }
            }
            Source::File(path) => {
                let text = std::fs::read_to_string(path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                let value = config_scope::parse_document(&text)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                let origin = path.display().to_string();
                validate(&origin, &value)?;
                documents.push(Document { origin, value });
            }
            Source::Content(text) => {
                let value = config_scope::parse_document(text)
                    .map_err(|error| format!("inline config: {error}"))?;
                validate("inline config", &value)?;
                documents.push(Document {
                    origin: "inline config".to_string(),
                    value,
                });
            }
        }
    }
    Ok(documents)
}

/// Validate the root object and `sandbox`/`lsp` section shapes against the
/// product's config schema, naming the source and key path on a mismatch.
fn validate(origin: &str, value: &serde_json::Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(format!("{origin}: config root must be an object"));
    };
    match object.get("sandbox") {
        None => {}
        Some(sandbox) => validate_sandbox(origin, sandbox)?,
    }
    match object.get("lsp") {
        None => {}
        Some(lsp) => validate_lsp(origin, lsp)?,
    }
    Ok(())
}

fn validate_sandbox(origin: &str, sandbox: &serde_json::Value) -> Result<(), String> {
    let Some(sandbox) = sandbox.as_object() else {
        return Err(format!("{origin}: sandbox must be an object"));
    };
    if let Some(mode) = sandbox.get("mode") {
        if mode.as_str() != Some("off") && mode.as_str() != Some("workspace-write") {
            return Err(format!(
                "{origin}: sandbox.mode must be \"off\" or \"workspace-write\""
            ));
        }
    }
    if let Some(network) = sandbox.get("network") {
        if !network.is_boolean() {
            return Err(format!("{origin}: sandbox.network must be a boolean"));
        }
    }
    if let Some(roots) = sandbox.get("writable_roots") {
        if roots
            .as_array()
            .is_none_or(|roots| roots.iter().any(|root| !root.is_string()))
        {
            return Err(format!(
                "{origin}: sandbox.writable_roots must be an array of strings"
            ));
        }
    }
    if let Some(on_unavailable) = sandbox.get("on_unavailable") {
        if on_unavailable.as_str() != Some("warn") && on_unavailable.as_str() != Some("fail") {
            return Err(format!(
                "{origin}: sandbox.on_unavailable must be \"warn\" or \"fail\""
            ));
        }
    }
    Ok(())
}

fn validate_lsp(origin: &str, lsp: &serde_json::Value) -> Result<(), String> {
    if lsp.is_boolean() {
        return Ok(());
    }
    let Some(entries) = lsp.as_object() else {
        return Err(format!("{origin}: lsp must be a boolean or an object"));
    };
    for (id, entry) in entries {
        let Some(entry) = entry.as_object() else {
            return Err(format!("{origin}: lsp.{id} must be an object"));
        };
        if entry.get("disabled") == Some(&serde_json::Value::Bool(true)) {
            continue;
        }
        if let Some(disabled) = entry.get("disabled") {
            if !disabled.is_boolean() {
                return Err(format!("{origin}: lsp.{id}.disabled must be a boolean"));
            }
        }
        // The product schema's Server variant requires a command; only the
        // Disabled variant may omit it, so a command-less entry refuses the
        // same way the schema decode does.
        let Some(command) = entry.get("command") else {
            return Err(format!(
                "{origin}: lsp.{id}.command must be an array of strings"
            ));
        };
        if !command.is_array()
            || command.as_array().unwrap().is_empty()
            || command
                .as_array()
                .unwrap()
                .iter()
                .any(|part| !part.is_string())
        {
            return Err(format!(
                "{origin}: lsp.{id}.command must be an array of strings"
            ));
        }
        if let Some(extensions) = entry.get("extensions") {
            if extensions
                .as_array()
                .is_none_or(|items| items.iter().any(|item| !item.is_string()))
            {
                return Err(format!(
                    "{origin}: lsp.{id}.extensions must be an array of strings"
                ));
            }
        }
        if let Some(env) = entry.get("env") {
            if !env.is_object()
                || env
                    .as_object()
                    .unwrap()
                    .iter()
                    .any(|(_, value)| !value.is_string())
            {
                return Err(format!(
                    "{origin}: lsp.{id}.env must map strings to strings"
                ));
            }
        }
        if let Some(initialization) = entry.get("initialization") {
            if !initialization.is_object() {
                return Err(format!(
                    "{origin}: lsp.{id}.initialization must be an object"
                ));
            }
        }
    }
    Ok(())
}

/// The product capability policy the host used to materialize as a temp file:
/// workspace mode with every capability family its ordered agent rules can
/// address, no implicit request-count cutoff, and the operator's OS-sandbox
/// choice recorded for process commands.
pub fn policy(documents: &[Document], miao_sandbox: Option<&str>) -> permission::Config {
    permission::Config {
        mode: permission::Mode::Workspace,
        allow_process: true,
        allow_background: true,
        allow_subagents: true,
        allow_mcp: true,
        allow_web: true,
        allow_wakeup: true,
        allow_cron: true,
        process_network: true,
        sandbox: sandbox_enabled(documents, miao_sandbox),
        rules: Vec::new(),
        // Matches the engine's default; the product policy never sets it.
        approval_timeout_ms: 60_000,
        max_provider_turns: None,
    }
}

/// The native sandbox switch (product `SandboxPolicy.nativeEnabled`): an
/// explicit `MIAO_SANDBOX` wins in both directions, the merged `sandbox.mode`
/// decides otherwise, and with neither the engine keeps confining commands.
pub fn sandbox_enabled(documents: &[Document], miao_sandbox: Option<&str>) -> bool {
    if let Some(decision) = env_switch(miao_sandbox) {
        return decision;
    }
    let values = documents
        .iter()
        .map(|document| document.value.clone())
        .collect::<Vec<_>>();
    let merged = config_scope::merge_values(&values);
    !matches!(
        merged
            .get("sandbox")
            .and_then(Value::as_object)
            .and_then(|sandbox| sandbox.get("mode"))
            .and_then(Value::as_str),
        Some("off")
    )
}

fn env_switch(value: Option<&str>) -> Option<bool> {
    match value {
        None | Some("") => None,
        Some(value) => Some(value.eq_ignore_ascii_case("1") || value.eq_ignore_ascii_case("true")),
    }
}

/// Derive the product policy from one config directory plus the environment:
/// the entry `serve`/`acp` path when the host passes `--config-dir` instead of
/// materializing a policy file.
pub fn policy_from_directory(
    directory: &std::path::Path,
    miao_sandbox: Option<&str>,
) -> Result<permission::Config, String> {
    let documents = load(std::slice::from_ref(&Source::Dir(directory.to_path_buf())))?;
    Ok(policy(&documents, miao_sandbox))
}

/// Derive the product policy from the host's ordered source plan: the same
/// documents the product's Config service applies, lowest priority first.
pub fn policy_from_sources(
    sources: &[Source],
    miao_sandbox: Option<&str>,
) -> Result<permission::Config, String> {
    let documents = load(sources)?;
    Ok(policy(&documents, miao_sandbox))
}

/// Where the engine derives LSP servers from. Kept for the lifetime of the
/// process so a reload derives exactly the way startup did: the same files, the
/// same precedence, and the same built-in table.
#[derive(Clone)]
pub enum LspOrigin {
    /// `--lsp-config`: a host-materialized manifest outside the workspace.
    Manifest(PathBuf),
    /// `--config-sources`: the host's ordered source plan.
    Sources(Vec<Source>),
    /// `--config-dir`: one directory, the standalone entry.
    Directory(PathBuf),
}

/// Where startup read the MCP server list from. Only the host-supplied
/// manifest exists today, but a reload re-reads exactly the file the operator
/// named rather than any caller-supplied snapshot.
#[derive(Clone)]
pub enum McpOrigin {
    /// `--mcp-config`: a host-materialized server manifest outside the
    /// workspace.
    Manifest(PathBuf),
}

impl McpOrigin {
    pub fn derive(&self) -> Result<Vec<mcp::Config>, String> {
        match self {
            McpOrigin::Manifest(path) => {
                let bytes =
                    std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
                if bytes.len() > 65536 {
                    return Err("MCP config exceeds 64 KiB".into());
                }
                serde_json::from_slice(&bytes).map_err(|error| {
                    format!("{}: invalid MCP host config: {error}", path.display())
                })
            }
        }
    }

    /// The files a reload would read, for a cheap change check.
    pub fn files(&self) -> Vec<PathBuf> {
        match self {
            McpOrigin::Manifest(path) => vec![path.clone()],
        }
    }
}

/// Where the engine read the context-carrying host configuration from. Each
/// part is independent — the operator may supply any subset of the five host
/// files — and a part no operator supplied cannot appear on reload.
#[derive(Clone, Default)]
pub struct ContextOrigin {
    pub sources: Option<PathBuf>,
    pub skills: Option<PathBuf>,
    pub references: Option<PathBuf>,
    pub hooks: Option<PathBuf>,
    pub formatter: Option<PathBuf>,
}

/// The context configuration, derived part by part. `None` means the operator
/// supplied no file for that part; an empty list means they supplied one that
/// selects nothing.
pub struct ContextParts {
    pub sources: Option<Vec<context::Source>>,
    pub skills: Option<Vec<context::SkillDirectory>>,
    /// References with the read scope they resolve to, so replacing them can
    /// never pair one list with another's scope.
    pub references: Option<(Vec<context::Reference>, Vec<PathBuf>)>,
    pub hooks: Option<Vec<hooks::Hook>>,
    pub formatter: Option<Arc<formatter::Registry>>,
}

impl ContextOrigin {
    /// Read and validate every configured part. Nothing is applied here, so a
    /// malformed file fails the whole reload with its own name and leaves the
    /// running configuration untouched.
    pub fn derive(&self, workspace: &Path) -> Result<ContextParts, String> {
        Ok(ContextParts {
            sources: match &self.sources {
                Some(path) => {
                    let sources: Vec<context::Source> = read_part(path, "Context", workspace)?;
                    context::validate(&sources).map_err(|error| invalid(path, &error))?;
                    Some(sources)
                }
                None => None,
            },
            skills: match &self.skills {
                Some(path) => {
                    let skills: Vec<context::SkillDirectory> =
                        read_part(path, "Skills", workspace)?;
                    context::validate_skills(&skills).map_err(|error| invalid(path, &error))?;
                    Some(skills)
                }
                None => None,
            },
            references: match &self.references {
                Some(path) => {
                    let references: Vec<context::Reference> =
                        read_part(path, "References", workspace)?;
                    let resolved = tools::resolve_references(references)
                        .map_err(|error| invalid(path, &error))?;
                    Some(resolved)
                }
                None => None,
            },
            hooks: match &self.hooks {
                Some(path) => {
                    let hooks: Vec<hooks::Hook> = read_part(path, "Hooks", workspace)?;
                    hooks::validate(&hooks).map_err(|error| invalid(path, &error))?;
                    Some(hooks)
                }
                None => None,
            },
            formatter: match &self.formatter {
                Some(path) => {
                    let configs: Vec<formatter::Config> = read_part(path, "formatter", workspace)?;
                    let registry = formatter::Registry::new(configs, workspace)
                        .map_err(|error| invalid(path, &error))?;
                    Some(Arc::new(registry))
                }
                None => None,
            },
        })
    }

    /// The files a reload would read, for a cheap change check.
    pub fn files(&self) -> Vec<PathBuf> {
        [
            &self.sources,
            &self.skills,
            &self.references,
            &self.hooks,
            &self.formatter,
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect()
    }
}

impl ContextParts {
    /// Swap the parts that differ from the running `Tools` and report each one,
    /// so the reload report can name them. Everything was validated when this
    /// was derived, so the swap itself cannot fail; a part whose content did
    /// not change is not touched at all.
    pub fn apply(self, tools: &tools::Tools) -> Vec<(&'static str, bool)> {
        let mut outcome = Vec::new();
        if let Some(sources) = self.sources {
            let changed = sources != *tools.context_sources();
            if changed {
                tools.set_context_sources(sources);
            }
            outcome.push(("sources", changed));
        }
        if let Some(skills) = self.skills {
            let changed = skills != *tools.skill_directories();
            if changed {
                tools.set_skill_directories(skills);
            }
            outcome.push(("skills", changed));
        }
        if let Some((references, roots)) = self.references {
            let changed = references != *tools.references();
            if changed {
                tools.set_references(references, roots);
            }
            outcome.push(("references", changed));
        }
        if let Some(hooks) = self.hooks {
            let changed = hooks != *tools.hooks();
            if changed {
                tools.set_hooks(hooks);
            }
            outcome.push(("hooks", changed));
        }
        if let Some(formatter) = self.formatter {
            let changed = Some(formatter.descriptor())
                != tools.formatter().map(|registry| registry.descriptor());
            if changed {
                tools.set_formatter(formatter);
            }
            outcome.push(("formatter", changed));
        }
        outcome
    }
}

/// Read one host file for a context part. The boundary and size limits mirror
/// startup's, so a reload accepts exactly the files startup would.
fn read_part<T: serde::de::DeserializeOwned>(
    path: &Path,
    label: &str,
    workspace: &Path,
) -> Result<T, String> {
    if path.starts_with(workspace) {
        return Err(format!(
            "{}: {label} host config must be outside model-writable workspace",
            path.display()
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| invalid(path, &error))?;
    if bytes.len() > 65536 {
        return Err(format!("{}: {label} config exceeds 64 KiB", path.display()));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{}: invalid {label} host config: {error}", path.display()))
}

fn invalid(path: &Path, error: &impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

impl LspOrigin {
    pub fn derive(&self) -> Result<Vec<lsp::Config>, String> {
        match self {
            LspOrigin::Manifest(path) => {
                let bytes =
                    std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
                if bytes.len() > 65536 {
                    return Err("LSP config exceeds 64 KiB".into());
                }
                serde_json::from_slice(&bytes).map_err(|_| "invalid LSP host config".to_string())
            }
            LspOrigin::Sources(sources) => lsp_from_documents(&load(sources)?),
            LspOrigin::Directory(directory) => lsp_from_documents(&load(std::slice::from_ref(
                &Source::Dir(directory.clone()),
            ))?),
        }
    }

    /// The files a reload would read, for a cheap change check. Inline
    /// `Content` sources have no file and never change on disk.
    pub fn files(&self) -> Vec<PathBuf> {
        match self {
            LspOrigin::Manifest(path) => vec![path.clone()],
            LspOrigin::Directory(directory) => files_in(directory),
            LspOrigin::Sources(sources) => sources
                .iter()
                .flat_map(|source| match source {
                    Source::Dir(directory) => files_in(directory),
                    Source::File(path) => vec![path.clone()],
                    Source::Content(_) => Vec::new(),
                })
                .collect(),
        }
    }
}

fn files_in(directory: &std::path::Path) -> Vec<PathBuf> {
    config_scope::FILE_NAMES
        .iter()
        .map(|name| directory.join(name))
        .collect()
}

/// Where the engine derives its base permission policy from. Kept for the
/// process lifetime so a reload derives exactly the way startup did instead of
/// guessing at a source the operator never named.
#[derive(Clone)]
pub enum PolicyOrigin {
    /// `--policy`: a host-materialized permission config.
    File(PathBuf),
    /// `--config-sources`: the host's ordered source plan.
    Sources(Vec<Source>),
    /// `--config-dir`: one directory, the standalone entry.
    Directory(PathBuf),
    /// No operator source: the entry's own default. `acp` selects which.
    Entry { acp: bool },
}

impl PolicyOrigin {
    /// Re-derive the policy from the sources. `mode` is the operator's
    /// `--mode` override, applied last because it wins over both the entry
    /// default and a policy file. The sandbox switch is re-read from the
    /// environment, which cannot change inside a running process.
    pub fn derive(&self, mode: Option<permission::Mode>) -> Result<permission::Config, String> {
        let sandbox = std::env::var("MIAO_SANDBOX").ok();
        let mut config = match self {
            PolicyOrigin::File(path) => {
                let bytes =
                    std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
                if bytes.len() > 65536 {
                    return Err("permission config exceeds 64 KiB".into());
                }
                serde_json::from_slice(&bytes)
                    .map_err(|error| format!("{}: {error}", path.display()))?
            }
            PolicyOrigin::Sources(sources) => policy_from_sources(sources, sandbox.as_deref())?,
            PolicyOrigin::Directory(directory) => {
                policy_from_directory(directory, sandbox.as_deref())?
            }
            PolicyOrigin::Entry { acp } => permission::Config::for_entry(*acp),
        };
        if let Some(mode) = mode {
            config.mode = mode;
        }
        Ok(config)
    }

    /// The files a reload would read, for a cheap change check.
    pub fn files(&self) -> Vec<PathBuf> {
        match self {
            PolicyOrigin::File(path) => vec![path.clone()],
            PolicyOrigin::Directory(directory) => files_in(directory),
            PolicyOrigin::Sources(sources) => sources
                .iter()
                .flat_map(|source| match source {
                    Source::Dir(directory) => files_in(directory),
                    Source::File(path) => vec![path.clone()],
                    Source::Content(_) => Vec::new(),
                })
                .collect(),
            PolicyOrigin::Entry { .. } => Vec::new(),
        }
    }
}

fn lsp_from_documents(documents: &[Document]) -> Result<Vec<lsp::Config>, String> {
    let configured = lsp_configured(documents);
    lsp_entries(configured.as_ref(), &BUILTIN_SERVERS, &system_lookup())
}

/// Parse the host's ordered source plan: a JSON array of `{"dir": path}`,
/// `{"file": path}` or `{"content": text}` entries, lowest priority first.
pub fn plan(text: &str) -> Result<Vec<Source>, String> {
    if text.len() > 65536 {
        return Err("config source plan exceeds 64 KiB".into());
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|error| format!("invalid config source plan: {error}"))?;
    let entries = value
        .as_array()
        .ok_or("config source plan must be a JSON array")?;
    entries
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or("config source plan entries must be objects")?;
            match (object.get("dir"), object.get("file"), object.get("content")) {
                (Some(dir), None, None) => Ok(Source::Dir(PathBuf::from(
                    dir.as_str().ok_or("config source dir must be a string")?,
                ))),
                (None, Some(file), None) => Ok(Source::File(PathBuf::from(
                    file.as_str().ok_or("config source file must be a string")?,
                ))),
                (None, None, Some(content)) => Ok(Source::Content(
                    content
                        .as_str()
                        .ok_or("config source content must be a string")?
                        .to_string(),
                )),
                _ => Err("config source entry needs exactly one of dir, file, content".into()),
            }
        })
        .collect()
}

/// A built-in language server, ported from the product's `LSPServer.servers`.
/// The golden fixtures pin this table against the TypeScript original; a
/// product-side change must land here and in the fixtures together.
pub struct BuiltinServer {
    pub id: &'static str,
    pub command: &'static [&'static str],
    pub extensions: &'static [&'static str],
}

pub const BUILTIN_SERVERS: [BuiltinServer; 5] = [
    BuiltinServer {
        id: "typescript",
        command: &["typescript-language-server", "--stdio"],
        extensions: &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    },
    BuiltinServer {
        id: "gopls",
        command: &["gopls"],
        extensions: &[".go"],
    },
    BuiltinServer {
        id: "rust",
        command: &["rust-analyzer"],
        extensions: &[".rs"],
    },
    BuiltinServer {
        id: "pyright",
        command: &["pyright-langserver", "--stdio"],
        extensions: &[".py", ".pyi"],
    },
    BuiltinServer {
        id: "clangd",
        command: &["clangd"],
        extensions: &[".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"],
    },
];

/// The configured `lsp` section: the last document defining one wins whole,
/// which is how the product reads it (`findLast` over its documents) — a
/// partial section in a later file replaces the earlier one entirely.
pub fn lsp_configured(documents: &[Document]) -> Option<Value> {
    documents
        .iter()
        .rev()
        .find(|document| {
            document
                .value
                .get("lsp")
                .is_some_and(|lsp| lsp.is_boolean() || lsp.is_object())
        })
        .and_then(|document| document.value.get("lsp").cloned())
}

/// Resolve the configured section into concrete servers: built-ins carry the
/// defaults, `disabled: true` removes a server, and an entry with a `command`
/// replaces the server whole (a command-less entry leaves the default alone).
/// Servers whose executable is not installed are skipped, matching the
/// product's `which` filter.
pub fn lsp_entries(
    configured: Option<&Value>,
    builtin: &[BuiltinServer],
    lookup: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Vec<lsp::Config>, String> {
    let mut servers: Vec<(String, Value)> = builtin
        .iter()
        .map(|server| {
            (
                server.id.to_string(),
                serde_json::json!({"command": server.command, "extensions": server.extensions}),
            )
        })
        .collect();
    match configured {
        None | Some(Value::Bool(true)) => {}
        Some(Value::Bool(false)) => servers.clear(),
        Some(Value::Object(overrides)) => {
            for (id, entry) in overrides {
                let Some(entry) = entry.as_object() else {
                    continue;
                };
                if entry.get("disabled") == Some(&Value::Bool(true)) {
                    servers.retain(|(name, _)| name != id);
                    continue;
                }
                let command = entry.get("command").and_then(command_strings);
                if command.is_none() {
                    continue;
                }
                match servers.iter_mut().find(|(name, _)| name == id) {
                    Some(slot) => slot.1 = Value::Object(entry.clone()),
                    None => servers.push((id.clone(), Value::Object(entry.clone()))),
                }
            }
        }
        Some(_) => {}
    }
    let mut entries = Vec::new();
    for (id, value) in &servers {
        let command = value
            .get("command")
            .and_then(command_strings)
            .unwrap_or_default();
        let Some(executable) = command.first().and_then(|name| lookup(name)) else {
            continue;
        };
        let extensions = value
            .get("extensions")
            .and_then(strings)
            .or_else(|| {
                builtin.iter().find(|server| server.id == id).map(|server| {
                    server
                        .extensions
                        .iter()
                        .map(|extension| extension.to_string())
                        .collect()
                })
            })
            .unwrap_or_default();
        entries.push(lsp::Config {
            name: id.clone(),
            argv: std::iter::once(executable.display().to_string())
                .chain(command.into_iter().skip(1))
                .collect(),
            extensions,
            env: value.get("env").and_then(string_map).unwrap_or_default(),
            initialization: value
                .get("initialization")
                .and_then(Value::as_object)
                .map(|initialization| Value::Object(initialization.clone())),
        });
    }
    if entries.len() > 8 {
        return Err("native LSP supports at most 8 installed servers".into());
    }
    let extensions = entries
        .iter()
        .flat_map(|entry| entry.extensions.iter())
        .map(|extension| {
            extension
                .strip_prefix('.')
                .unwrap_or(extension)
                .to_lowercase()
        })
        .collect::<Vec<_>>();
    if extensions.len()
        != extensions
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    {
        return Err("native LSP requires one configured server per extension".into());
    }
    let bound = serde_json::to_vec(&entries).map_err(|error| error.to_string())?;
    if bound.len() > 65536 {
        return Err("LSP config exceeds 64 KiB".into());
    }
    Ok(entries)
}

fn command_strings(value: &Value) -> Option<Vec<String>> {
    let command = strings(value)?;
    (!command.is_empty()).then_some(command)
}

fn strings(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn string_map(value: &Value) -> Option<std::collections::BTreeMap<String, String>> {
    value.as_object().map(|map| {
        map.iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect()
    })
}

/// Resolve a server command the way the product `which()` does: a name with a
/// path separator is used as a path directly, otherwise every search directory
/// is tried in order, and on Windows each candidate also tries the `path_ext`
/// suffixes. A candidate must be an existing file (with an execute bit on unix).
pub fn resolve(command: &str, search: &[PathBuf], path_ext: &[String]) -> Option<PathBuf> {
    if command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        let path = PathBuf::from(command);
        return executable(&path).then_some(path);
    }
    for directory in search {
        let candidate = directory.join(command);
        if executable(&candidate) {
            return Some(candidate);
        }
        for extension in path_ext {
            let candidate = PathBuf::from(format!("{}{extension}", candidate.display()));
            if executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// The production lookup: `PATH` plus the product tool directory passed in
/// `MIAO_TOOL_BIN`, which is the product `which()` search order.
pub fn system_lookup() -> impl Fn(&str) -> Option<PathBuf> {
    let mut search: Vec<PathBuf> = match std::env::var_os("PATH") {
        Some(path) => std::env::split_paths(&path).collect(),
        None => Vec::new(),
    };
    if let Some(bin) = std::env::var_os("MIAO_TOOL_BIN") {
        search.push(PathBuf::from(bin));
    }
    let path_ext: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    move |command| resolve(command, &search, &path_ext)
}

fn executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod validate_tests {
    use super::*;

    fn validated(value: Value) -> Result<(), String> {
        validate("miao.json", &value)
    }

    #[test]
    fn a_mistyped_sandbox_mode_names_the_key_path() {
        assert_eq!(
            validated(serde_json::json!({"sandbox": {"mode": true}})).unwrap_err(),
            "miao.json: sandbox.mode must be \"off\" or \"workspace-write\""
        );
        assert!(validated(serde_json::json!({"sandbox": {"mode": "off"}})).is_ok());
    }

    #[test]
    fn a_boolean_sandbox_is_refused_like_the_product_schema() {
        assert_eq!(
            validated(serde_json::json!({"sandbox": true})).unwrap_err(),
            "miao.json: sandbox must be an object"
        );
    }

    #[test]
    fn lsp_entries_require_a_command_unless_disabled() {
        assert!(validated(serde_json::json!({"lsp": {"gopls": {"disabled": true}}})).is_ok());
        assert!(validated(serde_json::json!({"lsp": {"gopls": {}}})).is_err());
        assert!(validated(
            serde_json::json!({"lsp": {"gopls": {"command": ["gopls"], "extensions": [".go"]}}})
        )
        .is_ok());
        assert!(validated(serde_json::json!({"lsp": {"gopls": {"command": "gopls"}}})).is_err());
        assert!(validated(serde_json::json!({"lsp": {"gopls": 3}})).is_err());
        assert!(validated(serde_json::json!({"lsp": false})).is_ok());
    }

    #[test]
    fn known_config_fields_reject_null_and_mistyped_values() {
        for (value, key) in [
            (serde_json::json!({"sandbox": null}), "sandbox"),
            (serde_json::json!({"lsp": null}), "lsp"),
            (
                serde_json::json!({"sandbox": {"network": null}}),
                "sandbox.network",
            ),
            (
                serde_json::json!({"lsp": {"test": {"command": ["test"], "disabled": "yes"}}}),
                "lsp.test.disabled",
            ),
            (
                serde_json::json!({"lsp": {"test": {"command": ["test"], "disabled": null}}}),
                "lsp.test.disabled",
            ),
            (
                serde_json::json!({"lsp": {"test": {"command": ["test"], "initialization": 42}}}),
                "lsp.test.initialization",
            ),
            (
                serde_json::json!({"lsp": {"test": {"command": ["test"], "initialization": null}}}),
                "lsp.test.initialization",
            ),
            (
                serde_json::json!({"lsp": {"test": {"command": ["test"], "initialization": []}}}),
                "lsp.test.initialization",
            ),
        ] {
            let error = validated(value.clone()).expect_err(&format!("accepted {value}"));
            assert!(error.starts_with("miao.json:"), "{error}");
            assert!(error.contains(key), "{error}");
        }
    }

    #[test]
    fn legal_lsp_switches_and_disabled_variants_remain_valid() {
        for value in [
            serde_json::json!({"sandbox": {"network": false}}),
            serde_json::json!({"lsp": true}),
            serde_json::json!({"lsp": false}),
            serde_json::json!({"lsp": {"test": {"disabled": true, "command": 42, "initialization": 42}}}),
            serde_json::json!({"lsp": {"test": {"command": ["test"], "disabled": false, "initialization": {"settings": {}}}}}),
        ] {
            assert!(validated(value.clone()).is_ok(), "rejected {value}");
        }
    }

    #[test]
    fn unknown_keys_never_fail() {
        assert!(validated(serde_json::json!({"theme": "dark", "model": "x/y"})).is_ok());
    }
}

/// The merged configuration as a tree, so a leaf can name the document that
/// won it. An object holds its children; an array or scalar is a leaf, because
/// a higher-priority file replaces those whole.
enum Tree {
    Leaf {
        value: Value,
        origin: String,
        overridden: Vec<Value>,
    },
    Object(Vec<(String, Tree)>),
}

/// One effective leaf: the value the merged configuration reads, the document
/// that won it, and the values it replaced.
///
/// The product reports the same shape from `Config.explain`, and the shared
/// golden cases pin both readers to one answer so the engine and the TUI cannot
/// drift on which file a setting came from.
pub fn explain(documents: &[Document]) -> Value {
    let mut tree = Tree::Object(Vec::new());
    for document in documents {
        tree = merge_tree(tree, &document.value, &document.origin);
    }
    let mut keys = Vec::new();
    flatten(&tree, &mut Vec::new(), &mut keys);
    let sources = documents
        .iter()
        .map(|document| {
            let mut defined = Vec::new();
            collect_defined(&document.value, &mut Vec::new(), &mut defined);
            serde_json::json!({ "origin": document.origin, "keys": defined })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "sources": sources, "keys": keys })
}

/// Applies one document under the same rules as [`merge_values`]. A leaf that
/// records the value it replaced is an override; a leaf replacing an object, or
/// an object replacing a leaf, discards the previous value entirely, so there
/// is no override chain to report.
fn merge_tree(current: Tree, value: &Value, origin: &str) -> Tree {
    let Value::Object(map) = value else {
        let overridden = match current {
            Tree::Leaf {
                value: previous,
                origin: previous_origin,
                overridden: mut chain,
            } => {
                chain.push(serde_json::json!({ "value": previous, "origin": previous_origin }));
                chain
            }
            Tree::Object(_) => Vec::new(),
        };
        return Tree::Leaf {
            value: value.clone(),
            origin: origin.to_string(),
            overridden,
        };
    };
    let entries = match current {
        Tree::Object(entries) => entries,
        Tree::Leaf { .. } => Vec::new(),
    };
    // Keys the current document does not mention keep the value the earlier
    // documents gave them; only the keys it does mention are merged or
    // replaced. Building the result from this document alone would drop them.
    let mut merged: Vec<(String, Tree)> = entries;
    for (key, item) in map {
        let existing = merged
            .iter()
            .position(|(name, _)| name == key)
            .map(|index| merged.remove(index).1);
        let child = match existing {
            Some(existing) => merge_tree(existing, item, origin),
            None => merge_tree(Tree::Object(Vec::new()), item, origin),
        };
        merged.push((key.clone(), child));
    }
    Tree::Object(merged)
}

fn flatten(tree: &Tree, prefix: &mut Vec<String>, out: &mut Vec<Value>) {
    match tree {
        Tree::Leaf {
            value,
            origin,
            overridden,
        } => out.push(serde_json::json!({
            "path": prefix.clone(),
            "value": value,
            "origin": origin,
            "overridden": overridden,
        })),
        Tree::Object(entries) => {
            for (key, child) in entries {
                prefix.push(key.clone());
                flatten(child, prefix, out);
                prefix.pop();
            }
        }
    }
}

/// The leaf paths a single document defines, in document order.
fn collect_defined(value: &Value, prefix: &mut Vec<String>, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                prefix.push(key.clone());
                collect_defined(item, prefix, out);
                prefix.pop();
            }
        }
        _ => out.push(Value::Array(
            prefix
                .iter()
                .map(|part| Value::String(part.clone()))
                .collect(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_object_documents_fail_with_the_origin_for_every_source_kind() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("miao.json");
        for text in ["null", "false", "42", "\"oops\"", "[]"] {
            std::fs::write(&file, text).unwrap();
            for (source, origin) in [
                (
                    Source::Dir(root.path().to_owned()),
                    file.display().to_string(),
                ),
                (Source::File(file.clone()), file.display().to_string()),
                (Source::Content(text.to_owned()), "inline config".to_owned()),
            ] {
                let error = load(&[source])
                    .err()
                    .expect("non-object config was accepted");
                assert!(error.contains(&origin), "{error}");
                assert!(error.contains("config root must be an object"), "{error}");
            }
        }
    }

    #[test]
    fn invalid_inline_json_names_its_source() {
        let error = load(&[Source::Content("{ bad".into())]).err().unwrap();
        assert!(error.starts_with("inline config:"), "{error}");
        assert!(error.contains("line 1"), "{error}");
    }

    #[test]
    fn valid_object_documents_keep_tolerating_unrelated_product_fields() {
        for text in ["{}", r#"{"theme":"nord","unknown":{"enabled":true}}"#] {
            let documents = load(&[Source::Content(text.to_owned())]).unwrap();
            assert_eq!(documents.len(), 1);
            assert_eq!(
                documents[0].value,
                serde_json::from_str::<Value>(text).unwrap()
            );
        }
    }

    fn documents(values: &[Value]) -> Vec<Document> {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| Document {
                origin: format!("document-{index}"),
                value: value.clone(),
            })
            .collect()
    }

    fn lookup(installed: &[&str]) -> impl Fn(&str) -> Option<PathBuf> {
        let installed: Vec<String> = installed.iter().map(|name| name.to_string()).collect();
        move |command: &str| {
            installed
                .contains(&command.to_string())
                .then(|| PathBuf::from("/tools").join(command))
        }
    }

    // The lookup joins with the platform separator, so an expectation written by
    // hand as "/tools/gopls" compares equal on Linux and macOS but not on
    // Windows, where the joined path is "\\tools\\gopls".
    fn installed(name: &str) -> String {
        PathBuf::from("/tools")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn sandbox_environment_overrides_config_in_both_directions() {
        let config = documents(&[serde_json::json!({"sandbox": {"mode": "off"}})]);
        assert!(!sandbox_enabled(&config, None));
        assert!(sandbox_enabled(&config, Some("1")));
        // The product reads the switch case-insensitively.
        assert!(sandbox_enabled(&config, Some("TRUE")));
        let off_by_default =
            documents(&[serde_json::json!({"sandbox": {"mode": "workspace-write"}})]);
        assert!(sandbox_enabled(&off_by_default, None));
        assert!(!sandbox_enabled(&off_by_default, Some("0")));
        // An empty value means unset, like the product's environment read.
        assert!(sandbox_enabled(&off_by_default, Some("")));
        assert!(sandbox_enabled(&documents(&[]), None));
    }

    #[test]
    fn sandbox_mode_merges_across_documents_like_the_product() {
        let merged = documents(&[
            serde_json::json!({"sandbox": {"mode": "off", "network": false}}),
            serde_json::json!({"sandbox": {"network": true}}),
        ]);
        assert!(!sandbox_enabled(&merged, None));
        // A later object field replaces an earlier one; arrays replace whole.
        let replaced = documents(&[
            serde_json::json!({"sandbox": {"mode": "workspace-write", "writable_roots": ["/a"]}}),
            serde_json::json!({"sandbox": {"writable_roots": ["/b"]}}),
        ]);
        assert!(sandbox_enabled(&replaced, None));
        assert_eq!(
            config_scope::merge_values(
                &replaced
                    .iter()
                    .map(|document| document.value.clone())
                    .collect::<Vec<_>>()
            )["sandbox"]["writable_roots"],
            serde_json::json!(["/b"])
        );
    }

    #[test]
    fn derived_policy_matches_the_materialized_product_policy() {
        let policy = policy(
            &documents(&[serde_json::json!({"sandbox": {"mode": "off"}})]),
            None,
        );
        assert_eq!(
            serde_json::to_value(&policy).unwrap(),
            serde_json::json!({
                "mode": "workspace",
                "allow_process": true,
                "allow_background": true,
                "allow_subagents": true,
                "allow_mcp": true,
                "allow_web": true,
                "allow_wakeup": true,
                "allow_cron": true,
                "process_network": true,
                "sandbox": false,
                "rules": [],
                "approval_timeout_ms": 60_000,
                "max_provider_turns": null,
            })
        );
    }

    #[test]
    fn lsp_defaults_resolve_through_the_lookup_and_skip_missing_servers() {
        let entries =
            lsp_entries(None, &BUILTIN_SERVERS, &lookup(&["gopls", "rust-analyzer"])).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "gopls");
        assert_eq!(entries[0].argv, vec![installed("gopls")]);
        assert_eq!(entries[0].extensions, vec![".go"]);
        assert_eq!(entries[1].name, "rust");
        assert_eq!(entries[1].argv, vec![installed("rust-analyzer")]);
        assert_eq!(entries[0].env, std::collections::BTreeMap::new());
        assert_eq!(entries[0].initialization, None);
    }

    #[test]
    fn lsp_overrides_replace_whole_and_disabled_removes() {
        let configured = serde_json::json!({
            "gopls": {"command": ["/custom/gopls", "-remote"], "env": {"GOFLAGS": "-tags=x"}, "initialization": {"settings": {}}},
            "clangd": {"disabled": true},
            "tailwind": {"command": ["tw-ls"], "extensions": [".html"]},
            "broken": {"extensions": [".x"]}
        });
        let entries = lsp_entries(
            Some(&configured),
            &BUILTIN_SERVERS,
            &lookup(&["tw-ls", "/custom/gopls"]),
        )
        .unwrap();
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["gopls", "tailwind"]);
        // Replaced in place: the built-in keeps its slot ahead of the custom
        // server appended after the built-ins.
        assert_eq!(entries[0].argv, vec!["/custom/gopls", "-remote"]);
        assert_eq!(
            entries[0].env.get("GOFLAGS").map(String::as_str),
            Some("-tags=x")
        );
        assert_eq!(
            entries[0].initialization,
            Some(serde_json::json!({"settings": {}}))
        );
        // A command-less entry leaves the built-in alone.
        assert!(!names.contains(&"broken"));
        // A custom server must declare its extensions.
        assert_eq!(entries[1].extensions, vec![".html"]);
    }

    #[test]
    fn lsp_false_disables_the_whole_section_and_later_documents_win_whole() {
        let off = lsp_entries(
            Some(&Value::Bool(false)),
            &BUILTIN_SERVERS,
            &lookup(&["gopls"]),
        )
        .unwrap();
        assert!(off.is_empty());
        let documents = documents(&[
            serde_json::json!({"lsp": {"gopls": {"command": ["first"]}, "clangd": {"command": ["c"]}}}),
            serde_json::json!({"lsp": {"gopls": {"command": ["second"]}}}),
        ]);
        let configured = lsp_configured(&documents).unwrap();
        let entries =
            lsp_entries(Some(&configured), &BUILTIN_SERVERS, &lookup(&["second"])).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].argv, vec![installed("second")]);
    }

    #[test]
    fn lsp_rejects_too_many_servers_and_extension_overlap() {
        let mut overrides = serde_json::Map::new();
        for index in 0..9 {
            overrides.insert(
                format!("server-{index}"),
                serde_json::json!({"command": ["x"], "extensions": [format!(".ext{index}")]}),
            );
        }
        let error = lsp_entries(
            Some(&Value::Object(overrides)),
            &BUILTIN_SERVERS,
            &lookup(&["x"]),
        )
        .err()
        .unwrap();
        assert_eq!(error, "native LSP supports at most 8 installed servers");
        let overlap = serde_json::json!({"extra": {"command": ["x"], "extensions": [".TS"]}});
        // The overlap is against the installed built-ins, so typescript must
        // be installed for the lowercased extension collision to exist.
        let error = lsp_entries(
            Some(&overlap),
            &BUILTIN_SERVERS,
            &lookup(&["x", "typescript-language-server"]),
        )
        .err()
        .unwrap();
        assert_eq!(
            error,
            "native LSP requires one configured server per extension"
        );
    }

    #[test]
    fn resolve_prefers_a_direct_path_and_then_the_search_order() {
        let root = std::env::temp_dir().join(format!("miao-derive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("first")).unwrap();
        std::fs::create_dir_all(root.join("second")).unwrap();
        std::fs::write(root.join("first/tool"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("first/tool"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        std::fs::write(root.join("second/tool"), "").unwrap();
        let search = vec![root.join("first"), root.join("second")];
        assert_eq!(resolve("tool", &search, &[]), Some(root.join("first/tool")));
        assert_eq!(resolve("./first/tool", &search, &[]), None);
        let direct = root.join("first").join("tool");
        assert_eq!(
            resolve(direct.to_str().unwrap(), &search, &[]),
            Some(direct)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn load_reads_sources_in_order_and_reports_malformed_documents() {
        let root = std::env::temp_dir().join(format!("miao-derive-load-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("miao.json"),
            r#"{"engine": {}, // comment
}"#,
        )
        .unwrap();
        let file = root.join("loose.jsonc");
        std::fs::write(&file, r#"{"model": "a",}"#).unwrap();
        let sources = vec![
            Source::Dir(root.clone()),
            Source::File(file),
            Source::Content("{\"lsp\": true}".to_string()),
        ];
        let documents = load(&sources).unwrap();
        assert_eq!(documents.len(), 3);
        assert_eq!(documents[2].value["lsp"], Value::Bool(true));
        let malformed = vec![Source::Content("{ broken".to_string())];
        assert!(load(&malformed).is_err());
        let missing = vec![Source::File(root.join("absent.json"))];
        assert!(load(&missing).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_origin_names_the_files_a_reload_reads() {
        let manifest = LspOrigin::Manifest(PathBuf::from("/host/lsp.json"));
        assert_eq!(manifest.files(), vec![PathBuf::from("/host/lsp.json")]);

        let directory = LspOrigin::Directory(PathBuf::from("/config"));
        assert_eq!(directory.files().len(), config_scope::FILE_NAMES.len());
        assert!(directory
            .files()
            .iter()
            .all(|path| path.starts_with("/config")));

        // Inline content has no file to watch and must not add a phantom path.
        let sources = LspOrigin::Sources(vec![
            Source::Dir(PathBuf::from("/config")),
            Source::File(PathBuf::from("/project/miao.json")),
            Source::Content("{}".to_string()),
        ]);
        let files = sources.files();
        assert_eq!(files.len(), config_scope::FILE_NAMES.len() + 1);
        assert_eq!(files.last(), Some(&PathBuf::from("/project/miao.json")));
    }
}
