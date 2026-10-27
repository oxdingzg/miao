//! The composer's text model and key handling.
//!
//! The editor is deliberately independent of ratatui: it owns a UTF-8 buffer
//! and a byte cursor that always sits on a char boundary, and it measures
//! motion and rendering in display cells (`unicode-width`) so CJK text moves and
//! scrolls the way a terminal shows it. Everything that touches session state
//! goes back to the UI as an [`Action`].

use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use unicode_width::UnicodeWidthChar;

const HISTORY_LIMIT: usize = 100;
const FILE_LIMIT: usize = 2000;
const TAB_CELLS: usize = 4;

pub enum Action {
    None,
    Submit(String),
    Quit,
}

#[derive(Debug, Default)]
pub struct Editor {
    buffer: String,
    /// Byte offset into `buffer`, always on a char boundary.
    cursor: usize,
    /// Display column a run of up/down motion is aiming at. Cleared by any
    /// horizontal edit so the next run re-reads the cursor.
    goal: Option<usize>,
}

impl Editor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> &str {
        &self.buffer
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn line_count(&self) -> usize {
        self.buffer.split('\n').count()
    }

    pub fn set_text(&mut self, text: &str) {
        self.buffer = text.to_string();
        self.cursor = self.buffer.len();
        self.goal = None;
    }

