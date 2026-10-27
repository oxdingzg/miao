//! Attention notifications and sounds.
//!
//! The TypeScript host asks the renderer to show a desktop notification and
//! plays a bundled sound. A terminal-only client has neither, so this module
//! emits the same terminal notifications the renderer does (OSC 9 or OSC 777,
//! wrapped for tmux) and falls back to the terminal bell when no sound file is
//! configured.

use std::io::{self, Write};
use std::process::{Command, Stdio};

use crate::config::AttentionConfig;

const TITLE_LIMIT: usize = 80;
const MESSAGE_LIMIT: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Done,
    Error,
    Permission,
    Question,
}

impl Kind {
    pub fn sound(self) -> &'static str {
        match self {
            Kind::Done => "done",
            Kind::Error => "error",
            Kind::Permission => "permission",
            Kind::Question => "question",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Kind::Done => "Session done",
            Kind::Error => "Session error",
            Kind::Permission => "Permission needs input",
            Kind::Question => "Question needs input",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Unknown,
    Focused,
    Blurred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notified {
    pub notification: bool,
    pub sound: bool,
}

/// What the terminal around us can do, captured once at startup so tests can
/// exercise the sequence builders without touching the process environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terminal {
    pub program: Option<String>,
    pub tmux: bool,
    pub windows_terminal: bool,
    pub os: &'static str,
}

impl Terminal {
    pub fn current() -> Self {
        Self {
            program: std::env::var("TERM_PROGRAM").ok(),
            tmux: std::env::var_os("TMUX").is_some(),
            windows_terminal: std::env::var_os("WT_SESSION").is_some(),
            os: std::env::consts::OS,
        }
    }
}

pub struct Attention {
    config: AttentionConfig,
    terminal: Terminal,
    focus: Focus,
}

impl Attention {
    pub fn new(config: AttentionConfig) -> Self {
        Self::with_terminal(config, Terminal::current())
    }

    pub fn with_terminal(config: AttentionConfig, terminal: Terminal) -> Self {
        Self {
            config,
            terminal,
            focus: Focus::Unknown,
        }
    }

    pub fn focus(&self) -> Focus {
        self.focus
    }

    pub fn set_focus(&mut self, focused: bool) {
        self.focus = if focused {
            Focus::Focused
        } else {
            Focus::Blurred
        };
    }

    /// Show the notification the user's settings allow. Every failure is
    /// silent: attention is a convenience and must never end a Session.
    pub fn notify(&mut self, kind: Kind, title: &str) -> Notified {
        let mut notified = Notified {
            notification: false,
            sound: false,
        };
        if !self.config.enabled {
            return notified;
        }
        let message = normalize(kind.message(), MESSAGE_LIMIT);
        let title = normalize(
            if title.trim().is_empty() {
                "miao"
            } else {
                title
            },
            TITLE_LIMIT,
        );
        if self.config.notifications && self.focus == Focus::Blurred {
            notified.notification = emit(&sequence(&title, &message, &self.terminal));
        }
        if self.config.sound {
            notified.sound = play_sound(
                self.config.sounds.get(kind.sound()).map(String::as_str),
                self.config.volume,
                self.terminal.os,
            );
        }
        notified
    }
}

/// The bytes a notification needs, without a trailing newline. `None` only
/// when the terminal cannot be addressed at all.
pub fn sequence(title: &str, message: &str, terminal: &Terminal) -> String {
    let program = terminal
        .program
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let body = if program == "iterm.app" || program == "wezterm" || terminal.windows_terminal {
        format!("\x1b]9;{message}\x07")
    } else {
        format!("\x1b]777;notify;{title};{message}\x07")
    };
    if terminal.tmux {
        // Same pair the clipboard writer emits: the plain sequence for a
        // passthrough-aware multiplexer, the wrapped one for the outer
        // terminal.
        format!("{body}\x1bPtmux;\x1b{body}\x1b\\")
    } else {
        body
    }
}

/// Strip ANSI, fold line breaks, drop control characters, then clamp to
/// `limit` characters. Mirrors `normalizeText` in `attention.ts`.
pub fn normalize(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for next in chars.by_ref() {
                        if next == '\x07' {
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            }
            continue;
        }
        if c == '\r' || c == '\n' {
            while out.ends_with([' ', '\t']) {
                out.pop();
            }
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
            while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
                chars.next();
            }
            continue;
        }
        if c.is_control() {
            continue;
        }
        out.push(c);
    }
    out.trim().chars().take(limit).collect()
}

fn emit(sequence: &str) -> bool {
    let mut stdout = io::stdout();
    stdout
        .write_all(sequence.as_bytes())
        .and_then(|_| stdout.flush())
        .is_ok()
}

