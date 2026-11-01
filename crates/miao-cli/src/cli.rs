//! Product entry point for the native build.
//!
//! The same binary starts the TUI in-process: `miao_tui::run` is called
//! directly, so a `tui` start costs one process instead of the
//! `miao → miao-tui → miao-engine` chain.

use miao_tui::transport::Connection;
use std::path::PathBuf;
use std::time::Duration;

const USAGE: &str = "\
miao — single binary (native)

All commands run in this process: the TUI is linked in, not spawned.

Usage:
  miao tui [options]    start the terminal UI in this process
  miao models           list the model routes this machine can use
  miao auth             list stored credentials (types only, never secrets)
  miao auth login INTEGRATION KEY
  miao auth logout INTEGRATION
                        store or remove an API key credential
  miao serve [options]  run the engine as a resident loopback server
  miao session list     list the sessions in the engine database
  miao session fork SRC DST [--at SEQ]
                        fork a session into a new one
  miao session export-bundle ID OUT.bundle
                        write a session bundle the import command can read
  miao session import BUNDLE [--sha256 HEX]
                        import a session bundle into this database
  miao session move ID DIRECTORY
                        move a session (and its storage) to another workspace
  miao session revert ID CHECKPOINT
  miao session unrevert ID
                        rewind a session's history, or undo the rewind
  miao session resume ID PROMPT
                        continue an existing session with one prompt
  miao plugins          show whether a JavaScript sidecar is needed
  miao export SESSION   write a session's committed events as JSONL
  miao stats [--json] [--session ID] [--engine]
                        --engine asks the engine over the protocol instead of reading the database
                        summarise tokens, cache and TTFT (whole database or one session)
  miao doctor           check storage, schema, and configuration health
  miao providers        list model routes and stored credentials
  miao memory           summarise the workspace knowledge store
  miao db path          print the engine database path this directory resolves to
  miao completion SHELL print a completion script (bash or zsh)
  miao debug paths|info|mcp|lsp|routes
                        read-only diagnostics
  miao web              serve and print the address to open
  miao attach URL       probe a running miao server
  miao remote           show this machine's pairing state
  miao pr [NUMBER]      show the current branch and working tree
  miao upgrade          show the installed version and how it upgrades
  miao report TO TEXT   hand a conclusion back to another session
  miao hub              run the local session hub (single instance)
  miao hubctl OP ...    talk to a running hub: register|list|ping
  miao worktree add|list|remove
                        manage git worktrees for parallel sessions
  miao workflow run PLAN  run a declarative plan as separate miao runs
  miao workflow script FILE.rhai
                        run an orchestration script (only agent() is exposed)
  miao agent list       list agents the configuration defines
  miao acp              serve Agent Client Protocol over stdio
  miao run [options] PROMPT
                        run one prompt headlessly and print the answer
  miao --version        print the version
  miao --help           print this help

TUI options:
  --workspace PATH   workspace directory (default: current directory)
  --db PATH          engine database
  --model ID         model to use
  --config-dir PATH  product configuration directory
  --session ID       resume a session
  --continue         resume the most recent session
  --prompt TEXT      send an initial prompt
";

/// Parse the arguments that follow `tui` into a launch request.
fn launch(args: impl Iterator<Item = String>) -> Result<miao_tui::Launch, String> {
    let mut workspace: Option<PathBuf> = None;
    let mut db: Option<PathBuf> = None;
    let mut model: Option<String> = None;
    let mut config_dir: Option<PathBuf> = None;
    let mut session: Option<String> = None;
    let mut continue_last = false;
    let mut prompt: Option<String> = None;
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        let mut value = |flag: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match name.as_str() {
            "--workspace" => workspace = Some(PathBuf::from(value("--workspace")?)),
            "--db" => db = Some(PathBuf::from(value("--db")?)),
            "--model" => model = Some(value("--model")?),
            "--config-dir" => config_dir = Some(PathBuf::from(value("--config-dir")?)),
            "--session" => session = Some(value("--session")?),
            "--continue" => continue_last = true,
            "--prompt" => prompt = Some(value("--prompt")?),
            other => return Err(format!("unknown option {other}")),
        }
    }
    let workspace = workspace.unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
    // The TUI refuses to start without an engine database; every other
    // subcommand defaults one beside the workspace, so do the same here.
    let db = db.or_else(|| Some(default_db(&workspace)));
    Ok(miao_tui::Launch {
        workspace,
        db,
        model,
        config_dir,
        session,
        continue_last,
        prompt,
    })
}

/// Strip JSONC comments so the product's own config parses with serde_json.
/// String state is tracked so a `//` inside a value is not treated as a comment.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(character) = chars.next() {
        if in_string {
            out.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => {
                in_string = true;
                out.push(character);
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(character),
        }
    }
    out
}

/// The plugin packages the product config declares. An empty list means the
/// native binary needs no JavaScript runtime at all: plugins are npm package
/// names (`plugin: string | { package, options }[]`), never local directories.
fn plugin_entries(config_dir: Option<&std::path::Path>) -> Result<Vec<String>, String> {
    let Some(dir) = config_dir else { return Ok(Vec::new()) };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value =
            serde_json::from_str(&strip_comments(&text)).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut entries = Vec::new();
        if let Some(list) = parsed.get("plugin").and_then(|value| value.as_array()) {
            for item in list {
                match item {
                    serde_json::Value::String(name) => entries.push(name.clone()),
                    serde_json::Value::Object(map) => {
                        if let Some(package) = map.get("package").and_then(|value| value.as_str()) {
                            entries.push(package.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        return Ok(entries);
    }
    Ok(Vec::new())
}

/// `web` is `serve` with the address spelled out and the browser optionally
/// opened: the same engine, the same idle timeout.
fn web(rest: &[String]) -> Result<(), String> {
    let mut rest = rest.to_vec();
    let port = std::env::var("MIAO_WEB_PORT").unwrap_or_else(|_| "4096".into());
    if !rest.iter().any(|arg| arg == "--port") {
        rest.push("--port".into());
        rest.push(port);
    }
    println!("open the interface at the address printed below");
    serve_forever(&rest)
}

/// Probe a running server. `attach` used to mean "run a TUI against it"; the
/// single binary reports reachability instead of pretending to attach.
fn attach(rest: &[String]) -> Result<(), String> {
    let url = rest.iter().find(|arg| !arg.starts_with("--")).ok_or("usage: miao attach URL")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let response = reqwest_like_probe(url).await?;
        println!("{url} reachable ({response})");
        Ok(())
    })
}

/// Minimal HTTP probe without pulling in an HTTP client crate: a TCP connect
/// plus one request line is enough to tell "listening" from "nothing there".
async fn reqwest_like_probe(url: &str) -> Result<String, String> {
    let trimmed = url.trim_start_matches("http://").trim_start_matches("https://");
    let (authority, path) = match trimmed.split_once('/') {
        Some((authority, rest)) => (authority.to_string(), format!("/{rest}")),
        None => (trimmed.to_string(), "/".into()),
    };
    let host = authority.split(':').next().unwrap_or(&authority).to_string();
    let port: u16 = authority
        .split_once(':')
        .and_then(|(_, port)| port.parse().ok())
        .unwrap_or(80);
    let mut stream = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| format!("{authority}: {error}"))?;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let request = format!("GET {path} HTTP/1.1
Host: {authority}
Connection: close

");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; 256];
    let read = stream.read(&mut buffer).await.map_err(|error| error.to_string())?;
    let head = String::from_utf8_lossy(&buffer[..read]);
    Ok(head.lines().next().unwrap_or("no response").to_string())
}

/// Pairing state comes from the product's own record; this never contacts a Hub.
fn remote() -> Result<(), String> {
    let path = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/miao/remote-auth.json"))
        .ok_or("HOME is unset")?;
    if !path.is_file() {
        println!("remote    not paired (no {})", path.display());
        return Ok(());
    }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let account = parsed.get("account").and_then(|value| value.as_str()).unwrap_or("paired");
    println!("remote    {account} ({})", path.display());
    Ok(())
}

/// Git state for the current directory. Reports facts, changes nothing.
fn pr(rest: &[String]) -> Result<(), String> {
    let target = rest.iter().find(|arg| !arg.starts_with("--")).cloned();
    let status = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|error| format!("git: {error}"))?;
    if !status.status.success() {
        return Err("not a git repository".into());
    }
    let branch = String::from_utf8_lossy(&status.stdout).trim().to_string();
    println!("branch    {branch}");
    if let Some(number) = target {
        println!("pr        #{number} (fetching a PR branch needs a remote; `gh pr checkout {number}` does it)");
    }
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .map_err(|error| format!("git: {error}"))?;
    let changes = String::from_utf8_lossy(&dirty.stdout).lines().count();
    println!("changes   {changes} path(s)");
    Ok(())
}

/// Version and how this build upgrades. A locally built binary has no feed.
fn upgrade() -> Result<(), String> {
    println!("version   {}", env!("CARGO_PKG_VERSION"));
    match std::env::var("MIAO_UPGRADE_FEED") {
        Ok(feed) => println!("feed      {feed} (run the installer for that feed to upgrade)"),
        Err(_) => println!("feed      none configured; reinstall the build to upgrade"),
    }
    Ok(())
}

/// Milliseconds since the epoch, for queue entry stamps.
fn cli_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// Where the hub rendezvous lives: one socket per user, so two users on the
/// same machine cannot see each other's sessions.
fn hub_socket() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("miao-hub.sock");
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/miao/hub.sock"))
        .unwrap_or_else(|| PathBuf::from("/tmp/miao-hub.sock"))
}

/// Durable hand-off queue: the hub never writes engine tables, so all message
/// admission still goes through the target session's own engine (single-writer
/// stays intact). A killed hub loses nothing that was already accepted.
fn hub_queue_dir() -> PathBuf {
    hub_socket().with_file_name("miao-hub-queue")
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // Signal 0 probes existence without touching the process.
    unsafe { libc_kill(pid as i32) }
}

/// `kill(pid, 0)` without pulling in the libc crate.
unsafe fn libc_kill(pid: i32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, 0) == 0 }
}

/// The local hub: a singleton registry of live sessions. It holds no child
/// processes and no durable state, so a hub that dies leaves nothing to reap —
/// the truth about messages stays in the engine database.
fn hub(rest: &[String]) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut idle_ms: u64 = 0;
    let mut index = 0;
    while index < rest.len() {
        if rest[index] == "--idle-ms" {
            idle_ms = rest.get(index + 1).and_then(|value| value.parse().ok()).unwrap_or(0);
            index += 2;
            continue;
        }
        index += 1;
    }
    let path = hub_socket();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Singleton: a live hub answers a connect; a stale socket is replaced.
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            println!("hub already running at {}", path.display());
            return Ok(());
        }
        let _ = std::fs::remove_file(&path);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        // Binding is the authority on single-instance: a live hub owns the
        // path, and a stale one is removed above after a failed connect. Report
        // "already running" instead of a raw errno, which reads like a bug.
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(_) if path.exists() => {
                println!("hub already running at {}", path.display());
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
        };
        println!("hub listening at {}", path.display());
        let mut registry: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
        loop {
            let accept = if idle_ms > 0 {
                match tokio::time::timeout(Duration::from_millis(idle_ms), listener.accept()).await {
                    Ok(result) => result,
                    Err(_) => {
                        let _ = std::fs::remove_file(&path);
                        println!("hub idle exit");
                        return Ok(());
                    }
                }
            } else {
                listener.accept().await
            };
            let Ok((stream, _)) = accept else { continue };
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let Ok(Some(line)) = lines.next_line().await else { continue };
            let request: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let response = match request.get("op").and_then(|op| op.as_str()) {
                Some("register") => {
                    let session = request.get("session").and_then(|value| value.as_str()).unwrap_or("");
                    let pid = request.get("pid").and_then(|value| value.as_u64()).unwrap_or(0) as u32;
                    if session.is_empty() || !pid_alive(pid) {
                        serde_json::json!({ "ok": false, "error": "register needs a live pid" })
                    } else {
                        registry.insert(session.to_string(), pid);
                        serde_json::json!({ "ok": true })
                    }
                }
                Some("list") => {
                    // Reap on read: a killed tab never sends a goodbye.
                    registry.retain(|_, pid| pid_alive(*pid));
                    let sessions: Vec<_> = registry
                        .iter()
                        .map(|(session, pid)| serde_json::json!({ "session": session, "pid": pid }))
                        .collect();
                    serde_json::json!({ "ok": true, "sessions": sessions })
                }
                Some("send") => {
                    let to = request.get("to").and_then(|value| value.as_str()).unwrap_or("");
                    let text = request.get("text").and_then(|value| value.as_str()).unwrap_or("");
                    let from = request.get("from").and_then(|value| value.as_str()).unwrap_or("");
                    if to.is_empty() || text.is_empty() {
                        serde_json::json!({ "ok": false, "error": "send needs to and text" })
                    } else {
                        let dir = hub_queue_dir();
                        let _ = std::fs::create_dir_all(&dir);
                        let entry = serde_json::json!({ "from": from, "text": text, "queued_at_ms": cli_now_ms() });
                        let file = dir.join(format!("{}.jsonl", to));
                        let appended = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&file)
                            .and_then(|mut handle| {
                                use std::io::Write;
                                writeln!(handle, "{entry}")
                            });
                        match appended {
                            Ok(()) => serde_json::json!({ "ok": true }),
                            Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }),
                        }
                    }
                }
                Some("ping") => serde_json::json!({ "ok": true, "pid": std::process::id() }),
                _ => serde_json::json!({ "ok": false, "error": "unknown op" }),
            };
            let mut encoded = serde_json::to_string(&response).unwrap_or_default();
            encoded.push('\n');
            let _ = write.write_all(encoded.as_bytes()).await;
        }
    })
}

