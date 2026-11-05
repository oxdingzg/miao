//! Engine-side WARN and ERROR lines.
//!
//! The interactive path runs the Rust TUI and this engine only, so the
//! TypeScript file logger never loads: a failed run left no trace on disk and
//! the only copy of its error was the TUI's 8 KiB stderr ring, gone with the
//! window. Failures therefore append here instead, into the same `log/miao.log`
//! the other channels write, with the same size rotation, so one file answers
//! "what happened" no matter which entry point was running.
//!
//! Recording is best effort: a diagnostic that cannot be written must never
//! fail the work it was describing.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The TypeScript writer rotates at this size; matching it keeps one channel
/// from growing a file the other channel then prunes without warning.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// A single value never carries more than this, so one pathological provider
/// body cannot fill the file in a single write.
const MAX_VALUE_BYTES: usize = 8 * 1024;

pub fn warn(message: &str, fields: &[(&str, String)]) {
    record("WARN", message, fields);
}

pub fn error(message: &str, fields: &[(&str, String)]) {
    record("ERROR", message, fields);
}

fn record(level: &str, message: &str, fields: &[(&str, String)]) {
    let Some(file) = log_file() else { return };
    append(&file, level, message, fields, chrono::Utc::now());
}

/// `MIAO_LOG_FILE` names the file directly for tests and for a host that keeps
/// diagnostics somewhere else; otherwise the product's data root decides, which
/// is where every other channel looks.
fn log_file() -> Option<PathBuf> {
    if let Some(file) = std::env::var_os("MIAO_LOG_FILE") {
        return Some(PathBuf::from(file));
    }
    crate::cli::data_home().map(|root| root.join("log").join("miao.log"))
}

fn append(
    file: &Path,
    level: &str,
    message: &str,
    fields: &[(&str, String)],
    now: chrono::DateTime<chrono::Utc>,
) {
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut line = format!(
        "timestamp={} level={} message={}",
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        value(message)
    );
    for (key, field) in fields {
        line.push_str(&format!(" {key}={}", value(field)));
    }
    line.push('\n');
    // Rotation reopens the path on every line, so two processes writing the
    // same file cannot keep appending into a renamed one.
    let size = std::fs::metadata(file).map(|meta| meta.len()).unwrap_or(0);
    if size + line.len() as u64 > MAX_FILE_BYTES {
        let _ = std::fs::rename(file, file.with_extension("log.previous"));
    }
    let Ok(mut handle) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    else {
        return;
    };
    let _ = handle.write_all(line.as_bytes());
}

/// One `key=value` field: bare when it needs no quoting, JSON-quoted otherwise,
/// the same shape the TypeScript formatter emits so both writers stay readable
/// by one parser.
fn value(text: &str) -> String {
    let flat = text.replace(['\n', '\r'], " ");
    let bounded = match flat.char_indices().nth(MAX_VALUE_BYTES) {
        Some((at, _)) => &flat[..at],
        None => &flat,
    };
    if bounded.contains(|character: char| {
        character.is_whitespace() || character == '=' || character == '"' || character == '\\'
    }) {
        return serde_json::Value::String(bounded.to_owned()).to_string();
    }
    bounded.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "miao-diagnostics-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("log").join("miao.log")
    }

    fn read(file: &Path) -> String {
        std::fs::read_to_string(file).unwrap()
    }

    #[test]
    fn a_line_carries_the_level_message_and_quoted_fields() {
        let file = scratch();
        append(
            &file,
            "WARN",
            "provider failed",
            &[
                ("run", "run-1".to_owned()),
                ("error", "HTTP 502: used body".to_owned()),
            ],
            chrono::Utc::now(),
        );
        let line = read(&file);
        assert!(line.starts_with("timestamp="), "{line}");
        assert!(line.contains(" level=WARN "), "{line}");
        assert!(line.contains("message=\"provider failed\""), "{line}");
        assert!(line.contains("run=run-1 "), "{line}");
        assert!(line.contains("error=\"HTTP 502: used body\""), "{line}");
        assert!(line.ends_with('\n'));
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn one_line_stays_one_line() {
        let file = scratch();
        append(
            &file,
            "ERROR",
            "run failed",
            &[("error", "first\nsecond\rthird".to_owned())],
            chrono::Utc::now(),
        );
        assert_eq!(read(&file).lines().count(), 1);
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_file_rotates_before_it_grows_past_the_bound() {
        let file = scratch();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, vec![b'x'; MAX_FILE_BYTES as usize - 4]).unwrap();
        append(&file, "WARN", "rotated", &[], chrono::Utc::now());
        let previous = file.with_extension("log.previous");
        assert_eq!(
            std::fs::metadata(&previous).unwrap().len(),
            MAX_FILE_BYTES - 4
        );
        assert!(read(&file).contains("message=rotated"));
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }
}