/// Play a configured sound file, or ring the terminal bell. Volume is only
/// applied where the platform player accepts it.
fn play_sound(path: Option<&str>, volume: f32, os: &str) -> bool {
    if let Some(path) = path {
        if std::path::Path::new(path).is_file() && play_file(path, volume, os) {
            return true;
        }
    }
    emit("\x07")
}

fn play_file(path: &str, volume: f32, os: &str) -> bool {
    let volume = volume.clamp(0.0, 1.0).to_string();
    let candidates: &[(&str, &[&str])] = match os {
        "macos" => &[("afplay", &["-v"])],
        "linux" => &[("paplay", &[]), ("aplay", &["-q"])],
        "windows" => &[(
            "powershell.exe",
            &[
                "-NonInteractive",
                "-NoProfile",
                "-Command",
                "(New-Object Media.SoundPlayer $args[0]).PlaySync()",
            ],
        )],
        _ => &[],
    };
    for (program, prefix) in candidates {
        let mut command = Command::new(program);
        command.args(*prefix);
        if *program == "afplay" {
            command.arg(&volume);
        }
        command
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if command.spawn().is_ok() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal(program: Option<&str>) -> Terminal {
        Terminal {
            program: program.map(str::to_string),
            tmux: false,
            windows_terminal: false,
            os: "linux",
        }
    }

    fn enabled() -> AttentionConfig {
        AttentionConfig {
            enabled: true,
            ..AttentionConfig::default()
        }
    }

    #[test]
    fn iterm_and_wezterm_get_osc_9_and_the_rest_get_osc_777() {
        let seq = sequence("miao", "Session done", &terminal(Some("iTerm.app")));
        assert_eq!(seq, "\x1b]9;Session done\x07");
        let seq = sequence("build", "Session done", &terminal(Some("WezTerm")));
        assert_eq!(seq, "\x1b]9;Session done\x07");
        let seq = sequence("build", "Session done", &terminal(Some("Apple_Terminal")));
        assert_eq!(seq, "\x1b]777;notify;build;Session done\x07");
        let mut wt = terminal(None);
        wt.windows_terminal = true;
        assert_eq!(
            sequence("miao", "Permission needs input", &wt),
            "\x1b]9;Permission needs input\x07"
        );
    }

    #[test]
    fn tmux_gets_the_plain_sequence_and_its_passthrough_twin() {
        let mut tmux = terminal(None);
        tmux.tmux = true;
        let seq = sequence("miao", "done", &tmux);
        assert!(seq.starts_with("\x1b]777;notify;miao;done\x07\x1bPtmux;\x1b"));
        assert!(seq.ends_with("\x1b\\"));
    }

    #[test]
    fn normalization_collapses_lines_strips_ansi_and_clamps() {
        assert_eq!(normalize("a\n\n  b\t c", 240), "a b c");
        assert_eq!(normalize("\x1b[31mred\x1b[0m", 240), "red");
        assert_eq!(normalize("x\u{0007}y", 240), "xy");
        assert_eq!(normalize(&"é".repeat(300), 240).chars().count(), 240);
        assert_eq!(normalize("", 240), "");
    }

    #[test]
    fn notifications_need_blurred_focus_but_sounds_do_not() {
        let mut attention = Attention::with_terminal(
            AttentionConfig {
                enabled: true,
                sound: false,
                ..AttentionConfig::default()
            },
            terminal(None),
        );
        let notified = attention.notify(Kind::Done, "miao");
        assert!(!notified.notification, "focus is unknown");
        attention.set_focus(true);
        let notified = attention.notify(Kind::Done, "miao");
        assert!(!notified.notification, "focused");
        attention.set_focus(false);
        let notified = attention.notify(Kind::Done, "miao");
        assert!(notified.notification);
    }

    #[test]
    fn disabled_attention_does_nothing() {
        let mut attention = Attention::with_terminal(AttentionConfig::default(), terminal(None));
        attention.set_focus(false);
        let notified = attention.notify(Kind::Error, "miao");
        assert_eq!(
            notified,
            Notified {
                notification: false,
                sound: false
            }
        );
    }

    #[test]
    fn sound_names_follow_the_typescript_pack() {
        assert_eq!(Kind::Done.sound(), "done");
        assert_eq!(Kind::Error.sound(), "error");
        assert_eq!(Kind::Permission.sound(), "permission");
        assert_eq!(Kind::Question.sound(), "question");
    }

    #[test]
    fn an_enabled_attention_with_a_missing_sound_file_still_rings_the_bell() {
        // No configured path: the bell branch is reached without spawning a
        // player, so the assertion is about the decision, not the audio device.
        let mut config = enabled();
        config.notifications = false;
        config.sounds.clear();
        let mut attention = Attention::with_terminal(config, terminal(None));
        let notified = attention.notify(Kind::Done, "miao");
        assert!(notified.sound);
    }
}