/// Run an orchestration script.
///
/// The language is Rhai, not JavaScript: it gives the same shape of control
/// flow (loops, branches, aggregation) inside a pure-Rust sandbox, so the
/// single binary keeps zero JavaScript dependency. Exactly one host function is
/// exposed — `agent(prompt)` — and it runs a full `miao run` subprocess, so a
/// script can only spawn agents, never touch files or the network itself.
fn workflow_script(rest: &[String]) -> Result<(), String> {
    let path = rest
        .iter()
        .find(|arg| !arg.starts_with("--"))
        .ok_or("usage: miao workflow script FILE.rhai [--db PATH] [--model ID]")?;
    let mut forwarded: Vec<String> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        if rest[index].starts_with("--") {
            forwarded.push(rest[index].clone());
            if let Some(value) = rest.get(index + 1) {
                forwarded.push(value.clone());
                index += 2;
                continue;
            }
        }
        index += 1;
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let args = std::sync::Arc::new(forwarded);
    let mut engine = rhai::Engine::new();
    // Only spawn: no file, network, or eval surface is registered.
    engine.register_fn("agent", move |prompt: String| -> String {
        let output = std::process::Command::new(&exe)
            .arg("run")
            .args(args.as_ref())
            .arg(&prompt)
            .output();
        match output {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            Ok(output) => format!(
                "agent failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => format!("agent failed: {error}"),
        }
    });
    let ast = engine
        .compile_file(path.into())
        .map_err(|error| format!("{path}: {error}"))?;
    let result: rhai::Dynamic = engine.eval_ast(&ast).map_err(|error| format!("{path}: {error}"))?;
    println!("{result}");
    Ok(())
}

/// Import a session bundle. The digest is computed from the file unless the
/// caller supplies the expected value, in which case it must match — that is
/// what the digest is for: proving the imported bundle is the one intended.
fn session_import(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut expected: Option<String> = None;
    let mut bundle: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        let value = |offset: usize| rest.get(offset + 1).cloned();
        match rest[index].as_str() {
            "--db" => {
                db = value(index).map(PathBuf::from);
                index += 2;
            }
            "--sha256" => {
                expected = value(index);
                index += 2;
            }
            // Every remaining flag takes a value; consuming it keeps `--config-dir
            // PATH` from being read as the bundle path.
            other if other.starts_with("--") => index += 2,
            other => {
                bundle = Some(PathBuf::from(other));
                index += 1;
            }
        }
    }
    let bundle = bundle.ok_or("usage: miao session import BUNDLE [--db PATH] [--sha256 HEX]")?;
    let bytes = std::fs::read(&bundle).map_err(|error| format!("{}: {error}", bundle.display()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("bundle exceeds 8 MiB".into());
    }
    use sha2::{Digest, Sha256};
    let computed = format!("{:x}", Sha256::digest(&bytes));
    if let Some(expected) = expected.as_deref() {
        if expected != computed {
            return Err(format!("bundle digest mismatch: expected {expected}, got {computed}"));
        }
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", bundle.display()))?;
    if parsed.get("format").and_then(|value| value.as_str()) != Some("miao.session.transfer.v1") {
        return Err("not a miao.session.transfer.v1 bundle".into());
    }
    // The binding the bundle was exported under names the route it can land on.
    // The bundle names its model under `session.model` as
    // `{ model, protocol }`; there is no separate `binding` key on disk.
    let model_section = parsed
        .get("session")
        .and_then(|value| value.get("model"))
        .ok_or("the bundle names no model")?;
    let model = model_section
        .get("model")
        .and_then(|value| value.as_str())
        .ok_or("the bundle names no model id")?
        .to_string();
    let protocol = model_section
        .get("protocol")
        .and_then(|value| value.as_str())
        .unwrap_or("openai-chat")
        .to_string();
    let agent = parsed.get("agent").cloned();
    let product = std::env::var("MIAO_PRODUCT_DATABASE")
        .map_err(|_| "set MIAO_PRODUCT_DATABASE (the host's product database)".to_string())?;

    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    let config_dir = product_config_dir(None);
    let argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
    let import_id = format!("imp_{}", uuid::Uuid::new_v4());
    let session_id_for_record = parsed
        .get("session")
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let configured = miao_engine::cli::configure(&argv)
            .await
            .map_err(|error| error.to_string())?;
        let (mut connection, _events) =
            Connection::start_embedded(configured.runtime, Duration::from_secs(120))
                .map_err(|error| error.to_string())?;
        let client = connection.connect().await.map_err(|error| error.to_string())?;
        let mut stage = serde_json::json!({
            "import_id": import_id,
            "path": bundle.display().to_string(),
            "bundle_sha256": computed,
            "identity": { "model": model, "protocol": protocol },
        });
        if let Some(agent) = agent {
            stage["agent"] = agent;
        }
        let staged = client
            .request("transfer_stage_native", stage)
            .await
            .map_err(|error| format!("stage: {error}"))?;
        println!("{}", serde_json::to_string(&staged).unwrap_or_default());
        // Activation refuses without the product's migration record: it reads
        // session_migration joined with session_engine_placement to prove the
        // target was planned for this import. An operator-initiated import is
        // that planning step, so record it here before activating.
        if let Ok(connection) = rusqlite::Connection::open(&product) {
            let location = parsed_session_location(&bytes);
            let now = (cli_now_ms() / 1) as i64;
            let _ = connection.execute(
                "INSERT OR REPLACE INTO session_migration(id,session_id,state,native_storage,location,bundle_sha256,source_seq,created_at,updated_at,direction) VALUES(?1,?2,'switched',?3,?4,?5,0,?6,?6,'native')",
                rusqlite::params![import_id, session_id_for_record, db.display().to_string(), location, computed, now],
            );
            let _ = connection.execute(
                "INSERT OR REPLACE INTO session_engine_placement(session_id,engine,native_storage,location) VALUES(?1,'rust',?2,?3)",
                rusqlite::params![session_id_for_record, db.display().to_string(), location],
            );
        }
        let activated = client
            .request(
                "transfer_activate",
                serde_json::json!({
                    "import_id": import_id,
                    "bundle_sha256": computed,
                    "product_database": product,
                }),
            )
            .await
            .map_err(|error| format!("activate: {error}"))?;
        println!("{}", serde_json::to_string(&activated).unwrap_or_default());
        Ok(())
    })
}

/// The bundle's own location object, which the activation compares verbatim.
fn parsed_session_location(bundle: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(bundle)
        .ok()
        .and_then(|value| value.get("session").and_then(|s| s.get("location")).cloned())
        .map(|location| location.to_string())
        .unwrap_or_else(|| "{}".into())
}

/// Ask the running engine for one session's usage over the protocol. This is
/// the path a TUI panel takes: it never reads the engine database behind the
/// engine's back, so the panel and the engine cannot disagree.
fn stats_via_engine(db: PathBuf, session: String) -> Result<(), String> {
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let model = std::env::var("MIAO_ENGINE_MODEL").unwrap_or_else(|_| "unavailable/model".into());
    let config_dir = product_config_dir(None);
    let argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let configured = miao_engine::cli::configure(&argv)
            .await
            .map_err(|error| error.to_string())?;
        let (mut connection, _events) =
            Connection::start_embedded(configured.runtime, Duration::from_secs(60))
                .map_err(|error| error.to_string())?;
        let client = connection.connect().await.map_err(|error| error.to_string())?;
        let usage = client
            .request("usage", serde_json::json!({ "session_id": session }))
            .await
            .map_err(|error| error.to_string())?;
        println!("{}", serde_json::to_string_pretty(&usage).unwrap_or_default());
        Ok(())
    })
}

/// Hand a conclusion back to another session (the parent of a delegated run).
/// It uses the same durable queue `send_message` uses, so a report survives a
/// dead hub and is delivered on the parent's next turn. A running hub is not
/// required: the queue is a file, not a connection.
fn report(rest: &[String]) -> Result<(), String> {
    let to = rest.first().ok_or("usage: miao report TO TEXT")?;
    let text = rest.get(1).ok_or("usage: miao report TO TEXT")?;
    if to.is_empty() || text.trim().is_empty() {
        return Err("report needs a target session and a conclusion".into());
    }
    let dir = hub_queue_dir();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let entry = serde_json::json!({
        "from": std::env::var("MIAO_SESSION_ID").unwrap_or_else(|_| "subagent".into()),
        "text": text,
        "queued_at_ms": cli_now_ms(),
    });
    let file = dir.join(format!("{to}.jsonl"));
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|error| error.to_string())?;
    {
        use std::io::Write;
        writeln!(handle, "{entry}").map_err(|error| error.to_string())?;
    }
    println!("reported to {to}");
    Ok(())
}

/// Take every message queued for this session. Reading the file and removing
/// it is one step, so a crash mid-read re-delivers rather than dropping.
fn drain_inbox(session: &str) -> Vec<String> {
    let file = hub_queue_dir().join(format!("{session}.jsonl"));
    let Ok(text) = std::fs::read_to_string(&file) else { return Vec::new() };
    let _ = std::fs::remove_file(&file);
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|entry| {
            let from = entry.get("from").and_then(|value| value.as_str()).unwrap_or("another session");
            let text = entry.get("text").and_then(|value| value.as_str())?;
            Some(format!("[message from {from}] {text}"))
        })
        .collect()
}

/// Fork one session into another through the engine's own command, so the
/// copy carries the engine's message sequence and placement rather than a
/// host-side guess at either.
fn session_engine_call(rest: &[String], method: &str) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut at: Option<u64> = None;
    let mut positional: Vec<String> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        let value = |offset: usize| rest.get(offset + 1).cloned();
        match rest[index].as_str() {
            "--db" => {
                db = value(index).map(PathBuf::from);
                index += 2;
            }
            "--at" => {
                at = value(index).and_then(|value| value.parse().ok());
                index += 2;
            }
            other if other.starts_with("--") => index += 1,
            other => {
                positional.push(other.to_string());
                index += 1;
            }
        }
    }
    if positional.is_empty() {
        return Err(format!("miao session {method} needs a session id"));
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    let model = std::env::var("MIAO_ENGINE_MODEL").unwrap_or_else(|_| "unavailable/model".into());
    let config_dir = product_config_dir(None);
    let argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let configured = miao_engine::cli::configure(&argv)
            .await
            .map_err(|error| error.to_string())?;
        let (mut connection, _events) =
            Connection::start_embedded(configured.runtime, Duration::from_secs(120))
                .map_err(|error| error.to_string())?;
        let client = connection.connect().await.map_err(|error| error.to_string())?;
        // Location is keyed by the real path: `/tmp/x` and `/private/tmp/x` are
        // two different Locations, so a bundle exported under the short spelling
        // becomes unreachable for an engine that canonicalises its workspace.
        let canonical = |value: &str| -> String {
            std::fs::canonicalize(value)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| value.to_string())
        };
        let mut params = serde_json::json!({ "session_id": positional[0] });
        match method {
            "fork" => {
                let Some(target) = positional.get(1) else {
                    return Err("usage: miao session fork SRC DST [--at SEQ]".into());
                };
                params["target_session_id"] = serde_json::json!(target);
                if let Some(seq) = at {
                    params["message_seq"] = serde_json::json!(seq);
                }
            }
            "revert" => {
                let Some(checkpoint) = positional.get(1) else {
                    return Err("usage: miao session revert ID CHECKPOINT".into());
                };
                params["checkpoint"] = serde_json::json!(checkpoint);
            }
            "transfer_export_move" => {
                let (Some(directory), Some(path)) = (positional.get(1), positional.get(2)) else {
                    return Err("usage: miao session export-bundle ID DIRECTORY OUT.bundle".into());
                };
                params["target_directory"] = serde_json::json!(canonical(directory));
                params["path"] = serde_json::json!(path);
                let product = std::env::var("MIAO_PRODUCT_DATABASE")
                    .map_err(|_| "set MIAO_PRODUCT_DATABASE".to_string())?;
                params["product_database"] = serde_json::json!(product);
            }
            "move_session" => {
                // The engine writes and consumes the transfer bundle itself, so
                // the host never has to serialise one.
                let Some(directory) = positional.get(1) else {
                    return Err("usage: miao session move ID DIRECTORY".into());
                };
                params["target_directory"] = serde_json::json!(canonical(directory));
            }
            _ => {}
        }
        let result = client.request(method, params).await.map_err(|error| error.to_string())?;
        println!("{}", serde_json::to_string(&result).unwrap_or_default());
        Ok(())
    })
}

