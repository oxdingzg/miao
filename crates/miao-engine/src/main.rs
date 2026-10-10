use miao_engine::{
    credential::{Credential, Source},
    host::Host,
    permission::{Config, Policy},
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
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses|gemini] [--endpoint URL] [--policy PATH] [--http ADDR [--http-token TOKEN]]\n       miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine doctor [--db PATH]\nUse ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY for the selected provider. An explicit engine database is required.");
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
            "--tool-replay",
            "--mcp-config",
            "--lsp-config",
            "--hooks-config",
            "--context-config",
            "--skills-config",
            "--references-config",
            "--worker-config",
            "--credential-db",
            "--credential-id",
            "--credential-integration",
            "--auth-file",
            "--http",
            "--http-token",
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
    if ![
        "anthropic",
        "openai-chat",
        "openai-responses",
        "subscription-responses",
        "gemini",
    ]
    .contains(&provider_name)
    {
        return Err("unknown provider".into());
    }
    let integration = options
        .get("--credential-integration")
        .cloned()
        .unwrap_or_else(|| {
            if provider_name == "anthropic" {
                "anthropic".into()
            } else if provider_name == "gemini" {
                "google".into()
            } else {
                "openai".into()
            }
        });
    if options.contains_key("--credential-db") && options.contains_key("--auth-file") {
        return Err("select only one credential source".into());
    }
    let source = if let Some(path) = options.get("--credential-db") {
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
            return Err("credential-id requires credential-db".into());
        }
        Source::Legacy {
            path: tokio::fs::canonicalize(path).await?,
            integration,
        }
    } else {
        if options.contains_key("--credential-id")
            || options.contains_key("--credential-integration")
        {
            return Err("credential selection requires a file/database source".into());
        }
        if provider_name == "subscription-responses" {
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
    source.load().await?;
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
    let provider = miao_engine::routing::build(
        provider_name,
        options.get("--endpoint").map(String::as_str),
        source.clone(),
        model.clone(),
    )?;
    let provider: Arc<dyn Provider> = if let Some(model) = options.get("--fallback-model") {
        let endpoint = options.get("--fallback-endpoint").or_else(|| {
            if provider_name == "gemini" {
                None
            } else {
                options.get("--endpoint")
            }
        });
        let fallback = miao_engine::routing::build(
            provider_name,
            endpoint.map(String::as_str),
            source.clone(),
            model.clone(),
        )?;
        Arc::new(miao_engine::routing::Fallback::new(provider, fallback)?)
    } else {
        provider
    };
    let config = if let Some(path) = options.get("--policy") {
        let bytes = tokio::fs::read(path).await?;
        if bytes.len() > 65536 {
            return Err("permission config exceeds 64 KiB".into());
        }
        serde_json::from_slice::<Config>(&bytes)?
    } else {
        Config::default()
    };
    let policy = Policy::new(config)?;
    let mut tools = Tools::new(workspace)
        .await?
        .with_process_runner(std::env::current_exe()?);
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
        let registry =
            miao_engine::worker::Registry::connect(config, std::path::Path::new(tools.location()))
                .await?;
        tools = tools
            .with_protected_resource(&path)
            .with_worker(Arc::new(registry));
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
        tools = tools
            .with_protected_resource(&path)
            .with_mcp(Arc::new(registry));
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
    let runtime = Runtime::with_policy_and_tool_replay(
        Store::open(db).await?,
        provider,
        tools,
        policy,
        replay,
    )
    .await?;
    if acp {
        let result = miao_engine::acp::serve(runtime.clone()).await;
        runtime.shutdown().await;
        result?;
        return Ok(());
    }
    if options.contains_key("--http-token") && !options.contains_key("--http") {
        return Err("--http-token requires --http".into());
    }
    if let Some(address) = options.get("--http") {
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
        let result = miao_engine::http::serve(runtime.clone(), listener, token).await;
        runtime.shutdown().await;
        result?;
        return Ok(());
    }
    let result = serve(&runtime).await;
    runtime.shutdown().await;
    result?;
    Ok(())
}

async fn serve(runtime: &Runtime) -> io::Result<()> {
    let (output, mut outgoing) = mpsc::channel::<Value>(128);
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
    let result=async {
        loop {
            tokio::select! {
                line=read_line(&mut input,&mut bytes)=>{
                    let Some(line)=line? else { break; };
                    let request=match serde_json::from_slice::<Request>(&line) {
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
                notice=progress.recv()=>match notice {
                    Ok(notice)=>{if notice["session_id"].as_str().is_some_and(|s|host.subscribed(s)) {send(&output,json!({"method":"progress","params":notice}))?;}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>send(&output,json!({"method":"resync","params":{"reason":"ephemeral_progress_lagged"}}))?,
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
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
