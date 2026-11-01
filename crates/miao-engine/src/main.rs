use miao_engine::{
    host::Host,
    protocol::{Command, Error, Request},
    runtime::Runtime,
};
use serde_json::{json, Value};
use std::{collections::HashMap, io, net::SocketAddr, time::Duration};
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
                "product_permission_evaluation": 1,
                "permission_patterns": 1,
                "permission_pattern_changes": 1,
                "saved_permission_migration": 1,
                "permission_import_changes": 1,
                "permission_project_store": 1,
                "permission_changefeed": 1,
                "permission_context_store": 1,
                "permission_project_handoff": 1,
                "permission_context_handoff": 1,
                "permission_source_handoff": 1,
                "permission_source_initialize": 1,
                "shared_permission_runtime": 1,
                "product_permission_requests": 1,
                "product_permission_replies": 1,
                "product_permission_cancel": 1,
                "product_permission_diagnostics": 1,
                "product_permission_auto": 1,
                "saved_rules_snapshot": 1,
                "session_agent_defaults": 1,
            })
        );
        return Ok(());
    }
    if matches!(
        args.first().map(String::as_str),
        Some("permission-source" | "permission-source-init")
    ) {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--db", "--project", "--directory"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("unknown or duplicate permission-source option".into());
            }
        }
        if !remainder.is_empty() || options.len() != 3 {
            return Err(
                "Usage: miao-engine permission-source --db PATH --project ID --directory PATH"
                    .into(),
            );
        }
        let result = serve_permission_source(
            &options["--db"],
            options["--project"].clone(),
            &options["--directory"],
            args[0] == "permission-source-init",
        )
        .await;
        if let Err(error) = &result {
            eprintln!("miao-engine permission-source: {error}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if args.first().map(String::as_str) == Some("permissions") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--db", "--project", "--directory", "--workspace-id"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("unknown or duplicate permissions option".into());
            }
        }
        if !remainder.is_empty()
            || !options.contains_key("--db")
            || !options.contains_key("--project")
            || (options.contains_key("--workspace-id") && !options.contains_key("--directory"))
        {
            return Err("Usage: miao-engine permissions --db PATH --project ID [--directory PATH [--workspace-id ID]]".into());
        }
        let project = options.remove("--project").unwrap();
        let path = options.remove("--db").unwrap();
        let result = serve_permissions(
            &path,
            project,
            options.remove("--directory"),
            options.remove("--workspace-id"),
        )
        .await;
        if let Err(error) = &result {
            eprintln!("miao-engine permissions: {error}");
        }
        // Idle/signal termination can leave Tokio's blocking stdin reader parked.
        // All accepted database operations and stdout replies have settled here.
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if args.first().map(String::as_str) == Some("config") {
        // `json` prints the normalized document the engine actually reads, so a
        // host can compare its own reader against it instead of trusting that
        // the two implementations agree.
        let verb = args.get(1).map(String::as_str);
        let normalized = verb == Some("json");
        // Both verbs are followed by the same flags; `explain` keeps working as
        // it did, and a bare flag still parses for older callers.
        let rest: &[String] = match verb {
            Some("json") | Some("explain") => &args[2..],
            _ => &args[1..],
        };
        let sources =
            match rest {
                [flag, directory] if flag == "--config-dir" => {
                    vec![miao_engine::config_derive::Source::Dir(directory.into())]
                }
                [flag, plan] if flag == "--config-sources" => {
                    let plan = if plan == "-" {
                        use std::io::Read;
                        let mut input = Vec::new();
                        std::io::stdin()
                            .lock()
                            .take(1024 * 1024 + 1)
                            .read_to_end(&mut input)?;
                        if input.len() > 1024 * 1024 {
                            return Err("config source plan exceeds 1 MiB".into());
                        }
                        String::from_utf8(input).map_err(|_| "config source plan must be UTF-8")?
                    } else {
                        plan.clone()
                    };
                    miao_engine::config_derive::plan(&plan)?
                }
                _ => return Err(if normalized {
                    "Usage: miao-engine config json --config-dir PATH | --config-sources JSON|-"
                } else {
                    "Usage: miao-engine config explain --config-dir PATH | --config-sources JSON|-"
                }
                .into()),
            };
        let report = tokio::task::spawn_blocking(move || match normalized {
            true => miao_engine::config_derive::normalized_from_sources(&sources),
            false => miao_engine::config_explain::report(&sources),
        })
        .await??;
        let output = serde_json::to_vec(&report)?;
        if output.len() > 8 * 1024 * 1024 {
            return Err("config explanation exceeds 8 MiB".into());
        }
        use std::io::Write;
        std::io::stdout().lock().write_all(&output)?;
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
    let configured = miao_engine::cli::configure(&args)
        .await
        .map_err(|error| format!("engine configuration failed: {error}"))?;
    let miao_engine::cli::Configured {
        runtime,
        mut options,
        acp,
        plugin_hooks,
    } = configured;
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

/// Canonicalize one optional path flag. A context origin records canonical
/// paths, so a reload re-reads exactly the file startup read.
async fn serve_permissions(
    path: &str,
    project: String,
    directory: Option<String>,
    workspace_id: Option<String>,
) -> io::Result<()> {
    let controller = match directory {
        Some(directory) => {
            miao_engine::permission_control::Controller::open_context(
                path,
                project,
                directory,
                workspace_id,
            )
            .await
        }
        None => miao_engine::permission_control::Controller::open(path, project).await,
    }
    .map_err(io::Error::other)?;
    serve_permission_control(|value| controller.dispatch(value)).await
}

async fn serve_permission_source(
    path: &str,
    project: String,
    directory: &str,
    initialize: bool,
) -> io::Result<()> {
    let controller = if initialize {
        miao_engine::permission_source_control::Controller::initialize(path, project, directory)
            .await
    } else {
        miao_engine::permission_source_control::Controller::open(path, project, directory).await
    }
    .map_err(io::Error::other)?;
    let result = serve_permission_control(|value| controller.dispatch(value)).await;
    controller.close().await.map_err(io::Error::other)?;
    result
}

async fn serve_permission_control<F, Reply>(dispatch: F) -> io::Result<()>
where
    F: Fn(Value) -> Reply,
    Reply: std::future::Future<Output = (Value, bool)>,
{
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut bytes = Vec::new();
    loop {
        let line = tokio::select! {
            line=read_line(&mut input, &mut bytes)=>line,
            _=signal_exit()=>break,
            _=tokio::time::sleep(Duration::from_secs(300))=>break,
        };
        let (response, shutdown) = match line {
            Ok(Some(line)) => match serde_json::from_slice::<Value>(&line) {
                Ok(value) => dispatch(value).await,
                Err(_) => (
                    json!({"id":null,"error":{"code":"invalid_request","message":"expected JSON"}}),
                    false,
                ),
            },
            Ok(None) => break,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let id = leading_request_id(&bytes);
                discard_line(&mut input, &mut bytes).await?;
                (
                    json!({"id":id,"error":{"code":"request_too_large","message":error.to_string()}}),
                    false,
                )
            }
            Err(error) => return Err(error),
        };
        let mut line = serde_json::to_vec(&response).map_err(io::Error::other)?;
        line.push(b'\n');
        output.write_all(&line).await?;
        output.flush().await?;
        if shutdown {
            break;
        }
    }
    Ok(())
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
        if let Some(context) = manifest.get("host_context") {
            runtime
                .set_product_context(
                    serde_json::from_value(context.clone()).map_err(io::Error::other)?,
                )
                .await
                .map_err(io::Error::other)?;
        }
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
    let mut config_events = runtime.config_events();
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
                report=config_events.recv()=>match report {
                    // A reloaded configuration is process-wide, not
                    // Session-scoped, so every subscriber is told. A lagged
                    // listener skipped a notice it cannot replay; the next
                    // reload still reports its own generation.
                    Ok(report)=>send(&output,json!({"method":"config","params":report})).await?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{},
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