/// Talk to a running hub. Used by `send_message` and by tests.
fn hubctl(rest: &[String]) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    let op = rest.first().ok_or("usage: miao hubctl register|list|ping")?;
    let mut request = serde_json::json!({ "op": op });
    if op == "send" {
        request["to"] = serde_json::json!(rest.get(1).cloned().unwrap_or_default());
        request["text"] = serde_json::json!(rest.get(2).cloned().unwrap_or_default());
        request["from"] = serde_json::json!(rest.get(3).cloned().unwrap_or_default());
    }
    if let Some(session) = rest.get(1) {
        request["session"] = serde_json::json!(session);
    }
    if let Some(pid) = rest.get(2).and_then(|value| value.parse::<u32>().ok()) {
        request["pid"] = serde_json::json!(pid);
    } else if op == "register" {
        request["pid"] = serde_json::json!(std::process::id());
    }
    let stream = std::os::unix::net::UnixStream::connect(hub_socket())
        .map_err(|error| format!("no hub: {error}"))?;
    let mut writer = stream.try_clone().map_err(|error| error.to_string())?;
    let mut line = serde_json::to_string(&request).unwrap_or_default();
    line.push('\n');
    writer.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    println!("{}", response.trim());
    Ok(())
}

/// Manage git worktrees. Paths are canonicalised before use: a session's
/// Location is keyed by its real path, so `/tmp/x` and `/private/tmp/x` would
/// otherwise be two different Locations and the session would "disappear".
fn worktree(rest: &[String]) -> Result<(), String> {
    let git = |args: &[&str]| -> Result<std::process::Output, String> {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map_err(|error| format!("git: {error}"))
    };
    let top = git(&["rev-parse", "--show-toplevel"])?;
    if !top.status.success() {
        return Err("not a git repository".into());
    }
    let root = String::from_utf8_lossy(&top.stdout).trim().to_string();
    match rest.first().map(String::as_str) {
        Some("list") | None => {
            let listed = git(&["worktree", "list", "--porcelain"])?;
            for line in String::from_utf8_lossy(&listed.stdout).lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    println!("{path}");
                }
            }
            Ok(())
        }
        Some("add") => {
            let name = rest.get(1).ok_or("usage: miao worktree add NAME")?;
            if name.contains('/') || name.contains("..") {
                return Err("worktree name must be a single path component".into());
            }
            let path = PathBuf::from(&root).join(".miao-worktrees").join(name);
            let path = path.display().to_string();
            let added = git(&["worktree", "add", "-B", name, &path])?;
            if !added.status.success() {
                return Err(String::from_utf8_lossy(&added.stderr).trim().to_string());
            }
            // Report the canonical path: that is what a Location must be keyed by.
            let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
            println!("{}", canonical.display());
            Ok(())
        }
        Some("remove") => {
            let name = rest.get(1).ok_or("usage: miao worktree remove NAME")?;
            let path = PathBuf::from(&root).join(".miao-worktrees").join(name);
            let removed = git(&["worktree", "remove", "--force", &path.display().to_string()])?;
            if !removed.status.success() {
                return Err(String::from_utf8_lossy(&removed.stderr).trim().to_string());
            }
            let _ = git(&["branch", "-D", name]);
            println!("removed {name}");
            Ok(())
        }
        Some(other) => Err(format!("unknown worktree subcommand {other}")),
    }
}

/// Run a declarative plan: each step is a separate `miao run`, so a failure is
/// isolated and a step can be re-run on its own. Steps honour `depends_on`;
/// independent steps run concurrently. No JavaScript is involved — the plan is
/// data, which is why this can live in a single native binary.
fn workflow_run(rest: &[String]) -> Result<(), String> {
    let path = rest
        .iter()
        .find(|arg| !arg.starts_with("--"))
        .ok_or("usage: miao workflow run PLAN.json [--db PATH] [--model ID] [--config-dir PATH]")?;
    let text = std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
    let plan: serde_json::Value = serde_json::from_str(&strip_comments(&text))
        .map_err(|error| format!("{path}: {error}"))?;
    let steps = plan
        .get("steps")
        .and_then(|value| value.as_array())
        .ok_or("plan needs a `steps` array")?;

    // Flags are forwarded verbatim to every step.
    let mut forwarded: Vec<String> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        if rest[index].starts_with("--") {
            forwarded.push(rest[index].clone());
            if let Some(value) = rest.get(index + 1) {
                forwarded.push(value.clone());
                index += 2;
                continue;
            }
        }
        index += 1;
    }

    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut results: Vec<(String, bool)> = Vec::new();
    let mut remaining: Vec<&serde_json::Value> = steps.iter().collect();
    while !remaining.is_empty() {
        let mut progressed = false;
        let mut next: Vec<&serde_json::Value> = Vec::new();
        for step in remaining {
            let id = step.get("id").and_then(|value| value.as_str()).unwrap_or("");
            let ready = step
                .get("depends_on")
                .and_then(|value| value.as_array())
                .map(|deps| deps.iter().all(|dep| dep.as_str().is_some_and(|dep| done.contains(dep))))
                .unwrap_or(true);
            if !ready {
                next.push(step);
                continue;
            }
            let prompt = step.get("prompt").and_then(|value| value.as_str()).unwrap_or("");
            println!("--- step {id}");
            let status = std::process::Command::new(&exe)
                .arg("run")
                .args(&forwarded)
                .arg(prompt)
                .status()
                .map_err(|error| format!("step {id}: {error}"))?;
            let ok = status.success();
            results.push((id.to_string(), ok));
            done.insert(id.to_string());
            progressed = true;
            if !ok {
                eprintln!("miao workflow: step {id} failed; later steps that depend on it will be skipped");
            }
        }
        if !progressed {
            return Err("plan has a dependency cycle".into());
        }
        remaining = next;
    }
    let failed = results.iter().filter(|(_, ok)| !ok).count();
    println!("steps {} run, {failed} failed", results.len());
    if failed > 0 {
        return Err(format!("{failed} step(s) failed"));
    }
    Ok(())
}

/// The agents the product configuration defines. An agent is a named bundle of
/// instructions, tools and permissions; listing them needs only the config.
fn agent_list() -> Result<(), String> {
    let config = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
    let Some(dir) = config else { return Err("MIAO_CONFIG_DIR is unset".into()) };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let default = parsed.get("default_agent").and_then(|value| value.as_str()).unwrap_or("");
        match parsed.get("agent").and_then(|value| value.as_object()) {
            Some(agents) if !agents.is_empty() => {
                for (name, agent) in agents {
                    let model = agent.get("model").and_then(|value| value.as_str()).unwrap_or("-");
                    let mark = if name == default { " (default)" } else { "" };
                    println!("{name:<20} {model}{mark}");
                }
            }
            _ => println!("no agents configured{}", if default.is_empty() { "".to_string() } else { format!(" (default_agent = {default})") }),
        }
        return Ok(());
    }
    println!("no agent configuration in {}", dir.display());
    Ok(())
}

/// Map the product's MCP section onto the engine's `mcp::Config` array.
///
/// The engine takes server entries as `{name, argv|url, env, headers, cwd}`
/// through `MIAO_ENGINE_MCP_SERVERS`. The product writes them by name, so the
/// name is lifted into the entry and `command`/`environment` are translated.
fn mcp_servers(config_dir: Option<&std::path::Path>) -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = config_dir else { return Ok(Vec::new()) };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let section = parsed
            .get("mcp")
            .or_else(|| parsed.get("mcpServers"))
            .and_then(|value| value.as_object());
        let Some(section) = section else { return Ok(Vec::new()) };
        let mut servers = Vec::new();
        for (name, entry) in section {
            let mut server = serde_json::json!({ "name": name });
            if let Some(command) = entry.get("command") {
                let argv: Vec<String> = match command {
                    serde_json::Value::String(line) => vec![line.clone()],
                    serde_json::Value::Array(items) => items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect(),
                    _ => Vec::new(),
                };
                server["argv"] = serde_json::json!(argv);
            }
            if let Some(url) = entry.get("url").and_then(|value| value.as_str()) {
                server["url"] = serde_json::json!(url);
            }
            for (from, to) in [("env", "env"), ("environment", "env"), ("headers", "headers")] {
                if let Some(value) = entry.get(from) {
                    server[to] = value.clone();
                }
            }
            if let Some(cwd) = entry.get("cwd").and_then(|value| value.as_str()) {
                server["cwd"] = serde_json::json!(cwd);
            }
            servers.push(server);
        }
        return Ok(servers);
    }
    Ok(Vec::new())
}

/// Where the product keeps its configuration. Resolving this in one place
/// keeps every subcommand deriving the same routes from the same files.
fn product_config_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    explicit
        .or_else(|| std::env::var_os("MIAO_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")))
}

/// The engine database a workspace uses when none was named.
///
/// It must live outside the workspace: a process-enabled runtime refuses a
/// database the model itself could write. One file per workspace keeps
/// sessions from different directories apart without opting into a shared
/// store.
fn default_db(workspace: &std::path::Path) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    workspace.display().to_string().hash(&mut hasher);
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/miao/engine"))
        .unwrap_or_else(std::env::temp_dir);
    base.join(format!("{:x}.db", hasher.finish()))
}

/// Hand the derived routes to the TUI through the variables its own argument
/// builder already reads. Without this the default entry point has no model
/// catalogue and cannot resolve a credential.
fn prepare_tui_engine(launch: &miao_tui::Launch) {
    if std::env::var_os("MIAO_ENGINE_MODEL_ROUTES_CONFIG").is_some() {
        return;
    }
    let model = launch.model.clone().unwrap_or_default();
    // A TUI started without --config-dir still needs the product's providers:
    // resolve the same directory the product would use.
    let config_dir = launch.config_dir.clone().or_else(|| {
        product_config_dir(None).or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        })
    });
    let Ok(routes) = model_routes(config_dir.as_deref(), &model) else { return };
    let Some(primary) = routes.iter().find(|route| route["primary"] == true) else { return };
    // Without a chosen model the TUI would pass a placeholder name that matches
    // no route, and the engine rejects the primary route on identity. Name the
    // primary route's model so the two agree.
    if let Some(id) = primary["id"].as_str() {
        if std::env::var_os("MIAO_TUI_MODEL").is_none() {
            std::env::set_var("MIAO_TUI_MODEL", id);
        }
    }
    for (key, variable) in [("provider", "MIAO_ENGINE_PROVIDER"), ("endpoint", "MIAO_ENGINE_ENDPOINT")] {
        if let Some(value) = primary[key].as_str() {
            if !value.is_empty() {
                std::env::set_var(variable, value);
            }
        }
    }
    let credential = &primary["credential"];
    if credential["type"].as_str() == Some("database") {
        for (key, variable) in [
            ("path", "MIAO_ENGINE_CREDENTIAL_DB"),
            ("id", "MIAO_ENGINE_CREDENTIAL_ID"),
            ("integration", "MIAO_ENGINE_CREDENTIAL_INTEGRATION"),
        ] {
            if let Some(value) = credential[key].as_str() {
                std::env::set_var(variable, value);
            }
        }
    }
    if let Ok(encoded) = serde_json::to_string(&routes) {
        if encoded.len() <= 65536 {
            let path = std::env::temp_dir().join(format!("miao-tui-routes-{}.json", std::process::id()));
            if std::fs::write(&path, encoded).is_ok() {
                std::env::set_var("MIAO_ENGINE_MODEL_ROUTES_CONFIG", path);
            }
        }
    }
}

