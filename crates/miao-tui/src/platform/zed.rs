//! Zed editor selection context.
//!
//! Inside Zed's terminal the host knows which file and range the user has
//! selected, and the TypeScript TUI reads it straight from Zed's SQLite
//! database. The Rust client does the same through the system `sqlite3` CLI so
//! the crate does not take a C SQLite dependency. When `sqlite3` is missing the
//! integration is silently unavailable, exactly like a missing database.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub file_path: String,
    pub ranges: Vec<Range>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range {
    pub text: String,
    pub start_line: u64,
    pub start_character: u64,
    pub end_line: u64,
    pub end_character: u64,
}

impl Range {
    fn selected(&self) -> bool {
        self.start_line != self.end_line || self.start_character != self.end_character
    }
}

#[derive(Debug, Deserialize)]
struct EditorRow {
    item_kind: String,
    editor_id: Option<i64>,
    workspace_id: i64,
    workspace_paths: Option<String>,
    timestamp: String,
    buffer_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SelectionRow {
    selection_start: Option<i64>,
    selection_end: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ContentsRow {
    contents: Option<String>,
}

/// Only a Zed terminal carries the ambient selection state.
pub fn enabled() -> bool {
    std::env::var("ZED_TERM").is_ok_and(|value| value == "true")
        || std::env::var("TERM_PROGRAM").is_ok_and(|value| value.eq_ignore_ascii_case("zed"))
}

pub fn db_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MIAO_ZED_DB") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    [
        home.join("Library/Application Support/Zed/db/0-stable/db.sqlite"),
        home.join(".local/share/zed/db/0-stable/db.sqlite"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

/// The active editor in the workspace that contains `cwd`.
pub fn selection(cwd: &Path) -> Option<Selection> {
    if !enabled() {
        return None;
    }
    let db = db_path()?;
    let rows = query::<EditorRow>(
        &db,
        "select i.kind as item_kind, e.item_id as editor_id, i.workspace_id as workspace_id, \
         w.paths as workspace_paths, w.timestamp as timestamp, e.buffer_path as buffer_path \
         from items i \
         join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id \
         join workspaces w on w.workspace_id = i.workspace_id \
         left join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id \
         where i.active = 1 and p.active = 1 order by w.timestamp desc",
    )?;
    let row = rows
        .into_iter()
        .map(|row| {
            let score = workspace_score(row.workspace_paths.as_deref(), cwd);
            (row, score)
        })
        .filter(|(_, score)| *score > 0)
        .max_by(|(left, left_score), (right, right_score)| {
            left_score
                .cmp(right_score)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
        })?
        .0;
    if row.item_kind != "Editor" {
        return None;
    }
    let editor_id = row.editor_id?;
    let buffer_path = row.buffer_path?;
    let selections = query::<SelectionRow>(
        &db,
        &format!(
            "select start as selection_start, end as selection_end from editor_selections \
             where editor_id = {editor_id} and workspace_id = {}",
            row.workspace_id
        ),
    )?;
    let mut ranges: Vec<(i64, i64)> = selections
        .into_iter()
        .filter_map(|row| Some((row.selection_start?, row.selection_end?)))
        .map(|(start, end)| (start.min(end), start.max(end)))
        .collect();
    if ranges.is_empty() {
        return None;
    }
    ranges.sort_unstable();
    let contents = query::<ContentsRow>(
        &db,
        &format!(
            "select contents from editors where item_id = {editor_id} and workspace_id = {}",
            row.workspace_id
        ),
    )
    .and_then(|rows| rows.into_iter().next())
    .and_then(|row| row.contents)
    .or_else(|| std::fs::read_to_string(&buffer_path).ok())?;
    let ranges = ranges
        .into_iter()
        .map(|(start, end)| range(&contents, start, end))
        .collect();
    Some(Selection {
        file_path: buffer_path,
        ranges,
    })
}

fn query<T: for<'de> Deserialize<'de>>(db: &Path, sql: &str) -> Option<Vec<T>> {
    let output = Command::new("sqlite3")
        .args(["-readonly", "-json"])
        .arg(db)
        .arg(sql)
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn workspace_score(paths: Option<&str>, cwd: &Path) -> usize {
    paths
        .map(workspace_paths)
        .unwrap_or_default()
        .into_iter()
        .filter(|path| contains(path, cwd))
        .map(|path| path.as_os_str().len())
        .max()
        .unwrap_or(0)
}

fn workspace_paths(value: &str) -> Vec<PathBuf> {
    serde_json::from_str::<Vec<String>>(value)
        .map(|paths| paths.into_iter().map(PathBuf::from).collect())
        .unwrap_or_else(|_| {
            value
                .lines()
                .filter(|line| !line.is_empty())
                .map(PathBuf::from)
                .collect()
        })
}

fn contains(parent: &Path, child: &Path) -> bool {
    let parent = lexical(parent);
    let child = lexical(child);
    child.starts_with(&parent)
}

/// Resolve `.` and `..` without touching the filesystem (the workspace path in
/// Zed may be stale and `canonicalize` would fail on it).
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn range(text: &str, start: i64, end: i64) -> Range {
    let start = char_index(text, start);
    let end = char_index(text, end);
    let (start_line, start_character) = position(text, start);
    let (end_line, end_character) = position(text, end);
    Range {
        text: text
            .chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect(),
        start_line,
        start_character,
        end_line,
        end_character,
    }
}

/// Zed records UTF-8 byte offsets; the prompt context works in characters.
fn char_index(text: &str, byte_offset: i64) -> usize {
    if byte_offset <= 0 {
        return 0;
    }
    let mut bytes = 0i64;
    for (index, character) in text.char_indices() {
        let next = index + character.len_utf8();
        bytes += character.len_utf8() as i64;
        if bytes >= byte_offset {
            return text[..next].chars().count();
        }
    }
    text.chars().count()
}

/// 1-based line and character, as `offsetsToSelection` produces them.
fn position(text: &str, char_offset: usize) -> (u64, u64) {
    let mut line = 1u64;
    let mut character = 1u64;
    for character_value in text.chars().take(char_offset) {
        if character_value == '\n' {
            line += 1;
            character = 1;
        } else {
            character += 1;
        }
    }
    (line, character)
}

/// The text the prompt prepends, identical to `formatEditorContext`. A
/// cursor with no selected range still names the open file, like the host.
pub fn context(selection: &Selection) -> Option<String> {
    let selected: Vec<&Range> = selection
        .ranges
        .iter()
        .filter(|range| range.selected())
        .collect();
    if selected.is_empty() {
        return Some(format!(
            "<system-reminder>Note: The user opened the file {:?}. This may or may not be relevant to the current task.</system-reminder>\n",
            selection.file_path
        ));
    }
    let ranges: Vec<String> = selected
        .iter()
        .enumerate()
        .map(|(index, range)| {
            let prefix = if selected.len() > 1 {
                format!("Selection {}: ", index + 1)
            } else {
                String::new()
            };
            format!(
                "Note: The user selected {prefix}{} from {:?}. ```{}```\n\n",
                label(range),
                selection.file_path,
                range.text
            )
        })
        .collect();
    Some(format!(
        "<system-reminder>{} This may or may not be relevant to the current task.</system-reminder>\n",
        ranges.join("\n")
    ))
}

fn label(range: &Range) -> String {
    if range.start_line == range.end_line {
        format!("#{}", range.start_line)
    } else {
        format!("#{}-{}", range.start_line, range.end_line)
    }
}

/// Stable identity of a selection, so the same selection is not prepended to
/// every prompt.
pub fn key(selection: &Selection) -> String {
    let mut key = selection.file_path.clone();
    for range in &selection.ranges {
        key.push_str(&format!(
            "|{}:{}:{}:{}:{}",
            range.start_line,
            range.start_character,
            range.end_line,
            range.end_character,
            range.text
        ));
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_offsets_become_characters_lines_and_columns() {
        let text = "alpha\nβeta\ngamma";
        // `β` is two bytes, so byte 7 is the character after the newline.
        let range = range(text, 6, 7);
        assert_eq!(range.text, "β");
        assert_eq!((range.start_line, range.start_character), (2, 1));
        assert_eq!((range.end_line, range.end_character), (2, 2));
    }

    #[test]
    fn a_multi_line_range_uses_the_line_pair_label() {
        let selection = Selection {
            file_path: "/tmp/x.rs".into(),
            ranges: vec![range("a\nb\nc", 0, 3)],
        };
        let context = context(&selection).expect("context");
        assert!(
            context.contains("selected #1-2 from \"/tmp/x.rs\""),
            "{context}"
        );
        assert!(context.contains("```a\nb```"), "{context}");
        assert!(context.ends_with("</system-reminder>\n"));
    }

    #[test]
    fn a_cursor_without_a_selection_names_the_open_file() {
        let selection = Selection {
            file_path: "/tmp/x.rs".into(),
            ranges: vec![range("abc", 1, 1)],
        };
        let context = context(&selection).expect("context");
        assert!(
            context.contains("The user opened the file \"/tmp/x.rs\""),
            "{context}"
        );
        assert!(!context.contains("selected"), "{context}");
    }

    #[test]
    fn multiple_ranges_are_numbered() {
        let selection = Selection {
            file_path: "/tmp/x.rs".into(),
            ranges: vec![
                range("one\ntwo\nthree", 0, 3),
                range("one\ntwo\nthree", 4, 7),
            ],
        };
        let context = context(&selection).expect("context");
        assert!(context.contains("Selection 1: "), "{context}");
        assert!(context.contains("Selection 2: "), "{context}");
    }

    #[test]
    fn workspace_paths_accept_json_or_newline_lists() {
        assert_eq!(
            workspace_paths("[\"/a\",\"/b\"]"),
            vec![PathBuf::from("/a"), PathBuf::from("/b")]
        );
        assert_eq!(
            workspace_paths("/a\n/b"),
            vec![PathBuf::from("/a"), PathBuf::from("/b")]
        );
        assert!(contains(Path::new("/a"), Path::new("/a/b/c")));
        assert!(!contains(Path::new("/a"), Path::new("/ab")));
        assert!(contains(Path::new("/a/../a"), Path::new("/a/b")));
    }

    #[test]
    fn the_key_tracks_the_selection_not_the_database() {
        let first = Selection {
            file_path: "/tmp/x".into(),
            ranges: vec![range("abc", 0, 1)],
        };
        let second = Selection {
            file_path: "/tmp/x".into(),
            ranges: vec![range("abc", 0, 2)],
        };
        assert_ne!(key(&first), key(&second));
        assert_eq!(key(&first), key(&first.clone()));
    }
}
