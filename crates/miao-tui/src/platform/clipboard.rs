//! Clipboard reads and writes.
//!
//! Writes go through OSC 52 first (which works over SSH, tmux, and in most
//! modern terminals) and then through a platform command. Reads prefer an
//! image because that is what a TUI paste most often carries on macOS and
//! Windows; text is the fallback.

use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use base64::Engine;

/// An image paste is served only while it is fresh: an empty bracketed paste
/// on a terminal without image support would otherwise re-serve the previous
/// image forever.
const HOST_CLIPBOARD_MAX_AGE_MS: u128 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Image { mime: String, data: String },
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Environment {
    pub os: &'static str,
    pub wayland: bool,
    pub tmux: bool,
    pub screen: bool,
}

impl Environment {
    pub fn current() -> Self {
        Self {
            os: std::env::consts::OS,
            wayland: std::env::var_os("WAYLAND_DISPLAY").is_some(),
            tmux: std::env::var_os("TMUX").is_some(),
            screen: std::env::var_os("STY").is_some(),
        }
    }
}

/// Copy `text` everywhere the terminal can carry it. Osc 52 is unconditional
/// when stdout is a terminal; the platform command is best effort.
pub fn copy(text: &str) {
    if io::stdout().is_terminal() {
        let env = Environment::current();
        let mut stdout = io::stdout();
        let _ = stdout.write_all(osc52(text, env.tmux, env.screen).as_bytes());
        let _ = stdout.flush();
    }
    let env = Environment::current();
    if let Some((program, args)) = copy_command(env.os, env.wayland, command_exists) {
        run_with_input(&program, &args, text.as_bytes());
    }
}

/// OSC 52, wrapped for tmux and screen the same way `clipboard.ts` does.
pub fn osc52(text: &str, tmux: bool, screen: bool) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text);
    let sequence = format!("\x1b]52;c;{encoded}\x07");
    let passthrough = format!("\x1bPtmux;\x1b{sequence}\x1b\\");
    if tmux {
        format!("{sequence}{passthrough}")
    } else if screen {
        passthrough
    } else {
        sequence
    }
}

/// The first platform command able to take text on stdin.
pub fn copy_command(
    os: &str,
    wayland: bool,
    has: impl Fn(&str) -> bool,
) -> Option<(String, Vec<String>)> {
    match os {
        "macos" if has("pbcopy") => Some(("pbcopy".into(), Vec::new())),
        "linux" if wayland && has("wl-copy") => Some(("wl-copy".into(), Vec::new())),
        "linux" if has("xclip") => Some((
            "xclip".into(),
            vec!["-selection".into(), "clipboard".into()],
        )),
        "linux" if has("xsel") => {
            Some(("xsel".into(), vec!["--clipboard".into(), "--input".into()]))
        }
        "windows" if has("powershell.exe") => Some((
            "powershell.exe".into(),
            vec![
                "-NonInteractive".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Set-Clipboard -Value ([Console]::In.ReadToEnd())".into(),
            ],
        )),
        _ => None,
    }
}

/// Read the clipboard, preferring an image. `host_file` is the mtty handoff
/// path (`MTTY_CLIPBOARD_FILE`); it is consumed on every read.
pub fn read(host_file: Option<&Path>) -> Option<Content> {
    if let Some(content) = read_host_image(host_file) {
        return Some(content);
    }
    let env = Environment::current();
    match env.os {
        "macos" => read_macos().or_else(read_text_macos),
        "windows" => read_windows().or_else(read_text_windows),
        "linux" => read_linux(env.wayland).or_else(|| read_text_linux(env.wayland)),
        _ => None,
    }
}