/// The configured agent, as the engine's manifest: its `system` becomes the
/// instructions and its `model` can stand in when none was named. Tool and
/// permission narrowing stay with the policy until that mapping is proven.
fn agent_manifest_for(
    config_dir: Option<&std::path::Path>,
    name: &str,
    base_instructions: Option<String>,
) -> Result<Option<(String, serde_json::Value)>, String> {
    let Some(dir) = config_dir else { return Ok(None) };
    for file in ["miao.jsonc", "miao.json"] {
        let path = dir.join(file);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let Some(entry) = parsed
            .get("agent")
            .and_then(|value| value.get(name))
        else {
            return Err(format!("no agent named {name} in {}", path.display()));
        };
        let mut instructions = base_instructions.unwrap_or_default();
        if let Some(system) = entry.get("system").and_then(|value| value.as_str()) {
            if !instructions.is_empty() {
                instructions.push_str("\n\n");
            }
            instructions.push_str(system);
        }
        let model = entry
            .get("model")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let mut manifest = serde_json::json!({
            "name": name,
            "instructions": instructions,
            "permission_mode": "auto",
        });
        // The product states permissions as {action, resource, effect}; the
        // engine wants {tool, path, decision}. Same three facts, renamed.
        if let Some(rules) = entry.get("permissions").and_then(|value| value.as_array()) {
            let mapped: Vec<serde_json::Value> = rules
                .iter()
                .filter_map(|rule| {
                    let tool = rule.get("action")?.as_str()?;
                    Some(serde_json::json!({
                        "tool": tool,
                        "path": rule.get("resource").and_then(|value| value.as_str()).unwrap_or("*"),
                        "decision": rule.get("effect").and_then(|value| value.as_str()).unwrap_or("deny"),
                    }))
                })
                .collect();
            if !mapped.is_empty() {
                manifest["permissions"] = serde_json::Value::Array(mapped);
            }
        }
        if let Some(mode) = entry.get("permission_mode").and_then(|value| value.as_str()) {
            manifest["permission_mode"] = serde_json::json!(mode);
        }
        return Ok(Some((model, manifest)));
    }
    Ok(None)
}

/// Derive the engine's model-route manifest from the product configuration.
///
/// The engine's catalogue only ever comes from `--model-routes-config`, so
/// without this a TUI model picker has nothing to list. Each route names its
/// own credential source, which is what makes switching between providers
/// actually authenticate.
fn model_routes(
    config_dir: Option<&std::path::Path>,
    requested: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = config_dir else { return Ok(Vec::new()) };
    let mut parsed: Option<serde_json::Value> = None;
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        parsed = Some(
            serde_json::from_str(&strip_comments(&text))
                .map_err(|error| format!("{}: {error}", path.display()))?,
        );
        break;
    }
    let Some(parsed) = parsed else { return Ok(Vec::new()) };
    let Some(providers) = parsed.get("providers").and_then(|value| value.as_object()) else {
        return Ok(Vec::new());
    };
    let default_model = parsed.get("model").and_then(|value| value.as_str()).unwrap_or("");
    let credential_db = std::env::var("MIAO_ENGINE_CREDENTIAL_DB").unwrap_or_else(|_| {
        std::env::var_os("HOME")
            .map(|home| {
                std::path::PathBuf::from(home)
                    .join(".local/share/miao/miao.db")
                    .display()
                    .to_string()
            })
            .unwrap_or_default()
    });
    // Which stored credential belongs to an integration, so a route can name it.
    let credential_id = |integration: &str| -> Option<String> {
        let connection = rusqlite::Connection::open_with_flags(
            &credential_db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        connection
            .query_row(
                "SELECT id FROM credential WHERE integration_id=?1 AND label='default' LIMIT 1",
                rusqlite::params![integration],
                |row| row.get::<_, String>(0),
            )
            .ok()
    };
    let mut routes = Vec::new();
    for (provider_id, provider) in providers {
        let api = provider.get("api").cloned().unwrap_or(serde_json::Value::Null);
        // Some providers carry the URL per model instead of on the provider.
        let provider_url = api.get("url").and_then(|value| value.as_str()).unwrap_or("");
        let package = format!(
            "{}{}",
            api.get("package").and_then(|value| value.as_str()).unwrap_or(""),
            api.get("type").and_then(|value| value.as_str()).unwrap_or("")
        );
        // The engine posts to the endpoint verbatim, so an OpenAI-compatible
        // base URL needs its completions path appended here.
        let protocol = if package.contains("anthropic") {
            "anthropic"
        } else if package.contains("google") || package.contains("gemini") {
            "gemini"
        } else {
            "openai-chat"
        };
        let credential = match credential_id(provider_id) {
            Some(id) => serde_json::json!({
                "type": "database",
                "path": credential_db,
                "id": id,
                "integration": provider_id,
            }),
            None => serde_json::json!({
                "type": "environment",
                "key": format!("{}_API_KEY", provider_id.to_uppercase().replace('-', "_")),
            }),
        };
        if let Some(models) = provider.get("models").and_then(|value| value.as_object()) {
            for (model_id, model) in models {
                // A provider may carry its URL per model; fall back to the
                // provider-level one. The engine posts to the endpoint verbatim,
                // so an OpenAI-compatible base URL needs the completions path.
                let model_url = model
                    .get("api")
                    .and_then(|value| value.get("url"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let base_url = if model_url.is_empty() { provider_url } else { model_url };
                let endpoint = match protocol {
                    "openai-chat" if !base_url.is_empty() && !base_url.ends_with("/chat/completions") => {
                        format!("{}/chat/completions", base_url.trim_end_matches('/'))
                    }
                    _ => base_url.to_string(),
                };
                // A route without an endpoint cannot be called, and one bad
                // entry makes the whole manifest fail to load: skip it instead.
                if endpoint.is_empty() {
                    continue;
                }
                let mut route = serde_json::json!({
                    "id": model_id,
                    "provider": protocol,
                    "model": model_id,
                    "endpoint": endpoint,
                    "credential": credential,
                    "primary": model_id == default_model,
                });
                if let Some(limit) = model.get("limit") {
                    route["limit"] = limit.clone();
                }
                if let Some(modalities) = model
                    .get("capabilities")
                    .and_then(|value| value.get("input"))
                    .and_then(|value| value.as_array())
                {
                    route["input_modalities"] = serde_json::Value::Array(modalities.clone());
                }
                routes.push(route);
            }
        }
    }
    // Exactly one route must be primary: the model actually being asked for,
    // falling back to the first usable route when the name is not configured.
    if !routes.is_empty() && !routes.iter().any(|route| route["primary"] == true) {
        let index = routes
            .iter()
            .position(|route| route["id"].as_str() == Some(requested))
            .unwrap_or(0);
        routes[index]["primary"] = serde_json::json!(true);
    }
    Ok(routes)
}

/// Map the product's `lsp` section onto the engine's `lsp::Config` array: the
/// engine discovers servers from this manifest, so without it the `lsp_*` tools
/// have nothing to talk to.
fn lsp_servers(config_dir: Option<&std::path::Path>) -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = config_dir else { return Ok(Vec::new()) };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let Some(section) = parsed.get("lsp").and_then(|value| value.as_object()) else {
            return Ok(Vec::new());
        };
        let mut servers = Vec::new();
        for (name, entry) in section {
            let argv: Vec<String> = match entry.get("command") {
                Some(serde_json::Value::String(line)) => vec![line.clone()],
                Some(serde_json::Value::Array(items)) => items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect(),
                _ => continue,
            };
            if argv.is_empty() {
                continue;
            }
            let extensions: Vec<String> = entry
                .get("extensions")
                .and_then(|value| value.as_array())
                .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut server = serde_json::json!({ "name": name, "argv": argv, "extensions": extensions });
            if let Some(env) = entry.get("env").or_else(|| entry.get("environment")) {
                server["env"] = env.clone();
            }
            servers.push(server);
        }
        return Ok(servers);
    }
    Ok(Vec::new())
}

