use miao_engine::{
    credential::{Credential, Source},
    host::Host,
    permission::{Mode, Policy},
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
                "catalog": 1,
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
    if args.first().map(String::as_str) == Some("catalog") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--db", "--sessions", "--usage"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("unknown or duplicate catalog option".into());
            }
        }
        if !remainder.is_empty() {
            return Err("missing catalog option value".into());
        }
        let db = options.remove("--db").ok_or("--db is required")?;
        let sessions = options
            .remove("--sessions")
            .ok_or("--sessions is required")?;
        let sessions: Vec<String> = if sessions == "-" {
            use std::io::Read;
            let mut input = Vec::new();
            std::io::stdin()
                .lock()
                .take(1024 * 1024 + 1)
                .read_to_end(&mut input)?;
            if input.len() > 1024 * 1024 {
                return Err("catalog input exceeds 1 MiB".into());
            }
            serde_json::from_slice(&input)?
        } else {
            serde_json::from_str(&sessions)?
        };
        let usage = match options.remove("--usage").as_deref() {
            Some("true") => true,
            Some("false") | None => false,
            _ => return Err("--usage must be true or false".into()),
        };
        let entries = miao_engine::catalog::read(db, &sessions, usage).await?;
        let output = serde_json::to_vec(&entries)?;
        if output.len() > 8 * 1024 * 1024 {
            return Err("catalog exceeds output bound".into());
        }
        use std::io::Write;
        std::io::stdout().lock().write_all(&output)?;
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
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses|gemini|amazon-bedrock] [--endpoint URL] [--policy PATH] [--config-dir PATH] [--mode read-only|workspace] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off] [--context-limits JSON] [--http ADDR [--http-token TOKEN]]\n       miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH] [--config-dir PATH] [--mode read-only|workspace] [--verify-command COMMAND] [--prompt-cache on|off] [--responses-cache-contract JSON] [--responses-websocket-contract JSON] [--tool-disclosure full|compact] [--lsp-diagnostics on|off]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine doctor [--db PATH]\nUse ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY for the selected provider. Bedrock uses AWS_BEARER_TOKEN_BEDROCK or the AWS SDK credential chain (--aws-region/--aws-profile). An explicit engine database is required.");
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
            miao_engine::model_routes::load(&path, &workspace, base.clone()).await?;
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
    let mut mcp_origin = None;
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
    if let Some(origin) = &lsp_origin {
        runtime.set_lsp_origin(origin.clone()).await;
    }
    if let Some(origin) = &mcp_origin {
        runtime.set_mcp_origin(origin.clone()).await;
    }
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
    if let Err(error) = &result {
        eprintln!("miao-engine stdio: {error}");
    }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
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
                Err(error) => eprintln!("miao-engine configuration reload failed: {error}"),
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
    let writer_stop = tokio_util::sync::CancellationToken::new();
    let stop_output = writer_stop.clone();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        loop {
            let value = tokio::select! {
                _ = stop_output.cancelled(), if !outgoing.is_closed() => {
                    // Runtime product bridges retain sender clones. Close the
                    // receiver explicitly so shutdown can drain and finish.
                    outgoing.close();
                    outgoing.recv().await
                }
                value = outgoing.recv() => value,
            };
            let Some(value) = value else {
                break;
            };
            let mut line = serde_json::to_vec(&value).map_err(io::Error::other)?;
            line.push(b'\n');
            // A slow reader is backpressure, not a fatal transport error: the
            // client may be parsing a multi-megabyte replay frame or paused by
            // GC, and killing the engine would end every Session it owns. Block
            // until the pipe drains; only a closed pipe (a dead host) or an
            // explicit shutdown ends the stream.
            let write = async {
                stdout.write_all(&line).await?;
                stdout.flush().await
            };
            tokio::pin!(write);
            tokio::select! {
                result = &mut write => result?,
                _ = stop_output.cancelled() => {
                    // Shutdown already asked for this frame. The peer is still
                    // reading, so give the remaining frames a bounded drain
                    // instead of blocking process exit on a peer that stopped.
                    let _ = tokio::time::timeout(Duration::from_secs(5), &mut write).await;
                }
            }
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
                    let line=match line {
                        Ok(Some(line))=>line,
                        Ok(None)=>break,
                        // An oversized frame must not take the engine — and every
                        // Session in this storage — down with it: drop the rest of
                        // the frame, answer the id read from its head, and keep
                        // serving.
                        Err(error) if error.kind()==io::ErrorKind::InvalidData=>{
                            let id=leading_request_id(&bytes);
                            discard_line(&mut input,&mut bytes).await?;
                            send(&output,json!({"id":id,"error":{"code":"request_too_large","message":error.to_string()}})).await?;
                            continue;
                        }
                        Err(error)=>return Err(error),
                    };
                    if let Some(duration) = idle {
                        idle_deadline = tokio::time::Instant::now() + duration;
                    }
                    let value:Value=match serde_json::from_slice(&line) {Ok(v)=>v,Err(_)=>{send(&output,json!({"id":null,"error":{"code":"invalid_request","message":"expected a JSON object"}})).await?;continue;}};
                    if let Some(bridge_id)=value.get("bridge_id").and_then(|id|id.as_u64()) {
                        runtime.deliver_product_reply(bridge_id, value);
                        continue;
                    }
                    let request=match serde_json::from_value::<Request>(value) {
                        Ok(r) if r.id.is_string()||r.id.is_number()=>r,
                        _=>{send(&output,json!({"id":null,"error":{"code":"invalid_request","message":"expected an id and a typed method/params request"}})).await?;continue;},
                    };
                    let stop=matches!(request.command,Command::Shutdown);
                    let result:Result<Value,Error>=host.dispatch(request.command).await;
                    let response=match result {Ok(value)=>json!({"id":request.id,"result":value}),Err(error)=>json!({"id":request.id,"error":{"code":error.code(),"message":error.to_string()}})};
                    send(&output,response).await?;
                    if stop {break;}
                },
                _=poll.tick()=>{
                    if writer.is_finished() {
                        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdio output writer stopped"));
                    }
                    for value in host.poll_events().await.map_err(io::Error::other)? {
                        send(&output,value).await?;
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
                    Ok(notice)=>{if notice["session_id"].as_str().is_some_and(|s|host.subscribed(s)) {send(&output,json!({"method":"progress","params":notice})).await?;}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>send(&output,json!({"method":"resync","params":{"reason":"ephemeral_progress_lagged"}})).await?,
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
    writer_stop.cancel();
    drop(output);
    writer.await.map_err(io::Error::other)??;
    result
}

async fn send(output: &mpsc::Sender<Value>, value: Value) -> io::Result<()> {
    // A replay burst can exceed the queue while stdout is being drained. Wait
    // for the writer instead of terminating the Session: the reader may be
    // parsing a large frame, and the durable event cursor lets a real
    // disconnect replay later. Only a closed channel ends the stream.
    output
        .send(value)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "stdio subscriber disconnected"))
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

/// Largest stdio request frame. Attachment bytes ride the admission frame as
/// base64 and the product admits up to 6 MiB per attachment, so the transport
/// has to carry a full admission with headroom. A smaller cap turned every
/// larger PDF or image into an unexplained send failure.
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

/// Keep partial input across select cancellation; read_line itself is not
/// cancellation safe. Refuse an oversized frame before allocating it in full.
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
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
        if bytes.len() + n > MAX_REQUEST_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("request exceeds {} MiB", MAX_REQUEST_BYTES / (1024 * 1024)),
            ));
        }
        bytes.extend_from_slice(&buffer[..n]);
        reader.consume(n);
        if end.is_some() {
            return Ok(Some(std::mem::take(bytes)));
        }
    }
}

