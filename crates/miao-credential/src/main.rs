//! `miao-credential` — the standalone credential daemon.
//!
//! `serve` binds a unix socket and becomes the single refresh writer for the
//! credential rows of one SQLite database. `discover` prints the same
//! normalized listing as the engine's read-only bridge, for inspection
//! without going through the socket.

use miao_credential::{daemon::Daemon, profile, store};
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let error = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("discover") => discover(&args[1..]),
        _ => Err("usage: miao-credential serve --db PATH --socket PATH [--refresh-margin-ms N]\n       miao-credential discover --db PATH".into()),
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

fn serve(args: &[String]) -> Result<(), String> {
    let mut options = std::collections::HashMap::new();
    let allowed = ["--db", "--socket", "--refresh-margin-ms"];
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
    runtime.block_on(async move {
        let mut daemon = Daemon::new(PathBuf::from(db), profile::openai(), user_agent());
        if let Some(margin_ms) = margin_ms {
            daemon = daemon.with_margin_ms(margin_ms);
        }
        let listener = bind(socket).map_err(|error| format!("bind {socket}: {error}"))?;
        eprintln!("miao-credential serving on {socket}");
        Arc::new(daemon)
            .serve(listener)
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

/// Binds the socket with restrictive permissions: the daemon speaks full
/// credential values, so only the owning user may talk to it or reach it
/// through its directory.
fn bind(socket: &str) -> std::io::Result<tokio::net::UnixListener> {
    let path = std::path::Path::new(socket);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(listener)
}

fn user_agent() -> String {
    format!("miao-credential/{}", env!("CARGO_PKG_VERSION"))
}
