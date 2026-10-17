//! `miao-credential` — the standalone credential daemon.
//!
//! `serve` binds local IPC and becomes the single refresh writer for the
//! credential rows of one SQLite database. `discover` prints the same
//! normalized listing as the engine's read-only bridge, for inspection
//! without going through the socket.

use miao_credential::store;
#[cfg(any(unix, windows))]
use miao_credential::{daemon::Daemon, profile};
#[cfg(any(unix, windows))]
use std::path::PathBuf;
#[cfg(any(unix, windows))]
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let error = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("discover") => discover(&args[1..]),
        Some("login") => login(&args[1..]),
        Some("adopt" | "release") => ownership(&args[1..], &args[0]),
        _ => Err("usage: miao-credential serve --db PATH --socket PATH [--refresh-margin-ms N]\n       miao-credential discover --db PATH\n       miao-credential login --socket PATH --credential-id ID [--integration ID] [--label LABEL]\n       miao-credential adopt|release --socket PATH --credential-id ID --integration ID".into()),
    };
    if let Err(error) = error {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn parse_options(args: &[String], allowed: &[&str]) -> Result<Option<String>, String> {
    let mut options = std::collections::HashMap::new();
    let mut index = 0;
    while index + 1 < args.len() {
        let flag = &args[index];
        index += 1;
        let value = args.get(index).ok_or("missing option value")?;
        index += 1;
        if !allowed.contains(&flag.as_str())
            || options.insert(flag.clone(), value.clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    if index != args.len() {
        return Err("missing option value".into());
    }
    Ok(options.get("--db").cloned())
}

#[cfg(any(unix, windows))]
fn serve(args: &[String]) -> Result<(), String> {
    let mut options = std::collections::HashMap::new();
    let allowed = [
        "--db",
        "--socket",
        "--refresh-margin-ms",
        "--console-server",
        "--console-client-id",
        "--github-server",
    ];
    let mut index = 0;
    while index + 1 < args.len() {
        let flag = args[index].clone();
        let value = args.get(index + 1).ok_or("missing option value")?;
        if !allowed.contains(&flag.as_str()) || options.insert(flag, value.clone()).is_some() {
            return Err("unknown or duplicate option".into());
        }
        index += 2;
    }
    if index != args.len() {
        return Err("missing option value".into());
    }
    let db = options.get("--db").ok_or("--db is required")?;
    let socket = options.get("--socket").ok_or("--socket is required")?;
    let margin_ms = options
        .get("--refresh-margin-ms")
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "--refresh-margin-ms must be a number")
        })
        .transpose()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("tokio runtime failed: {error}"))?;
    runtime.block_on(async {
        let github = options
            .get("--github-server")
            .cloned()
            .unwrap_or_else(|| "https://github.com".into());
        let mut daemon = Daemon::new(PathBuf::from(db), profile::openai(), user_agent())
            .with_profile(profile::copilot(github));
        if let Some(server) = options.get("--console-server") {
            let client = options
                .get("--console-client-id")
                .cloned()
                .unwrap_or_else(|| "opencode-cli".into());
            daemon = daemon.with_profile(profile::console(server.clone(), client));
        }
        if let Some(margin_ms) = margin_ms {
            daemon = daemon.with_margin_ms(margin_ms);
        }
        #[cfg(unix)]
        if let Some(parent) = std::path::Path::new(socket).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        eprintln!("miao-credential serving on {socket}");
        Arc::new(daemon)
            .bind_and_serve(std::path::Path::new(socket))
            .await
            .map_err(|error| format!("serve failed: {error}"))
    })
}

fn discover(args: &[String]) -> Result<(), String> {
    let db = parse_options(args, &["--db"])?.ok_or("--db is required")?;
    let rows = store::discover(std::path::Path::new(&db)).map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&rows).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(any(unix, windows))]
fn user_agent() -> String {
    format!("miao-credential/{}", env!("CARGO_PKG_VERSION"))
}

#[cfg(not(any(unix, windows)))]
fn serve(_args: &[String]) -> Result<(), String> {
    Err("credential daemon requires Unix sockets".into())
}

#[cfg(any(unix, windows))]
fn login(args: &[String]) -> Result<(), String> {
    let mut options = std::collections::HashMap::new();
    if !args.len().is_multiple_of(2) {
        return Err("missing option value".into());
    }
    for pair in args.as_chunks::<2>().0 {
        if !["--socket", "--credential-id", "--label", "--integration"].contains(&pair[0].as_str())
            || options.insert(pair[0].clone(), pair[1].clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    let socket = options.get("--socket").ok_or("--socket is required")?;
    let id = options
        .get("--credential-id")
        .ok_or("--credential-id is required")?;
    let label = options
        .get("--label")
        .map(String::as_str)
        .unwrap_or("OpenAI device login");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let integration = options
        .get("--integration")
        .map(String::as_str)
        .unwrap_or("openai");
    runtime.block_on(async {
        use miao_credential::client;
        let path = std::path::Path::new(socket);
        let started = client::request(
            path,
            serde_json::json!({"id":1,"op":"login_start","integration":integration,"credential_id":id,"label":label})
                .to_string(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let public = started.get("ok").ok_or("device login start rejected")?;
        let handle = public
            .get("handle")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing login handle")?;
        let url = public
            .get("url")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing login URL")?;
        let code = public
            .get("user_code")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing user code")?;
        let interval = public
            .get("interval_ms")
            .and_then(serde_json::Value::as_u64)
            .ok_or("missing poll interval")?;
        println!("Open {url} and enter code {code}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(900);
        while std::time::Instant::now() < deadline {
            let reply = client::request(
                path,
                serde_json::json!({"id":1,"op":"login_poll","handle":handle}).to_string(),
            )
            .await
            .map_err(|e| e.to_string())?;
            let status = reply
                .get("ok")
                .and_then(|v| v.get("status"))
                .and_then(serde_json::Value::as_str)
                .ok_or("device login rejected")?;
            if status == "complete" {
                println!("Credential {id} saved by daemon");
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
        }
        Err("device login timed out".into())
    })
}

#[cfg(not(any(unix, windows)))]
fn login(_args: &[String]) -> Result<(), String> {
    Err("credential daemon requires Unix sockets".into())
}

#[cfg(any(unix, windows))]
fn ownership(args: &[String], operation: &str) -> Result<(), String> {
    let (pairs, remainder) = args.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("missing option value".into());
    }
    let mut options = std::collections::HashMap::new();
    for pair in pairs {
        if !["--socket", "--credential-id", "--integration"].contains(&pair[0].as_str())
            || options.insert(pair[0].clone(), pair[1].clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    let socket = options.get("--socket").ok_or("--socket is required")?;
    let id = options
        .get("--credential-id")
        .ok_or("--credential-id is required")?;
    let integration = options
        .get("--integration")
        .ok_or("--integration is required")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let reply = miao_credential::client::request(
            std::path::Path::new(socket),
            serde_json::json!({"id":1,"op":operation,"credential_id":id,"integration":integration})
                .to_string(),
        )
        .await
        .map_err(|e| e.to_string())?;
        if reply.get("ok").is_none() {
            return Err(format!("credential {operation} rejected"));
        }
        println!("Credential {id}: {operation} complete");
        Ok(())
    })
}

#[cfg(not(any(unix, windows)))]
fn ownership(_args: &[String], _operation: &str) -> Result<(), String> {
    Err("credential daemon requires Unix sockets".into())
}