/// Serve ACP over stdio: the editor-facing protocol, backed by the same engine
/// `run` and `serve` use.
fn acp_serve(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut model: Option<String> = None;
    let mut config_dir: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        let value = |offset: usize| rest.get(offset + 1).cloned();
        match rest[index].as_str() {
            "--db" => {
                db = value(index).map(PathBuf::from);
                index += 2;
            }
            "--workspace" => {
                workspace = value(index).map(PathBuf::from);
                index += 2;
            }
            "--model" => {
                model = value(index);
                index += 2;
            }
            "--config-dir" => {
                config_dir = value(index).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    let model = model
        .or_else(|| std::env::var("MIAO_ENGINE_MODEL").ok())
        .unwrap_or_else(|| "unavailable/model".into());
    let config_dir = config_dir.or_else(|| product_config_dir(None));
    let mut argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
    if let Some(instructions) = assemble_instructions(&workspace, config_dir.as_deref()) {
        let path = agent_manifest(&instructions)?;
        argv.push("--agent-config".into());
        argv.push(path.display().to_string());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let configured = miao_engine::cli::configure(&argv)
            .await
            .map_err(|error| error.to_string())?;
        miao_engine::acp::serve(configured.runtime)
            .await
            .map_err(|error| error.to_string())
    })
}

/// Read-only diagnostics. Only what this process can verify: no probing of
/// other installations, no network.
fn debug(rest: &[String]) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let config = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".config").join("miao")));
    match rest.first().map(String::as_str) {
        Some("paths") => {
            if let Some(home) = home.as_ref() {
                println!("data      {}", home.join(".local/share/miao").display());
                println!("cache     {}", home.join(".cache/miao").display());
                println!("state     {}", home.join(".local/state/miao").display());
            }
            println!("config    {}", config.as_ref().map(|dir| dir.display().to_string()).unwrap_or_else(|| "unset".into()));
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            println!("workspace {}", workspace.display());
            Ok(())
        }
        Some("routes") => {
            let config = std::env::var_os("MIAO_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
            let routes = model_routes(config.as_deref(), "")?;
            if routes.is_empty() {
                println!("no model routes configured");
            } else {
                println!("{}", serde_json::to_string(&routes).unwrap_or_default());
            }
            Ok(())
        }
        Some("lsp") => {
            let config = std::env::var_os("MIAO_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
            let servers = lsp_servers(config.as_deref())?;
            if servers.is_empty() {
                println!("no LSP servers configured");
            } else {
                println!("{}", serde_json::to_string(&servers).unwrap_or_default());
            }
            Ok(())
        }
        Some("mcp") => {
            let config = std::env::var_os("MIAO_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
            let servers = mcp_servers(config.as_deref())?;
            if servers.is_empty() {
                println!("no MCP servers configured");
            } else {
                println!("{}", serde_json::to_string(&servers).unwrap_or_default());
            }
            Ok(())
        }
        Some("info") => {
            println!("miao      {}", env!("CARGO_PKG_VERSION"));
            println!("engine    protocol {} schema {}", miao_engine::PROTOCOL, miao_engine::store::SCHEMA_VERSION);
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            println!("database  {}", default_db(&workspace).display());
            println!("config    {}", config.as_ref().map(|dir| dir.display().to_string()).unwrap_or_else(|| "unset".into()));
            let plugins = plugin_entries(config.as_deref()).unwrap_or_default();
            println!("plugins   {} configured", plugins.len());
            Ok(())
        }
        _ => Err("usage: miao debug paths | miao debug info".into()),
    }
}

/// The command words this binary understands, in one place so the usage text
/// and the completion script cannot drift apart.
const COMMANDS: &[&str] = &[
    "tui", "run", "serve", "session", "models", "auth", "plugins", "export", "stats", "doctor",
    "providers", "memory", "db", "completion",
];

/// Print a completion script for the given shell.
fn completion(rest: &[String]) -> Result<(), String> {
    let shell = rest.first().map(String::as_str).unwrap_or("bash");
    let words = COMMANDS.join(" ");
    match shell {
        "bash" => println!(
            "complete -W \"{words}\" miao"
        ),
        "zsh" => println!(
            "#compdef miao\n_miao() {{ compadd {words} }}\ncompdef _miao miao"
        ),
        other => return Err(format!("unsupported shell {other}; use bash or zsh")),
    }
    Ok(())
}

/// Print the database path this directory resolves to, so scripts do not have
/// to re-implement the default.
fn db_path(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    println!("{}", db.unwrap_or_else(|| default_db(&workspace)).display());
    Ok(())
}

/// One view of what a turn could use: routes first (what can be called), then
/// credentials (what can authenticate). Both are optional sources, so a missing
/// one is reported rather than treated as an empty success.
fn providers() -> Result<(), String> {
    match list_models() {
        Ok(()) => {}
        Err(message) => println!("routes    none ({message})"),
    }
    match plugin_entries(product_config_dir(None).as_deref()) {
        Ok(entries) if !entries.is_empty() => println!("plugins   {} configured", entries.len()),
        _ => println!("plugins   none"),
    }
    match std::env::var("MIAO_ENGINE_CREDENTIAL_DB") {
        Ok(path) => {
            let entries = miao_engine::credential::list_database(std::path::Path::new(&path))
                .map_err(|error| format!("{path}: {error}"))?;
            println!("credentials {}", entries.len());
            for entry in entries.iter().take(5) {
                println!("  {:<20} {:<4} {}", entry.integration, entry.kind, entry.id);
            }
            if entries.len() > 5 {
                println!("  … {} more", entries.len() - 5);
            }
        }
        Err(_) => println!("credentials unknown (MIAO_ENGINE_CREDENTIAL_DB is unset)"),
    }
    Ok(())
}

/// Summarise `.miao/knowledge.json` in the workspace. Advisory notes only; this
/// never writes, so it stays safe to run anywhere.
fn memory(rest: &[String]) -> Result<(), String> {
    let mut workspace: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--workspace" => {
                workspace = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let store = workspace.join(".miao").join("knowledge.json");
    if !store.is_file() {
        println!("memory    none ({})", store.display());
        return Ok(());
    }
    let text = std::fs::read_to_string(&store).map_err(|error| format!("{}: {error}", store.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", store.display()))?;
    let notes = parsed
        .get("notes")
        .and_then(|notes| notes.as_object())
        .map(|notes| notes.len())
        .unwrap_or(0);
    println!("memory    {} ({notes} note(s))", store.display());
    if let Some(notes) = parsed.get("notes").and_then(|notes| notes.as_object()) {
        for (id, note) in notes.iter().take(8) {
            let title = note.get("title").and_then(|title| title.as_str()).unwrap_or("");
            let kind = note.get("kind").and_then(|kind| kind.as_str()).unwrap_or("");
            println!("  {:<28} {:<12} {title}", id, kind);
        }
        if notes.len() > 8 {
            println!("  … {} more", notes.len() - 8);
        }
    }
    Ok(())
}

/// Health check: does the database exist, open at the expected schema, and can
/// it be read? Every line is a fact this process verified, not a guess.
fn doctor(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    println!("engine    protocol {} schema {}", miao_engine::PROTOCOL, miao_engine::store::SCHEMA_VERSION);
    println!("database  {}", db.display());
    match std::fs::metadata(&db) {
        Ok(metadata) => println!("size      {} bytes", metadata.len()),
        Err(error) => {
            println!("database  unreadable: {error}");
            return Err("the database cannot be opened".into());
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let sessions = runtime.block_on(async {
        let store = miao_engine::store::Store::open(&db)
            .await
            .map_err(|error| format!("cannot open the store: {error}"))?;
        store.sessions().await.map_err(|error| format!("cannot list sessions: {error}"))
    })?;
    println!("sessions  {}", sessions.len());
    let config_dir = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
    match config_dir.as_ref() {
        Some(dir) if dir.is_dir() => println!("config    {}", dir.display()),
        Some(dir) => println!("config    missing: {}", dir.display()),
        None => println!("config    MIAO_CONFIG_DIR is unset"),
    }
    let plugins = plugin_entries(config_dir.as_deref()).unwrap_or_default();
    println!("plugins   {} configured", plugins.len());
    Ok(())
}

/// Summarise token usage recorded in the engine database. Usage lives in the
/// `usage` events, so this reads them through the same committed-event export
/// the CLI already trusts instead of opening sqlite itself.
fn stats(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let sessions = runtime.block_on(async {
        let store = miao_engine::store::Store::open(&db).await.map_err(|error| error.to_string())?;
        store.sessions().await.map_err(|error| error.to_string())
    })?;
    let (mut input, mut output, mut cache_read, mut non_cached, mut turns) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut json = false;
    let mut only: Option<String> = None;
    let mut via_engine = false;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--json" => {
                json = true;
                index += 1;
            }
            "--session" => {
                only = rest.get(index + 1).cloned();
                index += 2;
            }
            "--engine" => {
                via_engine = true;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if via_engine {
        let session = only.clone().ok_or("--engine needs --session ID")?;
        return stats_via_engine(db.clone(), session);
    }
    let sessions: Vec<String> = match &only {
        Some(one) => sessions.into_iter().filter(|session| session == one).collect(),
        None => sessions,
    };
    for session in &sessions {
        let mut buffer: Vec<u8> = Vec::new();
        miao_engine::export::committed_events(&db, session, 0, &mut buffer)
            .map_err(|error| error.to_string())?;
        for line in String::from_utf8_lossy(&buffer).lines() {
            let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if event.get("kind").and_then(|kind| kind.as_str()) != Some("usage") {
                continue;
            }
            turns += 1;
            let data = &event["data"];
            let usage = &data["usage"];
            input += usage["inputTokens"].as_u64().unwrap_or(0);
            output += usage["outputTokens"].as_u64().unwrap_or(0);
            cache_read += data["cache"]["read"].as_u64().unwrap_or(0);
            non_cached += data["cache"]["nonCached"].as_u64().unwrap_or(0);
        }
    }
    let hit = if cache_read + non_cached > 0 {
        cache_read as f64 / (cache_read + non_cached) as f64
    } else {
        0.0
    };
    // TTFT comes from the engine's own timing side table, which the TUI panel
    // also reads: one source, so a panel and this command cannot disagree.
    let mut ttfts: Vec<i64> = Vec::new();
    if let Ok(connection) = rusqlite::Connection::open(&db) {
        // Same scope as the token totals: a single-session view must not mix
        // its TTFT with other sessions.
        let query = match &only {
            Some(_) => "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL AND session_id=?1",
            None => "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL",
        };
        if let Ok(mut statement) = connection.prepare(query) {
            // Separate branches: rusqlite's query_map returns a type parameterised
            // by the closure, so the two arms cannot share one binding.
            match &only {
                Some(session) => {
                    if let Ok(rows) = statement.query_map([session], |row| row.get::<_, i64>(0)) {
                        ttfts.extend(rows.flatten());
                    }
                }
                None => {
                    if let Ok(rows) = statement.query_map([], |row| row.get::<_, i64>(0)) {
                        ttfts.extend(rows.flatten());
                    }
                }
            }
        }
    }
    ttfts.sort_unstable();
    let percentile = |p: f64| -> i64 {
        if ttfts.is_empty() {
            return 0;
        }
        let index = ((ttfts.len() as f64 - 1.0) * p).round() as usize;
        ttfts[index.min(ttfts.len() - 1)]
    };
    if json {
        println!(
            "{}",
            serde_json::json!({
                "sessions": sessions.len(),
                "turns": turns,
                "input_tokens": input,
                "output_tokens": output,
                "cache_read": cache_read,
                "cache_fresh": non_cached,
                "cache_hit_ratio": hit,
                "ttft_ms_p50": percentile(0.5),
                "ttft_ms_p95": percentile(0.95),
                "ttft_samples": ttfts.len(),
            })
        );
        return Ok(());
    }
    println!("sessions  {}", sessions.len());
    println!("turns     {turns}");
    println!("input     {input}");
    println!("output    {output}");
    // TTFT comes from the engine's own timing side table, which the TUI panel
    // also reads: one source, so a panel and this command cannot disagree.
    let mut ttfts: Vec<i64> = Vec::new();
    if let Ok(connection) = rusqlite::Connection::open(&db) {
        // Same scope as the token totals: a single-session view must not mix
        // its TTFT with other sessions.
        let query = match &only {
            Some(_) => "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL AND session_id=?1",
            None => "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL",
        };
        if let Ok(mut statement) = connection.prepare(query) {
            // Separate branches: rusqlite's query_map returns a type parameterised
            // by the closure, so the two arms cannot share one binding.
            match &only {
                Some(session) => {
                    if let Ok(rows) = statement.query_map([session], |row| row.get::<_, i64>(0)) {
                        ttfts.extend(rows.flatten());
                    }
                }
                None => {
                    if let Ok(rows) = statement.query_map([], |row| row.get::<_, i64>(0)) {
                        ttfts.extend(rows.flatten());
                    }
                }
            }
        }
    }
    ttfts.sort_unstable();
    let percentile = |p: f64| -> i64 {
        if ttfts.is_empty() {
            return 0;
        }
        let index = ((ttfts.len() as f64 - 1.0) * p).round() as usize;
        ttfts[index.min(ttfts.len() - 1)]
    };
    if json {
        println!(
            "{}",
            serde_json::json!({
                "sessions": sessions.len(),
                "turns": turns,
                "input_tokens": input,
                "output_tokens": output,
                "cache_read": cache_read,
                "cache_fresh": non_cached,
                "cache_hit_ratio": hit,
                "ttft_ms_p50": percentile(0.5),
                "ttft_ms_p95": percentile(0.95),
                "ttft_samples": ttfts.len(),
            })
        );
        return Ok(());
    }
    println!("cache     {cache_read} read / {non_cached} fresh ({:.1}% hit)", hit * 100.0);
    if !ttfts.is_empty() {
        println!(
            "ttft      p50 {} ms / p95 {} ms ({} samples)",
            percentile(0.5),
            percentile(0.95),
            ttfts.len()
        );
    }
    Ok(())
}

/// Write one session's committed events as JSONL. Read-only and provider-free:
/// the export is a straight read of the engine database.
fn export_session(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut session: Option<String> = None;
    let mut after: u64 = 0;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--after" => {
                after = rest
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .ok_or("--after needs a number")?;
                index += 2;
            }
            other if other.starts_with("--") => index += 1,
            other => {
                session = Some(other.to_string());
                index += 1;
            }
        }
    }
    let session = session.ok_or("usage: miao export SESSION [--db PATH] [--after N]")?;
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    let cursor = miao_engine::export::committed_events(&db, &session, after, std::io::stdout().lock())
        .map_err(|error| error.to_string())?;
    eprintln!("miao export: {cursor} event(s) written");
    Ok(())
}

/// Report whether this machine would need a sidecar. The spawn itself is not
/// wired yet, so the message says exactly that instead of pretending.
fn list_plugins() -> Result<(), String> {
    let config_dir = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
    let entries = plugin_entries(config_dir.as_deref())?;
    if entries.is_empty() {
        println!("no plugins configured — the native binary needs no JavaScript runtime");
        return Ok(());
    }
    for entry in &entries {
        println!("plugin {entry}");
    }
    println!("{} plugin(s) configured — a JavaScript sidecar would be required (not wired yet)", entries.len());
    Ok(())
}

/// A configured plugin set that no sidecar serves is a silent capability gap.
/// Say so once per process instead of quietly running without those hooks.
fn warn_missing_sidecar(config_dir: Option<&std::path::Path>) {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        if let Ok(entries) = plugin_entries(config_dir) {
            if !entries.is_empty() {
                eprintln!(
                    "miao: {} plugin(s) configured but the JavaScript sidecar is not wired; plugin hooks are inactive",
                    entries.len()
                );
            }
        }
    });
}

/// List the sessions the engine database holds. `sessions` is a unit command,
/// so the frame carries no `params` at all — the same shape the stdio adapter
/// sends.
fn list_sessions(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    // Listing sessions needs the store, not a model: opening it directly keeps
    // the command usable on a machine with no credential configured.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let store = miao_engine::store::Store::open(&db)
            .await
            .map_err(|error| error.to_string())?;
        let mut ids = store.sessions().await.map_err(|error| error.to_string())?;
        ids.sort();
        if ids.is_empty() {
            println!("no sessions");
        }
        for id in ids {
            println!("{id}");
        }
        Ok(())
    })
}

/// Run the engine as a resident loopback server. A window attaches to it
/// instead of starting a second engine, and an optional idle timeout lets it
/// outlive a closed window without becoming an orphan.
fn serve_forever(rest: &[String]) -> Result<(), String> {
    let mut port: u16 = 0;
    let mut db: Option<PathBuf> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut model: Option<String> = None;
    let mut idle_ms: Option<u64> = None;
    let mut index = 0;
    while index < rest.len() {
        let value = |offset: usize| rest.get(offset + 1).cloned();
        match rest[index].as_str() {
            "--port" => {
                port = value(index).ok_or("--port needs a value")?.parse().map_err(|_| "--port must be a number")?;
                index += 2;
            }
            "--db" => {
                db = value(index).map(PathBuf::from);
                index += 2;
            }
            "--workspace" => {
                workspace = value(index).map(PathBuf::from);
                index += 2;
            }
            "--model" => {
                model = value(index);
                index += 2;
            }
            "--idle-ms" => {
                idle_ms = value(index).and_then(|value| value.parse().ok());
                index += 2;
            }
            _ => index += 1,
        }
    }
    let workspace = workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let db = db.unwrap_or_else(|| workspace.join(".miao-serve.db"));
    let model = model.or_else(|| std::env::var("MIAO_ENGINE_MODEL").ok()).unwrap_or_else(|| "unavailable/model".into());
    let config_dir = product_config_dir(None);
    let mut argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
    if let Some(skills) = assemble_skills(&workspace, config_dir.as_deref()) {
        argv.push("--skills-config".into());
        argv.push(skills.display().to_string());
    }
    if let Some(instructions) = assemble_instructions(&workspace, config_dir.as_deref()) {
        let path = agent_manifest(&instructions)?;
        argv.push("--agent-config".into());
        argv.push(path.display().to_string());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let configured = miao_engine::cli::configure(&argv)
            .await
            .map_err(|error| error.to_string())?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let token = std::env::var("MIAO_SERVER_PASSWORD").unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        println!("miao serve listening on http://{address} token={token}");
        miao_engine::http::serve_with_idle_timeout(
            configured.runtime,
            listener,
            token,
            idle_ms.map(Duration::from_millis),
        )
        .await
        .map_err(|error| error.to_string())
    })
}