fn read_host_image(path: Option<&Path>) -> Option<Content> {
    let path = path?;
    let metadata = std::fs::metadata(path).ok()?;
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map_or(u128::MAX, |elapsed| elapsed.as_millis());
    if age > HOST_CLIPBOARD_MAX_AGE_MS {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let bytes = std::fs::read(path).ok();
    let _ = std::fs::remove_file(path);
    let bytes = bytes.filter(|bytes| !bytes.is_empty())?;
    Some(Content::Image {
        mime: "image/png".into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn read_macos() -> Option<Content> {
    let file = std::env::temp_dir().join(format!(
        "miao-clipboard-{}-{}.png",
        std::process::id(),
        unique_suffix()
    ));
    let script = format!(
        r#"ObjC.import("AppKit")
const pasteboard = $.NSPasteboard.generalPasteboard
let image = pasteboard.dataForType("public.png")
if (image.isNil()) {{
  const tiff = pasteboard.dataForType("public.tiff")
  if (tiff.isNil()) throw new Error("clipboard holds no image")
  image = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
}}
if (image.isNil()) throw new Error("could not encode the clipboard image")
image.writeToFileAtomically({:?}, true)"#,
        file.to_string_lossy()
    );
    let status = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let bytes = std::fs::read(&file).ok();
    if !status.is_ok_and(|status| status.success()) {
        let _ = std::fs::remove_file(&file);
        return None;
    }
    let mut bytes = bytes.filter(|bytes| !bytes.is_empty())?;
    let mut mime = "image/png".to_string();
    // A Retina screenshot dwarfs the engine's 8 MiB base64 attachment cap, so
    // the admit would bounce after the operator already pasted it (issue
    // #2959: the prompt sends, the model never sees the picture). sips ships
    // with macOS: re-encode the oversized ones as JPEG at a bounded size.
    if bytes.len() > 4 * 1024 * 1024 {
        let jpeg = file.with_extension("jpg");
        let encoded = Command::new("sips")
            .args([
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "80",
                "--resampleHeightWidthMax",
                "2400",
            ])
            .arg(&file)
            .arg(&jpeg)
            .output()
            .is_ok_and(|output| output.status.success());
        if encoded {
            if let Ok(smaller) = std::fs::read(&jpeg) {
                if !smaller.is_empty() && smaller.len() < bytes.len() {
                    bytes = smaller;
                    mime = "image/jpeg".into();
                }
            }
        }
        let _ = std::fs::remove_file(&jpeg);
    }
    let _ = std::fs::remove_file(&file);
    Some(Content::Image {
        mime,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn read_text_macos() -> Option<Content> {
    let output = Command::new("pbpaste").stdin(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    non_empty_text(text)
}

/// The Windows image bridge: the clipboard image as base64 on stdout.
const WINDOWS_IMAGE_SCRIPT: &str = "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }";

/// Windows clipboard access is contended: the app that owns the clipboard may
/// hold it while another read races it, and `OpenClipboard` fails with
/// `CLIPBRD_E_CANT_OPEN`. A few short retries absorb that race; the count is
/// bounded so a wedged clipboard costs a moment, not a hang.
const WINDOWS_READ_ATTEMPTS: u32 = 3;
const WINDOWS_RETRY_DELAY_MS: u64 = 50;

/// One attempt to run a Windows clipboard script. `Output` carries the stdout
/// bytes of a clean exit; `Failed` covers spawn errors and nonzero exits, the
/// transient cases a retry can still recover.
enum WindowsOutput {
    Output(Vec<u8>),
    Failed,
}

/// Read the clipboard through a script, retrying script failures. A script
/// that ran and found nothing is a definitive answer and stops the retries;
/// `parse` decides what the bytes mean.
fn windows_read<T>(
    script: &str,
    delay_ms: u64,
    mut invoke: impl FnMut(&str) -> WindowsOutput,
    parse: impl Fn(&[u8]) -> Option<T>,
) -> Option<T> {
    for attempt in 1..=WINDOWS_READ_ATTEMPTS {
        match invoke(script) {
            WindowsOutput::Output(bytes) => return parse(&bytes),
            WindowsOutput::Failed if attempt < WINDOWS_READ_ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            WindowsOutput::Failed => return None,
        }
    }
    None
}

fn run_powershell(script: &str) -> WindowsOutput {
    match Command::new("powershell.exe")
        .args(["-NonInteractive", "-NoProfile", "-Command", script])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => WindowsOutput::Output(output.stdout),
        _ => WindowsOutput::Failed,
    }
}

fn read_windows() -> Option<Content> {
    windows_read(
        WINDOWS_IMAGE_SCRIPT,
        WINDOWS_RETRY_DELAY_MS,
        run_powershell,
        parse_windows_image,
    )
}

fn read_text_windows() -> Option<Content> {
    windows_read(
        "Get-Clipboard -Raw",
        WINDOWS_RETRY_DELAY_MS,
        run_powershell,
        parse_windows_text,
    )
}

/// The image bridge returns base64 of the PNG bytes. Keep it only when it is
/// canonical base64, so console noise can never reach the engine as pixels.
fn parse_windows_image(bytes: &[u8]) -> Option<Content> {
    let data = parse_base64_payload(bytes)?;
    Some(Content::Image {
        mime: "image/png".into(),
        data,
    })
}

fn parse_base64_payload(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    let canonical = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='));
    canonical.then(|| text.to_string())
}

/// `-Raw` output carries one console-added newline terminator; a newline the
/// clipboard itself holds survives as the second one, so trim exactly one.
fn parse_windows_text(bytes: &[u8]) -> Option<Content> {
    non_empty_text(trim_console_newline(
        String::from_utf8_lossy(bytes).to_string(),
    ))
}

fn trim_console_newline(text: String) -> String {
    text.strip_suffix("\r\n")
        .map(str::to_string)
        .unwrap_or_else(|| text.strip_suffix('\n').map(str::to_string).unwrap_or(text))
}

fn read_linux(wayland: bool) -> Option<Content> {
    let mut candidates: Vec<(&str, Vec<&str>)> = Vec::new();
    if wayland {
        candidates.push(("wl-paste", vec!["-t", "image/png"]));
    }
    candidates.push((
        "xclip",
        vec!["-selection", "clipboard", "-t", "image/png", "-o"],
    ));
    for (program, args) in candidates {
        let Some(output) = Command::new(program)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .ok()
        else {
            continue;
        };
        if output.status.success() && !output.stdout.is_empty() {
            return Some(Content::Image {
                mime: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode(output.stdout),
            });
        }
    }
    None
}

fn read_text_linux(wayland: bool) -> Option<Content> {
    let mut candidates: Vec<(&str, Vec<&str>)> = Vec::new();
    if wayland {
        candidates.push(("wl-paste", vec!["--no-newline"]));
    }
    candidates.push(("xclip", vec!["-selection", "clipboard", "-o"]));
    candidates.push(("xsel", vec!["--clipboard", "--output"]));
    for (program, args) in candidates {
        let Some(output) = Command::new(program)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .ok()
        else {
            continue;
        };
        if output.status.success() {
            if let Some(content) =
                non_empty_text(String::from_utf8_lossy(&output.stdout).to_string())
            {
                return Some(content);
            }
        }
    }
    None
}

fn non_empty_text(text: String) -> Option<Content> {
    if text.is_empty() {
        return None;
    }
    Some(Content::Text(text))
}

fn run_with_input(program: &str, args: &[String], input: &[u8]) {
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    let _ = child.wait();
}

/// PATH lookup without pulling in a crate. Windows command names are matched
/// case-insensitively and with PATHEXT extensions.
pub fn command_exists(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let names = if cfg!(windows) {
        let extensions = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut names = vec![name.to_string()];
        names.extend(
            extensions
                .into_iter()
                .filter(|extension| !extension.is_empty())
                .map(|extension| format!("{name}{extension}")),
        );
        names
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&paths).any(|dir| {
        names.iter().any(|name| {
            let candidate = dir.join(name);
            // One expression per platform: the early return followed by a bare
            // `true` reads as a boolean literal to clippy >= 1.100, which then
            // fails `-D warnings` on the Windows leg only.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                candidate.is_file()
                    && candidate
                        .metadata()
                        .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                candidate.is_file()
            }
        })
    })
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has(name: &'static str) -> impl Fn(&str) -> bool {
        move |candidate| candidate == name
    }

    #[test]
    fn osc52_wraps_for_tmux_and_screen() {
        assert_eq!(osc52("hi", false, false), "\x1b]52;c;aGk=\x07");
        let screen = osc52("hi", false, true);
        assert_eq!(screen, "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
        let tmux = osc52("hi", true, false);
        assert!(tmux.starts_with("\x1b]52;c;aGk=\x07\x1bPtmux;"));
    }

    #[test]
    fn copy_prefers_platform_native_commands_in_the_typescript_order() {
        assert_eq!(
            copy_command("macos", false, has("pbcopy")).map(|item| item.0),
            Some("pbcopy".into())
        );
        assert_eq!(
            copy_command("linux", true, has("xclip")).map(|item| item.0),
            Some("xclip".into())
        );
        assert_eq!(
            copy_command("linux", true, |name| name == "wl-copy").map(|item| item.0),
            Some("wl-copy".into())
        );
        assert_eq!(
            copy_command("linux", false, |_| true).map(|item| item.0),
            Some("xclip".into())
        );
        assert_eq!(copy_command("freebsd", false, |_| true), None);
    }

    #[test]
    fn the_host_clipboard_file_is_served_once_and_only_while_fresh() {
        let dir = std::env::temp_dir().join(format!("miao-clipboard-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("fresh.png");
        std::fs::write(&fresh, b"png").unwrap();
        let content = read_host_image(Some(&fresh)).expect("fresh image");
        assert_eq!(
            content,
            Content::Image {
                mime: "image/png".into(),
                data: "cG5n".into()
            }
        );
        assert!(!fresh.exists(), "the handoff file is consumed");

        let stale = dir.join("stale.png");
        std::fs::write(&stale, b"png").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(30);
        let file = std::fs::File::options().write(true).open(&stale).unwrap();
        file.set_modified(old).unwrap();
        drop(file);
        assert!(read_host_image(Some(&stale)).is_none());
        assert!(!stale.exists(), "a stale handoff is removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_handoff_file_is_not_an_image() {
        let dir = std::env::temp_dir().join(format!("miao-clipboard-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.png");
        std::fs::write(&path, b"").unwrap();
        assert!(read_host_image(Some(&path)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The Windows retry harness: a contended clipboard can fail to open a few
    /// times before it answers. `windows_read` takes its script runner as a
    /// parameter, so the retry semantics run on every platform's CI, not only
    /// where a clipboard exists.
    #[test]
    fn windows_read_retries_a_failed_script_until_it_runs() {
        let mut attempts = 0;
        let content = windows_read(
            "script",
            0,
            |_| {
                attempts += 1;
                if attempts < 3 {
                    WindowsOutput::Failed
                } else {
                    WindowsOutput::Output(b"cG5n".to_vec())
                }
            },
            parse_windows_image,
        );
        assert_eq!(attempts, 3, "the third attempt carried the answer");
        assert_eq!(
            content,
            Some(Content::Image {
                mime: "image/png".into(),
                data: "cG5n".into()
            })
        );
    }

    /// A script that ran and found nothing is a definitive answer: retrying
    /// cannot turn "no image" into one, so the loop stops after one attempt.
    #[test]
    fn windows_read_stops_at_a_definitive_answer() {
        let mut attempts = 0;
        let content = windows_read(
            "script",
            0,
            |_| {
                attempts += 1;
                WindowsOutput::Output(Vec::new())
            },
            parse_windows_image,
        );
        assert_eq!(attempts, 1, "an empty stdout is an answer, not a failure");
        assert_eq!(content, None);
    }

    /// A wedged clipboard must not hang the read: the attempts are bounded.
    #[test]
    fn windows_read_gives_up_after_the_bounded_attempts() {
        let mut attempts = 0;
        let content = windows_read(
            "script",
            0,
            |_| {
                attempts += 1;
                WindowsOutput::Failed
            },
            parse_windows_image,
        );
        assert_eq!(attempts, WINDOWS_READ_ATTEMPTS);
        assert_eq!(content, None);
    }

    /// Console noise can never reach the engine as pixels: only canonical
    /// base64 passes as the image bridge's payload.
    #[test]
    fn parse_windows_image_accepts_only_canonical_base64() {
        assert_eq!(
            parse_windows_image(b"cG5n\n"),
            Some(Content::Image {
                mime: "image/png".into(),
                data: "cG5n".into()
            })
        );
        assert_eq!(parse_windows_image(b"Add-Type : error at line 1"), None);
        assert_eq!(parse_windows_image(b""), None);
    }

    /// PowerShell's `-Raw` adds one newline as a console terminator; a newline
    /// the clipboard itself holds survives as the second one.
    #[test]
    fn parse_windows_text_trims_only_the_console_newline() {
        assert_eq!(
            parse_windows_text(b"hello\r\n"),
            Some(Content::Text("hello".into()))
        );
        assert_eq!(
            parse_windows_text(b"hello\n"),
            Some(Content::Text("hello".into()))
        );
        assert_eq!(
            parse_windows_text(b"a\r\nb\r\n"),
            Some(Content::Text("a\r\nb".into()))
        );
        assert_eq!(
            parse_windows_text(b"\r\n"),
            None,
            "a bare console terminator is not text"
        );
    }
}
