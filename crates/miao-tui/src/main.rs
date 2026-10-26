use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: miao-tui [--workspace <dir>]";

fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(Some(workspace)) => launch(workspace),
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

fn parse(args: impl Iterator<Item = String>) -> Result<Option<PathBuf>, String> {
    let mut workspace: Option<PathBuf> = None;
    let mut args = args;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--workspace" => {
                let value = args.next().ok_or("--workspace requires a directory")?;
                workspace = Some(PathBuf::from(value));
            }
            other => return Err(format!("unexpected argument \"{other}\"")),
        }
    }
    Ok(workspace)
}

fn launch(workspace: PathBuf) -> ExitCode {
    if !workspace.is_dir() {
        eprintln!("miao-tui: not a directory: {}", workspace.display());
        return ExitCode::from(2);
    }
    let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
    match miao_tui::run(workspace) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("miao-tui: {err}");
            ExitCode::from(1)
        }
    }
}
