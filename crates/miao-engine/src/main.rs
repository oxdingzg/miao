use miao_engine::{
    credential::{Credential, Source},
    host::Host,
    permission::{Config, Mode, Policy},
    protocol::{Command, Error, Request},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{collections::HashMap, io, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::mpsc,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    if matches!(
        mode.as_deref(),
        Some("__sandbox-run" | "__process-guardian")
    ) {
        let payload = args.next().ok_or("sandbox payload missing")?;
        if args.next().is_some() {
            return Err("unexpected sandbox arguments".into());
        }
        return if mode.as_deref() == Some("__process-guardian") {
            miao_engine::process::guardian(&payload)
        } else {
            miao_engine::process::sandbox_runner(&payload)
        };
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("miao-engine {}", env!("MIAO_ENGINE_VERSION"));
        return Ok(());
    }
    if args == ["--capabilities"] {
        // Machine-readable contract for the product's discovery handshake.
        // `protocol` moves only when a newer product must not reuse an older
        // engine (shared store, fenced Session ownership, control routing).
        println!(
            "{}",
            serde_json::json!({
                "name": "miao-engine",
                "version": env!("MIAO_ENGINE_VERSION"),
                "protocol": miao_engine::PROTOCOL,
                "schema": miao_engine::store::SCHEMA_VERSION,
                "routes_schema": miao_engine::model_routes::SCHEMA,
            })
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("doctor") {
        let path = match &args[1..] {
            [] => None,
            [flag, path] if flag == "--db" => Some(std::path::PathBuf::from(path)),
            _ => return Err("Usage: miao-engine doctor [--db PATH]".into()),
        };
        let report =
            tokio::task::spawn_blocking(move || miao_engine::doctor::report(path.as_deref()))
                .await??;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("credentials") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--credential-db", "--auth-file"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("invalid credential-list options".into());
            }
        }
        if !remainder.is_empty() || options.len() != 1 {
            return Err("select exactly one credential source".into());
        }
        let list = if let Some(path) = options.remove("--credential-db") {
            tokio::task::spawn_blocking(move || {
                miao_engine::credential::list_database(std::path::Path::new(&path))
            })
            .await??
        } else {
            let path = options.remove("--auth-file").ok_or("source missing")?;
            tokio::task::spawn_blocking(move || {
                miao_engine::credential::list_legacy(std::path::Path::new(&path))
            })
            .await??
        };
        for entry in list {
            println!("{}", serde_json::to_string(&entry)?);
        }
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("export") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--db", "--session", "--after"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("unknown or duplicate export option".into());
            }
        }
        if !remainder.is_empty() {
            return Err("missing export option value".into());
        }
        let db = options.remove("--db").ok_or("--db is required")?;
        let session = options.remove("--session").ok_or("--session is required")?;
        let after = options
            .remove("--after")
            .map(|v| v.parse::<u64>())
            .transpose()?
            .unwrap_or(0);
        tokio::task::spawn_blocking(move || {
            miao_engine::export::committed_events(db, &session, after, std::io::stdout().lock())
        })
        .await??;
        return Ok(());
    }
    let mode = args.first().map(String::as_str);
    if !matches!(mode, Some("serve" | "acp")) {
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses|gemini|amazon-bedrock] [--endpoint URL] [--policy PATH] [--mode read-only|workspace] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off] [--context-limits JSON] [--http ADDR [--http-token TOKEN]]\n       miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH] [--mode read-only|workspace] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine doctor [--db PATH]\nUse ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY for the selected provider. Bedrock uses AWS_BEARER_TOKEN_BEDROCK or the AWS SDK credential chain (--aws-region/--aws-profile). An explicit engine database is required.");
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
    let mut config = if let Some(path) = options.get("--policy") {
        let bytes = tokio::fs::read(path).await?;
        if bytes.len() > 65536 {
            return Err("permission config exceeds 64 KiB".into());
        }
        serde_json::from_slice::<Config>(&bytes)?
    } else {
        Config::for_entry(acp)
    };
    // An explicit flag wins over both the entry default and the policy file,
    // so an operator can keep a shared policy and pick the mode per launch.
    if let Some(mode) = options.get("--mode") {
        config.mode = match mode.as_str() {
            "read-only" | "read_only" => Mode::ReadOnly,
            "workspace" => Mode::Workspace,
            other => {
                return Err(
                    format!("unknown --mode `{other}`, expected read-only or workspace").into(),
                )
            }
        };
    }
    let policy = Policy::new(config)?;
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
    let provider = if let Some(path) = options.get("--model-routes-config") {
        let path = tokio::fs::canonicalize(path).await?;
        let (provider, route_limits_new) = miao_engine::model_routes::load(
            &path,
            std::path::Path::new(tools.location()),
            provider,
        )
        .await?;
        tools = tools.with_protected_resource(&path);
        route_limits = route_limits_new;
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
    if let Some(path) = options.get("--context-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Context host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Context config exceeds 64 KiB".into());
        }
        let sources = serde_json::from_slice::<Vec<miao_engine::context::Source>>(&bytes)
            .map_err(|_| "invalid Context host config")?;
        tools = tools
            .with_protected_resource(&path)
            .with_context_sources(sources)?;
    }
    if let Some(path) = options.get("--skills-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Skills host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Skills config exceeds 64 KiB".into());
        }
        let directories =
            serde_json::from_slice::<Vec<miao_engine::context::SkillDirectory>>(&bytes)
                .map_err(|_| "invalid Skills host config")?;
        tools = tools
            .with_protected_resource(&path)
            .with_skill_directories(directories)?;
    }
    if let Some(path) = options.get("--references-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("References host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("References config exceeds 64 KiB".into());
        }
        let references = serde_json::from_slice::<Vec<miao_engine::context::Reference>>(&bytes)
            .map_err(|_| "invalid References host config")?;
        tools = tools
            .with_protected_resource(&path)
            .with_references(references)?;
    }
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
    if let Some(path) = options.get("--hooks-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Hooks host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Hooks config exceeds 64 KiB".into());
        }
        let hooks = serde_json::from_slice::<Vec<miao_engine::hooks::Hook>>(&bytes)
            .map_err(|_| "invalid hooks host config")?;
        tools = tools.with_protected_resource(&path).with_hooks(hooks)?;
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
    }
    if let Some(path) = options.get("--mcp-config") {
        if !policy.mcp_enabled() {
            return Err("MCP config requires explicit workspace allow_mcp authority".into());
        }
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("MCP host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("MCP config exceeds 64 KiB".into());
        }
        let configs = serde_json::from_slice::<Vec<miao_engine::mcp::Config>>(&bytes)
            .map_err(|_| "invalid MCP host config")?;
        let registry =
            miao_engine::mcp::Registry::connect(configs, std::path::Path::new(tools.location()))
                .await?;
        let registry = Arc::new(registry);
        registry.start_watchers();
        tools = tools.with_protected_resource(&path).with_mcp(registry);
    }
    if let Some(path) = options.get("--formatter-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("formatter host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("formatter config exceeds 64 KiB".into());
        }
        let configs = serde_json::from_slice::<Vec<miao_engine::formatter::Config>>(&bytes)
            .map_err(|_| "invalid formatter host config")?;
        let registry =
            miao_engine::formatter::Registry::new(configs, std::path::Path::new(tools.location()))?;
        tools = tools
            .with_protected_resource(&path)
            .with_formatter(Arc::new(registry));
    }
    if let Some(path) = options.get("--lsp-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("LSP host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("LSP config exceeds 64 KiB".into());
        }
        let configs = serde_json::from_slice::<Vec<miao_engine::lsp::Config>>(&bytes)
            .map_err(|_| "invalid LSP host config")?;
        let registry =
            miao_engine::lsp::Registry::connect(configs, std::path::Path::new(tools.location()))
                .await?;
        tools = tools
            .with_protected_resource(&path)
            .with_lsp(Arc::new(registry));
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
    let runtime = Runtime::with_policy_and_tool_replay(
        Store::open(db).await?,
        provider,
        tools,
        policy,
        replay,
    )
    .await?;
    if let Some(limits) = context_limits {
        runtime.set_context_limits(Some(limits)).await;
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
    if acp {
        let result = miao_engine::acp::serve(runtime.clone()).await;
        runtime.shutdown().await;
        result?;
        return Ok(());
    }
    if (options.contains_key("--http-token") || options.contains_key("--http-idle-ms"))
        && !options.contains_key("--http")
    {
        return Err("HTTP token and idle timeout require --http".into());
    }
    if let Some(address) = options.get("--http") {
        let idle = options
            .get("--http-idle-ms")
            .map(|value| value.parse::<u64>())
            .transpose()?;
        if idle.is_some_and(|value| !(1_000..=3_600_000).contains(&value)) {
            return Err("--http-idle-ms must be between 1000 and 3600000".into());
        }
        let address: SocketAddr = address
            .parse()
            .map_err(|_| "--http must be an IP:port socket address")?;
        if !address.ip().is_loopback() {
            return Err(
                "--http must bind a loopback address; terminate TLS in a local proxy".into(),
            );
        }
        let token = match options
            .get("--http-token")
            .cloned()
            .or_else(|| std::env::var("MIAO_ENGINE_HTTP_TOKEN").ok())
        {
            Some(token) => token,
            None => {
                let token = uuid::Uuid::new_v4().to_string();
                eprintln!("miao-engine http generated token: {token}");
                token
            }
        };
        let listener = TcpListener::bind(address).await?;
        eprintln!(
            "miao-engine http listening on {} ({})",
            listener.local_addr()?,
            miao_engine::http::PROTOCOL_VERSION
        );
        let result = miao_engine::http::serve_with_idle_timeout(
            runtime.clone(),
            listener,
            token,
            idle.map(Duration::from_millis),
        )
        .await;
        runtime.shutdown().await;
        result?;
        return Ok(());
    }
    let result = serve(
        runtime.clone(),
        options.remove("--product-tools"),
        plugin_hooks,
    )
    .await;
    runtime.shutdown().await;
    // tokio's stdin fallback reader parks in read(2) while a pipe peer keeps
    // the descriptor open, so dropping the async runtime after an idle
    // reclaim can block forever. shutdown() has released every engine-owned
    // resource (LSP, MCP and worker children included), so exit directly.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

async fn serve(
    runtime: Runtime,
    product_tools: Option<String>,
    plugin_hooks: Option<miao_engine::product::Marker>,
) -> io::Result<()> {
    let (output, mut outgoing) = mpsc::channel::<Value>(128);
    if let Some(path) = product_tools {
        let file = tokio::fs::read_to_string(&path)
            .await
            .map_err(io::Error::other)?;
        let manifest: Value = serde_json::from_str(&file).map_err(io::Error::other)?;
        let tools: Vec<miao_engine::protocol::ToolDefinition> =
            serde_json::from_value(manifest["tools"].clone()).map_err(io::Error::other)?;
        runtime.with_product_tools(
            tools,
            miao_engine::product::Bridge::new(output.clone()),
            plugin_hooks,
        );
    }
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = outgoing.recv().await {
            let mut line = serde_json::to_vec(&value).map_err(io::Error::other)?;
            line.push(b'\n');
            tokio::time::timeout(Duration::from_secs(5), async {
                stdout.write_all(&line).await?;
                stdout.flush().await
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "stdio subscriber too slow"))??;
        }
        Ok::<_, io::Error>(())
    });
    // Possession of this local stdio adapter is the controller authority.
    // Future network adapters must authenticate before receiving this handle.
    // `Host` holds that capability together with the subscription cursors, so
    // stdio framing owns no domain state.
    let mut host = Host::new(runtime.clone());
    let mut input = BufReader::new(tokio::io::stdin());
    let mut bytes = Vec::new();
    let mut progress = runtime.progress();
    let mut poll = tokio::time::interval(Duration::from_millis(100));
    // Host-death watchdog: stdin EOF is unreliable because grandchild
    // processes (LSP servers, MCP workers) inherit the pipe write end, and
    // idle reclaim must not fire while durable runs look live. Reparenting is
    // the orphan signal that survives both: a dead host re-parents this
    // process within seconds regardless of inherited descriptors.
    #[cfg(unix)]
    let initial_parent = Some(std::os::unix::process::parent_id());
    #[cfg(not(unix))]
    let initial_parent: Option<u32> = None;
    let host_watch = initial_parent.is_some();
    let mut host_watch_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    // Auto-reclaim: a stdio engine whose client died without a clean exit
    // would otherwise linger forever (its stdin pipe can stay open through
    // grandchild processes). Only client input counts as activity: internal
    // events and progress notices keep flowing long after the client is gone
    // (watchers, LSP pushes), so they must not extend the deadline. Live
    // background work still postpones the reclaim. 0 disables.
    let idle = std::env::var("MIAO_ENGINE_STDIO_IDLE_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(900);
    let idle = if idle == 0 {
        None
    } else {
        Some(Duration::from_secs(idle))
    };
    let mut idle_deadline = tokio::time::Instant::now() + idle.unwrap_or(Duration::from_secs(3600));
    let result=async {
        loop {
            tokio::select! {
                line=read_line(&mut input,&mut bytes)=>{
                    let Some(line)=line? else { break; };
                    if let Some(duration) = idle {
                        idle_deadline = tokio::time::Instant::now() + duration;
                    }
                    let value:Value=match serde_json::from_slice(&line) {Ok(v)=>v,Err(_)=>{send(&output,json!({"id":null,"error":{"code":"invalid_request","message":"expected a JSON object"}}))?;continue;}};
                    if let Some(bridge_id)=value.get("bridge_id").and_then(|id|id.as_u64()) {
                        runtime.deliver_product_reply(bridge_id, value);
                        continue;
                    }
                    let request=match serde_json::from_value::<Request>(value) {
                        Ok(r) if r.id.is_string()||r.id.is_number()=>r,
                        _=>{send(&output,json!({"id":null,"error":{"code":"invalid_request","message":"expected an id and a typed method/params request"}}))?;continue;},
                    };
                    let stop=matches!(request.command,Command::Shutdown);
                    let result:Result<Value,Error>=host.dispatch(request.command).await;
                    let response=match result {Ok(value)=>json!({"id":request.id,"result":value}),Err(error)=>json!({"id":request.id,"error":{"code":error.code(),"message":error.to_string()}})};
                    send(&output,response)?;
                    if stop {break;}
                },
                _=poll.tick()=>{
                    for value in host.poll_events().await.map_err(io::Error::other)? {
                        send(&output,value)?;
                    }
                },
                _=tokio::time::sleep_until(idle_deadline), if idle.is_some() => {
                    if runtime.has_live_work().await.unwrap_or(false) {
                        idle_deadline = tokio::time::Instant::now() + idle.unwrap_or_default();
                    } else {
                        break;
                    }
                },
                notice=progress.recv()=>match notice {
                    Ok(notice)=>{if notice["session_id"].as_str().is_some_and(|s|host.subscribed(s)) {send(&output,json!({"method":"progress","params":notice}))?;}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>send(&output,json!({"method":"resync","params":{"reason":"ephemeral_progress_lagged"}}))?,
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
                },
                _=signal_exit()=>{ break; },
                _ = tokio::time::sleep_until(host_watch_deadline), if host_watch => {
                    #[cfg(unix)]
                    if Some(std::os::unix::process::parent_id()) != initial_parent {
                        break;
                    }
                    host_watch_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                },
            }
        }
        Ok::<_,io::Error>(())
    }.await;
    drop(output);
    writer.await.map_err(io::Error::other)??;
    result
}

fn send(output: &mpsc::Sender<Value>, value: Value) -> io::Result<()> {
    output.try_send(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "stdio subscriber must reconnect and replay committed events",
        )
    })
}

/// A terminated or interrupted engine must unwind instead of dying by
/// default signal disposition, so its kill-on-drop children (LSP, MCP,
/// workers) are reaped rather than orphaned. Registration failure disables
/// the branch instead of exiting spuriously.
#[cfg(unix)]
async fn signal_exit() {
    let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
    match terminate {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        _ => std::future::pending::<()>().await,
    }
}

/// Windows has no SIGTERM; Ctrl-C is the only graceful interruption.
#[cfg(not(unix))]
async fn signal_exit() {
    tokio::signal::ctrl_c().await.ok();
}

/// Keep partial input across select cancellation; read_line itself is not
/// cancellation safe. Refuse an oversized frame before allocating it in full.
async fn read_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    bytes: &mut Vec<u8>,
) -> io::Result<Option<Vec<u8>>> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete JSONL request",
                ))
            };
        }
        let end = buffer.iter().position(|b| *b == b'\n');
        let n = end.map(|n| n + 1).unwrap_or(buffer.len());
        if bytes.len() + n > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request exceeds 1 MiB",
            ));
        }
        bytes.extend_from_slice(&buffer[..n]);
        reader.consume(n);
        if end.is_some() {
            return Ok(Some(std::mem::take(bytes)));
        }
    }
}
