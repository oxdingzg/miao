use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str =
    "usage: miao-tui [--workspace <dir>] [--db <engine.db>] [--model <provider/model>]";

struct Options {
    workspace: PathBuf,
    db: Option<PathBuf>,
    model: Option<String>,
}

fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(Some(options)) => launch(options),
        Ok(None) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("miao-tui: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn parse(args: impl Iterator<Item = String>) -> Result<Option<Options>, String> {
    let mut workspace: Option<PathBuf> = None;
    let mut db: Option<PathBuf> = None;
    let mut model: Option<String> = None;
    let mut args = args;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--workspace" => {
                let value = args.next().ok_or("--workspace requires a directory")?;
                workspace = Some(PathBuf::from(value));
            }
            "--db" => {
                let value = args.next().ok_or("--db requires a database path")?;
                db = Some(PathBuf::from(value));
            }
            "--model" => {
                let value = args.next().ok_or("--model requires a provider/model")?;
                model = Some(value);
            }
            other => return Err(format!("unexpected argument \"{other}\"")),
        }
    }
    Ok(workspace.map(|workspace| Options {
        workspace,
        db,
        model,
    }))
}

fn launch(options: Options) -> ExitCode {
    let workspace = options.workspace;
    if !workspace.is_dir() {
        eprintln!("miao-tui: not a directory: {}", workspace.display());
        return ExitCode::from(2);
    }
    let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
    match miao_tui::run(workspace, options.db, options.model) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("miao-tui: {err}");
            ExitCode::from(1)
        }
    }
}