/// Read the operator's standing instructions the way the product does: the
/// global file first, then the workspace one, each under its own heading. The
/// engine appends this block to its base system prompt, so a rule stated here
/// reaches every turn without the host having to rewrite the prompt itself.
fn assemble_instructions(workspace: &std::path::Path, config_dir: Option<&std::path::Path>) -> Option<String> {
    const LIMIT: usize = 64 * 1024;
    /// The product's own persona, embedded at compile time from the TypeScript
    /// asset so the two hosts can never drift into different personalities.
    const PERSONA: &str = include_str!("../../../packages/core/src/system-context/persona/default.txt");
    let mut blocks: Vec<String> = vec![PERSONA.trim().to_string()];
    let mut total = 0usize;
    for (label, path) in [
        ("Global instructions", config_dir.map(|dir| dir.join("AGENTS.md"))),
        ("Project instructions", Some(workspace.join("AGENTS.md"))),
    ] {
        let Some(path) = path else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let text = text.trim();
        if text.is_empty() || total >= LIMIT {
            continue;
        }
        let room = LIMIT - total;
        let block = if text.len() > room { &text[..room] } else { text };
        total += block.len();
        blocks.push(format!("## {label} ({})\n{block}", path.display()));
    }
    Some(blocks.join("\n\n"))
}

/// Directories the engine should discover skills in. The engine owns discovery
/// and rendering (bodies load on demand), so the host only names the roots:
/// the product's skill directory and the workspace's own.
fn assemble_skills(workspace: &std::path::Path, config_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    let mut roots = Vec::new();
    for dir in [
        config_dir.map(|dir| dir.join("skills")),
        Some(workspace.join(".miao").join("skills")),
    ]
    .into_iter()
    .flatten()
    {
        if dir.is_dir() {
            roots.push(serde_json::json!({ "path": dir.display().to_string() }));
        }
    }
    if roots.is_empty() {
        return None;
    }
    let path = std::env::temp_dir().join(format!("miao-skills-{}.json", std::process::id()));
    std::fs::write(&path, serde_json::json!(roots).to_string()).ok()?;
    Some(path)
}

/// Write the assembled instructions as the agent manifest the engine reads.
fn agent_manifest(instructions: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("miao-agent-{}.json", std::process::id()));
    // `auto` lets the engine's own classifier settle the asks it can prove
    // safe (read-only bash, ordinary workspace edits); an operator rule still
    // wins, and a deny is never consulted.
    let manifest = serde_json::json!({
        "name": "miao",
        "instructions": instructions,
        "permission_mode": "auto",
    });
    std::fs::write(&path, manifest.to_string()).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

/// The engine argv the product hands `miao-engine serve`, built from the same
/// flags and environment variables the TUI uses so both entries agree.
fn engine_argv(db: &std::path::Path, workspace: &std::path::Path, model: &str, config_dir: Option<&std::path::Path>) -> Vec<String> {
    engine_argv_with(db, workspace, model, config_dir, |name| std::env::var(name).ok())
}

/// Same mapping with the environment supplied by the caller, so the flags a
/// turn inherits can be asserted without mutating process state.
fn engine_argv_with(
    db: &std::path::Path,
    workspace: &std::path::Path,
    model: &str,
    config_dir: Option<&std::path::Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    // The engine reads the server list from this variable (it prefers it over a
    // manifest file), so a configured MCP section reaches every command with no
    // extra plumbing. Absent configuration leaves the variable alone.
    if let Ok(servers) = mcp_servers(config_dir) {
        if !servers.is_empty() {
            if let Ok(encoded) = serde_json::to_string(&servers) {
                if encoded.len() <= 65536 {
                    std::env::set_var("MIAO_ENGINE_MCP_SERVERS", encoded);
                }
            }
        }
    }
    let mut argv = vec![
        "serve".into(),
        "--db".into(),
        db.display().to_string(),
        "--workspace".into(),
        workspace.display().to_string(),
        "--model".into(),
        model.into(),
    ];
    if let Some(dir) = config_dir {
        argv.push("--config-dir".into());
        argv.push(dir.display().to_string());
    }
    // The engine compares the primary route's identity against the base
    // provider's, so the base provider must be built from the same route:
    // provider, endpoint and credential all come from the primary entry.
    let mut derived_routes = false;
    if env("MIAO_ENGINE_MODEL_ROUTES_CONFIG").is_none() {
        if let Ok(routes) = model_routes(config_dir, model) {
            if !routes.is_empty() {
                if let Some(primary) = routes.iter().find(|route| route["primary"] == true) {
                    // A placeholder model name matches no route, and the engine
                    // compares the primary route's identity against the base
                    // provider's: name the route's own model instead.
                    if !routes.iter().any(|route| route["id"].as_str() == Some(model)) {
                        if let Some(id) = primary["id"].as_str() {
                            if let Some(position) = argv.iter().position(|arg| arg == "--model") {
                                argv[position + 1] = id.to_string();
                            }
                        }
                    }
                    for (key, flag) in [("provider", "--provider"), ("endpoint", "--endpoint")] {
                        if let Some(value) = primary[key].as_str() {
                            if !value.is_empty() {
                                argv.push(flag.into());
                                argv.push(value.into());
                            }
                        }
                    }
                    let credential = &primary["credential"];
                    if credential["type"].as_str() == Some("database") {
                        for (key, flag) in [
                            ("path", "--credential-db"),
                            ("id", "--credential-id"),
                            ("integration", "--credential-integration"),
                        ] {
                            if let Some(value) = credential[key].as_str() {
                                argv.push(flag.into());
                                argv.push(value.into());
                            }
                        }
                    }
                    if let Ok(encoded) = serde_json::to_string(&routes) {
                        if encoded.len() <= 65536 {
                            let path = std::env::temp_dir()
                                .join(format!("miao-routes-{}.json", std::process::id()));
                            if std::fs::write(&path, encoded).is_ok() {
                                argv.push("--model-routes-config".into());
                                argv.push(path.display().to_string());
                                derived_routes = true;
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(servers) = lsp_servers(config_dir) {
        if !servers.is_empty() {
            if let Ok(encoded) = serde_json::to_string(&servers) {
                let path = std::env::temp_dir().join(format!("miao-lsp-{}.json", std::process::id()));
                if std::fs::write(&path, encoded).is_ok() {
                    argv.push("--lsp-config".into());
                    argv.push(path.display().to_string());
                }
            }
        }
    }
    // `workspace` is the mode the product runs in; without it the engine keeps
    // its read-only default and process/write tools are never advertised.
    argv.push("--mode".into());
    argv.push("workspace".into());
    for (variable, flag) in [
        ("MIAO_ENGINE_PROVIDER", "--provider"),
        ("MIAO_ENGINE_ENDPOINT", "--endpoint"),
        ("MIAO_ENGINE_POLICY", "--policy"),
        ("MIAO_ENGINE_CREDENTIAL_DB", "--credential-db"),
        ("MIAO_ENGINE_CREDENTIAL_ID", "--credential-id"),
        ("MIAO_ENGINE_CREDENTIAL_INTEGRATION", "--credential-integration"),
        ("MIAO_ENGINE_MODEL_ROUTES_CONFIG", "--model-routes-config"),
    ] {
        // A derived manifest names a credential per route; passing the single
        // credential pair as well makes the engine demand an id it does not need.
        if derived_routes
            && matches!(
                variable,
                "MIAO_ENGINE_CREDENTIAL_DB" | "MIAO_ENGINE_CREDENTIAL_ID" | "MIAO_ENGINE_CREDENTIAL_INTEGRATION"
            )
        {
            continue;
        }
        if let Some(value) = env(variable) {
            argv.push(flag.into());
            argv.push(value);
        }
    }
    argv
}

/// Collect every `text` value in a snapshot, oldest first. The snapshot shape
/// is the engine's; walking it keeps this entry from pinning that shape.
/// Collect text only from assistant messages: the snapshot also carries the
/// prompt we just sent, and taking "the last text" picked that instead.
fn texts(value: &serde_json::Value, out: &mut Vec<String>) {
    if let serde_json::Value::Object(map) = value {
        if map.get("role").and_then(|role| role.as_str()) == Some("assistant") {
            let mut inner = Vec::new();
            collect_all_texts(value, &mut inner);
            out.extend(inner);
            return;
        }
    }
    match value {
        serde_json::Value::Object(map) => {
            for child in map.values() {
                texts(child, out);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| texts(item, out)),
        _ => {}
    }
}

fn collect_all_texts(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("type").and_then(|kind| kind.as_str()) == Some("reasoning") {
                return;
            }
            for (key, child) in map {
                if key == "reasoning" {
                    continue;
                }
                if key == "text" {
                    if let Some(text) = child.as_str() {
                        out.push(text.to_string());
                        continue;
                    }
                }
                collect_all_texts(child, out);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| collect_all_texts(item, out)),
        _ => {}
    }
}

fn unused_texts(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            // Reasoning fragments also carry `text`; they are not the answer.
            if map.get("type").and_then(|kind| kind.as_str()) == Some("reasoning") {
                return;
            }
            for (key, child) in map {
                if key == "reasoning" {
                    continue;
                }
                if key == "text" {
                    if let Some(text) = child.as_str() {
                        out.push(text.to_string());
                        continue;
                    }
                }
                texts(child, out);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| texts(item, out)),
        _ => {}
    }
}

/// Generate a credential id in the product's shape (`cred_` + 26 base62 chars).
/// Uniqueness is what matters; the alphabet matches the existing rows so any
/// consumer that pattern-matches on the prefix keeps working.
fn credential_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32;
    let mut id = String::from("cred_");
    for _ in 0..26 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        id.push(ALPHABET[(seed >> 33) as usize % ALPHABET.len()] as char);
    }
    id
}

/// Store or remove an API-key credential. This is the operator's own login
/// action, so it is the single writer at that moment; the engine keeps reading
/// the same table read-only and never gains write authority.
fn auth_write(rest: &[String]) -> Result<(), String> {
    let db = std::env::var("MIAO_ENGINE_CREDENTIAL_DB")
        .map_err(|_| "set MIAO_ENGINE_CREDENTIAL_DB (the product passes it to the engine)".to_string())?;
    let connection = rusqlite::Connection::open(&db).map_err(|error| format!("{db}: {error}"))?;
    let now = (cli_now_ms() / 1) as i64;
    match rest.first().map(String::as_str) {
        Some("login") => {
            let integration = rest.get(1).ok_or("usage: miao auth login INTEGRATION KEY")?;
            let key = rest.get(2).ok_or("usage: miao auth login INTEGRATION KEY")?;
            if key.trim().is_empty() {
                return Err("the key must not be empty".into());
            }
            let value = serde_json::json!({ "type": "key", "key": key }).to_string();
            let id = credential_id();
            // A login replaces the previous default for that integration
            // instead of piling rows up.
            connection
                .execute(
                    "DELETE FROM credential WHERE integration_id=?1 AND label='default'",
                    rusqlite::params![integration],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT INTO credential(id,integration_id,label,value,active,time_created,time_updated) VALUES(?1,?2,'default',?3,1,?4,?4)",
                    rusqlite::params![id, integration, value, now],
                )
                .map_err(|error| error.to_string())?;
            println!("stored {integration} default credential {id}");
            Ok(())
        }
        Some("logout") => {
            let integration = rest.get(1).ok_or("usage: miao auth logout INTEGRATION")?;
            let removed = connection
                .execute(
                    "DELETE FROM credential WHERE integration_id=?1 AND label='default'",
                    rusqlite::params![integration],
                )
                .map_err(|error| error.to_string())?;
            println!("removed {removed} credential(s) for {integration}");
            Ok(())
        }
        _ => Err("usage: miao auth login INTEGRATION KEY | miao auth logout INTEGRATION".into()),
    }
}

/// List stored credentials. `list_database` reports only normalized type and
/// expiry metadata — the engine never serializes a secret — so this stays a
/// read-only view and never touches the broker's write authority.
fn list_credentials() -> Result<(), String> {
    let path = std::env::var("MIAO_ENGINE_CREDENTIAL_DB")
        .map_err(|_| "set MIAO_ENGINE_CREDENTIAL_DB (the product passes it to the engine)".to_string())?;
    let entries = miao_engine::credential::list_database(std::path::Path::new(&path))
        .map_err(|error| format!("{path}: {error}"))?;
    for entry in entries {
        println!(
            "{:<22} {:<18} {:<6} {}{}",
            entry.integration,
            entry.label,
            entry.kind,
            entry.id,
            if entry.expired { " (expired)" } else { "" }
        );
    }
    Ok(())
}

/// List the routes the engine would be given. The routes manifest is the same
/// file the product passes as `--model-routes-config`, so this prints exactly
/// what a turn can address rather than a separate opinion.
fn list_models() -> Result<(), String> {
    let path = std::env::var("MIAO_ENGINE_MODEL_ROUTES_CONFIG")
        .map_err(|_| "set MIAO_ENGINE_MODEL_ROUTES_CONFIG (the product passes it to the engine)".to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))?;
    let mut ids = Vec::new();
    collect_ids(&manifest, &mut ids);
    ids.sort();
    ids.dedup();
    for id in ids {
        println!("{id}");
    }
    Ok(())
}

/// Route ids live under the manifest's `models` maps; collect those keys.
fn collect_ids(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Object(models)) = map.get("models") {
                out.extend(models.keys().cloned());
            }
            for child in map.values() {
                collect_ids(child, out);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| collect_ids(item, out)),
        _ => {}
    }
}

struct Target {
    session: Option<String>,
    continue_last: bool,
    format: String,
}

/// Product-tool definitions the host serves. These are the cross-session tools
/// the engine calls back into the host for; without them a single binary has no
/// way to reach other sessions or the operator.
fn product_tools() -> Vec<miao_engine::protocol::ToolDefinition> {
    let spec = |name: &str, description: &str, schema: serde_json::Value| miao_engine::protocol::ToolDefinition {
        name: name.into(),
        description: description.into(),
        input_schema: schema,
    };
    vec![
        spec(
            "list_sessions",
            "List the sessions in this engine database with their titles.",
            serde_json::json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        spec(
            "read_session_context",
            "Read another session's stored events, newest last, as JSON lines.",
            serde_json::json!({"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"],"additionalProperties":false}),
        ),
        spec(
            "push_notification",
            "Raise a desktop notification on the operator's machine.",
            serde_json::json!({"type":"object","properties":{"title":{"type":"string"},"message":{"type":"string"}},"required":["message"],"additionalProperties":false}),
        ),
    ]
}

/// Execute one product-tool call locally. The engine already dispatched it, so
/// the only job here is to answer truthfully; an unknown name is an error, not
/// a silent success.
async fn call_product_tool(name: &str, input: &serde_json::Value, db: &std::path::Path) -> serde_json::Value {
    match name {
        // Answered from the engine's own view: opening the store a second time
        // in this process answers "runtime already owns this store".
        "list_sessions" => serde_json::json!({ "error": "list_sessions is served by the engine" }),
        "read_session_context" => {
            let Some(session) = input.get("session_id").and_then(|value| value.as_str()) else {
                return serde_json::json!({ "error": "session_id is required" });
            };
            let mut buffer: Vec<u8> = Vec::new();
            match miao_engine::export::committed_events(db, session, 0, &mut buffer) {
                Ok(_) => serde_json::json!({ "events": String::from_utf8_lossy(&buffer).lines().count(), "session_id": session }),
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            }
        }
        "push_notification" => {
            let message = input.get("message").and_then(|value| value.as_str()).unwrap_or("");
            let title = input.get("title").and_then(|value| value.as_str()).unwrap_or("miao");
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                message.replace('"', " "),
                title.replace('"', " ")
            );
            match std::process::Command::new("osascript").arg("-e").arg(&script).status() {
                Ok(status) if status.success() => serde_json::json!({ "delivered": true }),
                Ok(status) => serde_json::json!({ "error": format!("osascript exited {status}") }),
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            }
        }
        other => serde_json::json!({ "error": format!("unknown product tool {other}") }),
    }
}

