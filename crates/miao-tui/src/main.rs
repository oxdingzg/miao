use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str =
    "usage: miao-tui [--workspace <dir>] [--db <engine.db>] [--model <provider/model>]
                  [--config-dir <dir>] [--session <id>] [--continue] [--prompt <text>]";

/// The release build injects the product version; a source build falls back to
/// the crate's own version.
const VERSION: &str = match option_env!("MIAO_TUI_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// The identity an installer keeps this build under. It answers before the TUI
/// starts so an install can name a directory and verify the artifact it holds.
const BUILD_ID: &str = match option_env!("MIAO_TUI_BUILD_ID") {
    Some(id) => id,
    None => "00000000-0000-0000-0000-000000000000",
};

/// What this build calls itself. Installed as the product's only binary it is
/// `miao`; kept as the paired TUI it stays `miao-tui`, so an installer can tell
/// which file it is looking at.
fn program_name() -> &'static str {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .filter(|stem| stem == "miao")
        .map(|_| "miao")
        .unwrap_or("miao-tui")
}

struct Options {
    workspace: PathBuf,
    db: Option<PathBuf>,
    model: Option<String>,
    config_dir: Option<PathBuf>,
    session: Option<String>,
    continue_last: bool,
    prompt: Option<String>,
}

enum Invocation {
    Run(Options),
    Help,
    Version,
    /// What an installer asks for before it trusts the artifact.
    BuildId,
}

fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(Invocation::Run(options)) => launch(options),
        Ok(Invocation::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Invocation::BuildId) => {
            println!("{BUILD_ID}");
            ExitCode::SUCCESS
        }
        Ok(Invocation::Version) => {
            println!("{} {VERSION}", program_name());
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("miao-tui: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Invocation, String> {
    let mut workspace: Option<PathBuf> = None;
    let mut db: Option<PathBuf> = None;
    let mut model: Option<String> = None;
    let mut config_dir: Option<PathBuf> = None;
    let mut session: Option<String> = None;
    let mut continue_last = false;
    let mut prompt: Option<String> = None;
    while let Some(arg) = args.next() {
        // Both `--flag value` and `--flag=value` are accepted; the CLI passes
        // the former, a person typing the command often uses the latter.
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg, None),
        };
        let mut value = |name: &str| {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match name.as_str() {
            "-h" | "--help" => return Ok(Invocation::Help),
            "-v" | "--version" => return Ok(Invocation::Version),
            "--build-id" => return Ok(Invocation::BuildId),
            "--workspace" => workspace = Some(PathBuf::from(value("--workspace")?)),
            "--db" => db = Some(PathBuf::from(value("--db")?)),
            "--model" => model = Some(value("--model")?),
            "--config-dir" => config_dir = Some(PathBuf::from(value("--config-dir")?)),
            "--session" => session = Some(value("--session")?),
            "--prompt" => prompt = Some(value("--prompt")?),
            "--continue" => {
                if inline.is_some() {
                    return Err("--continue takes no value".into());
                }
                continue_last = true;
            }
            other => return Err(format!("unexpected argument \"{other}\"")),
        }
    }
    Ok(match workspace {
        Some(workspace) => Invocation::Run(Options {
            workspace,
            db,
            model,
            config_dir,
            session,
            continue_last,
            prompt,
        }),
        // A single binary is started in a directory, so the working directory is
        // the workspace unless one is named; `-h` still asks for help.
        None => Invocation::Run(Options {
            workspace: std::env::current_dir()
                .map_err(|error| format!("cannot read the working directory: {error}"))?,
            db,
            model,
            config_dir,
            session,
            continue_last,
            prompt,
        }),
    })
}

fn launch(options: Options) -> ExitCode {
    let workspace = options.workspace;
    if !workspace.is_dir() {
        eprintln!("miao-tui: not a directory: {}", workspace.display());
        return ExitCode::from(2);
    }
    let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
    match miao_tui::run(miao_tui::Launch {
        workspace,
        db: options.db,
        model: options.model,
        config_dir: options.config_dir,
        session: options.session,
        continue_last: options.continue_last,
        prompt: options.prompt,
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("miao-tui: {err}");
            ExitCode::from(1)
        }
    }
}
