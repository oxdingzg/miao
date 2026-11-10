//! Product entry point for the native build.
//!
//! The same binary starts the TUI in-process: `miao_tui::run` is called
//! directly, so a `tui` start costs one process instead of the
//! `miao → miao-tui → miao-engine` chain.

use miao_tui::transport::Connection;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The release build injects the product version from the root package.json;
/// a source build falls back to the crate's own version. This binary is the
/// product, so it must report the product version rather than the placeholder
/// its own manifest carries.
const VERSION: &str = match option_env!("MIAO_CLI_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// What an installer asks for before it trusts the artifact: it keeps each
/// build in a directory named after this identity, so the answer also proves
/// which binary is on disk.
const BUILD_ID: &str = match option_env!("MIAO_CLI_BUILD_ID") {
    Some(id) => id,
    None => "00000000-0000-0000-0000-000000000000",
};

const USAGE: &str = "\
miao — single binary (native)

All commands run in this process: the TUI is linked in, not spawned.

Usage:
  miao                  start the terminal UI (same as `miao tui`)
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
                        list the move's impact first; --apply performs it,
                        --copy-changes carries uncommitted work along
  miao session archive ID [--unarchive]
                        set or clear a session's archive fact (reversible)
  miao session delete ID
                        delete a session; its forks survive
  miao session account SESSION [CREDENTIAL_ID | --clear]
                        pin one session's credential choice, or clear the pin
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
  miao db path          print the engine and product database paths this directory resolves to
  miao db stats|vacuum  report or reclaim space (--db PATH, --apply for vacuum)
  miao db retention     report events a snapshot-then-truncate could drop (report-only)
  miao db blob-gc       report or remove blob files nothing references (--db PATH, --apply)
  miao db backup        copy the ledger and its blobs into a verified backup (--db PATH, --to PATH)
  miao completion SHELL print a completion script (bash or zsh)
  miao debug paths|info|mcp|lsp|routes
                        read-only diagnostics
  miao web              serve and print the address to open
  miao attach URL       probe a running miao server
  miao remote           show this machine's pairing state
  miao pr [NUMBER]      show the current branch and working tree
  miao upgrade          update to the newest release (--check only reports)
  miao uninstall        list install artifacts to remove (--apply to remove)
  miao report TO TEXT   hand a conclusion back to another session
  miao hub              run the local session hub (single instance)
  miao hubctl OP ...    talk to a running hub: register|list|ping
  miao worktree add|list|remove
                        manage git worktrees for parallel sessions
  miao project copy SOURCE TARGET_PARENT [--name NAME] [--apply]
                        copy a project as a git worktree of its repository
  miao workflow run PLAN  run a declarative plan as separate miao runs
  miao workflow script FILE.rhai
                        run an orchestration script (only agent() is exposed)
  miao agent list       list agents the configuration defines
  miao acp              serve Agent Client Protocol over stdio
  miao run [options] PROMPT
                        run one prompt headlessly and print the answer
  miao --build-id       print the identity an installer keeps this build under
  miao --version        print the version
  miao --help           print this help

TUI options:
  --workspace PATH   workspace directory (default: current directory)
  --db PATH          engine database
  --model ID         model to use
  --config-dir PATH  product configuration directory
  -s, --session ID   resume a session
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
    let mut fork = false;
    let mut agent: Option<String> = None;
    let mut auto = false;
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
            "--model" | "-m" => model = Some(value("--model")?),
            "--config-dir" => config_dir = Some(PathBuf::from(value("--config-dir")?)),
            // The TUI's exit hint prints the short spelling, so both parse.
            "--session" | "-s" => session = Some(value("--session")?),
            "--continue" => continue_last = true,
            "--prompt" => prompt = Some(value("--prompt")?),
            // The engine resolves the merged configuration's `agents` entry
            // into the default manifest, so the Session starts under that
            // agent the way the product host starts one.
            "--agent" => agent = Some(value("--agent")?),
            // Three spellings the TypeScript entry carried for the same thing:
            // a launch-wide permission relaxation. They map onto the engine's
            // classifier-guarded auto mode, which still honours operator deny
            // and ask rules.
            "--auto" | "--yolo" | "--dangerously-skip-permissions" => auto = true,
            // The TypeScript entry documented `--fork` as resume-time only.
            "--fork" => fork = true,
            // The legacy interface carried these; the Rust TUI does not
            // implement them yet. Refusing with the reason beats a different
            // Session than the one asked for, and names the still-available
            // escape hatch (CLI-01's "clear error before the terminal exists").
            "--mini" | "--replay" | "--no-replay" | "--replay-limit" | "--demo" => {
                return Err(format!(
                    "the Rust TUI does not implement {name}; drop it, or run the legacy TypeScript TUI with `miao --tui legacy`"
                ))
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    if fork && session.is_none() && !continue_last {
        return Err(
            "--fork copies a Session you are resuming; pair it with --session or --continue".into(),
        );
    }
    let workspace =
        workspace.unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
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
        fork,
        agent,
        auto,
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
    let Some(dir) = config_dir else {
        return Ok(Vec::new());
    };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
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
    let url = rest
        .iter()
        .find(|arg| !arg.starts_with("--"))
        .ok_or("usage: miao attach URL")?;
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
    let trimmed = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let (authority, path) = match trimmed.split_once('/') {
        Some((authority, rest)) => (authority.to_string(), format!("/{rest}")),
        None => (trimmed.to_string(), "/".into()),
    };
    let host = authority
        .split(':')
        .next()
        .unwrap_or(&authority)
        .to_string();
    let port: u16 = authority
        .split_once(':')
        .and_then(|(_, port)| port.parse().ok())
        .unwrap_or(80);
    let mut stream = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| format!("{authority}: {error}"))?;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let request = format!(
        "GET {path} HTTP/1.1
Host: {authority}
Connection: close

"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; 256];
    let read = stream
        .read(&mut buffer)
        .await
        .map_err(|error| error.to_string())?;
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
    let account = parsed
        .get("account")
        .and_then(|value| value.as_str())
        .unwrap_or("paired");
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

/// Upgrade this installation to the newest release.
///
/// The download, the platform asset name, the checksum check and the rollback
/// all live in the published `install` script, and that is the only path CI
/// exercises. Re-implementing them here would be a second copy that can drift,
/// so this command reads the newest version, decides whether an update is
/// needed, and then runs that script the same way a person would.
///
/// `--check` stops after the comparison, which is what a script or a CI job
/// wants: an exit code that says whether an update exists without touching the
/// installed build.
fn upgrade(rest: &[String]) -> Result<(), String> {
    let check_only = rest.iter().any(|argument| argument == "--check");
    let feed = std::env::var("MIAO_UPGRADE_FEED").ok();
    println!("Current version: {VERSION}");
    println!("Checking for updates…");
    let latest = latest_version(feed.as_deref())?;
    if !is_newer(&latest, VERSION) {
        println!("miao {VERSION} is up to date");
        return Ok(());
    }
    if check_only {
        println!("Update available: {VERSION} → {latest}");
        return Ok(());
    }
    println!("Updating to {latest}…");
    run_installer(feed.as_deref())?;
    // The installer repoints `~/.miao/bin/miao` at a new build; this process
    // keeps running the old image, so the operator has to start it again.
    println!("Updated: {VERSION} → {latest}");
    println!("Restart miao to use the new build.");
    Ok(())
}

/// The newest published version, read from the release redirect.
///
/// `releases/latest` answers with a 302 whose `Location` ends in the tag, and
/// following it costs one request. The REST API would answer the same question
/// but allows only 60 unauthenticated calls an hour per IP — a budget an
/// update check must not spend. `feed` overrides the host for installations
/// that track an internal mirror.
fn latest_version(feed: Option<&str>) -> Result<String, String> {
    let base = feed
        .unwrap_or("https://github.com/oxdingzg/miao")
        .trim_end_matches('/');
    // curl.exe on Windows resolves `/dev/null` against the current drive
    // (`D:\dev\null` from `D:\`), and every write of the redirect body fails
    // with curl 23. The null device is spelled `NUL` there.
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let output = std::process::Command::new("curl")
        .args([
            // A single transient TLS reset through a local proxy used to fail the
            // whole upgrade with `SSL_ERROR_SYSCALL`; the download that follows a
            // successful check already retries, so the check must too.
            "--retry",
            "4",
            "--retry-all-errors",
            "--retry-delay",
            "2",
            "-fsSL",
            "-o",
            null,
            "-w",
            "%{url_effective}",
            &format!("{base}/releases/latest"),
        ])
        .output()
        .map_err(|error| format!("curl: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not read the latest release: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let url = String::from_utf8_lossy(&output.stdout);
    url.rsplit('/')
        .next()
        .map(|tag| tag.trim().trim_start_matches('v').to_string())
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| format!("could not read a version from {url}"))
}

/// Whether `candidate` is a newer release than `current`.
///
/// Compared numerically field by field: a plain string comparison would call
/// `0.3.9` newer than `0.3.29`. A pre-release suffix is ignored, because the
/// release feed only publishes full releases.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |version: &str| -> Vec<u64> {
        version
            .split(['.', '-', '+'])
            .map_while(|field| field.parse::<u64>().ok())
            .collect()
    };
    let (candidate, current) = (parse(candidate), parse(current));
    if candidate.is_empty() || current.is_empty() {
        return false;
    }
    candidate > current
}

/// Run the published installer, which replaces this installation in place.
fn run_installer(feed: Option<&str>) -> Result<(), String> {
    let base = feed.unwrap_or("https://github.com/oxdingzg/miao");
    // The `/raw/` path is the one GitHub answers: `/main/install` without it
    // is a 404 on every request, which is what every upgrade since this
    // command learned to download has died on. `-L` follows the redirect to
    // the raw host, and the retries absorb the transient failures a proxied
    // link throws off mid-TLS.
    let script = format!("{}/raw/main/install", base.trim_end_matches('/'));
    // Download first, then run: a `curl | bash` pipe reports the tail's exit
    // code, so a failed download would pipe an empty script into bash, exit 0,
    // and announce an update it never installed.
    let staged = std::env::temp_dir().join("miao-install.sh");
    let downloaded = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "--retry",
            "4",
            "--retry-all-errors",
            "--retry-delay",
            "2",
            "-o",
        ])
        .arg(&staged)
        .arg(&script)
        .status()
        .map_err(|error| format!("could not run curl: {error}"))?;
    if !downloaded.success() {
        let _ = std::fs::remove_file(&staged);
        return Err(format!(
            "could not download the installer ({downloaded}); the previous build is still installed"
        ));
    }
    let status = std::process::Command::new("bash")
        .arg(&staged)
        .status()
        .map_err(|error| format!("could not run the installer: {error}"));
    let _ = std::fs::remove_file(&staged);
    let status = status?;
    if !status.success() {
        return Err(format!(
            "the installer exited with {status}; the previous build is still installed"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod upgrade_tests {
    use std::sync::{Mutex, MutexGuard};
    // These tests repoint HOME and friends at temp trees; the variables are
    // process-global, so overlapping tests would answer each other's reads.
    static ENV_SERIES: Mutex<()> = Mutex::new(());

    fn env_guard() -> MutexGuard<'static, ()> {
        ENV_SERIES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    use super::{is_newer, latest_version};

    #[test]
    fn a_newer_release_is_detected_numerically_not_lexically() {
        // The comparison that matters: `0.3.9` sorts after `0.3.29` as text and
        // before it as a version, so a string compare would refuse the update.
        assert!(is_newer("0.3.29", "0.3.9"));
        assert!(is_newer("0.3.30", "0.3.29"));
        assert!(is_newer("0.4.0", "0.3.29"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.3.29", "0.3.29"));
        assert!(!is_newer("0.3.28", "0.3.29"));
        // A shorter version is not newer than a longer one that matches it.
        assert!(!is_newer("0.3", "0.3.0"));
    }

    #[test]
    fn a_prerelease_suffix_is_ignored() {
        assert!(is_newer("0.3.30-beta.1", "0.3.29"));
        assert!(!is_newer("0.3.29-rc.1", "0.3.29"));
    }

    #[test]
    fn an_unreadable_version_never_reports_an_update() {
        assert!(!is_newer("", "0.3.29"));
        assert!(!is_newer("not-a-version", "0.3.29"));
    }

    #[test]
    fn the_version_comes_from_the_release_redirect() {
        let _env = env_guard();
        // The redirect ends in the tag; `latest_version` keeps only that part.
        // Exercised against the real endpoint so a change to how GitHub answers
        // shows up here rather than in an operator's failed upgrade.
        let version = latest_version(None).expect("the latest release is readable");
        assert!(
            version.split('.').count() >= 2,
            "expected a dotted version, got {version:?}"
        );
        assert!(
            version.chars().all(|c| c.is_ascii_digit() || c == '.'),
            "expected a bare version, got {version:?}"
        );
    }
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
    // The hub is a Unix-domain-socket service. Windows has no UDS in std and
    // no shipping implementation here, so the command exists but says why it
    // cannot run instead of failing to compile the whole binary.
    #[cfg(not(unix))]
    {
        let _ = rest;
        return Err(
            "the session hub needs a Unix domain socket and is not available on this platform"
                .into(),
        );
    }
    #[cfg(unix)]
    {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let mut idle_ms: u64 = 0;
        let mut index = 0;
        while index < rest.len() {
            if rest[index] == "--idle-ms" {
                idle_ms = rest
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
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
    let result: rhai::Dynamic = engine
        .eval_ast(&ast)
        .map_err(|error| format!("{path}: {error}"))?;
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
            return Err(format!(
                "bundle digest mismatch: expected {expected}, got {computed}"
            ));
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
            let now = cli_now_ms() as i64;
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
        .and_then(|value| {
            value
                .get("session")
                .and_then(|s| s.get("location"))
                .cloned()
        })
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
        let client = connection
            .connect()
            .await
            .map_err(|error| error.to_string())?;
        let usage = client
            .request("usage", serde_json::json!({ "session_id": session }))
            .await
            .map_err(|error| error.to_string())?;
        println!(
            "{}",
            serde_json::to_string_pretty(&usage).unwrap_or_default()
        );
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
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };
    let _ = std::fs::remove_file(&file);
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|entry| {
            let from = entry
                .get("from")
                .and_then(|value| value.as_str())
                .unwrap_or("another session");
            let text = entry.get("text").and_then(|value| value.as_str())?;
            Some(format!("[message from {from}] {text}"))
        })
        .collect()
}

/// Fork one session into another through the engine's own command, so the
/// copy carries the engine's message sequence and placement rather than a
/// host-side guess at either.
/// What moving one session would touch, read from its own ledger before the
/// engine moves anything: where the session lives now, how much history the
/// move carries, what else is anchored to the same tree, and what the target
/// looks like. The WSP-03 rule is that the impact is listed first, so the move
/// itself waits for `--apply`.
fn session_move_plan(
    db: &std::path::Path,
    session_id: &str,
    target: &std::path::Path,
    copy_changes: bool,
) -> Result<Vec<String>, String> {
    let connection = db_read_only(db)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err(format!("no session {session_id} in {}", db.display()));
    }
    let mut plan = vec![format!("session · {session_id}")];
    let current: Option<String> = connection
        .query_row(
            "SELECT root FROM engine_location WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
        .map_err(|error| error.to_string())?;
    match current.as_deref() {
        Some(root) => plan.push(format!("current location · {root}")),
        None => plan.push("current location · none recorded".into()),
    }
    let (events, messages, last_ms): (i64, i64, Option<i64>) = connection
        .query_row(
            "SELECT (SELECT count(*) FROM engine_event WHERE session_id=?1), \
                    (SELECT count(*) FROM engine_message WHERE session_id=?1), \
                    (SELECT MAX(recorded_at_ms) FROM engine_event WHERE session_id=?1)",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    plan.push(format!(
        "history carried · {events} event(s), {messages} message(s)"
    ));
    if let Some(ms) = last_ms {
        plan.push(format!("last activity · {ms} ms epoch"));
    }
    if let Some(root) = &current {
        let siblings: i64 = connection
            .query_row(
                "SELECT count(*) FROM engine_location WHERE root=?1 AND session_id<>?2",
                [root, session_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if siblings > 0 {
            plan.push(format!(
                "anchored with the session · {siblings} other session(s) share the current root and stay put"
            ));
        }
    }
    plan.push(format!("target · {}", target.display()));
    plan.push(if copy_changes {
        "uncommitted changes · carried to the target (--copy-changes)".into()
    } else {
        "uncommitted changes · left behind in the source".into()
    });
    if target.exists() {
        plan.push("target state · exists".into());
        if target.join(".git").exists() {
            plan.push("target state · a git checkout".into());
        }
    } else {
        plan.push("target state · absent (the engine creates it)".into());
    }
    let ledger = db_file_bytes(db);
    plan.push(format!(
        "ledger · {} ({})",
        db.display(),
        human_bytes(ledger.0 + ledger.1 + ledger.2)
    ));
    Ok(plan)
}

fn session_engine_call(rest: &[String], method: &str) -> Result<(), String> {
    session_engine_call_with(rest, method, |_| {})
}

/// `session_engine_call` with a hook for callers that add method-specific
/// params beyond the session id (the account pin's credential choice, and any
/// future forward that carries structured payload).
fn session_engine_call_with(
    rest: &[String],
    method: &str,
    decorate: impl FnOnce(&mut serde_json::Value),
) -> Result<(), String> {
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
        let client = connection
            .connect()
            .await
            .map_err(|error| error.to_string())?;
        // Location is keyed by the real path: `/tmp/x` and `/private/tmp/x` are
        // two different Locations, so a bundle exported under the short spelling
        // becomes unreachable for an engine that canonicalises its workspace.
        let canonical = |value: &str| -> String {
            std::fs::canonicalize(value)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| value.to_string())
        };
        let mut params = serde_json::json!({ "session_id": positional[0] });
        decorate(&mut params);
        match method {
            "archive" => {
                // Absence of the flag means un-archive: the reversible pair
                // shares one command, and the engine treats archiving as a
                // catalog fact that touches no message, run or inbox row.
                let archived = !rest.iter().any(|argument| argument == "--unarchive");
                params["archived"] = serde_json::json!(archived);
            }
            "remove" => {}
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
        let result = client
            .request(method, params)
            .await
            .map_err(|error| error.to_string())?;
        println!("{}", serde_json::to_string(&result).unwrap_or_default());
        Ok(())
    })
}

/// Talk to a running hub. Used by `send_message` and by tests.
fn hubctl(rest: &[String]) -> Result<(), String> {
    // Same Unix-domain-socket boundary as `hub`; see its note.
    #[cfg(not(unix))]
    {
        let _ = rest;
        return Err(
            "the session hub needs a Unix domain socket and is not available on this platform"
                .into(),
        );
    }
    #[cfg(unix)]
    {
        use std::io::{BufRead, BufReader, Write};
        let op = rest
            .first()
            .ok_or("usage: miao hubctl register|list|ping")?;
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
        writer
            .write_all(line.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .map_err(|error| error.to_string())?;
        println!("{}", response.trim());
        Ok(())
    }
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
            // The engine owns the git plumbing; the CLI only prints what it
            // answers, so a tree another client creates lists here too.
            for tree in miao_engine::worktree::list(std::path::Path::new(&root))
                .map_err(|error| error.to_string())?
            {
                println!("{}", tree.path);
            }
            Ok(())
        }
        Some("add") => {
            let name = rest.get(1).ok_or("usage: miao worktree add NAME")?;
            if name.contains('/') || name.contains("..") {
                return Err("worktree name must be a single path component".into());
            }
            // Report the canonical path: that is what a Location must be keyed
            // by, and the engine's service already canonicalises it.
            let tree = miao_engine::worktree::create(std::path::Path::new(&root), name)
                .map_err(|error| error.to_string())?;
            println!("{}", tree.path);
            Ok(())
        }
        Some("remove") => {
            let name = rest
                .get(1)
                .ok_or("usage: miao worktree remove NAME [--apply] [--force]")?;
            if name.contains('/') || name.contains("..") {
                return Err("worktree name must be a single path component".into());
            }
            let apply = rest.iter().any(|argument| argument == "--apply");
            let force = rest.iter().any(|argument| argument == "--force");
            let path = PathBuf::from(&root).join(".miao-worktrees").join(name);
            for line in worktree_remove_plan(&root, name, &path)? {
                println!("{line}");
            }
            if !apply {
                println!("dry run · pass --apply to remove");
                return Ok(());
            }
            worktree_remove_apply(&root, name, &path, force)?;
            println!("removed {name}");
            Ok(())
        }
        Some(other) => Err(format!("unknown worktree subcommand {other}")),
    }
}

/// What removing one worktree touches, collected before anything is removed:
/// the git registration, the branch and the commits only it holds, the engine
/// sessions anchored to the tree's directory, and the bytes on disk including
/// the ledger file the tree's sessions wrote into. The WSP-04 rule is that a
/// cleanup shows who references the target first, so `--apply` is a separate,
/// explicit step rather than a flag buried in the same action.
fn worktree_remove_plan(
    root: &str,
    name: &str,
    path: &std::path::Path,
) -> Result<Vec<String>, String> {
    let git = |args: &[&str]| -> Result<std::process::Output, String> {
        std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .map_err(|error| format!("git: {error}"))
    };
    let success = |output: &std::process::Output| output.status.success();
    let mut plan = vec![format!("worktree · {}", path.display())];

    let registered = git(&["worktree", "list", "--porcelain"])?;
    let listed = String::from_utf8_lossy(&registered.stdout);
    // git reports the real path, and a symlinked temp dir (macOS /var →
    // /private/var) otherwise reads as unregistered; compare canonical forms.
    let check_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let is_registered = listed.lines().any(|line| {
        line.strip_prefix("worktree ") == Some(check_path.display().to_string().as_str())
    });
    plan.push(format!(
        "git registration · {}",
        if is_registered {
            "registered"
        } else {
            "not registered (git already forgot it)"
        }
    ));

    let branch_tip = git(&["rev-parse", "--verify", &format!("refs/heads/{name}")])?;
    if success(&branch_tip) {
        // `branch -D` discards every commit the branch holds that HEAD cannot
        // reach; the count is what an operator needs before agreeing to that.
        let ahead = git(&["rev-list", "--count", &format!("HEAD..refs/heads/{name}")])?;
        let commits = String::from_utf8_lossy(&ahead.stdout).trim().to_string();
        plan.push(format!(
            "branch {name} · {} commit(s) not reachable from HEAD will be discarded",
            if commits.is_empty() { "0" } else { &commits }
        ));
    } else {
        plan.push(format!("branch {name} · absent"));
    }

    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let ledger = default_db(&canonical);
    if ledger.is_file() {
        let connection = rusqlite::Connection::open_with_flags(
            &ledger,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let anchored: i64 = connection
            .query_row(
                "SELECT count(*) FROM engine_location WHERE root = ?1 OR root LIKE ?1 || '/%'",
                [canonical.display().to_string()],
                |row| row.get(0),
            )
            .unwrap_or(0);
        plan.push(format!(
            "engine sessions · {} anchored in {} ({})",
            anchored,
            ledger.display(),
            human_bytes(db_file_bytes(&ledger).0)
        ));
        if anchored > 0 {
            plan.push(
                "  · removing the tree strands these sessions' cwd; move or close them first"
                    .into(),
            );
        }
    } else {
        plan.push("engine sessions · none (no ledger for this tree)".to_string());
    }

    let main_anchored = anchored_sessions(&default_db(std::path::Path::new(root)), &canonical)?;
    plan.push(format!(
        "main ledger · {main_anchored} session(s) anchor this tree from the checkout's ledger"
    ));

    plan.push(format!(
        "directory · {} on disk",
        human_bytes(tree_bytes(path))
    ));
    Ok(plan)
}

/// One `git` invocation with `dir` as the working directory. Arguments travel
/// directly to git — never through a shell.
fn git_in(dir: &std::path::Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|error| format!("git: {error}"))
}

/// Sessions in `db` whose recorded root is `tree` itself or lives below it.
/// Roots are canonical in the ledger, so the caller passes a canonical path.
fn anchored_sessions(db: &std::path::Path, tree: &std::path::Path) -> Result<i64, String> {
    if !db.is_file() {
        return Ok(0);
    }
    let connection = db_read_only(db)?;
    connection
        .query_row(
            "SELECT count(*) FROM engine_location WHERE root = ?1 OR root LIKE ?1 || '/%'",
            [tree.display().to_string()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

/// Remove one worktree after the plan: a tree whose sessions still anchor it
/// must not strand them with a dead cwd. Without `force`, refuse and say who
/// is anchored; with it, point those sessions back at the main checkout first,
/// then remove. The tree's own ledger disappears with the directory — the plan
/// said so before anything was removed.
fn worktree_remove_apply(
    root: &str,
    name: &str,
    path: &std::path::Path,
    force: bool,
) -> Result<(), String> {
    let check_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let anchored = tree_anchored_sessions(root, &check_path)?;
    if anchored > 0 && !force {
        return Err(format!(
            "{anchored} session(s) still anchor {}: move or close them first, or pass --force to point them back at the main checkout before removal",
            path.display()
        ));
    }
    if anchored > 0 {
        let checkout = git_worktree_main_checkout(root)?;
        let moved = tree_migrate_sessions(root, &check_path, &checkout)?;
        println!("migrated {moved} session(s) back to {}", checkout.display());
    }
    miao_engine::worktree::remove(std::path::Path::new(root), name)
        .map_err(|error| error.to_string())
}

/// Sessions anchored to `tree` across the two ledgers that can hold one: the
/// checkout's own ledger and the tree's. Removal strands both kinds.
fn tree_anchored_sessions(root: &str, tree: &std::path::Path) -> Result<i64, String> {
    let main = anchored_sessions(&default_db(std::path::Path::new(root)), tree)?;
    let tree_own = anchored_sessions(&default_db(tree), tree)?;
    Ok(main + tree_own)
}

/// Point every session anchored to `from` at `to` instead, in both ledgers
/// that can hold one, and return how many moved.
fn tree_migrate_sessions(
    root: &str,
    from: &std::path::Path,
    to: &std::path::Path,
) -> Result<usize, String> {
    let mut moved = 0;
    for db in [default_db(std::path::Path::new(root)), default_db(from)] {
        if !db.is_file() {
            continue;
        }
        let connection = rusqlite::Connection::open(&db).map_err(|error| error.to_string())?;
        moved += connection
            .execute(
                "UPDATE engine_location SET root = ?2 WHERE root = ?1 OR root LIKE ?1 || '/%'",
                rusqlite::params![from.display().to_string(), to.display().to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(moved)
}

/// The main working tree of the repository `root` belongs to: the first entry
/// `worktree list --porcelain` reports, which git always puts first.
fn git_worktree_main_checkout(root: &str) -> Result<PathBuf, String> {
    let listed = git_in(
        std::path::Path::new(root),
        &["worktree", "list", "--porcelain"],
    )?;
    if !listed.status.success() {
        return Err(String::from_utf8_lossy(&listed.stderr).trim().to_string());
    }
    for line in String::from_utf8_lossy(&listed.stdout).lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            return Ok(PathBuf::from(path));
        }
    }
    Err("git worktree list reported no worktrees".into())
}

/// The path a copy lands on: `name`, then `name-2` up to `name-10`, then a
/// refusal — the same suffix walk the TypeScript product runs, so a copy never
/// silently lands on, or overwrites, a directory the operator did not ask for.
fn project_copy_target(parent: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    let mut suffix = 1;
    loop {
        let candidate = parent.join(if suffix == 1 {
            name.to_string()
        } else {
            format!("{name}-{suffix}")
        });
        if !candidate.exists() {
            return Ok(candidate);
        }
        suffix += 1;
        if suffix > 10 {
            return Err(format!(
                "every spelling of {name} up to {name}-10 already exists in {}",
                parent.display()
            ));
        }
    }
}

/// What copying one project creates, collected before anything is created: the
/// source's registration as a repository, the target path the suffix rule
/// picks, the sessions that stay with the source, and the fact a worktree
/// checks out HEAD, so uncommitted changes stay behind. The plan touches
/// nothing: the source is only ever read.
fn project_copy_plan(
    source: &std::path::Path,
    target_parent: &std::path::Path,
    name: &str,
    db: &std::path::Path,
) -> Result<Vec<String>, String> {
    let head = git_in(source, &["rev-parse", "--verify", "HEAD"])?;
    if !head.status.success() {
        return Err(format!("{} has no commits to copy", source.display()));
    }
    let mut plan = vec![format!("project copy · {}", source.display())];
    plan.push("strategy · git worktree of the source repository".into());
    let anchored = anchored_sessions(&default_db(source), source)?;
    plan.push(format!(
        "source sessions · {anchored} anchored session(s) stay with the source"
    ));
    let target = project_copy_target(target_parent, name)?;
    plan.push(format!("target · {}", target.display()));
    plan.push("uncommitted changes · stay in the source (a worktree checks out HEAD)".into());
    let size = db_file_bytes(db);
    plan.push(format!(
        "ledger · {} ({})",
        db.display(),
        human_bytes(size.0 + size.1 + size.2)
    ));
    Ok(plan)
}

/// Copy a project: a git worktree of the source repository at a new path (the
/// TypeScript product's `git_worktree` strategy). The source is read-only for
/// the whole run; the target gets a fresh suffix instead of ever touching an
/// existing directory; a failed `worktree add` cleans up its half-built
/// directory and prunes the registration before reporting the error.
fn project_copy(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut name: Option<String> = None;
    let mut apply = false;
    let mut positional: Vec<String> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        let value = |offset: usize| rest.get(offset + 1).cloned();
        match rest[index].as_str() {
            "--db" => {
                db = value(index).map(PathBuf::from);
                index += 2;
            }
            "--name" => {
                let taken = value(index).ok_or("--name needs a value")?;
                if taken.starts_with("--") {
                    return Err("--name needs a value".into());
                }
                name = Some(taken);
                index += 2;
            }
            "--apply" => {
                apply = true;
                index += 1;
            }
            other => {
                positional.push(other.to_string());
                index += 1;
            }
        }
    }
    let (Some(source), Some(target_parent)) = (positional.first(), positional.get(1)) else {
        return Err("usage: miao project copy SOURCE TARGET_PARENT [--name NAME] [--apply]".into());
    };
    if name
        .as_deref()
        .is_some_and(|value| value.contains('/') || value.contains(".."))
    {
        return Err("copy name must be a single path component".into());
    }
    let source = std::fs::canonicalize(source).map_err(|error| format!("source: {error}"))?;
    if !source.is_dir() {
        return Err(format!("source {} is not a directory", source.display()));
    }
    let target_parent =
        std::fs::canonicalize(target_parent).map_err(|error| format!("target parent: {error}"))?;
    if !target_parent.is_dir() {
        return Err(format!(
            "target parent {} is not a directory",
            target_parent.display()
        ));
    }
    let name = name.unwrap_or_else(|| {
        source
            .file_name()
            .map(|base| base.to_string_lossy().to_string())
            .unwrap_or_else(|| "copy".into())
    });
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let db = db.unwrap_or_else(|| default_db(&workspace));
    for line in project_copy_plan(&source, &target_parent, &name, &db)? {
        println!("{line}");
    }
    if !apply {
        println!("dry run · pass --apply to create the copy");
        return Ok(());
    }
    let target = project_copy_apply(&source, &target_parent, &name)?;
    println!("copy created · {}", target.display());
    Ok(())
}

/// Create the worktree a copy is: the target gets a fresh suffix instead of
/// ever touching an existing directory, and a failed `worktree add` cleans up
/// its half-built directory and prunes the registration before the error
/// surfaces. The source is only ever read.
fn project_copy_apply(
    source: &std::path::Path,
    target_parent: &std::path::Path,
    name: &str,
) -> Result<PathBuf, String> {
    let target = project_copy_target(target_parent, name)?;
    let created = git_in(source, &["worktree", "add", &target.display().to_string()])?;
    if !created.status.success() {
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(&target);
        }
        let _ = git_in(source, &["worktree", "prune"]);
        return Err(String::from_utf8_lossy(&created.stderr).trim().to_string());
    }
    Ok(std::fs::canonicalize(&target).unwrap_or(target))
}

/// Carry the source's uncommitted changes onto the target — the TypeScript
/// product's warp `copyChanges` (packages/core/src/workspace-live.ts): the
/// HEAD diff plus every untracked file, applied on the target as one patch.
/// Returns the patch size carried; zero means the source was clean. The
/// target must be a git repository: a patch needs something to apply against.
/// The source is only ever read.
fn carry_uncommitted_changes(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<usize, String> {
    let status = git_in(source, &["status", "--porcelain", "-z"])?;
    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
    }
    let mut patch = String::from_utf8_lossy(&git_in(source, &["diff", "HEAD"])?.stdout).to_string();
    for entry in String::from_utf8_lossy(&status.stdout).split('\0') {
        let Some(file) = entry.strip_prefix("?? ") else {
            continue;
        };
        if file.is_empty() {
            continue;
        }
        // Untracked files have no HEAD version: diff each against /dev/null.
        let single = git_in(source, &["diff", "--no-index", "--", "/dev/null", file])?;
        patch.push_str(&String::from_utf8_lossy(&single.stdout));
    }
    if patch.is_empty() {
        return Ok(0);
    }
    let applied = std::process::Command::new("git")
        .arg("-C")
        .arg(target)
        .args(["apply", "--whitespace=nowarn", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .expect("piped stdin")
                .write_all(patch.as_bytes())?;
            child.wait_with_output()
        })
        .map_err(|error| format!("git apply: {error}"))?;
    if !applied.status.success() {
        return Err(format!(
            "the target could not take the source's changes: {}",
            String::from_utf8_lossy(&applied.stderr).trim()
        ));
    }
    Ok(patch.len())
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
    let plan: serde_json::Value =
        serde_json::from_str(&strip_comments(&text)).map_err(|error| format!("{path}: {error}"))?;
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
            let id = step
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let ready = step
                .get("depends_on")
                .and_then(|value| value.as_array())
                .map(|deps| {
                    deps.iter()
                        .all(|dep| dep.as_str().is_some_and(|dep| done.contains(dep)))
                })
                .unwrap_or(true);
            if !ready {
                next.push(step);
                continue;
            }
            let prompt = step
                .get("prompt")
                .and_then(|value| value.as_str())
                .unwrap_or("");
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
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        });
    let Some(dir) = config else {
        return Err("MIAO_CONFIG_DIR is unset".into());
    };
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let default = parsed
            .get("default_agent")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match parsed.get("agent").and_then(|value| value.as_object()) {
            Some(agents) if !agents.is_empty() => {
                for (name, agent) in agents {
                    let model = agent
                        .get("model")
                        .and_then(|value| value.as_str())
                        .unwrap_or("-");
                    let mark = if name == default { " (default)" } else { "" };
                    println!("{name:<20} {model}{mark}");
                }
            }
            _ => println!(
                "no agents configured{}",
                if default.is_empty() {
                    "".to_string()
                } else {
                    format!(" (default_agent = {default})")
                }
            ),
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
fn mcp_servers(layers: &[PathBuf]) -> Result<Vec<serde_json::Value>, String> {
    let Some(parsed) = merged_config(layers) else {
        return Ok(Vec::new());
    };
    let Some(section) = parsed
        .get("mcp")
        .or_else(|| parsed.get("mcpServers"))
        .and_then(|value| value.as_object())
    else {
        return Ok(Vec::new());
    };
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
        for (from, to) in [
            ("env", "env"),
            ("environment", "env"),
            ("headers", "headers"),
        ] {
            if let Some(value) = entry.get(from) {
                server[to] = value.clone();
            }
        }
        if let Some(cwd) = entry.get("cwd").and_then(|value| value.as_str()) {
            server["cwd"] = serde_json::json!(cwd);
        }
        servers.push(server);
    }
    Ok(servers)
}

/// The model the product configuration names as its default. Rust commands
/// honour it the way the product does, so a machine with one configured model
/// needs no flags at all.
fn configured_model(config_dir: Option<&std::path::Path>) -> Option<String> {
    let dir = config_dir?;
    for name in ["miao.jsonc", "miao.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text)).ok()?;
        let configured = parsed.get("model").and_then(|value| value.as_str())?;
        // Routes are keyed by bare model id; the product spells it
        // `provider/model`.
        return Some(
            configured
                .rsplit_once('/')
                .map(|(_, model)| model.to_string())
                .unwrap_or_else(|| configured.to_string()),
        );
    }
    None
}

/// Where the product keeps its configuration. Resolving this in one place
/// keeps every subcommand deriving the same routes from the same files.
fn product_config_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    explicit
        .or_else(|| std::env::var_os("MIAO_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        })
}

/// The config directories one start reads, lowest priority first. An explicit
/// directory keeps the long-standing single-directory answer. Otherwise the
/// global directory comes first, then the project layers a walk up from the
/// workspace finds: stray config files sit under the `.miao`/`.opencode`
/// directories of the same level, and a nearer directory wins. The walk stops
/// at the git worktree root, or the filesystem root outside a repository;
/// `MIAO_DISABLE_PROJECT_CONFIG` or a workspace that is the global directory
/// itself skips it. Mirrors the product's scoped stack.
fn config_layers(
    workspace: &Path,
    explicit: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<PathBuf> {
    config_layers_with(
        workspace,
        explicit,
        env,
        env("MIAO_MANAGED_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(miao_engine::config_scope::managed_dir)
            .as_deref(),
    )
}

/// The four scopes in precedence order: an administrator's system-wide
/// directory, the user's global directory, then the project layers a walk up
/// from the workspace finds. The managed layer is only a layer when an
/// administrator actually deployed one, so an ordinary machine keeps exactly
/// the stack it had.
fn config_layers_with(
    workspace: &Path,
    explicit: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
    managed: Option<&Path>,
) -> Vec<PathBuf> {
    if let Some(dir) = explicit {
        return vec![dir.to_path_buf()];
    }
    let global = env("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| env("HOME").map(|home| PathBuf::from(home).join(".config").join("miao")));
    let mut layers = Vec::new();
    if let Some(dir) = managed.filter(|dir| dir.is_dir()) {
        layers.push(dir.to_path_buf());
    }
    if let Some(dir) = global.as_ref() {
        layers.push(dir.clone());
    }
    if !project_config_disabled(env) && !same_directory(global.as_deref(), workspace) {
        let (directories, files) = project_config_layers(workspace, global.as_deref());
        layers.extend(files.into_iter().rev());
        layers.extend(directories.into_iter().rev());
    }
    layers
}

fn project_config_disabled(env: &dyn Fn(&str) -> Option<String>) -> bool {
    matches!(
        env("MIAO_DISABLE_PROJECT_CONFIG").as_deref(),
        Some("true") | Some("1")
    )
}

fn same_directory(left: Option<&Path>, right: &Path) -> bool {
    let (Some(left), Ok(resolved)) = (left, right.canonicalize()) else {
        return false;
    };
    left.canonicalize()
        .map(|seen| seen == resolved)
        .unwrap_or(false)
}

/// The last directory a project walk examines: the git worktree root when the
/// workspace sits in a repository, the filesystem root otherwise — the same
/// boundary the product's project resolution draws.
fn walk_stop(workspace: &Path) -> Option<PathBuf> {
    let mut current = workspace;
    loop {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

/// The `.miao`/`.opencode` directories and stray config files a walk up from
/// the workspace finds, nearest first. The walk ends at the git worktree root
/// or, outside one, at the home directory — the boundary that keeps a
/// workspace under `$HOME` from reading a sibling project's configuration.
fn project_config_layers(workspace: &Path, global: Option<&Path>) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let stop = walk_stop(workspace).or_else(|| {
        std::env::var_os("HOME").map(|home| {
            let home = PathBuf::from(home);
            home.parent().unwrap_or(&home).to_path_buf()
        })
    });
    let mut directories = Vec::new();
    let mut files = Vec::new();
    let mut current = Some(workspace);
    while let Some(dir) = current {
        if same_directory(global, dir) {
            break;
        }
        for name in [".miao", ".opencode"] {
            let candidate = dir.join(name);
            if candidate.is_dir() {
                directories.push(candidate);
            }
        }
        for name in miao_engine::config_scope::FILE_NAMES {
            let candidate = dir.join(name);
            if candidate.is_file() {
                files.push(candidate);
            }
        }
        if stop.as_deref().map(|stop| dir == stop).unwrap_or(false) {
            break;
        }
        current = dir.parent();
    }
    (directories, files)
}

/// The merged configuration document the layered stack produces, `None` when
/// no layer has a config file. Each directory reads the product's file names
/// in their documented order and a later layer wins key for key.
fn merged_config(layers: &[PathBuf]) -> Option<serde_json::Value> {
    let mut values = Vec::new();
    for dir in layers {
        for name in miao_engine::config_scope::FILE_NAMES {
            let path = dir.join(name);
            if !path.is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = miao_engine::config_scope::parse_document(&text) else {
                continue;
            };
            values.push(value);
        }
    }
    (!values.is_empty()).then(|| miao_engine::config_scope::merge_values(&values))
}

/// The engine database a workspace uses when none was named.
///
/// It must live outside the workspace: a process-enabled runtime refuses a
/// database the model itself could write. One file per workspace keeps
/// sessions from different directories apart without opting into a shared
/// store.
///
/// The name resolves through the engine's own placement rule. A private hash
/// here once sent `miao tui` to a second, empty ledger while `miao-tui` opened
/// the one the product already uses — every entry point has to agree on the
/// file, or the maintenance commands audit a database nobody writes.
fn default_db(workspace: &std::path::Path) -> PathBuf {
    let root = miao_engine::placement::storage_root().unwrap_or_else(std::env::temp_dir);
    miao_engine::placement::database_for(&root, workspace)
        .unwrap_or_else(|| root.join("unnamed.db"))
}

/// The product database the host projects into. The three-step rule matches the
/// one the engine already applies to stored credentials, so a report that names
/// this file points at the file the product actually writes.
fn product_db() -> Option<PathBuf> {
    product_db_with(|name| std::env::var(name).ok())
}

/// The same resolution against a caller-supplied environment, so a launch built
/// for one machine reads that machine's store rather than the process's.
fn product_db_with(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let root = env("MIAO_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env("XDG_DATA_HOME").map(|dir| PathBuf::from(dir).join("miao")))
        .or_else(|| env("HOME").map(|home| PathBuf::from(home).join(".local/share/miao")))?;
    Some(root.join("miao.db"))
}

/// The store `miao auth` reads and writes. An explicit
/// `MIAO_ENGINE_CREDENTIAL_DB` wins, because a host that spawns the engine hands
/// its own store over that way; without one the product store is the same file
/// the engine falls back to when no host passes a source, so a credential
/// written here is the one a single-binary start reads.
fn credential_db_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("MIAO_ENGINE_CREDENTIAL_DB") {
        return Ok(PathBuf::from(path));
    }
    product_db().ok_or_else(|| {
        "no credential store: set MIAO_ENGINE_CREDENTIAL_DB, or MIAO_DATA_HOME/XDG_DATA_HOME/HOME"
            .to_string()
    })
}

/// One XDG-scoped directory: the explicit `MIAO_*` variable wins, then the
/// XDG base, then the home-relative default. Uninstall and the db reports
/// share this so a removal target and a reporting target can never disagree.
fn xdg_dir(
    explicit: Option<&str>,
    xdg: &str,
    xdg_sub: &str,
    home_default: &str,
) -> Option<PathBuf> {
    explicit
        .and_then(|name| std::env::var_os(name).map(PathBuf::from))
        .or_else(|| std::env::var_os(xdg).map(|dir| PathBuf::from(dir).join(xdg_sub)))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(home_default)))
}

/// The directories an uninstall removes, in removal order. The engine ledger
/// storage is part of the data group: it is the single largest residue a
/// single-binary install leaves, and the TS uninstall never knew about it.
fn uninstall_targets(keep_config: bool, keep_data: bool) -> Vec<(&'static str, PathBuf, bool)> {
    let mut targets = Vec::new();
    if let Some(dir) = xdg_dir(
        Some("MIAO_DATA_HOME"),
        "XDG_DATA_HOME",
        "miao",
        ".local/share/miao",
    ) {
        targets.push(("data", dir, keep_data));
    }
    if let Some(root) = miao_engine::placement::storage_root() {
        targets.push(("engine storage", root, keep_data));
    }
    if let Some(dir) = xdg_dir(None, "XDG_CACHE_HOME", "miao", ".cache/miao") {
        targets.push(("cache", dir, false));
    }
    if let Some(dir) = product_config_dir(None) {
        targets.push(("config", dir, keep_config));
    }
    if let Some(dir) = xdg_dir(None, "XDG_STATE_HOME", "miao", ".local/state/miao") {
        targets.push(("state", dir, false));
    }
    targets
}

/// Bytes of a directory tree, or zero when it does not exist. Uninstall shows
/// the size before removing, so the operator sees what a `--apply` reclaims.
fn tree_bytes(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                total += tree_bytes(&entry.path());
            } else {
                total += metadata.len();
            }
        }
    }
    total
}

/// Remove every install artifact the single binary owns. A dry run is the
/// default and lists each target with its size; `--apply` removes. The shell
/// rc lines and the running binary itself are reported, not touched — editing
/// a user's rc by string match risks eating unrelated lines, and deleting the
/// file this process runs from is the operator's call.
fn uninstall(rest: &[String]) -> Result<(), String> {
    let apply = rest.iter().any(|argument| argument == "--apply");
    let keep_config = rest.iter().any(|argument| argument == "--keep-config");
    let keep_data = rest.iter().any(|argument| argument == "--keep-data");
    let targets = uninstall_targets(keep_config, keep_data);
    let mut failures = Vec::new();
    println!(
        "uninstall · {}",
        if apply {
            "removing"
        } else {
            "dry run (pass --apply to remove)"
        }
    );
    for (label, path, keep) in &targets {
        if !path.exists() {
            println!("  ○ {label} · {} · absent", path.display());
            continue;
        }
        if *keep {
            println!(
                "  ○ {label} · {} · keeping ({})",
                path.display(),
                human_bytes(tree_bytes(path))
            );
            continue;
        }
        println!(
            "  ✓ {label} · {} · {}",
            path.display(),
            human_bytes(tree_bytes(path))
        );
        if apply {
            if let Err(error) = std::fs::remove_dir_all(path) {
                failures.push(format!("{label}: {error}"));
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        println!(
            "  · binary {} — remove by hand once no session is running",
            exe.display()
        );
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rc in [".zshrc", ".bashrc", ".profile"] {
            let path = home.join(rc);
            if path.is_file() {
                println!(
                    "  · {} may hold a PATH line for ~/.miao/bin — check by hand",
                    path.display()
                );
            }
        }
    }
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(())
}

/// The documented exit convention: 0 success, 1 operational failure, 2 usage
/// error. Commands that build their usage line into the error message carry
/// the distinction in that prefix; this maps it to the code the docs promise.
fn exit_for(message: &str) -> std::process::ExitCode {
    if message.starts_with("usage:") {
        std::process::ExitCode::from(2)
    } else {
        std::process::ExitCode::from(1)
    }
}

/// Hand the derived routes to the TUI through the variables its own argument
/// builder already reads. Without this the default entry point has no model
/// catalogue and cannot resolve a credential.
fn prepare_tui_engine(launch: &mut miao_tui::Launch) {
    if std::env::var_os("MIAO_ENGINE_MODEL_ROUTES_CONFIG").is_some() {
        return;
    }
    let model = launch
        .model
        .clone()
        .or_else(|| configured_model(launch.config_dir.as_deref()))
        .unwrap_or_default();
    // A TUI started without --config-dir still needs the product's providers:
    // read the same layered stack the engine start will forward.
    let layers = config_layers(&launch.workspace, launch.config_dir.as_deref(), &|name| {
        std::env::var(name).ok()
    });
    let Ok(mut routes) = model_routes(&layers, &model) else {
        return;
    };
    settle_primary(&mut routes, &model);
    let Some(primary) = routes.iter().find(|route| route["primary"] == true) else {
        return;
    };
    // The engine builds its base provider from --model and then requires the
    // primary route to carry the same identity (protocol + model), while a
    // route id is provider-qualified. Hand it the bare model name whatever the
    // operator wrote, so a qualified id resolves back to its route's model and
    // a placeholder resolves to the default's.
    if let Some(name) = primary["model"].as_str() {
        if std::env::var_os("MIAO_TUI_MODEL").is_none() {
            std::env::set_var("MIAO_TUI_MODEL", name);
        }
        if launch.model.is_some() {
            launch.model = Some(name.to_string());
        }
    }
    for (key, variable) in [
        ("provider", "MIAO_ENGINE_PROVIDER"),
        ("endpoint", "MIAO_ENGINE_ENDPOINT"),
    ] {
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
    // The TUI passes no agent manifest, so the engine keeps its `ask` default
    // and every tool call blocks on an approval the UI then has to surface.
    // Hand over the same auto-settling manifest `run` uses. The instructions
    // stay a global-directory concern: AGENTS.md rides the global layer.
    if std::env::var_os("MIAO_ENGINE_AGENT_CONFIG").is_none() {
        let global = launch.config_dir.clone().or_else(|| {
            std::env::var_os("MIAO_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(|home| PathBuf::from(home).join(".config").join("miao"))
                })
        });
        let instructions =
            assemble_instructions(&launch.workspace, global.as_deref()).unwrap_or_default();
        let manifest = serde_json::json!({
            "name": "miao",
            "instructions": instructions,
            "permission_mode": "auto",
        });
        let path = std::env::temp_dir().join(format!("miao-tui-agent-{}.json", std::process::id()));
        if std::fs::write(&path, manifest.to_string()).is_ok() {
            std::env::set_var("MIAO_ENGINE_AGENT_CONFIG", path);
        }
    }
    if let Some(path) = write_routes_manifest("miao-tui-routes", &routes) {
        std::env::set_var("MIAO_ENGINE_MODEL_ROUTES_CONFIG", path);
    }
    // The TUI rewrites this manifest when a key is stored or replaced, and a
    // rewrite has to read the same configuration this launch did: the plan is
    // the layers in order, including the project and inline documents a bare
    // directory name would lose.
    let plan = config_sources(&layers)
        .iter()
        .filter_map(|source| match source {
            miao_engine::config_derive::Source::Dir(dir) => {
                Some(serde_json::json!({ "dir": dir.display().to_string() }))
            }
            miao_engine::config_derive::Source::File(file) => {
                Some(serde_json::json!({ "file": file.display().to_string() }))
            }
            miao_engine::config_derive::Source::Content(content) => {
                Some(serde_json::json!({ "content": content }))
            }
        })
        .collect::<Vec<_>>();
    if let Ok(encoded) = serde_json::to_string(&plan) {
        std::env::set_var("MIAO_TUI_CONFIG_SOURCES", encoded);
    }
}

/// Write the derived routes where the engine reads them and answer the path.
///
/// The engine takes a path and reads the file itself, so the 64 KiB ceiling
/// that governs a value passed through the environment does not apply here.
/// Applying it kept whole launches without a manifest once their route list
/// grew past it, and a key stored afterwards had nothing to append its routes
/// to: the provider only appeared after restarting miao, which re-derived the
/// list from scratch.
fn write_routes_manifest(name: &str, routes: &[serde_json::Value]) -> Option<std::path::PathBuf> {
    let encoded = serde_json::to_string(routes).ok()?;
    let path = std::env::temp_dir().join(format!("{name}-{}.json", std::process::id()));
    std::fs::write(&path, encoded).ok()?;
    Some(path)
}

/// Settle the one default route. A model the operator named wins, wherever its
/// route came from; otherwise the configuration's own primary stands, and a
/// launch whose configuration names no provider falls back to the first route a
/// stored key supplied. The engine accepts exactly one default.
fn settle_primary(routes: &mut [serde_json::Value], requested: &str) {
    let named = routes.iter().position(|route| {
        !requested.is_empty()
            && (route["id"].as_str() == Some(requested)
                || route["model"].as_str() == Some(requested))
    });
    if let Some(index) = named {
        for route in routes.iter_mut() {
            route["primary"] = serde_json::json!(false);
        }
        routes[index]["primary"] = serde_json::json!(true);
        return;
    }
    if routes.iter().any(|route| route["primary"] == true) {
        return;
    }
    if let Some(route) = routes.first_mut() {
        route["primary"] = serde_json::json!(true);
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
    let Some(dir) = config_dir else {
        return Ok(None);
    };
    for file in ["miao.jsonc", "miao.json"] {
        let path = dir.join(file);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let parsed: serde_json::Value = serde_json::from_str(&strip_comments(&text))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let Some(entry) = parsed.get("agent").and_then(|value| value.get(name)) else {
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
        if let Some(mode) = entry
            .get("permission_mode")
            .and_then(|value| value.as_str())
        {
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
fn model_routes(layers: &[PathBuf], requested: &str) -> Result<Vec<serde_json::Value>, String> {
    model_routes_with(layers, requested, credential_db_path().ok().as_deref())
}

/// The same derivation against an explicit store, so a caller that knows which
/// store a launch will use does not have to re-resolve it, and a test can hand
/// over a fixture instead of the operator's own keys.
fn model_routes_with(
    layers: &[PathBuf],
    requested: &str,
    credential_db: Option<&std::path::Path>,
) -> Result<Vec<serde_json::Value>, String> {
    // One derivation, in the engine: it already models a provider with several
    // stored keys as several routes (`provider/model@label`) and carries the
    // `account` metadata the TUI's account list is built from. A second copy
    // here read only the `default` label, so every extra account was invisible
    // and no key action could name it.
    let routes = miao_engine::native_routes::routes(&config_sources(layers), credential_db)?;
    let mut routes = routes.unwrap_or_default();
    let requested = match requested.is_empty() {
        true => merged_config(layers)
            .and_then(|parsed| {
                parsed
                    .get("model")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default(),
        false => requested.to_string(),
    };
    settle_primary(&mut routes, &requested);
    Ok(routes)
}

/// Map the product's `lsp` section onto the engine's `lsp::Config` array: the
/// engine discovers servers from this manifest, so without it the `lsp_*` tools
/// have nothing to talk to.
fn lsp_servers(layers: &[PathBuf]) -> Result<Vec<serde_json::Value>, String> {
    let Some(parsed) = merged_config(layers) else {
        return Ok(Vec::new());
    };
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
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let mut server =
            serde_json::json!({ "name": name, "argv": argv, "extensions": extensions });
        if let Some(env) = entry.get("env").or_else(|| entry.get("environment")) {
            server["env"] = env.clone();
        }
        servers.push(server);
    }
    Ok(servers)
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
    let workspace =
        workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
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
            println!(
                "config    {}",
                config
                    .as_ref()
                    .map(|dir| dir.display().to_string())
                    .unwrap_or_else(|| "unset".into())
            );
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            println!("workspace {}", workspace.display());
            Ok(())
        }
        Some("routes") => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let layers = config_layers(&workspace, None, &|name| std::env::var(name).ok());
            let routes = model_routes(&layers, "")?;
            if routes.is_empty() {
                println!("no model routes configured");
            } else {
                println!("{}", serde_json::to_string(&routes).unwrap_or_default());
            }
            Ok(())
        }
        Some("lsp") => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let layers = config_layers(&workspace, None, &|name| std::env::var(name).ok());
            let servers = lsp_servers(&layers)?;
            if servers.is_empty() {
                println!("no LSP servers configured");
            } else {
                println!("{}", serde_json::to_string(&servers).unwrap_or_default());
            }
            Ok(())
        }
        Some("mcp") => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let layers = config_layers(&workspace, None, &|name| std::env::var(name).ok());
            let servers = mcp_servers(&layers)?;
            if servers.is_empty() {
                println!("no MCP servers configured");
            } else {
                println!("{}", serde_json::to_string(&servers).unwrap_or_default());
            }
            Ok(())
        }
        Some("info") => {
            println!("miao      {VERSION}");
            println!(
                "engine    protocol {} schema {}",
                miao_engine::PROTOCOL,
                miao_engine::store::SCHEMA_VERSION
            );
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            println!("database  {}", default_db(&workspace).display());
            println!(
                "config    {}",
                config
                    .as_ref()
                    .map(|dir| dir.display().to_string())
                    .unwrap_or_else(|| "unset".into())
            );
            let plugins = plugin_entries(config.as_deref()).unwrap_or_default();
            println!("plugins   {} configured", plugins.len());
            Ok(())
        }
        Some("config") => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let layers = config_layers(&workspace, None, &|name| std::env::var(name).ok());
            let report = miao_engine::config_explain::report(&config_sources(&layers))?;
            for source in report["sources"].as_array().into_iter().flatten() {
                println!("config   {}", source["origin"].as_str().unwrap_or_default());
            }
            for key in report["keys"].as_array().into_iter().flatten() {
                let path = key["path"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.as_str())
                    .collect::<Vec<_>>()
                    .join(".");
                println!(
                    "{path} = {}  ({})",
                    key["value"],
                    key["origin"].as_str().unwrap_or_default()
                );
            }
            let warnings = report["warnings"].as_array().cloned().unwrap_or_default();
            if warnings.is_empty() {
                println!("keys     every top-level key is known");
            }
            for warning in warnings {
                println!(
                    "warning  unknown top-level key `{}` in {}{}",
                    warning["key"].as_str().unwrap_or_default(),
                    warning["origin"].as_str().unwrap_or_default(),
                    warning["hint"]
                        .as_str()
                        .map(|hint| format!("; did you mean `{hint}`?"))
                        .unwrap_or_default()
                );
            }
            Ok(())
        }
        _ => Err("usage: miao debug paths | miao debug info | miao debug config".into()),
    }
}

/// The ordered document set the engine reads, built from the same layers the
/// launcher forwards, so the diagnostic names the files that actually
/// configure the product rather than a guess at them.
fn config_sources(layers: &[PathBuf]) -> Vec<miao_engine::config_derive::Source> {
    let mut sources: Vec<miao_engine::config_derive::Source> = layers
        .iter()
        .map(|layer| {
            if layer.is_dir() {
                miao_engine::config_derive::Source::Dir(layer.clone())
            } else {
                miao_engine::config_derive::Source::File(layer.clone())
            }
        })
        .collect();
    if let Some(file) = std::env::var_os("MIAO_CONFIG") {
        sources.push(miao_engine::config_derive::Source::File(PathBuf::from(
            file,
        )));
    }
    if let Some(content) = std::env::var_os("MIAO_CONFIG_CONTENT") {
        sources.push(miao_engine::config_derive::Source::Content(
            content.to_string_lossy().into_owned(),
        ));
    }
    sources
}

/// The command words this binary understands, in one place so the usage text
/// and the completion script cannot drift apart.
const COMMANDS: &[&str] = &[
    "tui",
    "run",
    "serve",
    "session",
    "models",
    "auth",
    "plugins",
    "export",
    "stats",
    "doctor",
    "providers",
    "memory",
    "db",
    "completion",
];

/// Print a completion script for the given shell.
fn completion(rest: &[String]) -> Result<(), String> {
    let shell = rest.first().map(String::as_str).unwrap_or("bash");
    let words = COMMANDS.join(" ");
    match shell {
        "bash" => println!("complete -W \"{words}\" miao"),
        "zsh" => println!("#compdef miao\n_miao() {{ compadd {words} }}\ncompdef _miao miao"),
        other => return Err(format!("unsupported shell {other}; use bash or zsh")),
    }
    Ok(())
}

/// Print the database paths this directory resolves to, so scripts do not have
/// to re-implement the default. The first line stays a bare engine-ledger path
/// for the scripts that already read it; the product database follows labelled,
/// because a maintenance command that reports only one of the two files invites
/// auditing an empty database.
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
    match db {
        Some(path) => println!("{}", path.display()),
        None => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            println!("{}", default_db(&workspace).display());
            match product_db() {
                Some(path) if path.is_file() => println!("product · {}", path.display()),
                Some(path) => println!("product · {} (absent)", path.display()),
                None => println!("product · none"),
            }
        }
    }
    Ok(())
}

/// The database a maintenance command is aimed at: `--db` if it was given, the
/// same default `db path` prints otherwise.
fn db_argument(rest: &[String]) -> Result<PathBuf, String> {
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
    Ok(db.unwrap_or_else(|| default_db(&workspace)))
}

/// A read-only connection: a report must not be able to change the file, so the
/// command cannot write even by mistake.
fn db_read_only(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    if !path.exists() {
        return Err(format!("no database at {}", path.display()));
    }
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
}

/// The three files a live database occupies: the main file, the write-ahead log
/// and the shared-memory index. Each is absent until SQLite creates it, and an
/// absent one counts as zero.
fn db_file_bytes(path: &std::path::Path) -> (u64, u64, u64) {
    let size = |candidate: String| {
        std::fs::metadata(candidate)
            .map(|meta| meta.len())
            .unwrap_or(0)
    };
    let base = path.display().to_string();
    (
        size(base.clone()),
        size(format!("{base}-wal")),
        size(format!("{base}-shm")),
    )
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    match unit {
        0 => format!("{bytes} B"),
        _ => format!("{value:.1} {}", UNITS[unit]),
    }
}

/// What a maintenance command reports before it does anything: the file it is
/// aimed at, how much the pages take, what is already free, and what the tables
/// hold. Reported rather than acted on, so the operator can see the target and
/// the impact first — the rule DATA-03 asks for.
fn db_report(
    connection: &rusqlite::Connection,
    path: &std::path::Path,
) -> rusqlite::Result<Vec<String>> {
    let (main, wal, shm) = db_file_bytes(path);
    let bytes = main + wal + shm;
    let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let free: i64 = connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    let mut lines = vec![
        format!("database · {}", path.display()),
        // A WAL database keeps recent commits in `-wal` and the shared index in
        // `-shm`, so the main file alone understates what the database occupies.
        format!("file · {bytes} bytes ({})", human_bytes(bytes)),
        format!("pages · {page_count} × {page_size} bytes"),
        format!(
            "reclaimable · {} free pages ({} bytes)",
            free,
            human_bytes((free * page_size).max(0) as u64)
        ),
    ];
    let tables = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if wal > 0 || shm > 0 {
        lines.push(format!("sidecars · wal {wal} bytes · shm {shm} bytes"));
    }
    for table in tables {
        // Names come from the schema, not from the operator, and are quoted so a
        // name with a space still counts instead of failing the report.
        let count: i64 = connection.query_row(
            &format!("SELECT count(*) FROM \"{}\"", table.replace('"', "\"\"")),
            [],
            |row| row.get(0),
        )?;
        lines.push(format!("table · {table} · {count} rows"));
    }
    Ok(lines)
}

fn db_stats(rest: &[String]) -> Result<(), String> {
    let path = db_argument(rest)?;
    let connection = db_read_only(&path)?;
    for line in db_report(&connection, &path).map_err(|error| error.to_string())? {
        println!("{line}");
    }
    Ok(())
}

/// Reclaim the free pages, but only when the operator asked for it in words:
/// a dry run reports the same view and states that nothing was written.
fn db_vacuum(rest: &[String]) -> Result<(), String> {
    let path = db_argument(rest)?;
    let apply = rest.iter().any(|argument| argument == "--apply");
    let connection = db_read_only(&path)?;
    for line in db_report(&connection, &path).map_err(|error| error.to_string())? {
        println!("{line}");
    }
    drop(connection);
    if !apply {
        println!(
            "dry run · nothing was written; pass --apply to vacuum {}",
            path.display()
        );
        return Ok(());
    }
    let connection = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("VACUUM")
        .map_err(|error| error.to_string())?;
    let (main, wal, shm) = db_file_bytes(&path);
    println!(
        "vacuumed · {} · now {}",
        path.display(),
        human_bytes(main + wal + shm)
    );
    Ok(())
}

fn db_bundle(rest: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut session: Option<String> = None;
    let mut after = 0u64;
    let mut out: Option<PathBuf> = None;
    let mut index = 0;
    while index < rest.len() {
        match rest[index].as_str() {
            "--db" => {
                db = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--session" => {
                session = rest.get(index + 1).cloned();
                index += 2;
            }
            "--after" => {
                after = rest
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .ok_or("--after needs a cursor number")?;
                index += 2;
            }
            "--out" => {
                out = rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            _ => index += 1,
        }
    }
    let session = session.ok_or("db bundle needs --session ID")?;
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = db.unwrap_or_else(|| default_db(&workspace));
    let mut bundle = miao_engine::export::diagnostic_bundle(&path, &session, after)
        .map_err(|error| error.to_string())?;
    bundle["generated_by"] = serde_json::json!(VERSION);
    let rendered = serde_json::to_string_pretty(&bundle).map_err(|error| error.to_string())?;
    let written = match out {
        Some(path) => {
            std::fs::write(&path, format!("{rendered}\n")).map_err(|error| error.to_string())?;
            format!(" · written to {}", path.display())
        }
        None => {
            println!("{rendered}");
            String::new()
        }
    };
    println!(
        "bundle · {} events · {} redactions · through cursor {} · protocol {} schema {}{}",
        bundle["event_count"].as_u64().unwrap_or(0),
        bundle["redactions"].as_u64().unwrap_or(0),
        bundle["through"].as_u64().unwrap_or(0),
        bundle["protocol"],
        bundle["schema"],
        written,
    );
    Ok(())
}

/// The ledger `serve` and `web` run on when no `--db` was given.
///
/// A process-enabled runtime refuses a ledger inside its own workspace
/// (`runtime.rs`), so the default cannot sit beside the workspace: it did, and
/// the first run of `miao serve` failed with "requires its database outside the
/// workspace". The default is the Location-scoped ledger the rest of the product
/// uses, which is the path `miao db path` prints.
fn serve_database(db: Option<PathBuf>, workspace: &std::path::Path) -> PathBuf {
    db.unwrap_or_else(|| default_db(workspace))
}

/// Copy the ledger and its blobs into a backup that has been read back.
///
/// `VACUUM INTO` writes a consistent snapshot in one statement, so a live
/// write-ahead database is copied without stopping the engine that owns it. The
/// copy is then opened read-only and put through `PRAGMA integrity_check`: a
/// copy that does not read back is not a backup, so the command fails instead of
/// reporting one. An existing target is refused rather than replaced, because
/// this is the copy an upgrade falls back to (DATA-01).
fn db_backup(rest: &[String]) -> Result<(), String> {
    let path = db_argument(rest)?;
    if !path.exists() {
        return Err(format!("no database at {}", path.display()));
    }
    let target = match rest.iter().position(|argument| argument == "--to") {
        Some(index) => {
            std::path::PathBuf::from(rest.get(index + 1).ok_or("--to needs a value")?.to_string())
        }
        None => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0);
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("engine");
            path.with_file_name(format!("backups/{stem}-{stamp}.db"))
        }
    };
    if target.exists() {
        return Err(format!(
            "{} already exists; a backup never replaces one",
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    // The engine that owns the ledger may hold the write lock; a backup waits
    // for it instead of failing the operator's attempt.
    connection
        .busy_timeout(std::time::Duration::from_secs(30))
        .map_err(|error| error.to_string())?;
    let destination = target
        .to_str()
        .ok_or_else(|| format!("{} is not a valid path", target.display()))?
        .to_string();
    connection
        .execute("VACUUM INTO ?1", [destination])
        .map_err(|error| format!("copy {}: {error}", path.display()))?;
    drop(connection);

    let copy =
        rusqlite::Connection::open_with_flags(&target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("read back {}: {error}", target.display()))?;
    let integrity: String = copy
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!(
            "the copy at {} failed integrity_check: {integrity}",
            target.display()
        ));
    }
    let version: u32 = copy
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    drop(copy);

    let blobs = copy_blobs(
        &miao_engine::blob::root_for(&path),
        &miao_engine::blob::root_for(&target),
    )?;
    let bytes = std::fs::metadata(&target)
        .map(|meta| meta.len())
        .unwrap_or(0);
    println!("backup · {}", target.display());
    println!("database · {} · schema {version}", human_bytes(bytes));
    println!("verified · integrity_check ok");
    println!("blobs · {blobs} files");
    Ok(())
}

/// Copy the content-addressed blob tree beside the ledger. Digests are the file
/// names, so a destination that already holds a digest holds the same bytes and
/// does not need rewriting.
fn copy_blobs(from: &std::path::Path, to: &std::path::Path) -> Result<usize, String> {
    if !from.is_dir() {
        return Ok(0);
    }
    let mut copied = 0;
    let mut pending = vec![from.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let source = entry.map_err(|error| error.to_string())?.path();
            let relative = source
                .strip_prefix(from)
                .map_err(|error| error.to_string())?;
            let destination = to.join(relative);
            if source.is_dir() {
                std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
                pending.push(source);
                continue;
            }
            if destination.exists() {
                continue;
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::copy(&source, &destination).map_err(|error| error.to_string())?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Reclaim blob files no surviving row references, but only when the operator
/// asked for it in words: a dry run counts the orphans and states that nothing
/// was written. The live set is read through one read-only snapshot, so the
/// scan and the directory walk agree on what survives (DATA-04).
fn db_blob_gc(rest: &[String]) -> Result<(), String> {
    let path = db_argument(rest)?;
    let apply = rest.iter().any(|argument| argument == "--apply");
    let connection = db_read_only(&path)?;
    let mut live = std::collections::HashSet::new();
    let scans = [
        "SELECT data FROM engine_event WHERE data LIKE '%\"blob\"%'",
        "SELECT content FROM engine_message WHERE content LIKE '%\"blob\"%'",
        "SELECT input FROM engine_tool WHERE input LIKE '%\"blob\"%'",
        "SELECT prompt FROM engine_input WHERE prompt LIKE '%\"blob\"%'",
        "SELECT summary FROM engine_compaction WHERE summary LIKE '%\"blob\"%'",
    ];
    for sql in scans {
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let text: String = row.get(0).map_err(|error| error.to_string())?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            let mut found = Vec::new();
            miao_engine::blob::references(&value, &mut found);
            live.extend(found);
        }
    }
    let root = miao_engine::blob::root_for(&path);
    let report = miao_engine::blob::gc(&root, live, apply);
    let (main, wal, shm) = db_file_bytes(&path);
    println!(
        "ledger {} · blobs {} kept · {} orphans {} ({} reclaimed) · {} staging writes removed · {} failures · ledger now {}",
        path.display(),
        report.kept,
        report.removed_orphans,
        if apply { "removed" } else { "found (dry run; pass --apply)" },
        human_bytes(report.reclaimed_bytes),
        report.removed_tmp,
        report.failed,
        human_bytes(main + wal + shm),
    );
    Ok(())
}

/// Report what a snapshot-then-truncate retention could drop, without dropping
/// it. Events at or before each session's latest compaction baseline are the
/// candidates: their content already lives in the compacted summary, so the
/// copies in the event log are the growth a later truncation would reclaim.
///
/// The command deliberately has no `--apply`: the event log is still read in
/// full by cursors that assume history stays present, and deleting from it
/// safely needs a snapshot export plus a per-kind audit of every reader before
/// a single row may go. Reporting first is the DATA-03 rule — show the target
/// and the impact, and let the operator decide with numbers in hand.
fn db_retention(rest: &[String]) -> Result<(), String> {
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
    let mut reported = false;
    let targets = match db {
        Some(path) => vec![path],
        None => {
            let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let mut found = vec![default_db(&workspace)];
            if let Some(path) = product_db() {
                if path.is_file() && !found.contains(&path) {
                    found.push(path);
                }
            }
            found
        }
    };
    for path in targets {
        if !path.exists() {
            println!("database · {} · absent", path.display());
            continue;
        }
        let connection = db_read_only(&path)?;
        println!(
            "database · {} · {}",
            path.display(),
            if is_engine_ledger(&connection) {
                "engine ledger"
            } else {
                "product database"
            }
        );
        for line in retention_plan(&connection).map_err(|error| error.to_string())? {
            println!("{line}");
        }
        reported = true;
    }
    if reported {
        println!("report-only · nothing was deleted; retention truncation is not enabled");
    }
    Ok(())
}

/// An engine ledger announces its tables; the product database uses different
/// names. The retention SQL differs per family, so the family decides which
/// query runs rather than guessing from the file name.
fn is_engine_ledger(connection: &rusqlite::Connection) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_event')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false)
}

/// One prunable-size line for whichever database family the connection holds.
fn retention_plan(connection: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    if is_engine_ledger(connection) {
        // The compaction baseline is per session: everything at or before the
        // latest `through_seq` is already summarised in the projection.
        let mut statement = connection.prepare(
            "SELECT COUNT(DISTINCT e.session_id), COUNT(*), COALESCE(SUM(LENGTH(e.data)), 0) \
             FROM engine_event e \
             WHERE e.seq <= (SELECT COALESCE(MAX(c.through_seq), -1) \
                             FROM engine_compaction c WHERE c.session_id = e.session_id)",
        )?;
        let (sessions, events, bytes): (i64, i64, i64) =
            statement.query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        return Ok(vec![format!(
            "retention plan · {events} event(s) across {sessions} session(s) · {} prunable",
            human_bytes(bytes.max(0) as u64)
        )]);
    }
    let projected = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event') \
             AND EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !projected {
        return Ok(vec![
            "retention plan · neither engine nor product tables found".into(),
        ]);
    }
    // The product projection keeps the same shape: events strictly before the
    // session's newest compaction message are represented by it.
    let mut statement = connection.prepare(
        "SELECT COUNT(DISTINCT e.aggregate_id), COUNT(*), COALESCE(SUM(LENGTH(e.data)), 0) \
         FROM event e \
         WHERE e.seq < (SELECT MAX(m.seq) FROM session_message m \
                        WHERE m.session_id = e.aggregate_id AND m.type = 'compaction')",
    )?;
    let (sessions, events, bytes): (i64, i64, i64) =
        statement.query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(vec![format!(
        "retention plan · {events} event(s) across {sessions} session(s) · {} prunable",
        human_bytes(bytes.max(0) as u64)
    )])
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
    match credential_db_path() {
        Ok(path) if path.is_file() => {
            let entries = miao_engine::credential::list_database(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            println!("credentials {}", entries.len());
            for entry in entries.iter().take(5) {
                println!("  {:<20} {:<4} {}", entry.integration, entry.kind, entry.id);
            }
            if entries.len() > 5 {
                println!("  … {} more", entries.len() - 5);
            }
        }
        Ok(path) => println!("credentials 0 (nothing stored at {})", path.display()),
        Err(message) => println!("credentials unknown ({message})"),
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
    let workspace =
        workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let store = workspace.join(".miao").join("knowledge.json");
    if !store.is_file() {
        println!("memory    none ({})", store.display());
        return Ok(());
    }
    let text =
        std::fs::read_to_string(&store).map_err(|error| format!("{}: {error}", store.display()))?;
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
            let title = note
                .get("title")
                .and_then(|title| title.as_str())
                .unwrap_or("");
            let kind = note
                .get("kind")
                .and_then(|kind| kind.as_str())
                .unwrap_or("");
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
    println!("miao      {VERSION}");
    println!(
        "engine    protocol {} schema {}",
        miao_engine::PROTOCOL,
        miao_engine::store::SCHEMA_VERSION
    );
    println!("database  {}", db.display());
    // The database appears the first time a session runs. A fresh install has
    // none, and a doctor that failed there would report a broken machine before
    // the product has done anything; any other read error is a real fault.
    let created = match std::fs::metadata(&db) {
        Ok(metadata) => {
            println!("size      {} bytes", metadata.len());
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!("database  not created yet");
            false
        }
        Err(error) => {
            println!("database  unreadable: {error}");
            return Err("the database cannot be opened".into());
        }
    };
    if created {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let sessions = runtime.block_on(async {
            let store = miao_engine::store::Store::open(&db)
                .await
                .map_err(|error| format!("cannot open the store: {error}"))?;
            store
                .sessions()
                .await
                .map_err(|error| format!("cannot list sessions: {error}"))
        })?;
        println!("sessions  {}", sessions.len());
    } else {
        println!("sessions  0");
    }
    let config_dir = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        });
    match config_dir.as_ref() {
        Some(dir) if dir.is_dir() => println!("config    {}", dir.display()),
        Some(dir) => println!("config    missing: {}", dir.display()),
        None => println!("config    MIAO_CONFIG_DIR is unset"),
    }
    let plugins = plugin_entries(config_dir.as_deref()).unwrap_or_default();
    println!("plugins   {} configured", plugins.len());
    let layers = config_layers(&workspace, None, &|name| std::env::var(name).ok());
    // A doctor that names only the engine cannot answer "which model will this
    // machine use", and routing is the first thing a user asks about.
    let routes = model_routes(&layers, "").unwrap_or_default();
    let primary = routes
        .iter()
        .find(|route| route["primary"] == true)
        .and_then(|route| route["id"].as_str());
    println!(
        "routes    {} configured, {}",
        routes.len(),
        primary
            .map(|id| format!("primary {id}"))
            .unwrap_or_else(|| "no primary route".into())
    );
    // The mode that is in effect, not the mode the platform could support: a
    // machine can have the feature and the user has turned it off.
    let documents = miao_engine::config_derive::load(&config_sources(&layers)).unwrap_or_default();
    println!(
        "sandbox   {}",
        if miao_engine::config_derive::sandbox_enabled(&documents, None) {
            "enabled"
        } else {
            "disabled"
        }
    );
    // Programs the product shells out to. Missing ones degrade a feature, so a
    // support report has to show which, not only that something is missing.
    println!(
        "deps      {}",
        ["git", "pdftotext", "pdftoppm"]
            .iter()
            .map(|name| format!("{name} {}", if on_path(name) { "ok" } else { "missing" }))
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(())
}

fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| {
        directory.join(name).is_file() || directory.join(format!("{name}.exe")).is_file()
    })
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
        let store = miao_engine::store::Store::open(&db)
            .await
            .map_err(|error| error.to_string())?;
        store.sessions().await.map_err(|error| error.to_string())
    })?;
    let (mut input, mut output, mut cache_read, mut non_cached, mut turns) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
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
        Some(one) => sessions
            .into_iter()
            .filter(|session| session == one)
            .collect(),
        None => sessions,
    };
    for session in &sessions {
        let mut buffer: Vec<u8> = Vec::new();
        miao_engine::export::committed_events(&db, session, 0, &mut buffer)
            .map_err(|error| error.to_string())?;
        for line in String::from_utf8_lossy(&buffer).lines() {
            let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
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
    let hit = miao_engine::usage::hit_ratio(input, cache_read).unwrap_or(0.0);
    // TTFT comes from the engine's own timing side table, which the TUI panel
    // also reads: one source, so a panel and this command cannot disagree.
    let mut ttfts: Vec<i64> = Vec::new();
    if let Ok(connection) = rusqlite::Connection::open(&db) {
        // Same scope as the token totals: a single-session view must not mix
        // its TTFT with other sessions.
        let query = match &only {
            Some(_) => {
                "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL AND session_id=?1"
            }
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
            Some(_) => {
                "SELECT ttft_ms FROM engine_timing WHERE ttft_ms IS NOT NULL AND session_id=?1"
            }
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
    println!(
        "cache     {cache_read} read / {non_cached} fresh ({:.1}% hit)",
        hit * 100.0
    );
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
    let cursor =
        miao_engine::export::committed_events(&db, &session, after, std::io::stdout().lock())
            .map_err(|error| error.to_string())?;
    eprintln!("miao export: {cursor} event(s) written");
    Ok(())
}

/// Report whether this machine would need a sidecar. The spawn itself is not
/// wired yet, so the message says exactly that instead of pretending.
fn list_plugins() -> Result<(), String> {
    let config_dir = std::env::var_os("MIAO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        });
    let entries = plugin_entries(config_dir.as_deref())?;
    if entries.is_empty() {
        println!("no plugins configured — the native binary needs no JavaScript runtime");
        return Ok(());
    }
    for entry in &entries {
        println!("plugin {entry}");
    }
    println!(
        "{} plugin(s) configured — a JavaScript sidecar would be required (not wired yet)",
        entries.len()
    );
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
                port = value(index)
                    .ok_or("--port needs a value")?
                    .parse()
                    .map_err(|_| "--port must be a number")?;
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
    let workspace =
        workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let db = serve_database(db, &workspace);
    let model = model
        .or_else(|| std::env::var("MIAO_ENGINE_MODEL").ok())
        .unwrap_or_else(|| "unavailable/model".into());
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
        let token = std::env::var("MIAO_SERVER_PASSWORD")
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
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
fn assemble_instructions(
    workspace: &std::path::Path,
    config_dir: Option<&std::path::Path>,
) -> Option<String> {
    const LIMIT: usize = 64 * 1024;
    /// The product's own persona, embedded at compile time from the shared
    /// `assets/` copy so the Rust host and the desktop sidecar can never drift
    /// into different personalities.
    const PERSONA: &str = include_str!("../../../assets/persona/default.txt");
    let mut blocks: Vec<String> = vec![PERSONA.trim().to_string()];
    let mut total = 0usize;
    for (label, path) in [
        (
            "Global instructions",
            config_dir.map(|dir| dir.join("AGENTS.md")),
        ),
        ("Project instructions", Some(workspace.join("AGENTS.md"))),
    ] {
        let Some(path) = path else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || total >= LIMIT {
            continue;
        }
        let room = LIMIT - total;
        let block = if text.len() > room {
            &text[..room]
        } else {
            text
        };
        total += block.len();
        blocks.push(format!("## {label} ({})\n{block}", path.display()));
    }
    Some(blocks.join("\n\n"))
}

/// Directories the engine should discover skills in. The engine owns discovery
/// and rendering (bodies load on demand), so the host only names the roots:
/// the product's skill directory and the workspace's own.
fn assemble_skills(
    workspace: &std::path::Path,
    config_dir: Option<&std::path::Path>,
) -> Option<PathBuf> {
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
    std::fs::write(&path, manifest.to_string())
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

/// The engine argv the product hands `miao-engine serve`, built from the same
/// flags and environment variables the TUI uses so both entries agree.
fn engine_argv(
    db: &std::path::Path,
    workspace: &std::path::Path,
    model: &str,
    config_dir: Option<&std::path::Path>,
) -> Vec<String> {
    engine_argv_with(db, workspace, model, config_dir, |name| {
        std::env::var(name).ok()
    })
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
    let layers = config_layers(workspace, config_dir, &env);
    if let Ok(servers) = mcp_servers(&layers) {
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
    match layers.as_slice() {
        // An explicit --config-dir keeps the one-directory shape the operator
        // named. The default stack encodes as a plan: the engine layers the
        // same directories in order, so a project's providers, model and
        // permissions reach the engine they name. The env file and inline
        // document ride above the directories, the same order the product
        // applies them in.
        _ if config_dir.is_some() => {
            if let Some(dir) = config_dir {
                argv.push("--config-dir".into());
                argv.push(dir.display().to_string());
            }
        }
        [] => {}
        [only] if env("MIAO_CONFIG").is_none() && env("MIAO_CONFIG_CONTENT").is_none() => {
            argv.push("--config-dir".into());
            argv.push(only.display().to_string());
        }
        many => {
            let mut plan: Vec<serde_json::Value> = many
                .iter()
                .map(|dir| serde_json::json!({ "dir": dir.display().to_string() }))
                .collect();
            if let Some(file) = env("MIAO_CONFIG") {
                plan.push(serde_json::json!({ "file": file }));
            }
            if let Some(content) = env("MIAO_CONFIG_CONTENT") {
                plan.push(serde_json::json!({ "content": content }));
            }
            if let Ok(encoded) = serde_json::to_string(&plan) {
                argv.push("--config-sources".into());
                argv.push(encoded);
            }
        }
    }
    // The engine compares the primary route's identity against the base
    // provider's, so the base provider must be built from the same route:
    // provider, endpoint and credential all come from the primary entry.
    let mut derived_routes = false;
    if env("MIAO_ENGINE_MODEL_ROUTES_CONFIG").is_none() {
        // The store this launch will read, resolved through the same environment
        // the rest of the argv comes from, so a caller that supplies its own
        // environment gets routes derived against its own store.
        let credential_db = env("MIAO_ENGINE_CREDENTIAL_DB")
            .map(PathBuf::from)
            .or_else(|| product_db_with(&env));
        if let Ok(routes) = model_routes_with(&layers, model, credential_db.as_deref()) {
            if !routes.is_empty() {
                if let Some(primary) = routes.iter().find(|route| route["primary"] == true) {
                    // A placeholder model name matches no route, and the engine
                    // compares the primary route's identity against the base
                    // provider's: name the route's own model instead.
                    // A qualified route id names a route, not a model, but the
                    // engine compares the primary route's identity against the
                    // base provider built from --model: pass the route's bare
                    // model name in either case.
                    let known = routes.iter().any(|route| {
                        route["id"].as_str() == Some(model)
                            || route["model"].as_str() == Some(model)
                    });
                    if !known {
                        if let Some(id) = primary["id"].as_str() {
                            // Say which model a defaulted turn will use: a silent
                            // default here reads as "it hung" when that route is slow.
                            eprintln!("miao: no model chosen; using {id}");
                        }
                    }
                    if let Some(name) = primary["model"].as_str() {
                        if let Some(position) = argv.iter().position(|arg| arg == "--model") {
                            argv[position + 1] = name.to_string();
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
                    if let Some(path) = write_routes_manifest("miao-routes", &routes) {
                        argv.push("--model-routes-config".into());
                        argv.push(path.display().to_string());
                        derived_routes = true;
                    }
                }
            }
        }
    }
    if let Ok(servers) = lsp_servers(&layers) {
        if !servers.is_empty() {
            if let Ok(encoded) = serde_json::to_string(&servers) {
                let path =
                    std::env::temp_dir().join(format!("miao-lsp-{}.json", std::process::id()));
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
        (
            "MIAO_ENGINE_CREDENTIAL_INTEGRATION",
            "--credential-integration",
        ),
        ("MIAO_ENGINE_MODEL_ROUTES_CONFIG", "--model-routes-config"),
    ] {
        // A derived manifest names a credential per route; passing the single
        // credential pair as well makes the engine demand an id it does not need.
        if derived_routes
            && matches!(
                variable,
                "MIAO_ENGINE_CREDENTIAL_DB"
                    | "MIAO_ENGINE_CREDENTIAL_ID"
                    | "MIAO_ENGINE_CREDENTIAL_INTEGRATION"
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
        serde_json::Value::Array(items) => {
            items.iter().for_each(|item| collect_all_texts(item, out))
        }
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
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        id.push(ALPHABET[(seed >> 33) as usize % ALPHABET.len()] as char);
    }
    id
}

/// Store or remove an API-key credential. This is the operator's own login
/// action, so it is the single writer at that moment; the engine keeps reading
/// the same table read-only and never gains write authority.
fn auth_write(rest: &[String]) -> Result<(), String> {
    let db = credential_db_path()?;
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let connection =
        rusqlite::Connection::open(&db).map_err(|error| format!("{}: {error}", db.display()))?;
    // A fresh machine has no credential store yet: the single binary has to be
    // able to bootstrap its first credential through `auth login` alone, or
    // the first login on a new install fails on a chicken-and-egg (the store
    // was previously created only by the host's own database setup).
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS credential(id text primary key, integration_id text, label text, value text, active integer, time_created integer, time_updated integer)",
            [],
        )
        .map_err(|error| error.to_string())?;
    let now = cli_now_ms() as i64;
    match rest.first().map(String::as_str) {
        Some("login") => {
            // rest[0] is the subcommand word itself ("login"); the options and
            // positionals start after it — otherwise `miao auth login fixture
            // sk-key` stores integration "login" with key "fixture".
            let mut args = rest[1..].iter().peekable();
            let mut integration: Option<String> = None;
            let mut key: Option<String> = None;
            let mut account: Option<String> = None;
            let mut oauth = false;
            while let Some(argument) = args.next() {
                match argument.as_str() {
                    "--account" => {
                        account = Some(args.next().ok_or("--account needs a name")?.clone());
                    }
                    "--oauth" => oauth = true,
                    other if other.starts_with('-') => {
                        return Err(format!("unknown auth login option {other}"))
                    }
                    other => {
                        if integration.is_none() {
                            integration = Some(other.to_string());
                        } else if key.is_none() {
                            key = Some(other.to_string());
                        }
                    }
                }
            }
            let Some(integration) = integration else {
                return Err(
                    "usage: miao auth login INTEGRATION KEY [--account NAME] [--oauth]".into(),
                );
            };
            let Some(key) = key else {
                return Err(
                    "usage: miao auth login INTEGRATION KEY [--account NAME] [--oauth]".into(),
                );
            };
            if key.trim().is_empty() {
                return Err("the key must not be empty".into());
            }
            let account = account.filter(|name| !name.trim().is_empty());
            let value = if oauth {
                // The engine's oauth shape: access + required expiry, account
                // under metadata.accountID. Two tokens for one integration
                // with different accounts are two accounts — what per-session
                // pinning pins. A CLI-stored token has no refresh machinery,
                // so the expiry is set far out and the operator re-logs in.
                let far_out = now + 10 * 365 * 24 * 60 * 60 * 1000;
                serde_json::json!({
                    "type": "oauth",
                    "access": key,
                    "refresh": key,
                    "expires": far_out,
                    "metadata": {"accountID": account},
                })
            } else {
                serde_json::json!({ "type": "key", "key": key })
            }
            .to_string();
            // A login replaces the credential that label already holds rather
            // than piling rows up, and keeps its id: the manifest, a route and
            // a Session's account pin all name that id, so a changed secret
            // must not detach them. A named account is a second row beside the
            // default, which is what "another key for the same provider" means.
            let label = account.unwrap_or_else(|| "default".to_string());
            let id: String = match connection
                .query_row(
                    "SELECT id FROM credential WHERE integration_id=?1 AND label=?2 LIMIT 1",
                    rusqlite::params![integration, label],
                    |row| row.get(0),
                )
                .ok()
            {
                Some(id) => {
                    connection
                        .execute(
                            "UPDATE credential SET value=?2, active=1, time_updated=?3 WHERE id=?1",
                            rusqlite::params![id, value, now],
                        )
                        .map_err(|error| error.to_string())?;
                    id
                }
                None => {
                    let id = credential_id();
                    connection
                        .execute(
                            "INSERT INTO credential(id,integration_id,label,value,active,time_created,time_updated) VALUES(?1,?2,?3,?4,1,?5,?5)",
                            rusqlite::params![id, integration, label, value, now],
                        )
                        .map_err(|error| error.to_string())?;
                    id
                }
            };
            println!("stored {integration} {label} credential {id}");
            Ok(())
        }
        Some("logout") => {
            // `--account` names one stored account. Without it the default
            // account is removed, which is what a plain login created; a
            // named account was otherwise unreachable from the CLI and could
            // only be deleted by editing the store.
            let mut account: Option<String> = None;
            let mut integration: Option<String> = None;
            let mut args = rest[1..].iter();
            while let Some(argument) = args.next() {
                match argument.as_str() {
                    "--account" => {
                        account = Some(args.next().ok_or("--account needs a name")?.clone());
                    }
                    other if other.starts_with('-') => {
                        return Err(format!("unknown auth logout option {other}"))
                    }
                    other => {
                        if integration.replace(other.to_string()).is_some() {
                            return Err(
                                "usage: miao auth logout INTEGRATION [--account NAME]".into()
                            );
                        }
                    }
                }
            }
            let Some(integration) = integration else {
                return Err("usage: miao auth logout INTEGRATION [--account NAME]".into());
            };
            let label = account
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "default".to_string());
            let removed = connection
                .execute(
                    "DELETE FROM credential WHERE integration_id=?1 AND label=?2",
                    rusqlite::params![integration, label],
                )
                .map_err(|error| error.to_string())?;
            let remaining: i64 = connection
                .query_row(
                    "SELECT count(*) FROM credential WHERE integration_id=?1",
                    rusqlite::params![integration],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            println!(
                "removed {removed} credential(s) for {integration} ({label}); {remaining} left"
            );
            Ok(())
        }
        _ => Err(
            "usage: miao auth login INTEGRATION KEY [--account NAME] [--oauth] | miao auth logout INTEGRATION [--account NAME]"
                .into(),
        ),
    }
}

/// List stored credentials. `list_database` reports only normalized type and
/// expiry metadata — the engine never serializes a secret — so this stays a
/// read-only view and never touches the broker's write authority.
fn list_credentials() -> Result<(), String> {
    let path = credential_db_path()?;
    // A store nobody has written yet is an empty list, not an error: the first
    // `auth login` is what creates it.
    let entries = match path.is_file() {
        true => miao_engine::credential::list_database(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?,
        false => Vec::new(),
    };
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
///
/// A bare install runs this with nothing paved, and the product is the one that
/// normally derives the manifest and hands the path over. Deriving the same
/// routes from the configuration keeps the answer identical instead of
/// answering with the name of an internal variable.
fn list_models() -> Result<(), String> {
    let mut ids = match std::env::var("MIAO_ENGINE_MODEL_ROUTES_CONFIG") {
        Ok(path) => {
            let text =
                std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
            let manifest: serde_json::Value =
                serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))?;
            let mut ids = Vec::new();
            collect_ids(&manifest, &mut ids);
            ids
        }
        Err(_) => {
            // Same layered stack the engine start reads; the workspace is the
            // invocation directory because this command has no other anchor.
            let layers = config_layers(std::path::Path::new("."), None, &|name| {
                std::env::var(name).ok()
            });
            // `model_routes` is the engine's own derivation, so it already
            // covers the providers the configuration never names but a stored
            // key does — there is nothing left to append.
            model_routes(&layers, "")?
                .iter()
                .filter_map(|route| route["id"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        }
    };
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        let dir = product_config_dir(None)
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|| "no configuration directory".into());
        return Err(format!(
            "no model routes: no provider is configured in {dir}"
        ));
    }
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

/// One NDJSON event line, the shape the TypeScript headless runner emits:
/// `{"type": …, "timestamp": …, "sessionID": …, "part": …}`.
fn event_line(kind: &str, session: &str, part: serde_json::Value) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    serde_json::json!({
        "type": kind,
        "timestamp": timestamp,
        "sessionID": session,
        "part": part,
    })
    .to_string()
}

/// Non-JSON formats print nothing here — the final answer still goes out as
/// plain text when the turn settles.
fn emit_event(format: &str, kind: &str, session: &str, part: serde_json::Value) {
    if format != "json" {
        return;
    }
    println!("{}", event_line(kind, session, part));
}

/// Product-tool definitions the host serves. These are the cross-session tools
/// the engine calls back into the host for; without them a single binary has no
/// way to reach other sessions or the operator.
fn product_tools() -> Vec<miao_engine::protocol::ToolDefinition> {
    let spec = |name: &str, description: &str, schema: serde_json::Value| {
        miao_engine::protocol::ToolDefinition {
            name: name.into(),
            description: description.into(),
            input_schema: schema,
        }
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
async fn call_product_tool(
    name: &str,
    input: &serde_json::Value,
    db: &std::path::Path,
) -> serde_json::Value {
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
                Ok(_) => {
                    serde_json::json!({ "events": String::from_utf8_lossy(&buffer).lines().count(), "session_id": session })
                }
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            }
        }
        "push_notification" => {
            let message = input
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let title = input
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("miao");
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                message.replace('"', " "),
                title.replace('"', " ")
            );
            match std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .status()
            {
                Ok(status) if status.success() => serde_json::json!({ "delivered": true }),
                Ok(status) => serde_json::json!({ "error": format!("osascript exited {status}") }),
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            }
        }
        other => serde_json::json!({ "error": format!("unknown product tool {other}") }),
    }
}

async fn run_prompt(
    argv: Vec<String>,
    prompt: String,
    target: Target,
    db: PathBuf,
) -> Result<(), String> {
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
        .with_product_tools(product_tools(), bridge.clone());
    let (mut connection, mut events) =
        Connection::start_embedded(configured.runtime, Duration::from_secs(120))
            .map_err(|error| error.to_string())?;
    let client = connection
        .connect()
        .await
        .map_err(|error| error.to_string())?;
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
    client
        .subscribe(&session, 0)
        .await
        .map_err(|error| error.to_string())?;
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
    // A turn ends at its `stop` boundary, not at the first assistant text: an
    // agentic answer interleaves tool calls with text, and leaving on the
    // first line would hand a script a half answer. Text still streams out as
    // it commits, so `--format json` consumers see each part the moment the
    // engine journals it.
    let mut printed = baseline;
    let mut finished = false;
    let mut saw_run = false;
    let mut found: Vec<String> = Vec::new();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let snapshot = client
            .snapshot(&session)
            .await
            .map_err(|error| error.to_string())?;
        found.clear();
        texts(&snapshot, &mut found);
        // The snapshot itself carries the run boundary:  is set
        // while a turn is in flight and null again once it settles. A turn
        // that settles between two polls still reads as finished, because the
        // text it committed pushed  past the baseline.
        let running = snapshot.get("active_run").is_some_and(|run| !run.is_null());
        if running {
            saw_run = true;
        }
        if !running && (saw_run || printed > baseline) {
            finished = true;
        }
        while printed < found.len() {
            emit_event(
                &target.format,
                "text",
                &session,
                serde_json::json!({ "type": "text", "text": found[printed] }),
            );
            printed += 1;
        }
        if finished {
            break;
        }
        // A headless run cannot answer an operator question. Say so at once
        // instead of blocking until the deadline, and name the way out.
        while let Ok(frame) = bridge_rx.try_recv() {
            let Some(id) = frame.get("bridge_id").and_then(|value| value.as_u64()) else {
                continue;
            };
            let params = frame
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let name = params
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let input = params
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
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
            let miao_tui::transport::TransportEvent::Event(event) = event else {
                continue;
            };
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
                let tool = data
                    .get("tool")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                eprintln!(
                    "miao run: denied approval for {tool} (headless run cannot ask a person)"
                );
                let _ = client.approve(&session, response).await;
                continue;
            }
            // A failed provider turn produced no answer; waiting for the
            // deadline would hide the reason.
            if kind.contains("failed") || kind.contains("failure") {
                owner.shutdown().await;
                let detail = event
                    .data
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or(&kind)
                    .to_string();
                emit_event(
                    &target.format,
                    "error",
                    &session,
                    serde_json::json!({ "type": "error", "message": detail }),
                );
                return Err(format!("the turn failed: {detail}"));
            }
            // A finished tool call is part of the answer a script may want as
            // soon as it lands, so it streams like text does.
            if kind == "tool.completed" {
                emit_event(&target.format, "tool_use", &session, event.data.clone());
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
    if target.format != "json" {
        println!("{}", found.last().cloned().unwrap_or_default());
    }
    owner.shutdown().await;
    Ok(())
}

pub fn run(args: Vec<String>) -> std::process::ExitCode {
    // Before any path is derived: a Windows shell sets `USERPROFILE`, and every
    // reader here — config, credentials, the ledger — looks for `HOME`.
    miao_engine::placement::normalize_home();
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
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("miao"))
        });
    warn_missing_sidecar(config_dir.as_deref());
    let mut args = args.into_iter();
    match args.next().as_deref() {
        Some("tui") => match launch(args) {
            Ok(mut launch) => {
                // The Rust TUI builds its own engine argv from MIAO_ENGINE_*
                // variables, so the routes derived here reach it exactly the way
                // an operator-supplied manifest would.
                prepare_tui_engine(&mut launch);
                match miao_tui::run(launch) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("miao tui: {error}");
                        std::process::ExitCode::from(1)
                    }
                }
            }
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
                    // The product's `run` aliases the long flag as `-m`; without
                    // it the token was swallowed into the prompt instead.
                    "--model" | "-m" => {
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
            let workspace = workspace
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            let db = db.unwrap_or_else(|| default_db(&workspace));
            let config_dir = config_dir.or_else(|| product_config_dir(None));
            let model = model
                .or_else(|| std::env::var("MIAO_ENGINE_MODEL").ok())
                .or_else(|| configured_model(config_dir.as_deref()))
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
                            let chosen =
                                match agent_manifest_for(config_dir.as_deref(), name, instructions)
                                {
                                    Ok(chosen) => chosen,
                                    Err(message) => {
                                        eprintln!("miao run: {message}");
                                        return std::process::ExitCode::from(1);
                                    }
                                };
                            match chosen {
                                Some((agent_model, agent_manifest_json)) => {
                                    if model == "unavailable/model" && !agent_model.is_empty() {
                                        if let Some(position) =
                                            argv.iter().position(|arg| arg == "--model")
                                        {
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
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            eprintln!("miao run: {error}");
                            return std::process::ExitCode::from(1);
                        }
                    };
                    let target = Target {
                        session,
                        continue_last,
                        format: format.clone(),
                    };
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
                exit_for(&message)
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
        Some("upgrade") => match upgrade(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao upgrade: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("uninstall") => match uninstall(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao uninstall: {message}");
                std::process::ExitCode::from(1)
            }
        },
        Some("report") => match report(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao report: {message}");
                exit_for(&message)
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
        Some("project") => match project_copy(&args.collect::<Vec<_>>()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("miao project: {message}");
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
                Some("stats") => match db_stats(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db stats: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("vacuum") => match db_vacuum(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db vacuum: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("bundle") => match db_bundle(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db bundle: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("backup") => match db_backup(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db backup: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("blob-gc") => match db_blob_gc(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db blob-gc: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("retention") => match db_retention(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao db retention: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                _ => {
                    eprintln!("usage: miao db [path|stats|vacuum|retention] [--db PATH] [--apply]");
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
                Some("export-bundle") => {
                    match session_engine_call(&rest[1..], "transfer_export_move") {
                        Ok(()) => std::process::ExitCode::SUCCESS,
                        Err(message) => {
                            eprintln!("miao session: {message}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
                Some("import") => match session_import(&rest[1..]) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("move") => {
                    let inner = &rest[1..];
                    let copy_changes = inner.iter().any(|argument| argument == "--copy-changes");
                    let apply = inner.iter().any(|argument| argument == "--apply");
                    let mut db: Option<PathBuf> = None;
                    let mut positional: Vec<String> = Vec::new();
                    let mut index = 0;
                    while index < inner.len() {
                        match inner[index].as_str() {
                            "--db" => {
                                db = inner.get(index + 1).map(PathBuf::from);
                                index += 2;
                            }
                            other if other.starts_with("--") => index += 1,
                            other => {
                                positional.push(other.to_string());
                                index += 1;
                            }
                        }
                    }
                    let result = (|| -> Result<(), String> {
                        let (Some(id), Some(directory)) = (positional.first(), positional.get(1))
                        else {
                            return Err(
                                "usage: miao session move ID DIRECTORY [--apply] [--copy-changes]"
                                    .into(),
                            );
                        };
                        let workspace =
                            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                        let db = db.unwrap_or_else(|| default_db(&workspace));
                        for line in session_move_plan(
                            &db,
                            id,
                            std::path::Path::new(directory),
                            copy_changes,
                        )? {
                            println!("{line}");
                        }
                        if !apply {
                            println!("dry run · pass --apply to move");
                            return Ok(());
                        }
                        // Warp's carry rule: the source's uncommitted changes
                        // land on the target before the move, or the move does
                        // not happen — the session keeps working on them after
                        // its cwd changes, instead of losing reachability.
                        if copy_changes {
                            let connection = db_read_only(&db)?;
                            let source: Option<String> = connection
                                .query_row(
                                    "SELECT root FROM engine_location WHERE session_id=?1",
                                    [id],
                                    |row| row.get(0),
                                )
                                .map(Some)
                                .or_else(|error| match error {
                                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                                    other => Err(other.to_string()),
                                })?;
                            let Some(source) = source else {
                                return Err(format!(
                                    "session {id} has no recorded location to carry changes from"
                                ));
                            };
                            let carried = carry_uncommitted_changes(
                                std::path::Path::new(&source),
                                std::path::Path::new(directory),
                            )?;
                            println!(
                                "carried · {carried} byte(s) of uncommitted patch onto {directory}"
                            );
                        }
                        session_engine_call(inner, "move_session")
                    })();
                    match result {
                        Ok(()) => std::process::ExitCode::SUCCESS,
                        Err(message) => {
                            eprintln!("miao session: {message}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
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
                Some("archive") => match session_engine_call(&rest[1..], "archive") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("delete") => match session_engine_call(&rest[1..], "remove") {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("miao session: {message}");
                        std::process::ExitCode::from(1)
                    }
                },
                Some("account") => {
                    // Per-session account pin: forward SelectAccount with the
                    // named credential, or clear the pin when asked. One
                    // session's choice never moves another session's or the
                    // global default — the engine owns that isolation.
                    let outcome = (|| -> Result<(String, Option<String>), String> {
                        let mut db: Option<PathBuf> = None;
                        let mut positional: Vec<String> = Vec::new();
                        let mut clear = false;
                        let mut index = 0;
                        while index < rest[1..].len() {
                            match rest[1 + index].as_str() {
                                "--db" => {
                                    db = rest.get(2 + index).map(PathBuf::from);
                                    index += 2;
                                }
                                "--clear" => {
                                    clear = true;
                                    index += 1;
                                }
                                other if other.starts_with("--") => index += 1,
                                other => {
                                    positional.push(other.to_string());
                                    index += 1;
                                }
                            }
                        }
                        let Some(session_id) = positional.first().cloned() else {
                            return Err(
                                "usage: miao session account SESSION [CREDENTIAL_ID | --clear]"
                                    .into(),
                            );
                        };
                        let credential_id = positional.get(1).cloned();
                        if credential_id.is_some() && clear {
                            return Err("pass either a credential id or --clear, not both".into());
                        }
                        if credential_id.is_none() && !clear {
                            return Err(
                                "usage: miao session account SESSION [CREDENTIAL_ID | --clear]"
                                    .into(),
                            );
                        }
                        let _ = db;
                        Ok((session_id, credential_id))
                    })();
                    let (session_id, credential_id) = match outcome {
                        Ok(pair) => pair,
                        Err(message) => {
                            eprintln!("miao session: {message}");
                            return if message.starts_with("usage:") {
                                std::process::ExitCode::from(2)
                            } else {
                                std::process::ExitCode::from(1)
                            };
                        }
                    };
                    let mut forward: Vec<String> = vec![session_id];
                    if let Some(id) = &credential_id {
                        forward.push(id.clone());
                    }
                    match session_engine_call_with(&forward, "select_account", |params| {
                        params["credential_id"] = credential_id
                            .as_ref()
                            .map(|id| serde_json::json!(id))
                            .unwrap_or(serde_json::Value::Null);
                    }) {
                        Ok(()) => std::process::ExitCode::SUCCESS,
                        Err(message) => {
                            eprintln!("miao session: {message}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
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
                        Ok(status) => {
                            std::process::ExitCode::from(status.code().unwrap_or(1) as u8)
                        }
                        Err(error) => {
                            eprintln!("miao session: {error}");
                            std::process::ExitCode::from(1)
                        }
                    }
                }
                _ => {
                    eprintln!(
                        "usage: miao session list [--db PATH] | resume ID PROMPT [--db PATH]"
                    );
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
            println!("miao {VERSION}");
            std::process::ExitCode::SUCCESS
        }
        Some("--build-id") => {
            println!("{BUILD_ID}");
            std::process::ExitCode::SUCCESS
        }
        Some("--help" | "-h") => {
            println!("{USAGE}");
            std::process::ExitCode::SUCCESS
        }
        // A bare `miao` is how people start the product: `miao tui` is the
        // explicit spelling, but typing the program name alone must not print
        // usage and exit. `--help` is the way to ask for the text.
        None => start_tui(std::iter::empty()),
        // A leading option is a TUI flag, not a subcommand name: the TUI's
        // exit hint prints `miao -s ses_x`, and `miao --continue` is the same
        // kind of resume, so both have to start the product rather than read
        // as an unknown command.
        Some(other) if other.starts_with('-') => {
            start_tui(std::iter::once(other.to_string()).chain(args))
        }
        Some(other) => {
            eprintln!("miao: unknown command {other}\n{USAGE}");
            std::process::ExitCode::from(2)
        }
    }
}

fn start_tui(args: impl Iterator<Item = String>) -> std::process::ExitCode {
    match launch(args) {
        Ok(mut launch) => {
            prepare_tui_engine(&mut launch);
            match miao_tui::run(launch) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("miao: {error}");
                    std::process::ExitCode::from(1)
                }
            }
        }
        Err(message) => {
            eprintln!("miao: {message}\n{USAGE}");
            std::process::ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    // The engine reads its storage root from process-global environment
    // variables at call time, so tests that point those variables at their own
    // temp trees must not overlap, or one test's ledger answers another's
    // assertion.
    static ENV_SERIES: Mutex<()> = Mutex::new(());

    fn env_guard() -> MutexGuard<'static, ()> {
        // A panicked predecessor must not poison every later test.
        ENV_SERIES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    use super::{
        anchored_sessions, carry_uncommitted_changes, config_layers, config_layers_with, db_backup,
        db_file_bytes, db_read_only, db_report, db_vacuum, default_db, engine_argv_with,
        event_line, git_worktree_main_checkout, launch, lsp_servers, mcp_servers, merged_config,
        model_routes, model_routes_with, parsed_session_location, plugin_entries,
        project_copy_apply, project_copy_plan, retention_plan, serve_database, settle_primary,
        strip_comments, tree_bytes, uninstall_targets, worktree_remove_apply, worktree_remove_plan,
        write_routes_manifest,
    };
    use std::sync::{Mutex, MutexGuard};

    /// 64 KiB is the ceiling for a value passed through the environment, not for
    /// the file the engine reads. Applying it to the file kept a launch with a
    /// large route list from writing one at all, so a key stored afterwards had
    /// nothing to append to and the provider only appeared after restarting miao.
    #[test]
    fn a_route_list_past_the_environment_ceiling_still_gets_a_manifest() {
        let routes = (0..4_000)
            .map(|index| serde_json::json!({"id": format!("provider/model-{index}")}))
            .collect::<Vec<_>>();
        let path =
            write_routes_manifest("miao-routes-test", &routes).expect("the manifest is written");
        let written = std::fs::read_to_string(&path).expect("the manifest reads back");
        assert!(
            written.len() > 65_536,
            "the fixture must clear the old ceiling"
        );
        assert!(written.contains("provider/model-3999"));
        let _ = std::fs::remove_file(path);
    }
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn headless_event_lines_parse_and_carry_the_script_fields() {
        // The shape a script consumes: one JSON object per line with the
        // type, a timestamp, and the session it belongs to — the same fields
        // the TypeScript headless runner emits.
        let line = event_line(
            "text",
            "ses_x",
            serde_json::json!({ "type": "text", "text": "answer" }),
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON line");
        assert_eq!(parsed["type"], "text");
        assert_eq!(parsed["sessionID"], "ses_x");
        assert!(parsed["timestamp"].is_u64());
        assert_eq!(parsed["part"]["text"], "answer");
    }

    #[test]
    fn the_report_counts_the_write_ahead_log_and_the_shared_index() {
        // A WAL database is up to three files. Reporting only the main one
        // understates what it occupies, which is the number an operator acts on.
        let dir = std::env::temp_dir().join(format!("miao-db-wal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let path = dir.join("engine.db");
        std::fs::write(&path, vec![0u8; 64]).expect("main file");
        let (main, wal, shm) = db_file_bytes(&path);
        assert_eq!(
            (main, wal, shm),
            (64, 0, 0),
            "absent sidecars count as zero"
        );

        // SQLite creates these when it writes in WAL mode; the report has to add
        // them to the same total instead of treating the main file as the whole
        // database.
        std::fs::write(format!("{}-wal", path.display()), vec![0u8; 128]).expect("wal");
        std::fs::write(format!("{}-shm", path.display()), vec![0u8; 32]).expect("shm");
        assert_eq!(db_file_bytes(&path), (64, 128, 32));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_database_report_names_the_target_before_anything_is_written() {
        // DATA-03: a maintenance command has to show the database it is aimed at
        // and the impact it would have, and it may only touch real data under an
        // explicit authorisation. The report is read-only; vacuum is a dry run
        // until `--apply`.
        let dir = std::env::temp_dir().join(format!("miao-db-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let path = dir.join("engine.db");
        let connection = rusqlite::Connection::open(&path).expect("create database");
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT); \
                 INSERT INTO session VALUES ('a'), ('b');",
            )
            .expect("seed");

        let lines = db_report(&connection, &path).expect("report");
        let text = lines.join("\n");
        assert!(
            text.contains(&format!("database · {}", path.display())),
            "the target has to be named: {text}"
        );
        assert!(text.contains("table · session · 2 rows"), "{text}");
        assert!(text.contains("pages · "), "{text}");
        assert!(text.contains("reclaimable · "), "{text}");
        drop(connection);

        let before = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        db_vacuum(&["--db".into(), path.display().to_string()]).expect("dry run");
        let after = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        assert_eq!(before, after, "a dry run must not write");

        db_vacuum(&["--db".into(), path.display().to_string(), "--apply".into()]).expect("vacuum");
        let connection = rusqlite::Connection::open(&path).expect("reopen");
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM session", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 2, "vacuum keeps every row");
        drop(connection);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_serve_default_database_is_outside_the_workspace() {
        let workspace = std::env::temp_dir().join(format!("miao-cli-serve-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).expect("workspace");
        // The runtime refuses a process-enabled database inside its workspace, so
        // a default beside the workspace makes `miao serve` fail on first run.
        assert!(
            !serve_database(None, &workspace).starts_with(&workspace),
            "the default ledger must stay outside the workspace"
        );
        let chosen = workspace.join("chosen.db");
        assert_eq!(
            serve_database(Some(chosen.clone()), &workspace),
            chosen,
            "an explicit --db is used as given"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn backup_reads_the_copy_back_and_never_replaces_one() {
        let dir = std::env::temp_dir().join(format!("miao-cli-backup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("engine.db");
        let connection = rusqlite::Connection::open(&path).expect("create database");
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; \
                 CREATE TABLE session (id TEXT); \
                 INSERT INTO session VALUES ('a'), ('b');",
            )
            .expect("seed");
        drop(connection);
        let digest = "a".repeat(64);
        let blob = dir.join("blobs").join(&digest[0..2]).join(&digest);
        std::fs::create_dir_all(blob.parent().expect("blob dir")).expect("blob dir");
        std::fs::write(&blob, b"payload").expect("blob");

        let before = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let target = dir.join("backups").join("copy.db");
        db_backup(&[
            "--db".into(),
            path.display().to_string(),
            "--to".into(),
            target.display().to_string(),
        ])
        .expect("backup");

        assert!(target.exists(), "the copy has to exist");
        let copy = rusqlite::Connection::open(&target).expect("open copy");
        let rows: i64 = copy
            .query_row("SELECT count(*) FROM session", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 2, "every committed row reaches the copy");
        let integrity: String = copy
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity_check");
        assert_eq!(integrity, "ok", "the copy reads back clean");
        drop(copy);
        assert!(
            dir.join("backups")
                .join("blobs")
                .join(&digest[0..2])
                .join(&digest)
                .exists(),
            "a blob the ledger references has to travel with it"
        );
        assert_eq!(
            before,
            std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
            "a backup reads the source and never writes it"
        );

        let refused = db_backup(&[
            "--db".into(),
            path.display().to_string(),
            "--to".into(),
            target.display().to_string(),
        ])
        .expect_err("an existing backup must not be replaced");
        assert!(refused.contains("already exists"), "{refused}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Write a throwaway config directory and hand back its path.
    fn config_dir(tag: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("miao-cli-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut file = std::fs::File::create(dir.join("miao.jsonc")).expect("config");
        file.write_all(body.as_bytes()).expect("write");
        dir
    }

    /// A credential store holding one key per named integration. A route needs
    /// a secret, so a fixture that names providers has to name their keys too.
    fn credential_fixture(dir: &std::path::Path, integrations: &[&str]) -> std::path::PathBuf {
        let database = dir.join("credentials.db");
        for integration in integrations {
            miao_engine::credential::store_key(&database, integration, "sk-fixture", None)
                .expect("stores");
        }
        database
    }

    #[test]
    fn mcp_section_maps_to_the_engine_shape() {
        let dir = config_dir(
            "mcp",
            "{ // comment\n \"mcp\": { \"files\": { \"command\": [\"npx\", \"x\"], \"environment\": { \"A\": \"1\" } }, \"remote\": { \"url\": \"https://e.test/mcp\", \"headers\": { \"K\": \"v\" } } } }",
        );
        let servers = mcp_servers(std::slice::from_ref(&dir)).expect("maps");
        assert_eq!(servers.len(), 2);
        let files = servers
            .iter()
            .find(|s| s["name"] == "files")
            .expect("stdio server");
        assert_eq!(files["argv"], serde_json::json!(["npx", "x"]));
        assert_eq!(files["env"], serde_json::json!({"A": "1"}));
        let remote = servers
            .iter()
            .find(|s| s["name"] == "remote")
            .expect("http server");
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
        let servers = lsp_servers(std::slice::from_ref(&dir)).expect("maps");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["argv"], serde_json::json!(["ts-ls", "--stdio"]));
        assert_eq!(servers[0]["extensions"], serde_json::json!([".ts"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two providers can serve one model name — a mirror and the vendor — and
    /// the engine rejects the entire catalogue when two routes claim one id, so
    /// the derived ids have to be provider-qualified.
    #[test]
    fn routes_sharing_a_model_name_get_distinct_ids() {
        let dir = config_dir(
            "routes-duplicate",
            "{ \"model\": \"vendor/deepseek\", \"providers\": { \
               \"vendor\": { \"api\": { \"type\": \"openai\", \"url\": \"https://vendor.test/v1\" }, \
                 \"models\": { \"deepseek\": {} } }, \
               \"mirror\": { \"api\": { \"type\": \"openai\", \"url\": \"https://mirror.test/v1\" }, \
                 \"models\": { \"deepseek\": {} } } } }",
        );
        let database = credential_fixture(&dir, &["vendor", "mirror"]);
        let routes =
            model_routes_with(std::slice::from_ref(&dir), "", Some(&database)).expect("derives");
        assert_eq!(routes.len(), 2);
        let ids: Vec<&str> = routes
            .iter()
            .filter_map(|route| route["id"].as_str())
            .collect();
        assert!(ids.contains(&"vendor/deepseek"), "ids: {ids:?}");
        assert!(ids.contains(&"mirror/deepseek"), "ids: {ids:?}");
        // The bare name is what goes upstream and what the engine compares
        // against the base provider's identity.
        assert!(routes.iter().all(|route| route["model"] == "deepseek"));
        // Exactly one default, and it is the configured one rather than
        // whichever provider happened to be enumerated first.
        let primary: Vec<&serde_json::Value> = routes
            .iter()
            .filter(|route| route["primary"] == true)
            .collect();
        assert_eq!(primary.len(), 1, "exactly one primary");
        assert_eq!(primary[0]["id"], "vendor/deepseek");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A bare model name in the config still selects a route, so a config
    /// written before provider-qualified names kept working.
    #[test]
    fn a_bare_model_name_still_selects_a_route() {
        let dir = config_dir(
            "routes-bare",
            "{ \"model\": \"deepseek\", \"providers\": { \
               \"vendor\": { \"api\": { \"type\": \"openai\", \"url\": \"https://vendor.test/v1\" }, \
                 \"models\": { \"deepseek\": {}, \"other\": {} } } } }",
        );
        let database = credential_fixture(&dir, &["vendor"]);
        let routes =
            model_routes_with(std::slice::from_ref(&dir), "", Some(&database)).expect("derives");
        let primary = routes
            .iter()
            .find(|route| route["primary"] == true)
            .expect("a primary");
        assert_eq!(primary["id"], "vendor/deepseek");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A launch whose configuration names no provider still has the routes a
    /// stored key supplies, and the engine accepts exactly one default. The
    /// model the operator named wins over the configured order, because that
    /// is the route their turn is actually pinned to.
    #[test]
    fn the_named_model_becomes_the_only_default_route() {
        let route =
            |id: &str| serde_json::json!({ "id": id, "model": "glm-5.3", "primary": false });
        let mut routes = vec![
            route("zhipuai-coding-plan/glm-5.3"),
            serde_json::json!({ "id": "vendor/deepseek", "model": "deepseek", "primary": true }),
        ];
        settle_primary(&mut routes, "zhipuai-coding-plan/glm-5.3");
        let primaries: Vec<&serde_json::Value> = routes
            .iter()
            .filter(|route| route["primary"] == true)
            .collect();
        assert_eq!(primaries.len(), 1, "exactly one default");
        assert_eq!(primaries[0]["id"], "zhipuai-coding-plan/glm-5.3");
    }

    /// A launch that names no route and starts from nothing but stored keys
    /// still hands the engine a default instead of no primary at all.
    #[test]
    fn a_catalog_only_launch_defaults_to_its_first_route() {
        let mut routes = vec![
            serde_json::json!({ "id": "zhipuai-coding-plan/glm-5.3", "model": "glm-5.3" }),
            serde_json::json!({ "id": "deepseek/deepseek-v4-pro", "model": "deepseek-v4-pro" }),
        ];
        settle_primary(&mut routes, "");
        assert_eq!(routes[0]["primary"], true);
        assert_eq!(
            routes
                .iter()
                .filter(|route| route["primary"] == true)
                .count(),
            1
        );
    }

    /// Settling must leave an existing default alone when the operator named no
    /// model: the configuration's own choice is still the one to serve.
    #[test]
    fn an_existing_default_survives_when_nothing_is_named() {
        let mut routes = vec![
            serde_json::json!({ "id": "vendor/other", "model": "other", "primary": false }),
            serde_json::json!({ "id": "vendor/deepseek", "model": "deepseek", "primary": true }),
        ];
        settle_primary(&mut routes, "");
        assert_eq!(routes[1]["primary"], true);
        assert_eq!(routes[0]["primary"], false);
    }

    /// OpenCode's gateway refuses a turn that does not name its conversation,
    /// so the derived route has to carry the Session-bound header; without it
    /// every `opencode-go` turn fails with 400 MissingSessionID.
    #[test]
    fn opencode_go_routes_carry_the_session_header() {
        let dir = config_dir(
            "routes-opencode-go",
            "{ \"model\": \"opencode-go/deepseek\", \"providers\": { \
               \"opencode-go\": { \"api\": { \"type\": \"aisdk\", \"package\": \"@ai-sdk/openai-compatible\", \
                 \"url\": \"https://opencode.ai/inference/go/openai/v1\" }, \
                 \"models\": { \"deepseek\": {} } }, \
               \"vendor\": { \"api\": { \"url\": \"https://vendor.test/v1\" }, \
                 \"models\": { \"other\": {} } } } }",
        );
        let database = credential_fixture(&dir, &["opencode-go", "vendor"]);
        let routes = model_routes_with(
            std::slice::from_ref(&dir),
            "opencode-go/deepseek",
            Some(&database),
        )
        .expect("derives");
        let go = routes
            .iter()
            .find(|route| route["id"] == "opencode-go/deepseek")
            .expect("a route");
        assert_eq!(go["auth"]["headers"]["x-opencode-session"], "$session");
        assert_eq!(
            go["endpoint"],
            "https://opencode.ai/inference/go/openai/v1/chat/completions"
        );
        let other = routes
            .iter()
            .find(|route| route["id"] == "vendor/other")
            .expect("a route");
        assert!(
            other.get("auth").is_none(),
            "only the gateway needs the header"
        );
        // The key's documented name is not the mechanical provider spelling:
        // that rule only applies to the environment fallback, which a stored
        // key never reaches.
        assert_eq!(
            miao_engine::native_routes::route_env_key("opencode-go"),
            "OPENCODE_API_KEY"
        );
        assert_eq!(
            miao_engine::native_routes::route_env_key("vendor"),
            "VENDOR_API_KEY"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A provider whose key lives only in the environment still routes, and one
    /// with no key at all routes nothing: writing an environment credential the
    /// engine cannot resolve makes it refuse the whole manifest, so an absent
    /// key has to produce no route rather than a broken one.
    #[test]
    fn an_environment_key_routes_only_when_it_is_set() {
        let dir = config_dir(
            "routes-env-key",
            "{ \"providers\": { \"fixture-env\": { \"api\": { \"type\": \"aisdk\", \"package\": \"@ai-sdk/openai-compatible\", \"url\": \"https://env.test/v1\" }, \"models\": { \"m\": {} } } } }",
        );
        let layers = std::slice::from_ref(&dir);
        assert!(
            model_routes_with(layers, "", None)
                .expect("derives")
                .is_empty(),
            "no key anywhere routes nothing"
        );
        std::env::set_var("FIXTURE_ENV_API_KEY", "sk-env");
        let routes = model_routes_with(layers, "", None).expect("derives");
        std::env::remove_var("FIXTURE_ENV_API_KEY");
        assert_eq!(routes.len(), 1, "the environment key routes the provider");
        assert_eq!(routes[0]["credential"]["type"], "environment");
        assert_eq!(routes[0]["credential"]["key"], "FIXTURE_ENV_API_KEY");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A global config directory and a workspace carrying a project layer:
    /// the workspace's `.miao` overrides the global document key for key.
    fn layered_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("miao-cli-{tag}-{}", std::process::id()));
        let global = root.join("home/.config/miao");
        let workspace = root.join("work/repo");
        std::fs::create_dir_all(&global).expect("global dir");
        std::fs::create_dir_all(workspace.join(".miao")).expect("project layer");
        std::fs::write(
            global.join("miao.json"),
            r#"{ "model": "deepseek", "providers": { "vendor": { "api": { "type": "openai", "url": "https://global.test/v1" }, "models": { "deepseek": {} } } } }"#,
        )
        .expect("global config");
        std::fs::write(
            workspace.join(".miao/miao.json"),
            r#"{ "providers": { "vendor": { "api": { "type": "openai", "url": "https://project.test/v1" }, "models": { "deepseek": {} } } } }"#,
        )
        .expect("project config");
        (root, global, workspace)
    }

    fn fixture_env(root: &std::path::Path) -> impl Fn(&str) -> Option<String> + '_ {
        let home = root.join("home").display().to_string();
        move |name: &str| match name {
            "HOME" => Some(home.clone()),
            "MIAO_CONFIG_DIR" | "MIAO_MANAGED_CONFIG_DIR" | "MIAO_DISABLE_PROJECT_CONFIG" => None,
            _ => std::env::var(name).ok(),
        }
    }

    /// A machine where an administrator deployed a system-wide document: it
    /// loads first and still loses to every user and project key.
    #[test]
    fn a_managed_layer_loads_first_and_only_when_it_exists() {
        let (root, global, workspace) = layered_fixture("layer-managed");
        let managed = root.join("etc/miao");
        std::fs::create_dir_all(&managed).expect("managed dir");
        std::fs::write(
            managed.join("miao.json"),
            r#"{ "providers": { "vendor": { "api": { "type": "openai", "url": "https://managed.test/v1" } } } }"#,
        )
        .expect("managed config");
        let env = fixture_env(&root);
        let layers = config_layers_with(&workspace, None, &env, Some(&managed));
        assert_eq!(
            layers.first(),
            Some(&managed),
            "the managed layer comes first: {layers:?}"
        );
        assert_eq!(
            layers.get(1),
            Some(&global),
            "the user's global layer follows it: {layers:?}"
        );
        let merged = merged_config(&layers).expect("merges every layer");
        assert_eq!(
            merged["providers"]["vendor"]["api"]["url"], "https://project.test/v1",
            "a nearer layer still wins key for key"
        );
        let absent = root.join("etc/absent");
        let layers = config_layers_with(&workspace, None, &env, Some(&absent));
        assert_eq!(
            layers.first(),
            Some(&global),
            "an undeployed managed directory is not a layer: {layers:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_layer_overrides_the_global_one() {
        let (root, global, workspace) = layered_fixture("layer-win");
        let layers = config_layers_with(&workspace, None, &fixture_env(&root), None);
        assert_eq!(
            layers.first(),
            Some(&global),
            "the global layer comes first: {layers:?}"
        );
        assert!(
            layers.contains(&workspace.join(".miao")),
            "the project layer rides along: {layers:?}"
        );
        let merged = merged_config(&layers).expect("merges both layers");
        assert_eq!(
            merged["providers"]["vendor"]["api"]["url"], "https://project.test/v1",
            "the nearer layer wins key for key"
        );
        let database = credential_fixture(&root, &["vendor"]);
        let routes = model_routes_with(&layers, "", Some(&database)).expect("derives");
        let primary = routes
            .iter()
            .find(|route| route["primary"] == true)
            .expect("a primary");
        assert_eq!(
            primary["endpoint"], "https://project.test/v1/chat/completions",
            "the project layer's endpoint serves the route"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn disabling_the_project_config_skips_its_layers() {
        let (root, global, workspace) = layered_fixture("layer-disabled");
        let env = |name: &str| -> Option<String> {
            match name {
                "HOME" => Some(root.join("home").display().to_string()),
                "MIAO_DISABLE_PROJECT_CONFIG" => Some("1".into()),
                _ => std::env::var(name).ok(),
            }
        };
        let layers = config_layers_with(&workspace, None, &env, None);
        assert_eq!(layers, vec![global], "only the global layer survives");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_explicit_config_dir_stays_the_only_layer() {
        let (root, _global, workspace) = layered_fixture("layer-explicit");
        let explicit = root.join("explicit");
        let layers = config_layers(&workspace, Some(&explicit), &fixture_env(&root));
        assert_eq!(
            layers,
            vec![explicit],
            "an explicit directory is the whole answer"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_default_start_encodes_the_stack_as_a_plan() {
        let (root, global, workspace) = layered_fixture("layer-plan");
        // The product store under the fixture's own HOME: the launch resolves
        // the credential database through the environment it was handed, so the
        // route this asserts comes from the fixture rather than this machine.
        let product = root.join("home/.local/share/miao");
        std::fs::create_dir_all(&product).expect("product dir");
        miao_engine::credential::store_key(&product.join("miao.db"), "vendor", "sk-fixture", None)
            .expect("stores");
        let db = root.join("miao.db");
        let argv = engine_argv_with(&db, &workspace, "", None, fixture_env(&root));
        let position = argv
            .iter()
            .position(|arg| arg == "--config-sources")
            .expect("the layered stack rides as a plan");
        let plan: serde_json::Value =
            serde_json::from_str(&argv[position + 1]).expect("valid plan");
        let dirs: Vec<&str> = plan
            .as_array()
            .expect("a plan array")
            .iter()
            .filter_map(|entry| entry["dir"].as_str())
            .collect();
        assert_eq!(
            dirs.first().copied(),
            Some(global.display().to_string().as_str()),
            "global first: {dirs:?}"
        );
        assert!(
            dirs.iter().any(|dir| dir.ends_with(".miao")),
            "the project layer is in the plan: {dirs:?}"
        );
        // The merged routes rewrite --model's endpoint to the project layer's,
        // so the engine dials where the project points.
        let endpoint = argv
            .iter()
            .position(|arg| arg == "--endpoint")
            .expect("the project route is forwarded");
        assert_eq!(
            argv[endpoint + 1],
            "https://project.test/v1/chat/completions",
            "the engine dials where the project points"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_config_without_extensions_needs_no_sidecar() {
        let dir = config_dir("empty", "{ \"model\": \"a/b\" }");
        assert!(mcp_servers(std::slice::from_ref(&dir))
            .expect("maps")
            .is_empty());
        assert!(lsp_servers(std::slice::from_ref(&dir))
            .expect("maps")
            .is_empty());
        assert!(plugin_entries(Some(&dir)).expect("maps").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The product's `run` and `tui` alias `--model` as `-m`. Without the
    /// alias the token was taken for the prompt text, so a run silently used
    /// the default route while its prompt gained the flag and its value.
    #[test]
    fn the_short_model_flag_is_the_same_option() {
        let launch = super::launch(
            ["--workspace", "/tmp/ws", "-m", "mtty/claude-haiku-5-5"]
                .into_iter()
                .map(str::to_string),
        )
        .expect("parses");
        assert_eq!(launch.model.as_deref(), Some("mtty/claude-haiku-5-5"));
        // The long spelling keeps working.
        let launch = super::launch(
            ["--workspace", "/tmp/ws", "--model", "vendor/model"]
                .into_iter()
                .map(str::to_string),
        )
        .expect("parses");
        assert_eq!(launch.model.as_deref(), Some("vendor/model"));
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
        assert!(argv
            .windows(2)
            .any(|w| w == ["--endpoint", "https://e.test/v1"]));
        assert!(argv
            .windows(2)
            .any(|w| w == ["--credential-db", "/tmp/cred.db"]));
        assert!(argv.windows(2).any(|w| w == ["--config-dir", "/tmp/cfg"]));
        // An unset variable contributes no flag at all, rather than an empty one.
        assert!(!argv.iter().any(|a| a == "--credential-id"));
    }

    #[test]
    fn bundle_location_is_read_back_verbatim() {
        let bundle = br#"{"session":{"location":{"directory":"/private/tmp/x"}}}"#;
        assert_eq!(
            parsed_session_location(bundle),
            r#"{"directory":"/private/tmp/x"}"#
        );
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
        assert_eq!(
            entries,
            vec!["@scope/a".to_string(), "b-plugin".to_string()]
        );
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

    #[test]
    fn every_management_command_named_in_the_inventory_is_reachable() {
        // CLI-06 item 3: each command either has a Rust owner or a stated
        // deferral in docs/cli.md. This pins the Rust-owned set so a command
        // cannot silently disappear from the binary while the inventory still
        // claims it lives here.
        let owned = [
            "auth",
            "models",
            "agent",
            "db",
            "doctor",
            "remote",
            "upgrade",
            "uninstall",
            "session",
        ];
        let usage: Vec<&str> = super::USAGE.lines().collect();
        for command in owned {
            assert!(
                usage
                    .iter()
                    .any(|line| line.contains(&format!("miao {command}"))),
                "docs/cli.md owns `{command}` in Rust but USAGE never names it"
            );
        }
        // The deferrals must stay visible rather than silently absent: the
        // inventory's ts-only and rust-todo rows are the contract for what is
        // NOT here.
        for deferred in ["config", "mcp", "skill", "runtime"] {
            assert!(
                !usage.iter().any(|line| line.contains(&format!("miao {deferred} "))),
                "`{deferred}` is deferred in the inventory and must not appear as a Rust command yet"
            );
        }
    }

    #[test]
    fn unsupported_tui_options_are_refused_by_name_before_the_terminal_exists() {
        // The legacy interface carried these; the Rust TUI refuses them with
        // the reason and the legacy escape hatch, never with a silently
        // different session (CLI-01). A supported option keeps parsing.
        for option in [
            "--mini",
            "--replay",
            "--no-replay",
            "--replay-limit",
            "--demo",
        ] {
            let error = launch(
                [
                    "--db".to_string(),
                    "/tmp/x.db".to_string(),
                    option.to_string(),
                ]
                .into_iter(),
            )
            .expect_err(option);
            assert!(error.contains(option), "{option}: {error}");
            assert!(error.contains("--tui legacy"), "{option}: {error}");
        }
        assert!(launch(
            ["--db", "/tmp/x.db", "--continue"]
                .into_iter()
                .map(str::to_string)
        )
        .is_ok());
    }

    #[test]
    fn the_agent_option_names_the_configuration_agent() {
        // `--agent <name>` rides to the engine as `--agent-name`, which
        // resolves the merged configuration's `agents` entry into the default
        // manifest — the standalone counterpart of the product host's
        // prepared agent. Both spellings of the value land in Launch.agent.
        for argv in [vec!["--agent", "reviewer"], vec!["--agent=reviewer"]] {
            let mut args = vec!["--db".to_string(), "/tmp/x.db".to_string()];
            args.extend(argv.iter().map(|argument| argument.to_string()));
            let launch = launch(args.into_iter()).expect("--agent parses");
            assert_eq!(launch.agent.as_deref(), Some("reviewer"));
        }
        let error = launch(
            ["--db", "/tmp/x.db", "--agent"]
                .into_iter()
                .map(str::to_string),
        )
        .expect_err("--agent without a value is refused");
        assert!(error.contains("--agent"), "{error}");
    }

    #[test]
    fn the_auto_spellings_map_onto_the_engine_flag() {
        // The TypeScript entry carried three spellings for one behaviour; all
        // of them now parse and land in Launch.auto, which the TUI forwards as
        // the engine's --auto-approve (classifier-guarded, deny/ask stay put).
        for option in ["--auto", "--yolo", "--dangerously-skip-permissions"] {
            let launch = launch(
                [
                    "--db".to_string(),
                    "/tmp/x.db".to_string(),
                    option.to_string(),
                ]
                .into_iter(),
            )
            .expect(option);
            assert!(launch.auto, "{option} must set auto");
        }
        let plain = launch(["--db", "/tmp/x.db"].into_iter().map(str::to_string)).unwrap();
        assert!(!plain.auto);
    }
    #[test]
    fn fork_requires_a_session_to_copy() {
        // `--fork` alone has nothing to copy: the error names the pairing the
        // TypeScript entry documented, before the terminal exists.
        let error = launch(
            [
                "--db".to_string(),
                "/tmp/x.db".to_string(),
                "--fork".to_string(),
            ]
            .into_iter(),
        )
        .expect_err("--fork alone is refused");
        assert!(error.contains("--session"), "{error}");
        let paired = launch(
            [
                "--db".to_string(),
                "/tmp/x.db".to_string(),
                "--fork".to_string(),
                "--session".to_string(),
                "ses_x".to_string(),
            ]
            .into_iter(),
        )
        .expect("--fork with --session parses");
        assert!(paired.fork);
        let continued = launch(
            [
                "--db".to_string(),
                "/tmp/x.db".to_string(),
                "--fork".to_string(),
                "--continue".to_string(),
            ]
            .into_iter(),
        )
        .expect("--fork with --continue parses");
        assert!(continued.fork && continued.continue_last);
    }

    #[test]
    fn the_exit_hint_spelling_resumes_the_session() {
        // The epilogue prints `miao -s ses_x`, so the short spelling has to
        // reach Launch.session the same way `--session` does; a leading option
        // is passed through as a TUI flag rather than read as a subcommand.
        let resumed = launch(
            ["-s", "ses_x", "--db", "/tmp/x.db"]
                .into_iter()
                .map(str::to_string),
        )
        .expect("-s parses");
        assert_eq!(resumed.session.as_deref(), Some("ses_x"));
        assert!(!resumed.continue_last);
        let error = launch(["-s"].into_iter().map(str::to_string))
            .expect_err("-s without an identifier is refused");
        assert!(error.contains("--session"), "{error}");
    }

    #[test]
    fn tree_bytes_counts_a_nested_file_and_ignores_a_missing_path() {
        let dir = std::env::temp_dir().join(format!("miao-treebytes-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).expect("tree");
        std::fs::write(dir.join("a"), vec![0u8; 100]).expect("file");
        std::fs::write(dir.join("nested").join("b"), vec![0u8; 50]).expect("file");
        assert_eq!(tree_bytes(&dir), 150);
        assert_eq!(tree_bytes(&dir.join("absent")), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_uninstall_targets_cover_the_five_xdg_roots() {
        let _env = env_guard();
        // Isolated environment so the test never looks at the real home: the
        // variables the targets read are all pointed at one temp tree.
        let dir =
            std::env::temp_dir().join(format!("miao-uninstall-targets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let home = dir.join("home");
        std::env::set_var("HOME", &home);
        std::env::set_var("MIAO_ENGINE_STORAGE", dir.join("engine-storage"));
        std::env::set_var("XDG_DATA_HOME", dir.join("xdg-data"));
        std::env::set_var("XDG_CACHE_HOME", dir.join("xdg-cache"));
        std::env::set_var("XDG_STATE_HOME", dir.join("xdg-state"));
        std::env::remove_var("MIAO_CONFIG_DIR");
        std::env::remove_var("MIAO_DATA_HOME");

        let labels: Vec<&str> = uninstall_targets(false, false)
            .into_iter()
            .map(|(label, _, _)| label)
            .collect();
        assert_eq!(
            labels,
            vec!["data", "engine storage", "cache", "config", "state"],
            "removal order and coverage: {labels:?}"
        );

        // Keeping flags move whole groups: the product data root and the engine
        // ledger are both "data", the config root is its own.
        let keeps: Vec<(bool, bool)> = uninstall_targets(true, false)
            .into_iter()
            .map(|(_, _, keep)| (keep, false))
            .collect();
        assert!(keeps[3].0, "config is kept with --keep-config");
        assert!(!keeps[0].0, "data is removed without --keep-data");

        std::env::remove_var("MIAO_ENGINE_STORAGE");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("XDG_CACHE_HOME");
        std::env::remove_var("XDG_STATE_HOME");
        std::env::remove_var("HOME");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_worktree_remove_plan_previews_references_before_any_removal() {
        // A real repository with a real worktree: the plan reads git's own
        // registration, not a model of it, because the acceptance asks the
        // cleanup to show who references the target before anything moves.
        let dir = std::env::temp_dir().join(format!("miao-wt-plan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace dir");
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git runs")
        };
        assert!(
            run(&["init", "-q", "-b", "main"]).status.success(),
            "git init"
        );
        std::fs::write(dir.join("seed"), "seed").expect("seed file");
        assert!(run(&["add", "."]).status.success());
        assert!(run(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "seed"
        ])
        .status
        .success());
        let name = "plan-preview";
        let path = dir.join(".miao-worktrees").join(name);
        assert!(
            run(&[
                "worktree",
                "add",
                "-b",
                name,
                path.display().to_string().as_str()
            ])
            .status
            .success(),
            "worktree add"
        );
        // A commit only the branch holds: the plan has to count what `branch -D`
        // would discard, which is the number an operator decides on.
        std::fs::write(path.join("only"), "only on the branch").expect("branch file");
        assert!(std::process::Command::new("git")
            .args(["add", "only"])
            .current_dir(&path)
            .output()
            .expect("git runs")
            .status
            .success());
        assert!(std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "branch-only"
            ])
            .current_dir(&path)
            .output()
            .expect("git runs")
            .status
            .success());

        let plan =
            worktree_remove_plan(dir.display().to_string().as_str(), name, &path).expect("plan");
        let text = plan.join("\n");
        assert!(text.contains("git registration · registered"), "{text}");
        assert!(
            text.contains("1 commit(s) not reachable from HEAD"),
            "{text}"
        );
        assert!(text.contains("engine sessions · none"), "{text}");
        assert!(text.contains("directory ·"), "{text}");
        // The plan itself removes nothing: the tree and the branch still exist.
        assert!(path.exists(), "a plan must not remove the tree");
        assert!(
            run(&["rev-parse", "--verify", &format!("refs/heads/{name}")])
                .status
                .success()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A real repository with one commit: the smallest source a copy needs.
    fn seeded_repository(dir: &std::path::Path, name: &str) -> PathBuf {
        let source = dir.join(name);
        std::fs::create_dir_all(&source).expect("source dir");
        std::fs::write(source.join("README.md"), "original").expect("seed file");
        for args in [
            vec!["init", "-q"],
            vec!["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "seed",
            ],
        ] {
            assert!(
                std::process::Command::new("git")
                    .args(&args)
                    .current_dir(&source)
                    .output()
                    .expect("git runs")
                    .status
                    .success(),
                "git {args:?} runs"
            );
        }
        source
    }

    fn git_worktree_paths(source: &std::path::Path) -> Vec<String> {
        let listed = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(source)
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&listed.stdout)
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .map(|line| line.trim_start_matches("worktree ").to_string())
            .collect()
    }

    fn git_status_is_clean(source: &std::path::Path) -> bool {
        let status = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(source)
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&status.stdout).trim().is_empty()
    }

    #[test]
    fn a_project_copy_plan_previews_the_target_and_never_writes_the_source() {
        let _env = env_guard();
        let dir = std::env::temp_dir().join(format!("miao-copy-plan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::env::set_var("MIAO_ENGINE_STORAGE", dir.join("engine-storage"));

        let source = seeded_repository(&dir, "app");
        let parent = dir.join("copies");
        std::fs::create_dir_all(&parent).expect("parent dir");

        let plan = project_copy_plan(&source, &parent, "app", &default_db(&dir)).expect("plan");
        let text = plan.join("\n");
        assert!(text.contains("strategy · git worktree"), "{text}");
        assert!(
            text.contains(&format!("target · {}", parent.join("app").display())),
            "{text}"
        );
        assert!(text.contains("stay in the source"), "{text}");

        // An occupied name walks the suffix: the plan never points at a path
        // that already exists.
        std::fs::create_dir_all(parent.join("app")).expect("occupied name");
        let plan = project_copy_plan(&source, &parent, "app", &default_db(&dir)).expect("plan");
        let text = plan.join("\n");
        assert!(
            text.contains(&format!("target · {}", parent.join("app-2").display())),
            "{text}"
        );

        // The plan is read-only: the source keeps a clean tree and exactly one
        // registered worktree.
        assert!(git_status_is_clean(&source), "the source stays clean");
        let paths = git_worktree_paths(&source);
        assert_eq!(paths.len(), 1, "only the main worktree: {paths:?}");

        std::env::remove_var("MIAO_ENGINE_STORAGE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_project_copy_apply_registers_a_worktree_and_a_failure_leaves_no_half_copy() {
        let _env = env_guard();
        let dir = std::env::temp_dir().join(format!("miao-copy-apply-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::env::set_var("MIAO_ENGINE_STORAGE", dir.join("engine-storage"));

        let source = seeded_repository(&dir, "app");
        let parent = dir.join("copies");
        std::fs::create_dir_all(&parent).expect("parent dir");

        let target = project_copy_apply(&source, &parent, "fork").expect("copy succeeds");
        assert!(target.is_dir());
        assert!(
            target.join("README.md").exists(),
            "the worktree checks out HEAD"
        );
        let paths = git_worktree_paths(&source);
        assert!(
            paths.contains(&target.display().to_string()),
            "the copy is registered: {paths:?}"
        );
        assert!(git_status_is_clean(&source), "the source stays clean");

        // A failure must leave no half-built copy behind and the source
        // intact: an unwritable parent makes `worktree add` fail after it
        // started, exercising the cleanup path.
        let readonly = dir.join("readonly-parent");
        std::fs::create_dir_all(&readonly).expect("readonly parent dir");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o555))
                .expect("readonly parent");
        }
        let failed = project_copy_apply(&source, &readonly, "fork");
        assert!(failed.is_err(), "an unwritable parent fails the copy");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o755))
                .expect("restore parent");
        }
        assert_eq!(
            std::fs::read_dir(&readonly).expect("read parent").count(),
            0,
            "no half copy remains"
        );
        assert!(
            git_status_is_clean(&source),
            "the source survives the failure"
        );

        std::env::remove_var("MIAO_ENGINE_STORAGE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_worktree_remove_refuses_anchored_sessions_then_migrates_with_force() {
        let _env = env_guard();
        let dir = std::env::temp_dir().join(format!("miao-wt-anchored-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("engine-storage")).expect("temp dir");
        std::env::set_var("MIAO_ENGINE_STORAGE", dir.join("engine-storage"));

        let repo = seeded_repository(&dir, "main");
        let name = "side";
        let path = repo.join(".miao-worktrees").join(name);
        let added = std::process::Command::new("git")
            .args(["worktree", "add", "-B", name, &path.display().to_string()])
            .current_dir(&repo)
            .output()
            .expect("git runs");
        assert!(added.status.success(), "worktree add runs");

        // The main ledger anchors one session to the worktree's canonical path.
        let canonical = std::fs::canonicalize(&path).expect("canonical");
        let ledger = default_db(&repo);
        {
            let connection = rusqlite::Connection::open(&ledger).expect("ledger opens");
            connection
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS engine_session (id TEXT PRIMARY KEY, title TEXT);
                     CREATE TABLE IF NOT EXISTS engine_location (session_id TEXT PRIMARY KEY, root TEXT NOT NULL);
                     INSERT INTO engine_session (id, title) VALUES ('s1', 'anchored');",
                )
                .expect("seed tables");
            connection
                .execute(
                    "INSERT INTO engine_location (session_id, root) VALUES ('s1', ?1)",
                    [canonical.display().to_string()],
                )
                .expect("seed anchored session");
        }

        // Without --force: refuse, and leave both the tree and the anchor.
        let refused =
            worktree_remove_apply(repo.display().to_string().as_str(), name, &path, false);
        assert!(
            refused.is_err(),
            "anchored sessions refuse removal: {refused:?}"
        );
        assert!(path.exists(), "the tree survived the refusal");
        assert_eq!(
            anchored_sessions(&ledger, &canonical).expect("count"),
            1,
            "the anchor is untouched"
        );

        // With --force: the sessions migrate back to the main checkout first,
        // then the tree goes away.
        let checkout =
            git_worktree_main_checkout(repo.display().to_string().as_str()).expect("main checkout");
        worktree_remove_apply(repo.display().to_string().as_str(), name, &path, true)
            .expect("forced removal");
        assert!(!path.exists(), "the tree is gone");
        let root: String = {
            let connection = db_read_only(&ledger).expect("ledger opens");
            connection
                .query_row(
                    "SELECT root FROM engine_location WHERE session_id = 's1'",
                    [],
                    |row| row.get(0),
                )
                .expect("session root")
        };
        assert_eq!(
            root,
            checkout.display().to_string(),
            "the session now anchors the main checkout"
        );

        std::env::remove_var("MIAO_ENGINE_STORAGE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn carrying_changes_lands_the_source_edits_on_the_target_and_leaves_the_source() {
        let _env = env_guard();
        let dir = std::env::temp_dir().join(format!("miao-move-carry-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("engine-storage")).expect("temp dir");
        std::env::set_var("MIAO_ENGINE_STORAGE", dir.join("engine-storage"));

        // The source edits a tracked file and adds an untracked one; neither
        // is committed.
        let source = seeded_repository(&dir, "origin-app");
        std::fs::write(source.join("README.md"), "edited, uncommitted").expect("edit");
        std::fs::write(source.join("notes.txt"), "untracked").expect("untracked");
        let target = seeded_repository(&dir, "dest-app");

        let carried = carry_uncommitted_changes(&source, &target).expect("the carry succeeds");
        assert!(carried > 0, "the patch is non-empty: {carried}");
        assert_eq!(
            std::fs::read_to_string(target.join("README.md")).expect("target readme"),
            "edited, uncommitted",
            "the edit landed on the target"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes.txt")).expect("target notes"),
            "untracked",
            "the untracked file landed too"
        );
        assert!(
            !git_status_is_clean(&source),
            "the source keeps its changes: carrying reads it, never writes it"
        );

        std::env::remove_var("MIAO_ENGINE_STORAGE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_default_engine_ledger_uses_the_placement_rule() {
        // The CLI and the TUI have to resolve the same ledger for one workspace.
        // A private hash here once sent `miao tui` to a second, empty database,
        // so the default must carry the engine's own 64-hex placement name.
        let workspace = std::path::Path::new("/some/workspace");
        let path = default_db(workspace);
        let name = path
            .file_name()
            .expect("a ledger name")
            .to_string_lossy()
            .to_string();
        assert_eq!(name.len(), 64 + ".db".len(), "{name}");
        assert!(name.ends_with(".db"), "{name}");
        assert!(name[..64].chars().all(|c| c.is_ascii_hexdigit()), "{name}");
    }

    #[test]
    fn the_engine_retention_plan_counts_events_at_or_before_the_baseline() {
        let connection = rusqlite::Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE engine_event (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq)); \
                 CREATE TABLE engine_compaction (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, through_seq INTEGER NOT NULL, summary TEXT NOT NULL, created_seq INTEGER NOT NULL); \
                 INSERT INTO engine_event VALUES ('s1', 1, 'user.message', '\"long\"'), ('s1', 2, 'assistant.message', X'0000'), ('s1', 3, 'run.started', '\"x\"'); \
                 INSERT INTO engine_event VALUES ('s1', 5, 'summary.ready', X'00'); \
                 INSERT INTO engine_event VALUES ('s2', 1, 'user.message', '\"fresh\"'); \
                 INSERT INTO engine_compaction VALUES ('c1', 's1', 2, 'summary', 4);",
            )
            .expect("seed");

        let lines = retention_plan(&connection).expect("engine plan");
        let text = lines.join("\n");
        // Session s1 has events 1 and 2 at or before its baseline (through_seq 2);
        // s2 has no baseline, so its fresh event stays out of the plan.
        assert!(
            text.contains("retention plan · 2 event(s) across 1 session(s) · "),
            "{text}"
        );
    }

    #[test]
    fn the_product_retention_plan_reads_events_before_the_compaction_message() {
        let connection = rusqlite::Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE event (aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL); \
                 CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL); \
                 INSERT INTO event VALUES ('s1', 1, '\"a\"'), ('s1', 2, '\"b\"'), ('s1', 9, '\"live\"'); \
                 INSERT INTO session_message VALUES ('m1', 's1', 'compaction', 9, '{}');",
            )
            .expect("seed");

        let lines = retention_plan(&connection).expect("product plan");
        let text = lines.join("\n");
        // Events 1 and 2 sit strictly before the compaction message (seq 9);
        // the event at seq 9 is the compaction's own admission and stays.
        assert!(
            text.contains("retention plan · 2 event(s) across 1 session(s) · "),
            "{text}"
        );
    }
}

#[cfg(test)]
mod identity {
    /// An install decides where to keep the binary from this identity and
    /// refuses anything that is not the UUID shape it wrote, so a build that
    /// emitted nothing would be uninstallable.
    #[test]
    fn the_build_id_is_the_uuid_shape_an_installer_requires() {
        let id = super::BUILD_ID;
        assert_eq!(id.len(), 36, "{id}");
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
            "{id}"
        );
        assert_ne!(id, "00000000-0000-0000-0000-000000000000");
    }

    /// The root package.json is the single source of the product version; the
    /// crate's own manifest only carries a placeholder.
    #[test]
    fn the_binary_reports_the_root_package_version() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../package.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root).expect("root package.json"))
                .expect("valid root package.json");
        assert_eq!(super::VERSION, manifest["version"].as_str().unwrap());
    }
}