async fn run_prompt(argv: Vec<String>, prompt: String, target: Target, db: PathBuf) -> Result<(), String> {
    // Placeholder replaced below once the session id is known.
    // Read the session list before the runtime claims the store: a process may
    // hold one store per path, so opening it after `configure` (or twice) would
    // answer "runtime already owns this store". The read releases its lease as
    // soon as the value is produced.
    let known_sessions: Vec<String> = match miao_engine::store::Store::open(&db).await {
        Ok(store) => match store.sessions().await {
            Ok(sessions) => sessions,
            Err(error) => {
                eprintln!("miao run: cannot list sessions: {error}");
                Vec::new()
            }
        },
        Err(error) => {
            eprintln!("miao run: cannot open the store for listing: {error}");
            Vec::new()
        }
    };
    let configured = miao_engine::cli::configure(&argv)
        .await
        .map_err(|error| error.to_string())?;
    // Keep a handle so the store lease is released before this process exits;
    // otherwise the next `--continue` sees "runtime already owns this store".
    let owner = configured.runtime.clone();
    // Product tools are reverse-dispatched over this channel: the engine asks,
    // the host answers. Registering them is what gives the model any reach
    // beyond its own session.
    let (bridge_tx, mut bridge_rx) = tokio::sync::mpsc::channel::<serde_json::Value>(128);
    let bridge = miao_engine::product::Bridge::new(bridge_tx);
    configured
        .runtime
        .with_product_tools(product_tools(), bridge.clone(), None);
    let (mut connection, mut events) = Connection::start_embedded(configured.runtime, Duration::from_secs(120))
        .map_err(|error| error.to_string())?;
    let client = connection.connect().await.map_err(|error| error.to_string())?;
    // Reuse the requested session, or the most recent one for `--continue`;
    // otherwise start a fresh id so a one-shot run never inherits history.
    let session = match target.session.clone() {
        Some(id) => id,
        None if target.continue_last => {
            // Ask the already-open engine instead of opening the store again:
            // a process may hold one store per path, so a second `Store::open`
            // on the same database here answers "runtime already owns this
            // store" — with itself.
            let listed = client
                .command("sessions")
                .await
                .map_err(|error| error.to_string())?;
            let mut ids: Vec<String> = listed
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            ids.sort();
            ids.pop().ok_or("no session to continue")?
        }
        None => format!("ses_{}", "b".repeat(64)),
    };
    let resume = target.session.is_some() || target.continue_last;
    // Deliver anything the local hub queued for this session, ahead of the new
    // prompt, so a message from another tab is part of this turn's context.
    let inbox = drain_inbox(&session);
    let prompt = if inbox.is_empty() {
        prompt
    } else {
        format!("{}\n\n{prompt}", inbox.join("\n"))
    };
    // Baseline before this prompt: a resumed session already carries earlier
    // assistant turns, so "any assistant text" would return the previous answer.
    let baseline = {
        let mut existing = Vec::new();
        if let Ok(snapshot) = client.snapshot(&session).await {
            texts(&snapshot, &mut existing);
        }
        existing.len()
    };
    // An imported or previously used session already exists; initialize is a
    // create-if-absent step, so an existing row must not abort the run.
    let _ = client.initialize(&session, "run").await;
    client.subscribe(&session, 0).await.map_err(|error| error.to_string())?;
    client
        .admit(
            serde_json::json!({"session_id": session, "input_id": format!(
                "inp_run_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or(0)
            ), "prompt": prompt}),
            resume,
            Vec::new(),
        )
        .await
        .map_err(|error| error.to_string())?;
    client
        .request("resume", serde_json::json!({ "session_id": &session }))
        .await
        .map_err(|error| error.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let snapshot = client
            .snapshot(&session)
            .await
            .map_err(|error| error.to_string())?;
        let mut found = Vec::new();
        texts(&snapshot, &mut found);
        // Wait for a turn that is newer than the baseline, not merely present.
        if found.len() > baseline {
            if target.format == "json" {
                println!("{}", snapshot);
            } else {
                println!("{}", found.last().cloned().unwrap_or_default());
            }
            owner.shutdown().await;
            return Ok(());
        }
        // A headless run cannot answer an operator question. Say so at once
        // instead of blocking until the deadline, and name the way out.
        while let Ok(frame) = bridge_rx.try_recv() {
            let Some(id) = frame.get("bridge_id").and_then(|value| value.as_u64()) else { continue };
            let params = frame.get("params").cloned().unwrap_or(serde_json::Value::Null);
            let name = params
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let input = params.get("input").cloned().unwrap_or(serde_json::Value::Null);
            let payload = if name == "list_sessions" {
                serde_json::json!({ "sessions": known_sessions })
            } else {
                call_product_tool(&name, &input, &db).await
            };
            // The engine reads `{"result": …}` / `{"error": …}`; a bare value
            // arrives as Null and silently answers "nothing".
            let reply = match payload.get("error") {
                Some(error) => serde_json::json!({ "error": error }),
                None => serde_json::json!({ "result": payload }),
            };
            bridge.resolve(id, reply);
        }
        while let Ok(event) = events.try_recv() {
            let miao_tui::transport::TransportEvent::Event(event) = event else { continue };
            let kind = event.kind.to_lowercase();
            if kind == "approval.requested" {
                // Nobody is watching a headless run, so deny precisely and let
                // the turn continue: the model then reports the refusal instead
                // of the whole run hanging or aborting.
                let data = &event.data;
                let response = serde_json::json!({
                    "request_id": data.get("request_id").cloned().unwrap_or_default(),
                    "input_hash": data.get("input_hash").cloned().unwrap_or_default(),
                    "policy_revision": data.get("policy_revision").cloned().unwrap_or_default(),
                    "decision": "deny",
                });
                let tool = data.get("tool").and_then(|value| value.as_str()).unwrap_or("unknown");
                eprintln!("miao run: denied approval for {tool} (headless run cannot ask a person)");
                let _ = client.approve(&session, response).await;
                continue;
            }
            // A failed provider turn produced no answer; waiting for the
            // deadline would hide the reason.
            if kind.contains("failed") || kind.contains("failure") {
                owner.shutdown().await;
                let detail = event.data.get("message").and_then(|value| value.as_str()).unwrap_or(&kind);
                return Err(format!("the turn failed: {detail}"));
            }
            if kind.contains("question.requested") {
                owner.shutdown().await;
                return Err(format!(
                    "the engine asked the operator a question ({kind}); run this prompt in `miao tui`"
                ));
            }
        }
        if std::time::Instant::now() > deadline {
            owner.shutdown().await;
            return Err("timed out waiting for the answer".into());
        }
    }
}

