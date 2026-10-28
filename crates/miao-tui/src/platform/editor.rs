//! External editor handoff for the composer.
//!
//! The caller suspends the TUI around [`run`], which blocks until the editor
//! exits. The draft travels through a private temporary file, and the file is
//! removed whether the editor succeeds or not.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub command: Vec<String>,
    pub workspace: PathBuf,
    pub text: String,
}

/// Build a request from `$VISUAL`, then `$EDITOR`. `None` means the user has
/// no editor configured, which is reported without suspending the terminal.
pub fn request(workspace: &Path, text: String) -> Result<Request, String> {
    let editor = std::env::var("VISUAL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("EDITOR")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    let Some(editor) = editor else {
        return Err("no editor configured: set $VISUAL or $EDITOR".into());
    };
    let command = parse(&editor)?;
    Ok(Request {
        command,
        workspace: workspace.to_path_buf(),
        text,
    })
}

/// Split an editor command the way `editor.ts` does: whitespace separates the
/// program from its arguments. Quoting is intentionally not interpreted; an
/// editor path with spaces belongs in a shell wrapper.
pub fn parse(editor: &str) -> Result<Vec<String>, String> {
    let parts: Vec<String> = editor.split_whitespace().map(str::to_string).collect();
    if parts.is_empty() {
        return Err("no editor configured: set $VISUAL or $EDITOR".into());
    }
    Ok(parts)
}

/// Run the editor and return its saved contents. An empty file reads back as
/// `None`, matching the TypeScript handoff.
pub fn run(request: &Request) -> Result<Option<String>, String> {
    let path = temp_path();
    std::fs::write(&path, &request.text)
        .map_err(|error| format!("cannot write the editor buffer: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let status = Command::new(&request.command[0])
        .args(&request.command[1..])
        .arg(&path)
        .current_dir(&request.workspace)
        .status();
    let saved = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(status) if status.success() => Ok(saved.filter(|text| !text.is_empty())),
        Ok(status) => Err(match status.code() {
            Some(code) => format!("editor exited with code {code}"),
            None => "editor was terminated by a signal".into(),
        }),
        Err(error) => Err(format!("cannot run {}: {error}", request.command[0])),
    }
}

fn temp_path() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    std::env::temp_dir().join(format!("miao-{}-{stamp}.md", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_editor_command_splits_on_whitespace() {
        assert_eq!(
            parse("code --wait").unwrap(),
            vec!["code".to_string(), "--wait".to_string()]
        );
        assert!(parse("   ").is_err());
    }

    #[test]
    fn the_request_reports_a_missing_editor_instead_of_suspending() {
        let previous_visual = std::env::var_os("VISUAL");
        let previous_editor = std::env::var_os("EDITOR");
        std::env::remove_var("VISUAL");
        std::env::remove_var("EDITOR");
        let result = request(Path::new("/tmp"), "draft".into());
        match previous_visual {
            Some(value) => std::env::set_var("VISUAL", value),
            None => std::env::remove_var("VISUAL"),
        }
        match previous_editor {
            Some(value) => std::env::set_var("EDITOR", value),
            None => std::env::remove_var("EDITOR"),
        }
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_temp_file_is_private_read_back_and_removed() {
        let dir = std::env::temp_dir().join(format!("miao-editor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let request = Request {
            command: vec![
                "sh".into(),
                "-c".into(),
                r#"test "$(stat -c %a "$0" 2>/dev/null || stat -f %Lp "$0")" = 600 && printf edited > "$0""#
                    .into(),
            ],
            workspace: dir.clone(),
            text: "old".into(),
        };
        assert_eq!(run(&request).unwrap().as_deref(), Some("edited"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_editor_reports_the_exit_and_leaves_no_file() {
        let dir = std::env::temp_dir().join(format!("miao-editor-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let request = Request {
            command: vec!["sh".into(), "-c".into(), "exit 3".into()],
            workspace: dir.clone(),
            text: "draft".into(),
        };
        let error = run(&request).unwrap_err();
        assert!(error.contains("code 3"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
