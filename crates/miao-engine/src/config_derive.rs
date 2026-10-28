//! Product config derivation inside the engine (S5, step 2).
//!
//! Step 1 (`config_scope`) reads the product config files; this module turns
//! the loaded documents into the configs the host used to materialize as temp
//! files (`product-policy.ts`, `product-lsp.ts`). Every rule here mirrors a
//! product-side derivation and is pinned by the shared golden fixtures in
//! `tests/fixtures/config-golden`, which the TypeScript suite also reads: two
//! implementations, one set of samples.

use crate::{config_scope, lsp, permission};
use serde_json::Value;
use std::path::PathBuf;

/// One ordered configuration source from the host, lowest priority first.
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
                let value = config_scope::parse_document(text)?;
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

/// Validate the `sandbox` and `lsp` sections against the shapes the product's
/// config schema accepts, naming the file and the key path on a mismatch.
fn validate(origin: &str, value: &serde_json::Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    match object.get("sandbox") {
        None | Some(serde_json::Value::Null) => {}
        Some(sandbox) => validate_sandbox(origin, sandbox)?,
    }
    match object.get("lsp") {
        None | Some(serde_json::Value::Null) => {}
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
        if !network.is_boolean() && !network.is_null() {
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
    fn lsp_entries_without_a_command_stay_valid_but_mistyped_commands_refuse() {
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
    fn unknown_keys_never_fail() {
        assert!(validated(serde_json::json!({"theme": "dark", "model": "x/y"})).is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
