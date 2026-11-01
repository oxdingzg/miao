//! Serve/acp setup, lifted out of the binary so an in-process caller can
//! build the same Runtime the `serve` subcommand builds.
//!
//! Everything here used to live inside `main.rs`; the paths are unchanged
//! (`miao_engine::…` resolves through the crate self-alias in `lib.rs`).

use miao_engine::{
    credential::{Credential, Source},
    permission::{Mode, Policy},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use std::{collections::HashMap, error::Error, sync::Arc};

/// A Runtime configured exactly as the `serve` subcommand configures it.
pub struct Configured {
    pub runtime: crate::runtime::Runtime,
    pub options: HashMap<String, String>,
    pub acp: bool,
    pub plugin_hooks: Option<crate::product::Marker>,
}

pub async fn configure(args: &[String]) -> Result<Configured, Box<dyn Error + Send + Sync>> {
    let mode = args.first().map(String::as_str);
    if !matches!(mode, Some("serve" | "acp")) {
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses|gemini|amazon-bedrock] [--endpoint URL] [--policy PATH] [--agent-config PATH] [--config-dir PATH] [--mode read-only|workspace] [--permission-root-db PATH --permission-project ID] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off] [--context-limits JSON] [--http ADDR [--http-token TOKEN]]\n       miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH] [--agent-config PATH] [--config-dir PATH] [--mode read-only|workspace] [--permission-root-db PATH --permission-project ID] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine config explain --config-dir PATH | --config-sources JSON|-\n       miao-engine doctor [--db PATH]\n       miao-engine permissions --db PATH --project ID [--directory PATH [--workspace-id ID]]\n       miao-engine permission-source --db PATH --project ID --directory PATH\nUse ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY for the selected provider. Bedrock uses AWS_BEARER_TOKEN_BEDROCK or the AWS SDK credential chain (--aws-region/--aws-profile). An explicit engine database is required.");
        std::process::exit(2);
    }
    let acp = mode == Some("acp");
    let mut options = HashMap::new();
    let (flags, remainder) = args[1..].as_chunks::<2>();
    for flag in flags {
        if ![
            "--db",
            "--workspace",
            "--model",
            "--endpoint",
            "--fallback-model",
            "--fallback-endpoint",
            "--provider",
            "--policy",
            "--agent-config",
            "--config-dir",
            "--config-sources",
            "--mode",
            "--edit-recovery",
            "--verify-command",
            "--prompt-cache",
            "--responses-cache-contract",
            "--responses-websocket-contract",
            "--tool-disclosure",
            "--tool-replay",
            "--mcp-config",
            "--lsp-config",
            "--formatter-config",
            "--lsp-diagnostics",
            "--context-limits",
            "--hooks-config",
            "--plugin-hooks",
            "--context-config",
            "--workspace-instructions",
            "--skills-config",
            "--references-config",
            "--model-routes-config",
            "--product-tools",
            "--worker-config",
            "--credential-db",
            "--credential-id",
            "--credential-integration",
            "--aws-region",
            "--aws-profile",
            "--credential-socket",
            "--auth-file",
            "--http",
            "--http-token",
            "--http-idle-ms",
            "--permission-root-db",
            "--permission-project",
        ]
        .contains(&flag[0].as_str())
            || options.insert(flag[0].clone(), flag[1].clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    if !remainder.is_empty() {
        return Err("missing option value".into());
    }
    if options.contains_key("--permission-root-db") != options.contains_key("--permission-project")
    {
        return Err(
            "--permission-root-db and --permission-project must be selected together".into(),
        );
    }
    let db = options.get("--db").ok_or("--db is required")?;
    let workspace = options
        .get("--workspace")
        .ok_or("--workspace is required")?;
    let model = options.get("--model").ok_or("--model is required")?;
    let provider_name = options
        .get("--provider")
        .map(String::as_str)
        .unwrap_or("anthropic");
    // A `provider/model` --model value names the provider for host-side
    // routing; when the provider is given explicitly (the acp mode always
    // does), the transport wants the bare model id, mirroring serve-mode
    // route resolution.
    let model: String = match model.split_once('/') {
        Some((prefix, bare)) if prefix == provider_name => bare.to_owned(),
        _ => model.to_owned(),
    };
    if ![
        "anthropic",
        "openai-chat",
        "openai-responses",
        "subscription-responses",
        "gemini",
        "amazon-bedrock",
    ]
    .contains(&provider_name)
    {
        return Err("unknown provider".into());
    }
    if provider_name != "amazon-bedrock"
        && (options.contains_key("--aws-region") || options.contains_key("--aws-profile"))
    {
        return Err("AWS selection is only supported by amazon-bedrock".into());
    }
    let integration = options
        .get("--credential-integration")
        .cloned()
        .unwrap_or_else(|| {
            if provider_name == "anthropic" {
                "anthropic".into()
            } else if provider_name == "amazon-bedrock" {
                "amazon-bedrock".into()
            } else if provider_name == "gemini" {
                "google".into()
            } else {
                "openai".into()
            }
        });
    if options.contains_key("--credential-db") && options.contains_key("--auth-file") {
        return Err("select only one credential source".into());
    }
    if options.contains_key("--credential-socket")
        && (options.contains_key("--credential-db") || options.contains_key("--auth-file"))
    {
        return Err("select only one credential source".into());
    }
    let source = if let Some(socket) = options.get("--credential-socket") {
        Source::Daemon {
            #[cfg(unix)]
            socket: tokio::fs::canonicalize(socket).await?,
            #[cfg(windows)]
            socket: std::path::PathBuf::from(socket),
            id: options
                .get("--credential-id")
                .ok_or("--credential-id is required")?
                .clone(),
            integration,
        }
    } else if let Some(path) = options.get("--credential-db") {
        Source::Database {
            path: tokio::fs::canonicalize(path).await?,
            id: options
                .get("--credential-id")
                .ok_or("--credential-id is required")?
                .clone(),
            integration,
        }
    } else if let Some(path) = options.get("--auth-file") {
        if options.contains_key("--credential-id") {
            return Err("credential-id requires a database or socket source".into());
        }
        Source::Legacy {
            path: tokio::fs::canonicalize(path).await?,
            integration,
        }
    } else {
        if options.contains_key("--credential-id")
            || options.contains_key("--credential-integration")
        {
            return Err("credential selection requires a file, database, or socket source".into());
        }
        if provider_name == "amazon-bedrock" {
            match std::env::var("AWS_BEARER_TOKEN_BEDROCK") {
                Ok(token) => Source::Static(Credential::key(token)),
                Err(_) => Source::Aws {
                    region: options
                        .get("--aws-region")
                        .cloned()
                        .or_else(|| std::env::var("AWS_REGION").ok())
                        .unwrap_or_else(|| "us-east-1".into()),
                    profile: options
                        .get("--aws-profile")
                        .cloned()
                        .or_else(|| std::env::var("AWS_PROFILE").ok()),
                },
            }
        } else if provider_name == "subscription-responses" {
            Source::Static(Credential::token(
                std::env::var("OPENAI_ACCESS_TOKEN")
                    .map_err(|_| "OPENAI_ACCESS_TOKEN is required")?,
                std::env::var("OPENAI_ACCOUNT_ID").ok(),
            ))
        } else {
            let name = if provider_name == "anthropic" {
                "ANTHROPIC_API_KEY"
            } else if provider_name == "gemini" {
                "GEMINI_API_KEY"
            } else {
                "OPENAI_API_KEY"
            };
            Source::Static(Credential::key(
                std::env::var(name)
                    .map_err(|_| "API key or explicit credential source is required")?,
            ))
        }
    };
    source.validate().await?;
    if options.contains_key("--fallback-endpoint") && !options.contains_key("--fallback-model") {
        return Err("fallback-endpoint requires fallback-model".into());
    }
    if provider_name == "gemini"
        && options.contains_key("--fallback-model")
        && options.contains_key("--endpoint")
        && !options.contains_key("--fallback-endpoint")
    {
        return Err("custom Gemini endpoint requires an explicit fallback-endpoint".into());
    }
    // Prompt caching is a pure win for the transports that consume the flag
    // (Anthropic and Bedrock charge 0.1x for cache reads), so it defaults on;
    // `--prompt-cache off` opts out explicitly.
    let prompt_cache = match options.get("--prompt-cache").map(String::as_str) {
        None | Some("on") => true,
        Some("off") => false,
        Some(_) => return Err("--prompt-cache must be on or off".into()),
    };
    let cache_contract = options
        .get("--responses-cache-contract")
        .map(|value| miao_engine::responses_cache::Contract::from_wire(value))
        .transpose()?;
    let websocket_contract = options
        .get("--responses-websocket-contract")
        .map(|value| miao_engine::responses_websocket::Contract::from_wire(value))
        .transpose()
        .map_err(std::io::Error::other)?;
    let provider = if provider_name == "amazon-bedrock" {
        if cache_contract.is_some() || websocket_contract.is_some() {
            return Err("Responses continuation contracts are unsupported by Bedrock".into());
        }
        miao_engine::routing::build_bedrock(
            options.get("--endpoint").map(String::as_str),
            source.clone(),
            model.clone(),
            options.get("--aws-region").map(String::as_str),
            prompt_cache,
        )?
    } else {
        miao_engine::routing::build_with_responses(
            provider_name,
            options.get("--endpoint").map(String::as_str),
            source.clone(),
            model.clone(),
            prompt_cache,
            cache_contract,
            websocket_contract,
        )?
    };
    let provider: Arc<dyn Provider> = if let Some(model) = options.get("--fallback-model") {
        let endpoint = options.get("--fallback-endpoint").or_else(|| {
            if provider_name == "gemini" {
                None
            } else {
                options.get("--endpoint")
            }
        });
        let fallback = if provider_name == "amazon-bedrock" {
            miao_engine::routing::build_bedrock(
                endpoint.map(String::as_str),
                source.clone(),
                model.clone(),
                options.get("--aws-region").map(String::as_str),
                prompt_cache,
            )?
        } else {
            miao_engine::routing::build(
                provider_name,
                endpoint.map(String::as_str),
                source.clone(),
                model.clone(),
                prompt_cache,
            )?
        };
        Arc::new(miao_engine::routing::Fallback::new(provider, fallback)?)
    } else {
        provider
    };
    // An explicit flag wins over both the entry default and the policy file,
    // so an operator can keep a shared policy and pick the mode per launch.
    let mode = match options.get("--mode").map(String::as_str) {
        None => None,
        Some("read-only" | "read_only") => Some(Mode::ReadOnly),
        Some("workspace") => Some(Mode::Workspace),
        Some(other) => {
            return Err(format!("unknown --mode `{other}`, expected read-only or workspace").into())
        }
    };
    // Where the base policy comes from. Kept for the process lifetime so
    // `config_reload` derives it from exactly the sources startup used.
    let policy_origin = if let Some(path) = options.get("--policy") {
        miao_engine::config_derive::PolicyOrigin::File(path.into())
    } else if let Some(json) = options.get("--config-sources") {
        // The host forwards the ordered config source plan it resolved for
        // this Location, so the project chain overrides the global directory
        // exactly the way the product applies them. The plan supersedes the
        // single-directory fallback, which only sees the global files.
        miao_engine::config_derive::PolicyOrigin::Sources(miao_engine::config_derive::plan(json)?)
    } else if let Some(directory) = options.get("--config-dir") {
        // No explicit operator policy: derive the product policy from the
        // config directory and the environment the host forwarded, the way
        // the product used to before materializing a temporary file.
        miao_engine::config_derive::PolicyOrigin::Directory(directory.into())
    } else {
        miao_engine::config_derive::PolicyOrigin::Entry { acp }
    };
    let policy = Policy::new(policy_origin.derive(mode)?)?;
    let mut tools = Tools::new(workspace)
        .await?
        .with_workspace_instructions(
            match options.get("--workspace-instructions").map(String::as_str) {
                None | Some("true") => true,
                Some("false") => false,
                Some(_) => return Err("--workspace-instructions must be true or false".into()),
            },
        )
        .with_process_runner(std::env::current_exe()?)
        .with_edit_recovery(match options.get("--edit-recovery").map(String::as_str) {
            None | Some("on") => true,
            Some("off") => false,
            Some(_) => return Err("--edit-recovery must be on or off".into()),
        })
        .with_lsp_diagnostics(match options.get("--lsp-diagnostics").map(String::as_str) {
            None | Some("on") => true,
            Some("off") => false,
            Some(_) => return Err("--lsp-diagnostics must be on or off".into()),
        });
    let mut route_limits = miao_engine::model_routes::RouteLimits::default();
    let mut model_origin = None;
    let provider = if let Some(path) = options.get("--model-routes-config") {
        let path = tokio::fs::canonicalize(path).await?;
        let workspace = std::path::PathBuf::from(tools.location());
        // Keep the unrouted provider: a reload layers the new manifest over
        // exactly this base instead of re-deriving the operator's flags.
        let base = provider;
        let (provider, route_limits_new) =
            miao_engine::model_routes::load(&path, &workspace, base.clone())
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> {
                    error.to_string().into()
                })?;
        tools = tools.with_protected_resource(&path);
        route_limits = route_limits_new;
        model_origin = Some(miao_engine::model_routes::Origin {
            base,
            path,
            workspace,
        });
        provider
    } else {
        provider
    };
    if provider_name == "amazon-bedrock" {
        miao_engine::bedrock::validate_credential_paths(
            provider.protected_resources(),
            std::path::Path::new(tools.location()),
        )
        .await?;
    }
    if let Some(path) = source.path() {
        if policy.process_enabled() && path.starts_with(std::path::Path::new(tools.location())) {
            return Err("process-enabled credential sources must be outside workspace".into());
        }
        tools = tools.with_protected_resource(path);
    }
    // The five host files that carry context sources, skills, references,
    // hooks and formatters. One origin records their canonical paths, so a
    // reload reads exactly what startup read; one derive validates all of them
    // before any is applied.
    let context_origin = miao_engine::config_derive::ContextOrigin {
        sources: canonical_option(&options, "--context-config").await?,
        skills: canonical_option(&options, "--skills-config").await?,
        references: canonical_option(&options, "--references-config").await?,
        hooks: canonical_option(&options, "--hooks-config").await?,
        formatter: canonical_option(&options, "--formatter-config").await?,
    };
    for path in context_origin.files() {
        tools = tools.with_protected_resource(&path);
    }
    context_origin
        .derive(std::path::Path::new(tools.location()))?
        .apply(&tools);
    tools =
        tools.with_compact_disclosure(match options.get("--tool-disclosure").map(String::as_str) {
            None | Some("full") => false,
            Some("compact") => true,
            Some(_) => return Err("--tool-disclosure must be full or compact".into()),
        });
    if let Some(path) = options.get("--worker-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Worker host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Worker config exceeds 64 KiB".into());
        }
        let config = serde_json::from_slice::<miao_engine::worker::Config>(&bytes)
            .map_err(|_| "invalid Worker host config")?;
        tools = tools.with_protected_resource(&path);
        match miao_engine::worker::Registry::connect(config, std::path::Path::new(tools.location())).await {
            Ok(registry) => tools = tools.with_worker(Arc::new(registry)),
            Err(error) => eprintln!("miao-engine extension worker unavailable: {error}; built-in tools remain available"),
        }
    }
    let mut plugin_hooks = None;
    if let Some(path) = options.get("--plugin-hooks") {
        if !options.contains_key("--product-tools") {
            return Err("plugin hooks require the product tool bridge".into());
        }
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Plugin hooks host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Plugin hooks config exceeds 64 KiB".into());
        }
        plugin_hooks = Some(
            serde_json::from_slice::<miao_engine::product::Marker>(&bytes)
                .map_err(|_| "invalid plugin hooks host config")?,
        );
    } else if let Some(raw) = std::env::var_os("MIAO_ENGINE_PLUGIN_HOOKS") {
        // A host that knows which hook families are registered hands the marker
        // over inline; an explicit `--plugin-hooks` file still wins.
        if !options.contains_key("--product-tools") {
            return Err("plugin hooks require the product tool bridge".into());
        }
        let bytes = raw.to_string_lossy();
        if bytes.len() > 65536 {
            return Err("Plugin hooks config exceeds 64 KiB".into());
        }
        plugin_hooks = Some(
            serde_json::from_str::<miao_engine::product::Marker>(&bytes)
                .map_err(|_| "invalid inline plugin hooks host config")?,
        );
    }
    let mut mcp_origin = None;
    if let Some(raw) = std::env::var_os("MIAO_ENGINE_MCP_SERVERS") {
        // A host that already holds the server list hands it over inline: no
        // temporary file to write, guard, and clean up. An explicit
        // `--mcp-config` still wins, so an operator's on-disk manifest is never
        // silently replaced by a product default.
        if !options.contains_key("--mcp-config") {
            if !policy.mcp_enabled() {
                return Err("MCP config requires explicit workspace allow_mcp authority".into());
            }
            let value: serde_json::Value = serde_json::from_str(&raw.to_string_lossy())
                .map_err(|_| "invalid inline MCP host config")?;
            let origin = miao_engine::config_derive::McpOrigin::Inline(value);
            let registry = miao_engine::mcp::Registry::connect(
                origin.derive()?,
                std::path::Path::new(tools.location()),
            )
            .await?;
            let registry = Arc::new(registry);
            registry.start_watchers();
            tools = tools.with_mcp(registry);
            mcp_origin = Some(origin);
        }
    }
    if let Some(path) = options.get("--mcp-config") {
        if !policy.mcp_enabled() {
            return Err("MCP config requires explicit workspace allow_mcp authority".into());
        }
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("MCP host config must be outside model-writable workspace".into());
        }
        let origin = miao_engine::config_derive::McpOrigin::Manifest(path.clone());
        let registry = miao_engine::mcp::Registry::connect(
            origin.derive()?,
            std::path::Path::new(tools.location()),
        )
        .await?;
        let registry = Arc::new(registry);
        registry.start_watchers();
        tools = tools.with_protected_resource(&path).with_mcp(registry);
        mcp_origin = Some(origin);
    }
    // The origin a reload re-derives from. Every branch below records one, so
    // `config_reload` reads exactly the files startup read.
    let mut lsp_origin = None;
    if let Some(path) = options.get("--lsp-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("LSP host config must be outside model-writable workspace".into());
        }
        let origin = miao_engine::config_derive::LspOrigin::Manifest(path.clone());
        let registry = miao_engine::lsp::Registry::connect(
            origin.derive()?,
            std::path::Path::new(tools.location()),
        )
        .await?;
        tools = tools
            .with_protected_resource(&path)
            .with_lsp(Arc::new(registry));
        lsp_origin = Some(origin);
    } else if let Some(json) = options.get("--config-sources") {
        // Derive the servers from the same ordered plan the policy used, so
        // project-level `lsp` sections override the global directory.
        let origin =
            miao_engine::config_derive::LspOrigin::Sources(miao_engine::config_derive::plan(json)?);
        let configs = origin.derive()?;
        if !configs.is_empty() {
            let registry = miao_engine::lsp::Registry::connect(
                configs,
                std::path::Path::new(tools.location()),
            )
            .await?;
            tools = tools.with_lsp(Arc::new(registry));
        }
        lsp_origin = Some(origin);
    } else if let Some(directory) = options.get("--config-dir") {
        // No explicit LSP manifest: derive the servers from the config
        // directory the way the product used to before materializing one.
        let origin = miao_engine::config_derive::LspOrigin::Directory(directory.into());
        let configs = origin.derive()?;
        if !configs.is_empty() {
            let registry = miao_engine::lsp::Registry::connect(
                configs,
                std::path::Path::new(tools.location()),
            )
            .await?;
            tools = tools.with_lsp(Arc::new(registry));
        }
        lsp_origin = Some(origin);
    }
    let replay = options
        .get("--tool-replay")
        .map(|file| {
            if std::path::Path::new(db).exists() {
                return Err(miao_engine::protocol::Error::Invalid(
                    "native tool replay requires a fresh diagnostic database".into(),
                ));
            }
            miao_engine::tool_replay::ToolReplay::load(std::path::Path::new(file))
        })
        .transpose()?;
    let context_limits = options
        .get("--context-limits")
        .map(|json| miao_engine::context_trigger::ContextLimits::from_wire(json))
        .transpose()?;
    let default_agent = options
        .get("--agent-config")
        .map(|file| {
            if std::fs::metadata(file)?.len() > 4 * 1024 * 1024 {
                return Err(miao_engine::protocol::Error::Invalid(
                    "agent manifest exceeds 4 MiB".into(),
                ));
            }
            let agent: miao_engine::session_agent::AgentManifest =
                serde_json::from_slice(&std::fs::read(file)?)?;
            agent.validate()?;
            Ok::<_, miao_engine::protocol::Error>(agent)
        })
        .transpose()?;
    let runtime = match (
        options.get("--permission-root-db"),
        options.get("--permission-project"),
    ) {
        (Some(root), Some(project)) => {
            if replay.is_some() {
                return Err(
                    "shared permissions cannot use a fresh diagnostic replay database".into(),
                );
            }
            if !tokio::fs::metadata(root).await?.is_file() {
                return Err(
                    "shared permission selection requires an existing Root database".into(),
                );
            }
            let authority = miao_engine::permission_project::Authority::open(root).await?;
            let context = authority
                .project(project.clone())?
                .context(tools.location(), None)
                .await?;
            let source = Store::open(db).await?;
            let binding = context.bind_handoff(&source).await?;
            Runtime::with_shared_permissions_and_agent(
                binding,
                provider,
                tools,
                policy,
                default_agent,
            )
            .await?
        }
        (None, None) => {
            Runtime::with_policy_agent_and_tool_replay(
                Store::open(db).await?,
                provider,
                tools,
                policy,
                replay,
                default_agent,
            )
            .await?
        }
        _ => {
            return Err(
                "--permission-root-db and --permission-project must be selected together".into(),
            )
        }
    };
    if let Some(limits) = context_limits {
        runtime.set_context_limits(Some(limits)).await;
    }
    if let Some(origin) = &lsp_origin {
        runtime.set_lsp_origin(origin.clone()).await;
    }
    if let Some(origin) = &mcp_origin {
        runtime.set_mcp_origin(origin.clone()).await;
    }
    // The origin is recorded even when it names no file: the context section
    // is then supported and simply has nothing to derive.
    runtime.set_context_origin(context_origin.clone()).await;
    if let Some(origin) = &model_origin {
        runtime.set_model_origin(origin.clone()).await?;
    }
    runtime.set_policy_origin(policy_origin.clone(), mode).await;
    // No host watches these files in the standalone entry, so the engine polls
    // them itself; a hosted engine gets an explicit `config_reload`. Both
    // origins contribute: one reload re-derives every section from its source.
    let watched = {
        let mut files = policy_origin.files();
        if let Some(origin) = &lsp_origin {
            files.extend(origin.files());
        }
        if let Some(origin) = &mcp_origin {
            files.extend(origin.files());
        }
        if let Some(origin) = &model_origin {
            files.push(origin.path.clone());
        }
        files.extend(context_origin.files());
        files.sort();
        files.dedup();
        files
    };
    if !watched.is_empty() {
        watch_config(runtime.clone(), watched);
    }
    runtime.set_route_limits(route_limits).await;
    let roles = miao_engine::roles::Bindings {
        summarize: options.get("--role-summarize").cloned(),
        retrieve: options.get("--role-retrieve").cloned(),
        verify: options.get("--role-verify").cloned(),
    };
    if roles.summarize.is_some() || roles.retrieve.is_some() || roles.verify.is_some() {
        runtime.set_role_bindings(roles).await;
    }
    runtime
        .verify_with(options.get("--verify-command").cloned())
        .await;
    Ok(Configured {
        runtime,
        options,
        acp,
        plugin_hooks,
    })
}