/// Consume the remainder of a refused frame so the next request starts on a
/// frame boundary. `read_line` leaves the oversized prefix in `bytes`; dropping
/// it is what lets one bad frame be answered instead of ending the process.
async fn discard_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
) -> io::Result<()> {
    bytes.clear();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok(());
        }
        match buffer.iter().position(|b| *b == b'\n') {
            Some(n) => {
                reader.consume(n + 1);
                return Ok(());
            }
            None => {
                let n = buffer.len();
                reader.consume(n);
            }
        }
    }
}

/// The request id of a frame refused before it decoded, read from the bytes
/// already consumed. Answering it fails only the offending call; an `id: null`
/// answer rejects every request in flight on the same client.
fn leading_request_id(prefix: &[u8]) -> Value {
    let text = String::from_utf8_lossy(prefix);
    let Some(start) = text.find("\"id\"") else {
        return Value::Null;
    };
    let Some(rest) = text[start + 4..].trim_start().strip_prefix(':') else {
        return Value::Null;
    };
    let rest = rest.trim_start();
    if let Some(rest) = rest.strip_prefix('"') {
        return match rest.find('"') {
            Some(end) => Value::String(rest[..end].to_owned()),
            None => Value::Null,
        };
    }
    rest.chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    #[test]
    fn config_stamp_tracks_rewrites_and_absent_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("miao.json");
        let origin = miao_engine::config_derive::LspOrigin::Manifest(path.clone());
        let files = origin.files();
        assert_eq!(super::config_stamp(&files), vec![None]);
        std::fs::write(&path, "{}").unwrap();
        let first = super::config_stamp(&files);
        assert!(first[0].is_some());
        std::fs::write(&path, "{ }").unwrap();
        assert_ne!(super::config_stamp(&files), first);
    }

    #[tokio::test]
    async fn replay_burst_waits_for_output_capacity_instead_of_closing_the_engine() {
        let (output, mut incoming) = tokio::sync::mpsc::channel(2);
        output.send(serde_json::json!(1)).await.unwrap();
        output.send(serde_json::json!(2)).await.unwrap();
        let send = super::send(&output, serde_json::json!(3));
        tokio::pin!(send);
        // A healthy reader has not caught up yet; queue pressure is not EOF.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut send)
                .await
                .is_err()
        );
        assert_eq!(incoming.recv().await, Some(serde_json::json!(1)));
        send.await.unwrap();
        assert_eq!(incoming.recv().await, Some(serde_json::json!(2)));
        assert_eq!(incoming.recv().await, Some(serde_json::json!(3)));
    }

    #[tokio::test]
    async fn oversized_frame_reports_its_id_and_leaves_the_next_request_parseable() {
        let oversized = format!(
            "{{\"id\":4,\"method\":\"admit\",\"pad\":\"{}\"}}\n",
            "a".repeat(super::MAX_REQUEST_BYTES)
        );
        let source = format!("{oversized}{{\"id\":5,\"method\":\"snapshot\"}}\n");
        let mut reader = tokio::io::BufReader::new(source.as_bytes());
        let mut bytes = Vec::new();
        let error = super::read_line(&mut reader, &mut bytes).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        // The id travels in the frame head, before the cap refuses the rest.
        assert_eq!(super::leading_request_id(&bytes), serde_json::json!(4));
        super::discard_line(&mut reader, &mut bytes).await.unwrap();
        let next = super::read_line(&mut reader, &mut bytes)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&next).unwrap()["id"],
            serde_json::json!(5)
        );
    }
}