pub fn run(args: Vec<String>) -> std::process::ExitCode {
    // The engine re-executes its own binary for sandboxed processes; those
    // entry points must exist here too, or every bash call fails because the
    // child is this CLI and it does not know the flag.
    if let Some(payload) = args.get(1) {
        let outcome = match args.first().map(String::as_str) {
            Some("__sandbox-run") => Some(miao_engine::process::sandbox_runner(payload)),
            Some("__process-guardian") => Some(miao_engine::process::guardian(payload)),
            _ => None,
        };
        if let Some(result) = outcome {
            return match result {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("miao: {error}");
                    std::process::ExitCode::from(1)
                }
            };
        }
    }
    // One gate for every subcommand: a configured plugin set that no sidecar
    // serves must never look like a working install.
    let config_dir = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
    warn_missing_sidecar(config_dir.as_deref());
    let mut args = args.into_iter();
    match args.next().as_deref() {
        Some("tui") => match launch(args) {
            Ok(launch) => match {
                // The Rust TUI builds its own engine argv from MIAO_ENGINE_*
                // variables, so the routes derived here reach it exactly the way
                // an operator-supplied manifest would.
                prepare_tui_engine(&launch);
                miao_tui::run(launch)
            } {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("miao tui: {error}");
                    std::process::ExitCode::from(1)
                }
            },
            Err(message) => {
                eprintln!("miao: {message}\n{USAGE}");
                std::process::ExitCode::from(2)
            }
        },
        Some("run") => {
            let rest: Vec<String> = args.collect();
            // Flag values are not the prompt: consume them explicitly so
            // `--db /tmp/x.db hello` prompts with `hello`.
            let mut prompt = None;
            let mut db = None;
            let mut workspace = None;
            let mut model = None;
            let mut config_dir = None;
            let mut session = None;
            let mut continue_last = false;
            let mut format = "text".to_string();
            let mut agent_name: Option<String> = None;
            let mut index = 0;
            while index < rest.len() {
                let value = |offset: usize| rest.get(offset + 1).cloned();
                match rest[index].as_str() {
                    "--db" => {
                        db = value(index).map(PathBuf::from);
                        index += 2;
                    }
                    "--workspace" => {
                        workspace = value(index).map(PathBuf::from);
                        index += 2;
                    }
                    "--model" => {
                        model = value(index);
                        index += 2;
                    }
                    "--config-dir" => {
                        config_dir = value(index).map(PathBuf::from);
                        index += 2;
                    }
                    "--agent" => {
                        agent_name = value(index);
                        index += 2;
                    }
                    "--session" => {
                        session = value(index);
                        index += 2;
                    }
                    "--format" => {
                        format = value(index).unwrap_or_else(|| "text".into());
                        index += 2;
                    }
                    "--continue" => {
                        continue_last = true;
                        index += 1;
                    }
                    // Accepted for parity with the product; approval policy
                    // lives in the agent manifest, not in this switch.
                    "--auto" => index += 1,
                    other if other.starts_with("--") => index += 1,
                    other => {
                        prompt = Some(other.to_string());
                        index += 1;
                    }
                }
            }
            let prompt = prompt.ok_or("miao run needs a prompt");
            let workspace = workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            let db = db.unwrap_or_else(|| default_db(&workspace));
            let config_dir = config_dir.or_else(|| product_config_dir(None));
            let model = model
                .or_else(|| std::env::var("MIAO_ENGINE_MODEL").ok())
                .unwrap_or_else(|| "unavailable/model".into());
            match prompt {
                Ok(prompt) => {
                    let mut argv = engine_argv(&db, &workspace, &model, config_dir.as_deref());
                    if let Some(skills) = assemble_skills(&workspace, config_dir.as_deref()) {
                        argv.push("--skills-config".into());
                        argv.push(skills.display().to_string());
                    }
                    let instructions = assemble_instructions(&workspace, config_dir.as_deref());
                    let manifest = match agent_name.as_deref() {
                        // A named agent contributes its own system prompt, and its
                        // model stands in when the command named none.
                        Some(name) => {
                            let chosen = match agent_manifest_for(config_dir.as_deref(), name, instructions) {
                                Ok(chosen) => chosen,
                                Err(message) => {
                                    eprintln!("miao run: {message}");
                                    return std::process::ExitCode::from(1);
                                }
                            };
                            match chosen {
                                Some((agent_model, agent_manifest_json)) => {
                                    if model == "unavailable/model" && !agent_model.is_empty() {
                                        if let Some(position) = argv.iter().position(|arg| arg == "--model") {
                                            argv[position + 1] = agent_model;
                                        }
                                    }
                                    Some(agent_manifest_json.to_string())
                                }
                                None => None,
                            }
                        }
                        None => instructions.map(|text| {
                            serde_json::json!({
                                "name": "miao",
                                "instructions": text,
                                "permission_mode": "auto",
                            })
                            .to_string()
                        }),
                    };
                    if let Some(text) = manifest {
                        let path = std::env::temp_dir()
                            .join(format!("miao-agent-{}.json", std::process::id()));
                        if std::fs::write(&path, text).is_ok() {
                            argv.push("--agent-config".into());
                            argv.push(path.display().to_string());
                        }
                    }
                    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            eprintln!("miao run: {error}");
                            return std::process::ExitCode::from(1);
                        }
                    };
                    let target = Target { session, continue_last, format: format.clone() };
                    match runtime.block_on(run_prompt(argv, prompt, target, db.clone())) {
                        Ok(()) => std::process::ExitCode::SUCCESS,
                        Err(message) => {
                            eprintln!("miao run: {message}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
                Err(message) => {
                    eprintln!("miao: {message}");
                    std::process::ExitCode::from(2)
                }
            }
        }
        Some("web") => match web(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao web: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("attach") => match attach(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao attach: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("remote") => match remote() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao remote: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("pr") => match pr(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao pr: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("upgrade") => match upgrade() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao upgrade: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("report") => match report(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao report: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("hub") => match hub(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao hub: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("hubctl") => match hubctl(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao hubctl: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("worktree") => match worktree(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao worktree: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("workflow") => {
            let rest: Vec<String> = args.collect();
            match rest.first().map(String::as_str) {
                Some("script") => match workflow_script(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao workflow: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("run") => match workflow_run(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao workflow: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                _ => {
                    eprintln!("usage: miao workflow run PLAN.json");
                    std::process::ExitCode::from(2)
                }
            }
        }
        Some("agent") => {
            let rest: Vec<String> = args.collect();
            match rest.first().map(String::as_str) {
                None | Some("list") => match agent_list() {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao agent: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                _ => {
                    eprintln!("usage: miao agent list");
                    std::process::ExitCode::from(2)
                }
            }
        }
        Some("acp") => match acp_serve(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao acp: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("debug") => match debug(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao debug: {message}");
                std::process::ExitCode::from(2)
            }
        },
        Some("completion") => match completion(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao completion: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("db") => {
            let rest: Vec<String> = args.collect();
            match rest.first().map(String::as_str) {
                Some("path") => match db_path(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                _ => {
                    eprintln!("usage: miao db path [--db PATH]");
                    std::process::ExitCode::from(2)
                }
            }
        }
        Some("providers") => match providers() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao providers: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("memory") => match memory(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao memory: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("doctor") => match doctor(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao doctor: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("stats") => match stats(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao stats: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("export") => match export_session(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao export: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("plugins") => match list_plugins() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao plugins: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("session") => {
            let rest: Vec<String> = args.collect();
            match rest.first().map(String::as_str) {
                Some("list") => match list_sessions(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("export-bundle") => match session_engine_call(&rest[1..], "transfer_export_move") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("import") => match session_import(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("move") => match session_engine_call(&rest[1..], "move_session") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("revert") => match session_engine_call(&rest[1..], "revert") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("unrevert") => match session_engine_call(&rest[1..], "unrevert") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("fork") => match session_engine_call(&rest[1..], "fork") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("resume") => {
                    // Reuse the verified `run --session` path verbatim rather
                    // than duplicating its argv assembly here.
                    let mut forwarded: Vec<String> = vec!["run".into(), "--session".into()];
                    let mut id = None;
                    let mut prompt = None;
                    let mut index = 1;
                    while index < rest.len() {
                        let value = |offset: usize| rest.get(offset + 1).cloned();
                        match rest[index].as_str() {
                            "--db" | "--model" | "--config-dir" => {
                                forwarded.push(rest[index].clone());
                                if let Some(value) = value(index) {
                                    forwarded.push(value);
                                    index += 2;
                                } else {
                                    index += 1;
                                }
                            }
                            other if other.starts_with("--") => index += 1,
                            other => {
                                if id.is_none() {
                                    id = Some(other.to_string());
                                } else if prompt.is_none() {
                                    prompt = Some(other.to_string());
                                }
                                index += 1;
                            }
                        }
                    }
                    let (Some(id), Some(prompt)) = (id, prompt) else {
                        eprintln!("usage: miao session resume ID PROMPT [--db PATH] [--model ID] [--config-dir PATH]");
                        return std::process::ExitCode::from(2);
                    };
                    forwarded.insert(2, id);
                    forwarded.push(prompt);
                    let exe = match std::env::current_exe() {
                        Ok(exe) => exe,
                        Err(error) => {
                            eprintln!("miao session: {error}");
                            return std::process::ExitCode::from(1);
                        }
                    };
                    match std::process::Command::new(exe).args(&forwarded).status() {
                        Ok(status) => std::process::ExitCode::from(status.code().unwrap_or(1) as u8),
                        Err(error) => {
                            eprintln!("miao session: {error}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
                _ => {
                    eprintln!("usage: miao session list [--db PATH] | resume ID PROMPT [--db PATH]");
                    std::process::ExitCode::from(2)
                }
            }
        }
        Some("serve") => match serve_forever(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao serve: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("auth") if args.clone().count() > 0 => {
            let rest: Vec<String> = args.collect();
            match auth_write(&rest) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(message) => {
                    eprintln!("miao auth: {message}");
                    std::process::ExitCode::from(1)
                }
            }
        }
        Some("auth") => match list_credentials() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao auth: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("models") => match list_models() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao models: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("--version" | "-v") => {
            println!("miao {}", env!("CARGO_PKG_VERSION"));
            std::process::ExitCode::SUCCESS
        }
        Some("--help" | "-h") | None => {
            println!("{USAGE}");
            std::process::ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("miao: unknown command {other}\n{USAGE}");
            std::process::ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{lsp_servers, mcp_servers, parsed_session_location, plugin_entries, strip_comments};
    use std::io::Write;

    /// Write a throwaway config directory and hand back its path.
    fn config_dir(tag: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("miao-cli-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut file = std::fs::File::create(dir.join("miao.jsonc")).expect("config");
        file.write_all(body.as_bytes()).expect("write");
        dir
    }

    #[test]
    fn mcp_section_maps_to_the_engine_shape() {
        let dir = config_dir(
            "mcp",
            "{ // comment\n \"mcp\": { \"files\": { \"command\": [\"npx\", \"x\"], \"environment\": { \"A\": \"1\" } }, \"remote\": { \"url\": \"https://e.test/mcp\", \"headers\": { \"K\": \"v\" } } } }",
        );
        let servers = mcp_servers(Some(&dir)).expect("maps");
        assert_eq!(servers.len(), 2);
        let files = servers.iter().find(|s| s["name"] == "files").expect("stdio server");
        assert_eq!(files["argv"], serde_json::json!(["npx", "x"]));
        assert_eq!(files["env"], serde_json::json!({"A": "1"}));
        let remote = servers.iter().find(|s| s["name"] == "remote").expect("http server");
        assert_eq!(remote["url"], serde_json::json!("https://e.test/mcp"));
        assert_eq!(remote["headers"], serde_json::json!({"K": "v"}));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lsp_section_keeps_extensions_and_skips_servers_without_a_command() {
        let dir = config_dir(
            "lsp",
            "{ \"lsp\": { \"ts\": { \"command\": [\"ts-ls\", \"--stdio\"], \"extensions\": [\".ts\"] }, \"broken\": { \"extensions\": [\".x\"] } } }",
        );
        let servers = lsp_servers(Some(&dir)).expect("maps");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["argv"], serde_json::json!(["ts-ls", "--stdio"]));
        assert_eq!(servers[0]["extensions"], serde_json::json!([".ts"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_config_without_extensions_needs_no_sidecar() {
        let dir = config_dir("empty", "{ \"model\": \"a/b\" }");
        assert!(mcp_servers(Some(&dir)).expect("maps").is_empty());
        assert!(lsp_servers(Some(&dir)).expect("maps").is_empty());
        assert!(plugin_entries(Some(&dir)).expect("maps").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn argv_carries_the_base_flags_and_workspace_mode() {
        let argv = super::engine_argv_with(
            std::path::Path::new("/tmp/x.db"),
            std::path::Path::new("/tmp/ws"),
            "m",
            None,
            |_| None,
        );
        assert_eq!(argv[0], "serve");
        assert!(argv.windows(2).any(|w| w == ["--db", "/tmp/x.db"]));
        assert!(argv.windows(2).any(|w| w == ["--workspace", "/tmp/ws"]));
        assert!(argv.windows(2).any(|w| w == ["--model", "m"]));
        // Without `--mode workspace` the engine keeps its read-only default and
        // never advertises process or write tools.
        assert!(argv.windows(2).any(|w| w == ["--mode", "workspace"]));
        assert!(!argv.iter().any(|a| a == "--config-dir"));
    }

    #[test]
    fn argv_maps_every_engine_variable_to_its_flag() {
        let argv = super::engine_argv_with(
            std::path::Path::new("/tmp/x.db"),
            std::path::Path::new("/tmp/ws"),
            "m",
            Some(std::path::Path::new("/tmp/cfg")),
            |name| match name {
                "MIAO_ENGINE_PROVIDER" => Some("openai-chat".into()),
                "MIAO_ENGINE_ENDPOINT" => Some("https://e.test/v1".into()),
                "MIAO_ENGINE_CREDENTIAL_DB" => Some("/tmp/cred.db".into()),
                _ => None,
            },
        );
        assert!(argv.windows(2).any(|w| w == ["--provider", "openai-chat"]));
        assert!(argv.windows(2).any(|w| w == ["--endpoint", "https://e.test/v1"]));
        assert!(argv.windows(2).any(|w| w == ["--credential-db", "/tmp/cred.db"]));
        assert!(argv.windows(2).any(|w| w == ["--config-dir", "/tmp/cfg"]));
        // An unset variable contributes no flag at all, rather than an empty one.
        assert!(!argv.iter().any(|a| a == "--credential-id"));
    }

    #[test]
    fn bundle_location_is_read_back_verbatim() {
        let bundle = br#"{"session":{"location":{"directory":"/private/tmp/x"}}}"#;
        assert_eq!(parsed_session_location(bundle), r#"{"directory":"/private/tmp/x"}"#);
        // A malformed bundle must not panic; activation would reject it anyway.
        assert_eq!(parsed_session_location(b"not json"), "{}");
    }

    #[test]
    fn comments_are_removed_but_strings_survive() {
        let text = "{ // line\n  \"url\": \"https://example.test/a//b\", /* block */\n  \"n\": 1 }";
        let stripped = strip_comments(text);
        assert!(stripped.contains("https://example.test/a//b"));
        assert!(!stripped.contains("// line"));
        assert!(!stripped.contains("block"));
        let parsed: serde_json::Value = serde_json::from_str(&stripped).expect("valid json");
        assert_eq!(parsed["n"], serde_json::json!(1));
    }

    #[test]
    fn plugins_read_both_entry_shapes() {
        let dir = std::env::temp_dir().join(format!("miao-plugins-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join("miao.jsonc"),
            "{ // c\n \"plugin\": [\"@scope/a\", { \"package\": \"b-plugin\" }] }",
        )
        .expect("config");
        let entries = plugin_entries(Some(&dir)).expect("parses");
        assert_eq!(entries, vec!["@scope/a".to_string(), "b-plugin".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_config_without_plugins_needs_no_runtime() {
        let dir = std::env::temp_dir().join(format!("miao-noplugins-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("miao.jsonc"), "{ \"model\": \"a/b\" }").expect("config");
        assert!(plugin_entries(Some(&dir)).expect("parses").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