async fn canonical_option(
    options: &HashMap<String, String>,
    name: &str,
) -> Result<Option<std::path::PathBuf>, Box<dyn std::error::Error + Send + Sync>> {
    match options.get(name) {
        Some(path) => Ok(Some(tokio::fs::canonicalize(path).await?)),
        None => Ok(None),
    }
}

/// Standalone config reload. A hosted engine learns about a configuration
/// change from `config_reload`; the standalone entry has no host to tell it,
/// so it stats the same sources a reload reads.
///
/// Polling rather than an OS watcher is deliberate: network filesystems,
/// container mounts and editors' atomic renames do not deliver consistent
/// events across platforms, while mtime plus size does. A tick that lands
/// while a Session is draining is skipped, so a turn never observes half a
/// change. A failed derivation is reported once and retried only when a file
/// changes again, not on every tick.
fn watch_config(runtime: Runtime, files: Vec<std::path::PathBuf>) {
    tokio::spawn(async move {
        let mut stamp = config_stamp(&files);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let next = config_stamp(&files);
            if next == stamp {
                continue;
            }
            if runtime.is_draining() {
                continue;
            }
            stamp = next;
            match runtime.reload_config().await {
                Ok(report)
                    if report["changed"]
                        .as_array()
                        .is_some_and(|changed| !changed.is_empty()) =>
                {
                    eprintln!("miao-engine configuration reloaded: {}", report["changed"]);
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("miao-engine configuration reload failed: {error}");
                    runtime.announce_config_failure(&error.to_string());
                }
            }
        }
    });
}

/// Per-source `(mtime, size)`, `None` for a missing file. Nanosecond mtimes
/// keep two edits in the same second distinguishable.
fn config_stamp(files: &[std::path::PathBuf]) -> Vec<Option<(u128, u64)>> {
    files
        .iter()
        .map(|path| {
            std::fs::metadata(path).ok().map(|meta| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0);
                (mtime, meta.len())
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `config_stamp` moved here with the CLI; the test that covers it moved
    /// with it so the binary's test build does not reference a function this
    /// module keeps private.
    #[test]
    fn config_stamp_tracks_rewrites_and_absent_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("miao.json");
        let origin = crate::config_derive::LspOrigin::Manifest(path.clone());
        let files = origin.files();
        assert_eq!(config_stamp(&files), vec![None]);
        std::fs::write(&path, "{}").unwrap();
        let first = config_stamp(&files);
        assert!(first[0].is_some());
        std::fs::write(&path, "{ }").unwrap();
        assert_ne!(config_stamp(&files), first);
    }
}
