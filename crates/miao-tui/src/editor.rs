//! The composer's text model and key handling.
//!
//! The editor is deliberately independent of ratatui: it owns a UTF-8 buffer
//! and a byte cursor that always sits on a char boundary, and it measures
//! motion and rendering in display cells (`unicode-width`) so CJK text moves and
//! scrolls the way a terminal shows it. Everything that touches session state
//! goes back to the UI as an [`Action`].

use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::{json, Value};
use unicode_width::UnicodeWidthChar;

use crate::keybinds::{self, Keymap};

const HISTORY_LIMIT: usize = 100;
const FILE_LIMIT: usize = 2000;
const TAB_CELLS: usize = 4;

pub enum Action {
    None,
    Submit {
        text: String,
        attachments: Vec<Value>,
    },
    /// A `!` command: it runs on the host shell through the engine and never
    /// becomes a model prompt.
    Shell {
        command: String,
    },
    Quit,
}

/// Which input the composer is collecting. Shell mode is explicit so a prompt
/// that merely starts with `!` still reaches the model; the marker itself never
/// enters the buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Normal,
    Shell,
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

    pub fn delete_word_forward(&mut self) -> bool {
        let end = self.word_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.buffer.replace_range(self.cursor..end, "");
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CompletionKind {
    /// `@`-prefixed file paths.
    #[default]
    File,
    /// A slash command name; accepting it inserts `/name `.
    Command,
}

#[derive(Debug, Default)]
pub struct Completion {
    pub kind: CompletionKind,
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
    mode: Mode,
    pub completion: Completion,
    pub notice: Option<String>,
    /// Prompts durably admitted but not yet promoted into a turn. They are
    /// re-read from the snapshot every frame, so this is display state rather
    /// than a durable count the composer owns.
    pub queued: usize,
    /// What the active run is doing, re-read from the snapshot every frame. It
    /// rides the composer title so the phase is visible where the operator is
    /// typing.
    pub phase: Option<String>,
    /// Inline media sent with the prompt. The composer only shows their
    /// `[Image N]` markers; the bytes travel beside the text.
    attachments: Vec<Value>,
    history: Vec<String>,
    history_index: Option<usize>,
    draft: String,
    /// The mode the draft was written in, so leaving history restores the mode
    /// the operator left rather than the one the recalled entry ran in.
    draft_mode: Mode,
    files: Option<Vec<String>>,
    commands: Vec<String>,
    workspace: PathBuf,
    history_path: PathBuf,
}

impl Composer {
    pub fn new(workspace: &Path) -> Self {
        let history_path = state_file();
        Self {
            editor: Editor::new(),
            mode: Mode::Normal,
            completion: Completion::default(),
            notice: None,
            queued: 0,
            phase: None,
            attachments: Vec::new(),
            history: load_history(&history_path),
            history_index: None,
            draft: String::new(),
            draft_mode: Mode::Normal,
            files: None,
            commands: Vec::new(),
            workspace: workspace.to_path_buf(),
            history_path,
        }
    }

    /// Names (without the leading `/`) offered by slash completion.
    pub fn set_commands(&mut self, commands: Vec<String>) {
        self.commands = commands;
    }

    /// Feed a key to the editor. The caller keeps the keys that mean app
    /// navigation (`Esc`, `Ctrl+C`, transcript scrolling) before this point.
    pub fn handle_key(&mut self, key: KeyEvent, keys: &Keymap) -> Action {
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
        let action = self.handle_edit_key(key, keys);
        if matches!(action, Action::None) {
            self.refresh_completion();
        }
        action
    }

    /// Editing keys are the `input_*` actions; the keymap decides which stroke
    /// reaches which edit. Keys the keymap does not name (Home, End, Tab) keep
    /// their terminal meaning.
    fn handle_edit_key(&mut self, key: KeyEvent, keys: &Keymap) -> Action {
        let action = keys.input_action(&key);
        match action {
            Some(keybinds::Action::InputSubmit) => return self.submit(),
            Some(keybinds::Action::InputNewline) => self.editor.insert_char('\n'),
            Some(keybinds::Action::InputBackspace) => {
                if self.mode == Mode::Shell && self.editor.is_empty() {
                    self.mode = Mode::Normal;
                } else {
                    self.editor.backspace();
                }
            }
            Some(keybinds::Action::InputDelete) => {
                self.editor.delete_forward();
            }
            Some(keybinds::Action::InputMoveLeft) => {
                self.editor.move_left();
            }
            Some(keybinds::Action::InputMoveRight) => {
                self.editor.move_right();
            }
            Some(keybinds::Action::InputMoveUp) => {
                if !self.editor.move_up() {
                    self.history_previous();
                }
            }
            Some(keybinds::Action::InputMoveDown) => {
                if !self.editor.move_down() {
                    self.history_next();
                }
            }
            Some(keybinds::Action::InputLineHome) => {
                self.editor.move_line_start();
            }
            Some(keybinds::Action::InputLineEnd) => {
                self.editor.move_line_end();
            }
            Some(keybinds::Action::InputWordBackward) => {
                self.editor.move_word_backward();
            }
            Some(keybinds::Action::InputWordForward) => {
                self.editor.move_word_forward();
            }
            Some(keybinds::Action::InputDeleteWordBackward) => {
                self.editor.delete_word_backward();
            }
            Some(keybinds::Action::InputDeleteWordForward) => {
                self.editor.delete_word_forward();
            }
            Some(keybinds::Action::InputDeleteToLineStart) => {
                self.editor.delete_to_line_start();
            }
            Some(keybinds::Action::InputDeleteToLineEnd) => {
                self.editor.delete_to_line_end();
            }
            _ => match key.code {
                KeyCode::Home => {
                    self.editor.move_line_start();
                }
                KeyCode::End => {
                    self.editor.move_line_end();
                }
                KeyCode::Tab => self.editor.insert_str("  "),
                KeyCode::Char('!') if self.mode == Mode::Normal && self.editor.is_empty() => {
                    self.mode = Mode::Shell;
                }
                KeyCode::Char(c)
                    if !key.modifiers.contains(KeyModifiers::CONTROL)
                        && !key.modifiers.contains(KeyModifiers::ALT) =>
                {
                    self.editor.insert_char(c);
                }
                _ => {}
            },
        }
        Action::None
    }

    fn submit(&mut self) -> Action {
        if self.mode == Mode::Shell {
            if self.editor.text().trim().is_empty() {
                self.mode = Mode::Normal;
                return Action::None;
            }
            let command = self.editor.take();
            self.record_history(&format!("!{command}"));
            self.mode = Mode::Normal;
            return Action::Shell {
                command: command.trim().to_string(),
            };
        }
        if self.editor.text().trim().is_empty() {
            return Action::None;
        }
        let text = self.editor.take();
        let attachments = std::mem::take(&mut self.attachments);
        self.record_history(&text);
        self.history_index = None;
        self.draft.clear();
        self.completion = Completion::default();
        Action::Submit { text, attachments }
    }

    fn record_history(&mut self, entry: &str) {
        self.history.push(entry.to_string());
        if self.history.len() > HISTORY_LIMIT {
            self.history.drain(..self.history.len() - HISTORY_LIMIT);
        }
        save_history(&self.history_path, &self.history);
    }

    fn history_previous(&mut self) -> bool {
        if self.history.is_empty() {
            return false;
        }
        match self.history_index {
            None => {
                self.draft = self.editor.take();
                self.draft_mode = self.mode;
                self.history_index = Some(self.history.len() - 1);
            }
            Some(0) => return false,
            Some(index) => self.history_index = Some(index - 1),
        }
        let text = self.history[self.history_index.expect("index set")].clone();
        self.recall(&text);
        true
    }

    /// Text restored from history and from a failed send keeps its `!` marker:
    /// the marker is how an entry remembers which mode produced it.
    fn recall(&mut self, text: &str) {
        match text.strip_prefix('!') {
            Some(command) => {
                self.editor.set_text(command);
                self.mode = Mode::Shell;
            }
            None => {
                self.editor.set_text(text);
                self.mode = Mode::Normal;
            }
        }
    }

    fn history_next(&mut self) -> bool {
        let Some(index) = self.history_index else {
            return false;
        };
        if index + 1 < self.history.len() {
            self.history_index = Some(index + 1);
            let text = self.history[index + 1].clone();
            self.recall(&text);
            return true;
        }
        self.history_index = None;
        let draft = std::mem::take(&mut self.draft);
        self.editor.set_text(&draft);
        self.mode = self.draft_mode;
        true
    }

    /// Replace a bracketed paste with its normalized text. Multi-line pastes
    /// stay inline until the summary part lands with the transcript slices.
    pub fn paste(&mut self, text: &str) {
        self.editor.insert_str(&normalize_paste(text));
        self.refresh_completion();
    }

    /// Show an image as `[Image N] ` and keep its bytes for the next prompt.
    /// Returns the new attachment count.
    pub fn attach_image(&mut self, mime: &str, data: &str) -> usize {
        let count = self
            .attachments
            .iter()
            .filter(|attachment| {
                attachment
                    .get("mime")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/"))
            })
            .count()
            + 1;
        self.editor.insert_str(&format!("[Image {count}] "));
        self.attachments.push(json!({ "mime": mime, "data": data }));
        self.refresh_completion();
        count
    }

    /// Discard text and its pending attachments together: an attachment whose
    /// marker is gone must not ride along with an unrelated prompt.
    pub fn clear(&mut self) {
        self.editor.clear();
        self.attachments.clear();
        self.mode = Mode::Normal;
        self.completion = Completion::default();
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
        if mode == Mode::Shell {
            self.completion = Completion::default();
        }
    }

    /// Put a rejected `!` command back in the composer, still in shell mode, so
    /// the operator can fix and retry it instead of retyping it.
    pub fn restore_shell(&mut self, command: &str) {
        self.editor.set_text(command);
        self.mode = Mode::Shell;
        self.completion = Completion::default();
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
        self.restore_with(text, Vec::new());
    }

    pub fn restore_with(&mut self, text: &str, attachments: Vec<Value>) {
        self.mode = Mode::Normal;
        self.editor.set_text(text);
        self.attachments = attachments;
        self.refresh_completion();
    }

    fn refresh_completion(&mut self) {
        let Some((start, query, kind)) = self.editor.completion_query() else {
            self.completion = Completion::default();
            return;
        };
        let items = match kind {
            CompletionKind::Command => filter_commands(&self.commands, &query),
            CompletionKind::File => {
                let files = self
                    .files
                    .get_or_insert_with(|| index_files(&self.workspace));
                filter_files(files, &query)
            }
        };
        self.completion = Completion {
            kind,
            query,
            token_start: start,
            items,
            selected: 0,
        };
    }

    fn accept_completion(&mut self) {
        let Some(item) = self.completion.selected_item().cloned() else {
            return;
        };
        let start = self.completion.token_start;
        let end = self.editor.cursor();
        let replacement = match self.completion.kind {
            CompletionKind::Command => format!("/{item} "),
            CompletionKind::File => format!("@{item} "),
        };
        self.editor.replace(start, end, &replacement);
        self.completion = Completion::default();
    }
}

impl Editor {
    /// The completion token immediately before the cursor: slash commands own
    /// the first word, `@` mentions can start after any whitespace.
    fn completion_query(&self) -> Option<(usize, String, CompletionKind)> {
        let text = &self.buffer[..self.cursor];
        if let Some(name) = text.strip_prefix('/') {
            if !name.chars().any(char::is_whitespace) {
                return Some((0, name.to_string(), CompletionKind::Command));
            }
        }
        let start = text
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(0, |(offset, c)| offset + c.len_utf8());
        let token = &text[start..];
        let query = token.strip_prefix('@')?;
        Some((start, query.to_string(), CompletionKind::File))
    }
}

/// Bracketed paste reaches us with either line ending; ConPTY sends CR-only.
pub fn normalize_paste(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Command names that start with the typed prefix, alphabetically, capped so
/// the completion list fits the composer.
fn filter_commands(commands: &[String], query: &str) -> Vec<String> {
    let needle = query.to_lowercase();
    let mut matches = commands
        .iter()
        .filter(|name| name.to_lowercase().starts_with(&needle))
        .collect::<Vec<_>>();
    matches.sort_by_key(|name| name.to_lowercase());
    matches.into_iter().take(8).cloned().collect()
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
    crate::state::file("composer.json")
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
            mode: Mode::Normal,
            completion: Completion::default(),
            notice: None,
            queued: 0,
            phase: None,
            attachments: Vec::new(),
            history: Vec::new(),
            history_index: None,
            draft: String::new(),
            draft_mode: Mode::Normal,
            files: Some(Vec::new()),
            commands: Vec::new(),
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
    fn images_become_numbered_markers_and_submit_with_the_prompt() {
        let dir = std::env::temp_dir().join(format!("miao-tui-attach-{}", std::process::id()));
        let mut composer = composer(&dir);
        assert_eq!(composer.attach_image("image/png", "cG5n"), 1);
        assert_eq!(composer.attach_image("image/png", "cG5n"), 2);
        assert_eq!(composer.editor.text(), "[Image 1] [Image 2] ");
        let Action::Submit { text, attachments } = composer.submit() else {
            panic!("attachments make the composer non-empty");
        };
        assert_eq!(text, "[Image 1] [Image 2] ");
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0]["mime"], "image/png");
        assert!(composer.attachments.is_empty(), "submit consumes them");
    }

    #[test]
    fn clearing_the_composer_drops_pending_attachments() {
        let dir = std::env::temp_dir().join(format!("miao-tui-clear-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.attach_image("image/png", "cG5n");
        composer.clear();
        assert!(composer.editor.is_empty());
        assert!(composer.attachments.is_empty());
    }

    #[test]
    fn a_refused_prompt_restores_its_attachments() {
        let dir = std::env::temp_dir().join(format!("miao-tui-restore-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.attach_image("image/png", "cG5n");
        let Action::Submit { text, attachments } = composer.submit() else {
            panic!("submit");
        };
        composer.restore_with(&text, attachments);
        assert_eq!(composer.editor.text(), "[Image 1] ");
        assert_eq!(composer.attachments.len(), 1);
    }

    #[test]
    fn history_round_trip_restores_the_draft() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.editor.set_text("first");
        assert!(matches!(
            composer.handle_edit_key(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                &Keymap::default()
            ),
            Action::Submit { .. }
        ));
        composer.editor.set_text("draft");
        assert!(composer.history_previous());
        assert_eq!(composer.editor.text(), "first");
        assert!(composer.history_next());
        assert_eq!(composer.editor.text(), "draft");
    }

    #[test]
    fn a_bang_enters_shell_mode_and_submitting_returns_the_command() {
        let dir = std::env::temp_dir().join(format!("miao-tui-shell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        composer.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE), &keys);
        assert_eq!(composer.mode(), Mode::Shell);
        // The marker is a mode, not text: the buffer holds only the command.
        assert!(composer.editor.is_empty());
        composer.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE), &keys);
        composer.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE), &keys);
        assert_eq!(composer.editor.text(), "gs");
        let action = composer.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), &keys);
        let Action::Shell { command } = action else {
            panic!("shell mode must submit a command, not a prompt");
        };
        assert_eq!(command, "gs");
        assert_eq!(composer.mode(), Mode::Normal);
        assert!(composer.editor.is_empty());
    }

    #[test]
    fn shell_mode_exits_on_backspace_at_the_start_and_keeps_the_command() {
        let dir = std::env::temp_dir().join(format!("miao-tui-shell-exit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        composer.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE), &keys);
        // Backspace on the empty command drops the mode, not the Session.
        composer.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE), &keys);
        assert_eq!(composer.mode(), Mode::Normal);
        composer.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE), &keys);
        composer.handle_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE), &keys);
        // Leaving shell mode keeps the typed command as a plain draft.
        composer.set_mode(Mode::Normal);
        assert_eq!(composer.editor.text(), "l");
    }

    #[test]
    fn a_bang_mid_prompt_stays_model_text() {
        let dir = std::env::temp_dir().join(format!("miao-tui-bang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        composer.handle_key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE), &keys);
        composer.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE), &keys);
        assert_eq!(composer.mode(), Mode::Normal);
        assert_eq!(composer.editor.text(), "h!");
    }

    #[test]
    fn history_replays_a_shell_command_back_into_shell_mode() {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-shell-history-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        composer.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE), &keys);
        composer.editor.insert_str("ls -l");
        let action = composer.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), &keys);
        assert!(matches!(action, Action::Shell { .. }));
        composer.editor.insert_str("next prompt");
        assert!(composer.history_previous());
        assert_eq!(composer.mode(), Mode::Shell);
        assert_eq!(composer.editor.text(), "ls -l");
        assert!(composer.history_next());
        assert_eq!(composer.mode(), Mode::Normal);
        assert_eq!(composer.editor.text(), "next prompt");
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
        composer.handle_key(
            KeyEvent::new(KeyCode::Down, KeyModifiers::NONE),
            &Keymap::default(),
        );
        assert_eq!(composer.completion.selected, 1);
        // The arrow must not also move the text cursor while the list owns it.
        assert_eq!(composer.editor.cursor(), cursor);
    }

    #[test]
    fn slash_completion_offers_commands_and_inserts_the_chosen_one() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-s", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.set_commands(vec!["status".into(), "sessions".into(), "theme".into()]);
        composer.editor.insert_str("/se");
        composer.refresh_completion();
        assert_eq!(composer.completion.kind, CompletionKind::Command);
        assert_eq!(composer.completion.items, vec!["sessions".to_string()]);
        composer.accept_completion();
        assert_eq!(composer.editor.text(), "/sessions ");
        // A finished first word is no longer a command being completed.
        composer.refresh_completion();
        assert!(!composer.completion.active());
    }

    #[test]
    fn slash_completion_only_owns_the_first_word() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-t", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        composer.set_commands(vec!["review".into()]);
        composer.editor.insert_str("/review src/");
        composer.refresh_completion();
        assert!(!composer.completion.active());
        composer.editor.insert_str("@li");
        composer.refresh_completion();
        assert_eq!(composer.completion.kind, CompletionKind::File);
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