    /// Clear the buffer and hand the submitted text to the caller.
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        self.goal = None;
        std::mem::take(&mut self.buffer)
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
        self.goal = None;
    }

    pub fn insert_char(&mut self, c: char) {
        self.buffer.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.goal = None;
    }

    pub fn insert_str(&mut self, text: &str) {
        self.buffer.insert_str(self.cursor, text);
        self.cursor += text.len();
        self.goal = None;
    }

    /// Replace `start..end` with `text`; used by completion and history.
    pub fn replace(&mut self, start: usize, end: usize, text: &str) {
        self.buffer.replace_range(start..end, text);
        self.cursor = start + text.len();
        self.goal = None;
    }

    pub fn backspace(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        let start = self.prev_boundary(self.cursor);
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_forward(&mut self) -> bool {
        if self.cursor == self.buffer.len() {
            return false;
        }
        let end = self.next_boundary(self.cursor);
        self.buffer.replace_range(self.cursor..end, "");
        self.goal = None;
        true
    }

    pub fn delete_word_backward(&mut self) -> bool {
        let start = self.word_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_to_line_start(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_to_line_end(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.buffer.replace_range(self.cursor..end, "");
        self.goal = None;
        true
    }

    pub fn move_left(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor = self.prev_boundary(self.cursor);
        self.goal = None;
        true
    }

    pub fn move_right(&mut self) -> bool {
        if self.cursor == self.buffer.len() {
            return false;
        }
        self.cursor = self.next_boundary(self.cursor);
        self.goal = None;
        true
    }

    pub fn move_word_forward(&mut self) -> bool {
        let end = self.word_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.cursor = end;
        self.goal = None;
        true
    }

    pub fn move_word_backward(&mut self) -> bool {
        let start = self.word_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn move_line_start(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn move_line_end(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.cursor = end;
        self.goal = None;
        true
    }

    pub fn move_up(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == 0 {
            return false;
        }
        let goal = self.motion_goal();
        let previous_end = start - 1;
        let previous_start = self.line_start(previous_end);
        self.cursor = index_at_cell(
            &self.buffer[previous_start..previous_end],
            previous_start,
            goal,
        );
        true
    }

    pub fn move_down(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end == self.buffer.len() {
            return false;
        }
        let goal = self.motion_goal();
        let next_start = end + 1;
        let next_end = self.line_end(next_start);
        self.cursor = index_at_cell(&self.buffer[next_start..next_end], next_start, goal);
        true
    }

    /// Line index (zero-based) and display column of the cursor, in cells.
    pub fn cursor_position(&self) -> (usize, usize) {
        let start = self.line_start(self.cursor);
        let line = self.buffer[..start].matches('\n').count();
        (line, self.column_cells(self.cursor))
    }

    /// The visible lines, with tabs expanded for rendering.
    pub fn lines(&self) -> impl Iterator<Item = String> + '_ {
        self.buffer.split('\n').map(|line| {
            line.chars()
                .flat_map(|c| {
                    if c == '\t' {
                        vec![' '; TAB_CELLS].into_iter()
                    } else {
                        vec![c].into_iter()
                    }
                })
                .collect()
        })
    }

    fn motion_goal(&mut self) -> usize {
        match self.goal {
            Some(goal) => goal,
            None => {
                let goal = self.column_cells(self.cursor);
                self.goal = Some(goal);
                goal
            }
        }
    }

    fn column_cells(&self, index: usize) -> usize {
        self.buffer[self.line_start(index)..index]
            .chars()
            .map(cell_width)
            .sum()
    }

    fn line_start(&self, index: usize) -> usize {
        self.buffer[..index]
            .rfind('\n')
            .map_or(0, |newline| newline + 1)
    }

    fn line_end(&self, index: usize) -> usize {
        self.buffer[index..]
            .find('\n')
            .map_or(self.buffer.len(), |newline| index + newline)
    }

    fn prev_boundary(&self, index: usize) -> usize {
        self.buffer[..index]
            .char_indices()
            .next_back()
            .map_or(0, |(offset, _)| offset)
    }

    fn next_boundary(&self, index: usize) -> usize {
        self.buffer[index..]
            .chars()
            .next()
            .map_or(self.buffer.len(), |c| index + c.len_utf8())
    }

    fn word_start(&self, index: usize) -> usize {
        let head = &self.buffer[..index];
        let trimmed = head.trim_end_matches(char::is_whitespace);
        let boundary = trimmed
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(0, |(offset, c)| offset + c.len_utf8());
        boundary
    }

    fn word_end(&self, index: usize) -> usize {
        let rest = self.buffer[index..].trim_start_matches(char::is_whitespace);
        let skipped = self.buffer[index..].len() - rest.len();
        let end = rest
            .char_indices()
            .find(|(_, c)| c.is_whitespace())
            .map_or(rest.len(), |(offset, _)| offset);
        index + skipped + end
    }
}

fn cell_width(c: char) -> usize {
    if c == '\t' {
        return TAB_CELLS;
    }
    UnicodeWidthChar::width(c).unwrap_or(0)
}

/// Move to the last char boundary whose display column does not exceed `goal`.
fn index_at_cell(line: &str, base: usize, goal: usize) -> usize {
    let mut column = 0;
    for (offset, c) in line.char_indices() {
        let width = cell_width(c);
        if column + width > goal {
            return base + offset;
        }
        column += width;
    }
    base + line.len()
}

#[derive(Debug, Default)]
pub struct Completion {
    pub query: String,
    pub token_start: usize,
    pub items: Vec<String>,
    pub selected: usize,
}

impl Completion {
    pub fn active(&self) -> bool {
        !self.items.is_empty()
    }

    pub fn selected_item(&self) -> Option<&String> {
        self.items.get(self.selected)
    }

    pub fn move_cursor(&mut self, delta: i32) {
        if self.items.is_empty() {
            return;
        }
        let next = self.selected as i32 + delta;
        self.selected = next.clamp(0, self.items.len() as i32 - 1) as usize;
    }
}

pub struct Composer {
    pub editor: Editor,
    pub completion: Completion,
    pub notice: Option<String>,
    history: Vec<String>,
    history_index: Option<usize>,
    draft: String,
    files: Option<Vec<String>>,
    workspace: PathBuf,
    history_path: PathBuf,
}

impl Composer {
    pub fn new(workspace: &Path) -> Self {
        let history_path = state_file();
        Self {
            editor: Editor::new(),
            completion: Completion::default(),
            notice: None,
            history: load_history(&history_path),
            history_index: None,
            draft: String::new(),
            files: None,
            workspace: workspace.to_path_buf(),
            history_path,
        }
    }

    /// Feed a key to the editor. The caller keeps the keys that mean app
    /// navigation (`Esc`, `Ctrl+C`, transcript scrolling) before this point.
    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        if key.kind != KeyEventKind::Press {
            return Action::None;
        }
        if self.completion.active() {
            let handled = match key.code {
                KeyCode::Up => {
                    self.completion.move_cursor(-1);
                    true
                }
                KeyCode::Down => {
                    self.completion.move_cursor(1);
                    true
                }
                KeyCode::Tab | KeyCode::Enter => {
                    self.accept_completion();
                    true
                }
                KeyCode::Esc => {
                    self.completion = Completion::default();
                    true
                }
                _ => false,
            };
            if handled {
                return Action::None;
            }
        }
        let action = self.handle_edit_key(key);
        if matches!(action, Action::None) {
            self.refresh_completion();
        }
        action
    }

    fn handle_edit_key(&mut self, key: KeyEvent) -> Action {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Enter if !ctrl && !alt && !shift => return self.submit(),
            KeyCode::Enter => self.editor.insert_char('\n'),
            KeyCode::Char('j') if ctrl => self.editor.insert_char('\n'),
            KeyCode::Backspace if ctrl || alt => {
                self.editor.delete_word_backward();
            }
            KeyCode::Backspace => {
                self.editor.backspace();
            }
            KeyCode::Delete => {
                self.editor.delete_forward();
            }
            KeyCode::Left if ctrl || alt => {
                self.editor.move_word_backward();
            }
            KeyCode::Left => {
                self.editor.move_left();
            }
            KeyCode::Right if ctrl || alt => {
                self.editor.move_word_forward();
            }
            KeyCode::Right => {
                self.editor.move_right();
            }
            KeyCode::Up => {
                if !self.editor.move_up() {
                    self.history_previous();
                }
            }
            KeyCode::Down => {
                if !self.editor.move_down() {
                    self.history_next();
                }
            }
            KeyCode::Home => {
                self.editor.move_line_start();
            }
            KeyCode::End => {
                self.editor.move_line_end();
            }
            KeyCode::Tab => self.editor.insert_str("  "),
            KeyCode::Char('a') if ctrl => {
                self.editor.move_line_start();
            }
            KeyCode::Char('e') if ctrl => {
                self.editor.move_line_end();
            }
            KeyCode::Char('b') if ctrl => {
                self.editor.move_left();
            }
            KeyCode::Char('f') if ctrl => {
                self.editor.move_right();
            }
            KeyCode::Char('b') if alt => {
                self.editor.move_word_backward();
            }
            KeyCode::Char('f') if alt => {
                self.editor.move_word_forward();
            }
            KeyCode::Char('w') if ctrl => {
                self.editor.delete_word_backward();
            }
            KeyCode::Char('u') if ctrl => {
                self.editor.delete_to_line_start();
            }
            KeyCode::Char('k') if ctrl => {
                self.editor.delete_to_line_end();
            }
            KeyCode::Char('d') if ctrl => {
                self.editor.delete_forward();
            }
            KeyCode::Char(c) if !ctrl && !alt => self.editor.insert_char(c),
            _ => {}
        }
        Action::None
    }

    fn submit(&mut self) -> Action {
        if self.editor.text().trim().is_empty() {
            return Action::None;
        }
        let text = self.editor.take();
        self.history.push(text.clone());
        if self.history.len() > HISTORY_LIMIT {
            self.history.drain(..self.history.len() - HISTORY_LIMIT);
        }
        self.history_index = None;
        self.draft.clear();
        self.completion = Completion::default();
        save_history(&self.history_path, &self.history);
        Action::Submit(text)
    }

    fn history_previous(&mut self) -> bool {
        if self.history.is_empty() {
            return false;
        }
        match self.history_index {
            None => {
                self.draft = self.editor.take();
                self.history_index = Some(self.history.len() - 1);
            }
            Some(0) => return false,
            Some(index) => self.history_index = Some(index - 1),
        }
        let text = self.history[self.history_index.expect("index set")].clone();
        self.editor.set_text(&text);
        true
    }

    fn history_next(&mut self) -> bool {
        let Some(index) = self.history_index else {
            return false;
        };
        if index + 1 < self.history.len() {
            self.history_index = Some(index + 1);
            let text = self.history[index + 1].clone();
            self.editor.set_text(&text);
            return true;
        }
        self.history_index = None;
        let draft = std::mem::take(&mut self.draft);
        self.editor.set_text(&draft);
        true
    }

    /// Replace a bracketed paste with its normalized text. Multi-line pastes
    /// stay inline until the summary part lands with the transcript slices.
    pub fn paste(&mut self, text: &str) {
        self.editor.insert_str(&normalize_paste(text));
        self.refresh_completion();
    }

    pub fn dismiss_completion(&mut self) -> bool {
        if !self.completion.active() {
            return false;
        }
        self.completion = Completion::default();
        true
    }

    /// Restore a prompt that the engine refused, so the text is not lost.
    pub fn restore(&mut self, text: &str) {
        self.editor.set_text(text);
        self.refresh_completion();
    }

    fn refresh_completion(&mut self) {
        let Some((start, query)) = self.editor.completion_query() else {
            self.completion = Completion::default();
            return;
        };
        let files = self
            .files
            .get_or_insert_with(|| index_files(&self.workspace));
        let items = filter_files(files, &query);
        self.completion = Completion {
            query,
            token_start: start,
            items,
            selected: 0,
        };
    }

    fn accept_completion(&mut self) {
        let Some(path) = self.completion.selected_item().cloned() else {
            return;
        };
        let start = self.completion.token_start;
        let end = self.editor.cursor();
        self.editor.replace(start, end, &format!("@{path} "));
        self.completion = Completion::default();
    }
}

impl Editor {
    /// The `@token` immediately before the cursor, if any.
    fn completion_query(&self) -> Option<(usize, String)> {
        let text = &self.buffer[..self.cursor];
        let start = text
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(0, |(offset, c)| offset + c.len_utf8());
        let token = &text[start..];
        let query = token.strip_prefix('@')?;
        Some((start, query.to_string()))
    }
}

/// Bracketed paste reaches us with either line ending; ConPTY sends CR-only.
pub fn normalize_paste(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn filter_files(files: &[String], query: &str) -> Vec<String> {
    let needle = query.to_lowercase();
    let mut matches = files
        .iter()
        .filter(|path| path.to_lowercase().contains(&needle))
        .collect::<Vec<_>>();
    matches.sort_by_key(|path| {
        let lowered = path.to_lowercase();
        (
            !lowered.starts_with(&needle),
            lowered.len(),
            lowered.clone(),
        )
    });
    matches.into_iter().take(8).cloned().collect()
}

fn index_files(root: &Path) -> Vec<String> {
    const SKIP: [&str; 7] = [
        ".git",
        "node_modules",
        "target",
        ".worktrees",
        ".build-artifacts",
        "dist",
        ".turbo",
    ];
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if files.len() >= FILE_LIMIT {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !SKIP.contains(&name.as_ref()) && !name.starts_with('.') {
                    stack.push(path);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            files.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    files.sort();
    files
}

pub fn state_file() -> PathBuf {
    std::env::var_os("MIAO_TUI_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .map(|directory| directory.join("miao-tui").join("composer.json"))
        .unwrap_or_else(|| PathBuf::from("composer.json"))
}

fn load_history(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
}

fn save_history(path: &Path, history: &[String]) {
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    if let Ok(text) = serde_json::to_string(history) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composer(dir: &Path) -> Composer {
        Composer {
            editor: Editor::new(),
            completion: Completion::default(),
            notice: None,
            history: Vec::new(),
            history_index: None,
            draft: String::new(),
            files: Some(Vec::new()),
            workspace: dir.to_path_buf(),
            history_path: dir.join("history.json"),
        }
    }

    #[test]
    fn typing_and_backspace_walk_char_boundaries() {
        let mut editor = Editor::new();
        editor.insert_char('a');
        editor.insert_char('会');
        editor.insert_char('b');
        assert_eq!(editor.text(), "a会b");
        assert!(editor.backspace());
        assert_eq!(editor.text(), "a会");
        assert!(editor.backspace());
        assert_eq!(editor.text(), "a");
    }

    #[test]
    fn vertical_motion_keeps_the_display_column_across_wide_chars() {
        let mut editor = Editor::new();
        editor.set_text("会会话\nab\n会");
        // Cursor at the end of the wide first line (column 6).
        editor.cursor = editor.line_end(0);
        assert_eq!(editor.cursor_position().1, 6);
        assert!(editor.move_down());
        // The second line is shorter, so the cursor clamps to its end.
        assert_eq!(editor.cursor, "会会话\nab".len());
        assert!(editor.move_down());
        assert_eq!(editor.cursor, "会会话\nab\n会".len());
        assert!(editor.move_up());
        assert_eq!(editor.cursor, "会会话\nab".len());
    }

    #[test]
    fn word_motion_skips_whitespace_and_the_word() {
        let mut editor = Editor::new();
        editor.set_text("one two  three");
        assert!(editor.move_word_backward());
        assert_eq!(editor.cursor, "one two  ".len());
        assert!(editor.move_word_backward());
        assert_eq!(editor.cursor, "one ".len());
        assert!(editor.move_word_forward());
        assert_eq!(editor.cursor, "one two".len());
    }

    #[test]
    fn ctrl_w_deletes_the_word_before_the_cursor() {
        let mut editor = Editor::new();
        editor.set_text("build the thing");
        assert!(editor.delete_word_backward());
        assert_eq!(editor.text(), "build the ");
        assert!(editor.delete_word_backward());
        assert_eq!(editor.text(), "build ");
    }

    #[test]
    fn paste_normalizes_crlf_and_cr() {
        assert_eq!(normalize_paste("a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn history_round_trip_restores_the_draft() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.editor.set_text("first");
        assert!(matches!(
            composer.handle_edit_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Action::Submit(_)
        ));
        composer.editor.set_text("draft");
        assert!(composer.history_previous());
        assert_eq!(composer.editor.text(), "first");
        assert!(composer.history_next());
        assert_eq!(composer.editor.text(), "draft");
    }

    #[test]
    fn completion_filters_paths_by_substring() {
        assert_eq!(
            filter_files(
                &[
                    "src/lib.rs".into(),
                    "src/editor.rs".into(),
                    "docs/a.md".into()
                ],
                "edit"
            ),
            vec!["src/editor.rs".to_string()]
        );
    }

    #[test]
    fn arrows_move_the_completion_selection_while_it_is_open() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-c", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.files = Some(vec!["src/a.rs".into(), "src/b.rs".into()]);
        composer.editor.insert_str("@src");
        composer.refresh_completion();
        assert_eq!(composer.completion.selected, 0);
        let cursor = composer.editor.cursor();
        composer.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(composer.completion.selected, 1);
        // The arrow must not also move the text cursor while the list owns it.
        assert_eq!(composer.editor.cursor(), cursor);
    }

    #[test]
    fn completion_replaces_the_at_token() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-b", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.files = Some(vec!["src/lib.rs".into()]);
        composer.editor.insert_str("open @li");
        composer.refresh_completion();
        assert!(composer.completion.active());
        composer.accept_completion();
        assert_eq!(composer.editor.text(), "open @src/lib.rs ");
    }
}
