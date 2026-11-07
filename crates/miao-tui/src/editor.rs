//! The composer's text model and key handling.
//!
//! The editor is deliberately independent of ratatui: it owns a UTF-8 buffer
//! and a byte cursor that always sits on a char boundary, and it measures
//! motion and rendering in display cells (`unicode-width`) so CJK text moves and
//! scrolls the way a terminal shows it. Everything that touches session state
//! goes back to the UI as an [`Action`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::{json, Value};
use unicode_width::UnicodeWidthChar;

use crate::keybinds::{self, Keymap};

const HISTORY_LIMIT: usize = 100;
/// How many editing steps the composer remembers. A prompt is short, so this is
/// about surviving a mistake, not about keeping a document's full history.
const UNDO_LIMIT: usize = 200;
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

/// What started the newest undo step. Consecutive edits of one kind collapse
/// into a single step, so undo takes back a word that was typed rather than one
/// character of it; any other kind of edit starts a new step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EditKind {
    Insert,
    Backspace,
    Delete,
    Replace,
}

#[derive(Debug, Default)]
pub struct Editor {
    buffer: String,
    /// Byte offset into `buffer`, always on a char boundary.
    cursor: usize,
    /// Display column a run of up/down motion is aiming at. Cleared by any
    /// horizontal edit so the next run re-reads the cursor.
    goal: Option<usize>,
    /// States before each editing step, oldest first.
    undo: Vec<(String, usize)>,
    /// States a redo can re-apply, newest first.
    redo: Vec<(String, usize)>,
    /// The kind of the newest editing step, for coalescing runs.
    group: Option<EditKind>,
    /// Where a selection started. The cursor is the moving end, so the
    /// selection is the range between them; `None` means no selection.
    anchor: Option<usize>,
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

    /// The selected byte range, ordered, when the selection covers text.
    pub fn selection(&self) -> Option<(usize, usize)> {
        let anchor = self.anchor?;
        let (start, end) = if anchor <= self.cursor {
            (anchor, self.cursor)
        } else {
            (self.cursor, anchor)
        };
        (start < end).then_some((start, end))
    }

    /// The selected text, when there is a selection.
    pub fn selected_text(&self) -> Option<&str> {
        self.selection()
            .map(|(start, end)| &self.buffer[start..end])
    }

    /// Whether a selection is active. The anchor and the cursor can sit on the
    /// same byte after an arrow walked back onto it, and that is still "in
    /// selection mode" even though the range is empty.
    pub fn selecting(&self) -> bool {
        self.anchor.is_some()
    }

    /// Drop the selection without touching the text, leaving the cursor where
    /// it is.
    pub fn clear_selection(&mut self) {
        self.anchor = None;
    }

    /// Select the whole draft.
    pub fn select_all(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        self.anchor = Some(0);
        self.cursor = self.buffer.len();
        self.goal = None;
    }

    /// Run a motion with the selection extended: the anchor stays where the
    /// selection started and the cursor moves, which is what `shift+arrow`
    /// means. A motion that does not move keeps the anchor as it was.
    pub fn extending<T>(&mut self, motion: impl FnOnce(&mut Self) -> T) -> T {
        let start = self.anchor.unwrap_or(self.cursor);
        let moved = motion(self);
        self.anchor = Some(start);
        moved
    }

    /// Remove the selected text, if any, and put the cursor at its start. The
    /// caller records the undo step first, so a replacement undoes in one go.
    fn delete_selection(&mut self) -> bool {
        let Some((start, end)) = self.selection() else {
            // A selection collapsed to the cursor still has to be dropped.
            self.anchor = None;
            return false;
        };
        self.buffer.replace_range(start..end, "");
        self.cursor = start;
        self.anchor = None;
        self.goal = None;
        true
    }

    /// The selected display cells per logical line, as
    /// `(line index, first cell, one past the last cell)`. The renderer needs
    /// cells rather than bytes so a selection over CJK text covers the width the
    /// terminal actually shows.
    pub fn selection_cells(&self) -> Vec<(usize, usize, usize)> {
        let Some((start, end)) = self.selection() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut offset = 0usize;
        for (index, line) in self.buffer.split('\n').enumerate() {
            let line_start = offset;
            let line_end = line_start + line.len();
            offset = line_end + 1;
            let from = start.max(line_start);
            let to = end.min(line_end);
            if from >= to {
                continue;
            }
            let first = line[..from - line_start]
                .chars()
                .map(cell_width)
                .sum::<usize>();
            let width = line[from - line_start..to - line_start]
                .chars()
                .map(cell_width)
                .sum::<usize>();
            out.push((index, first, first + width));
        }
        out
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
        self.anchor = None;
        // A programmatic replacement (history recall, a stash, a restored
        // draft) is not an editing step: undoing back into a previous
        // session's prompt would be a surprise, not a convenience.
        self.forget_history();
    }

    fn forget_history(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.group = None;
    }

    /// Remember the state this edit is about to change, coalescing a run of the
    /// same kind into one step.
    fn record(&mut self, kind: EditKind) {
        if self.group == Some(kind) {
            return;
        }
        self.undo.push((self.buffer.clone(), self.cursor));
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.group = Some(kind);
    }

    /// Whether there is an editing step to take back. The UI asks before it
    /// claims a stroke the page also uses, so `ctrl+z` keeps suspending the
    /// process when the draft has nothing to undo.
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Whether a step is waiting to be re-applied.
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Take back the newest editing step. Returns whether anything changed.
    pub fn undo(&mut self) -> bool {
        let Some((buffer, cursor)) = self.undo.pop() else {
            return false;
        };
        self.redo
            .push((std::mem::take(&mut self.buffer), self.cursor));
        self.buffer = buffer;
        self.cursor = cursor.min(self.buffer.len());
        self.goal = None;
        // The next edit starts its own step instead of extending the one just
        // undone, which would otherwise be unreachable from a redo.
        self.group = None;
        true
    }

    /// Re-apply the step the last undo took back.
    pub fn redo(&mut self) -> bool {
        let Some((buffer, cursor)) = self.redo.pop() else {
            return false;
        };
        self.undo
            .push((std::mem::take(&mut self.buffer), self.cursor));
        self.buffer = buffer;
        self.cursor = cursor.min(self.buffer.len());
        self.goal = None;
        self.group = None;
        true
    }

    /// Clear the buffer and hand the submitted text to the caller.
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        self.goal = None;
        self.anchor = None;
        self.forget_history();
        std::mem::take(&mut self.buffer)
    }

    /// Empty the draft as an editing step, so `ctrl+z` brings back a prompt
    /// that was cleared by accident. Submitting goes through [`Self::take`],
    /// which forgets the history instead.
    pub fn clear(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        self.record(EditKind::Delete);
        self.buffer.clear();
        self.cursor = 0;
        self.goal = None;
        self.anchor = None;
    }

    pub fn insert_char(&mut self, c: char) {
        // Typing over a selection replaces it, and the pair has to undo in one
        // step: record before the deletion so undo restores the selected text.
        if self.selection().is_some() {
            self.record(EditKind::Replace);
            self.delete_selection();
        } else {
            self.record(EditKind::Insert);
        }
        self.buffer.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.goal = None;
    }

    pub fn insert_str(&mut self, text: &str) {
        // A paste over a selection replaces it, in one undo step.
        if self.selection().is_some() {
            self.record(EditKind::Replace);
            self.delete_selection();
        } else {
            self.record(EditKind::Insert);
        }
        self.buffer.insert_str(self.cursor, text);
        self.cursor += text.len();
        self.goal = None;
    }

    /// Replace `start..end` with `text`; used by completion and history.
    pub fn replace(&mut self, start: usize, end: usize, text: &str) {
        self.record(EditKind::Replace);
        self.anchor = None;
        self.buffer.replace_range(start..end, text);
        self.cursor = start + text.len();
        self.goal = None;
    }

    /// Remove `start..end` as one editing step, leaving the cursor at `start`.
    pub fn remove_span(&mut self, start: usize, end: usize) -> bool {
        if start >= end {
            return false;
        }
        self.record(EditKind::Delete);
        self.anchor = None;
        self.buffer.replace_range(start..end, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn backspace(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        if self.cursor == 0 {
            return false;
        }
        self.record(EditKind::Backspace);
        let start = self.prev_boundary(self.cursor);
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_forward(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        if self.cursor == self.buffer.len() {
            return false;
        }
        self.record(EditKind::Delete);
        let end = self.next_boundary(self.cursor);
        self.buffer.replace_range(self.cursor..end, "");
        self.goal = None;
        true
    }

    pub fn delete_word_backward(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        let start = self.word_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.record(EditKind::Delete);
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_word_forward(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        let end = self.word_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.record(EditKind::Delete);
        self.buffer.replace_range(self.cursor..end, "");
        self.goal = None;
        true
    }

    pub fn delete_to_line_start(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        let start = self.line_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.record(EditKind::Delete);
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn delete_to_line_end(&mut self) -> bool {
        if self.selection().is_some() {
            self.record(EditKind::Delete);
            self.delete_selection();
            return true;
        }
        self.anchor = None;
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.record(EditKind::Delete);
        self.buffer.replace_range(self.cursor..end, "");
        self.goal = None;
        true
    }

    pub fn move_left(&mut self) -> bool {
        self.end_run();
        if self.cursor == 0 {
            return false;
        }
        self.cursor = self.prev_boundary(self.cursor);
        self.goal = None;
        true
    }

    pub fn move_right(&mut self) -> bool {
        self.end_run();
        if self.cursor == self.buffer.len() {
            return false;
        }
        self.cursor = self.next_boundary(self.cursor);
        self.goal = None;
        true
    }

    pub fn move_word_forward(&mut self) -> bool {
        self.end_run();
        let end = self.word_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.cursor = end;
        self.goal = None;
        true
    }

    pub fn move_word_backward(&mut self) -> bool {
        self.end_run();
        let start = self.word_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn move_line_start(&mut self) -> bool {
        self.end_run();
        let start = self.line_start(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.cursor = start;
        self.goal = None;
        true
    }

    pub fn move_line_end(&mut self) -> bool {
        self.end_run();
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            return false;
        }
        self.cursor = end;
        self.goal = None;
        true
    }

    pub fn move_up(&mut self) -> bool {
        self.end_run();
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
        self.end_run();
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

    /// The draft as display rows inside `width` cells, each one
    /// `(line, first cell, text)`. A logical line longer than the width hard
    /// wraps, and every logical line takes at least one row, so the composer
    /// paints the rows it sized itself from instead of clipping the line the
    /// cursor happens to sit on.
    pub fn display_lines(&self, width: usize) -> Vec<(usize, usize, String)> {
        let width = width.max(1);
        let (caret_line, caret_cell) = self.cursor_position();
        self.lines()
            .enumerate()
            .flat_map(|(line, text)| {
                let caret = (line == caret_line).then_some(caret_cell);
                wrap_cells(&text, width, line, caret)
            })
            .collect()
    }

    /// How many display rows the draft needs inside `width` cells.
    pub fn display_rows(&self, width: usize) -> usize {
        self.display_lines(width).len()
    }

    /// Where the cursor sits among the wrapped rows: the display row and the
    /// cell within it, so a tall draft scrolls vertically instead of dragging
    /// the line sideways under a caret that never leaves the first row.
    pub fn display_cursor(&self, width: usize) -> (usize, usize) {
        let (line, column) = self.cursor_position();
        let mut cursor = (0, column);
        for (row, (index, start, _)) in self.display_lines(width).into_iter().enumerate() {
            if index > line {
                break;
            }
            if index == line && start <= column {
                cursor = (row, column - start);
            }
        }
        cursor
    }

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

    /// Any cursor motion ends the current typing run: typing, moving, then
    /// typing again are two undo steps rather than one. It also drops the
    /// selection, because a plain motion is what ends one.
    fn end_run(&mut self) {
        self.group = None;
        self.anchor = None;
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

    /// Every marker in the draft, as `(start, end, kind, text)` with the byte
    /// range of the bracket run. Text the operator typed that merely looks
    /// bracketed is not a marker: only the shapes the composer writes are.
    fn markers(&self) -> Vec<(usize, usize, Placeholder, String)> {
        let mut markers = Vec::new();
        let mut index = 0;
        while let Some(open) = self.buffer[index..].find('[') {
            let start = index + open;
            let Some(close) = self.buffer[start..].find(']') else {
                break;
            };
            let end = start + close + 1;
            let inner = &self.buffer[start + 1..end - 1];
            // A bracket run that wraps a line is prose, not a marker.
            let kind = (!inner.contains('\n'))
                .then(|| placeholder_kind(inner))
                .flatten();
            if let Some(kind) = kind {
                markers.push((start, end, kind, inner.to_string()));
            }
            index = end;
        }
        markers
    }

    /// The marker an edit before the cursor would land on, with the space the
    /// composer wrote after it, as `(start, end, kind, text)`. `backspace` at
    /// the edge of `[Image 1] ` takes the whole marker, not one character of
    /// the word it spells.
    pub fn placeholder_before(&self) -> Option<(usize, usize, Placeholder, String)> {
        self.markers()
            .into_iter()
            .find_map(|(start, end, kind, text)| {
                let end = if self.buffer[end..].starts_with(' ') {
                    end + 1
                } else {
                    end
                };
                (end == self.cursor).then_some((start, end, kind, text))
            })
    }

    /// The marker `delete` would land on, with its trailing space.
    pub fn placeholder_after(&self) -> Option<(usize, usize, Placeholder, String)> {
        self.markers()
            .into_iter()
            .find_map(|(start, end, kind, text)| {
                let end = if self.buffer[end..].starts_with(' ') {
                    end + 1
                } else {
                    end
                };
                (start == self.cursor).then_some((start, end, kind, text))
            })
    }

    /// How many markers of `kind` sit before `at`; for a paste, only the ones
    /// that read exactly as `text`. The composer fills its attachment and paste
    /// lists in the order it inserted the markers, so the count is the index of
    /// the payload this marker stands for.
    pub fn placeholder_rank(&self, at: usize, kind: Placeholder, text: &str) -> usize {
        self.markers()
            .into_iter()
            .filter(|(start, _, other, marker)| {
                *start < at && *other == kind && (kind != Placeholder::Paste || marker == text)
            })
            .count()
    }
}

/// A marker the composer writes into the buffer for content it carries beside
/// the text. An image or a file travels as bytes, a long paste as its full
/// text; the operator reads each marker as one thing, so an edit at its edge
/// takes all of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placeholder {
    /// The bytes wait in the composer's attachment list.
    Attachment,
    /// The full text waits in the composer's paste list.
    Paste,
}

fn placeholder_kind(inner: &str) -> Option<Placeholder> {
    fn numbered(text: &str) -> bool {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
    }
    if let Some(number) = inner.strip_prefix("Image ") {
        return numbered(number).then_some(Placeholder::Attachment);
    }
    if inner == "File" || inner.starts_with("File ") {
        return Some(Placeholder::Attachment);
    }
    let count = inner
        .strip_prefix("Pasted ~")
        .and_then(|rest| rest.strip_suffix(" lines"))?;
    numbered(count).then_some(Placeholder::Paste)
}

fn cell_width(c: char) -> usize {
    if c == '\t' {
        return TAB_CELLS;
    }
    UnicodeWidthChar::width(c).unwrap_or(0)
}

/// Split one logical line into display rows of at most `width` cells. A
/// double-width character that would straddle the edge moves whole onto the
/// next row, so no row is painted as half a glyph. `caret` is the cell the
/// cursor sits at on this line: a draft that ends exactly on the row boundary
/// continues onto an empty row so the caret keeps a cell to stand in.
fn wrap_cells(
    text: &str,
    width: usize,
    line: usize,
    caret: Option<usize>,
) -> Vec<(usize, usize, String)> {
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut start = 0usize;
    let mut cell = 0usize;
    for c in text.chars() {
        let cells = cell_width(c);
        if cell > 0 && cell + cells > width {
            rows.push((line, start, std::mem::take(&mut row)));
            start += cell;
            cell = 0;
        }
        row.push(c);
        cell += cells;
    }
    rows.push((line, start, row));
    if caret == Some(start + cell) && cell == width {
        rows.push((line, start + cell, String::new()));
    }
    rows
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
    /// How long the current phase has run, spelled for the right-aligned slot
    /// of the TS compact activity row. `None` clears the slot.
    pub phase_elapsed: Option<String>,
    /// The wait has gone long enough that the TS row turns its spinner
    /// warning-colored (30s while waiting for the model).
    pub phase_alert: bool,
    /// Which placeholder example the empty composer shows. The TS prompt picks
    /// one at random when it mounts and re-rolls on a Session change, so this
    /// is a stored index rather than a clock drift.
    pub placeholder: usize,
    /// The work the Session's own checklist still has left, offered in the
    /// empty composer once nothing is running. It is the todo list the engine
    /// continues from, not a guess at what to do next, so accepting it asks for
    /// the turn the engine would have picked up anyway.
    pub suggestion: Option<String>,
    /// Inline media sent with the prompt. The composer only shows their
    /// `[Image N]` markers; the bytes travel beside the text.
    attachments: Vec<Value>,
    /// Pasted blocks too large to show. The composer holds the placeholder
    /// (`[Pasted ~N lines]`) and the full text waits here until submit, so a
    /// 2000-line paste costs one line on screen instead of pushing the draft
    /// out of view. Cleared with the draft.
    pastes: Vec<(String, String)>,
    history: Vec<String>,
    history_index: Option<usize>,
    draft: String,
    /// The mode the draft was written in, so leaving history restores the mode
    /// the operator left rather than the one the recalled entry ran in.
    draft_mode: Mode,
    files: Option<Vec<String>>,
    commands: Vec<String>,
    /// One-line meaning per command, shown beside it in the completion list.
    pub details: HashMap<String, String>,
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
            phase_elapsed: None,
            phase_alert: false,
            placeholder: random_pick(),
            suggestion: None,
            attachments: Vec::new(),
            pastes: Vec::new(),
            history: load_history(&history_path),
            history_index: None,
            draft: String::new(),
            draft_mode: Mode::Normal,
            files: None,
            commands: Vec::new(),
            details: HashMap::new(),
            workspace: workspace.to_path_buf(),
            history_path,
        }
    }

    /// Re-roll the placeholder example, the way the TS prompt re-rolls when a
    /// different Session opens.
    pub fn reroll_placeholder(&mut self) {
        self.placeholder = self.placeholder.wrapping_add(1 + random_pick());
    }

    /// Offer `text` in the empty composer, or clear what the last turn left.
    /// Storing it beside the draft rather than in it keeps the offer out of the
    /// history, the stash and the paste bookkeeping until Tab spends a
    /// keystroke on it.
    pub fn set_suggestion(&mut self, text: Option<String>) {
        self.suggestion = text;
    }

    /// Promote the offer into the draft. Only an empty composer takes it: a
    /// draft the operator is writing is never overwritten by Tab.
    fn accept_suggestion(&mut self) -> bool {
        if !self.editor.is_empty() || self.mode != Mode::Normal {
            return false;
        }
        let Some(text) = self.suggestion.clone() else {
            return false;
        };
        self.editor.set_text(&text);
        true
    }

    /// Names (without the leading `/`) offered by slash completion.
    pub fn set_commands(&mut self, commands: Vec<String>) {
        self.commands = commands;
    }

    /// The meaning shown beside each command in the completion list.
    pub fn set_command_details(&mut self, details: Vec<(String, String)>) {
        self.details = details.into_iter().collect();
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
                // Enter runs the highlighted command in one stroke, the way the
                // TypeScript prompt does; a second Enter after the completion
                // closed read as "the command needs two returns". Tab keeps
                // plain completion for the operator who only wants the text.
                KeyCode::Enter if self.completion.kind == CompletionKind::Command => {
                    self.accept_completion();
                    let trimmed = self.editor.text().trim_end().to_string();
                    self.editor.set_text(&trimmed);
                    return self.submit();
                }
                KeyCode::Tab | KeyCode::Enter => {
                    // A query that already names its item exactly is finished:
                    // Enter submits it instead of spending a keystroke
                    // accepting a completion that changes nothing. `/quit`
                    // quit on the first Enter, the way the TS composer does.
                    if self.completion.items.contains(&self.completion.query) {
                        false
                    } else {
                        self.accept_completion();
                        true
                    }
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
        // Only once the completion list has had its turn: an open list keeps
        // Tab for the item it is highlighting.
        if key.code == KeyCode::Tab && key.modifiers.is_empty() && self.accept_suggestion() {
            self.refresh_completion();
            return Action::None;
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
            // Selection is `shift` on the motion the action already has: the
            // anchor stays where the selection started and the cursor moves.
            Some(keybinds::Action::InputSelectLeft) => {
                self.editor.extending(|editor| editor.move_left());
            }
            Some(keybinds::Action::InputSelectRight) => {
                self.editor.extending(|editor| editor.move_right());
            }
            Some(keybinds::Action::InputSelectUp) => {
                self.editor.extending(|editor| editor.move_up());
            }
            Some(keybinds::Action::InputSelectDown) => {
                self.editor.extending(|editor| editor.move_down());
            }
            Some(keybinds::Action::InputSelectLineHome) => {
                self.editor.extending(|editor| editor.move_line_start());
            }
            Some(keybinds::Action::InputSelectLineEnd) => {
                self.editor.extending(|editor| editor.move_line_end());
            }
            Some(keybinds::Action::InputSelectWordBackward) => {
                self.editor.extending(|editor| editor.move_word_backward());
            }
            Some(keybinds::Action::InputSelectWordForward) => {
                self.editor.extending(|editor| editor.move_word_forward());
            }
            Some(keybinds::Action::InputSelectAll) => self.editor.select_all(),
            Some(keybinds::Action::InputUndo) => {
                self.editor.undo();
            }
            Some(keybinds::Action::InputRedo) => {
                self.editor.redo();
            }
            Some(keybinds::Action::InputSubmit) => return self.submit(),
            Some(keybinds::Action::InputNewline) => self.editor.insert_char('\n'),
            Some(keybinds::Action::InputBackspace) => {
                if self.mode == Mode::Shell && self.editor.is_empty() {
                    self.mode = Mode::Normal;
                } else if !self.delete_placeholder(false) {
                    self.editor.backspace();
                }
            }
            Some(keybinds::Action::InputDelete) => {
                if !self.delete_placeholder(true) {
                    self.editor.delete_forward();
                }
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
        let draft = self.editor.take();
        let text = self.expand_pastes(&draft);
        let attachments = std::mem::take(&mut self.attachments);
        self.pastes.clear();
        self.record_history(&text);
        self.history_index = None;
        self.draft.clear();
        self.completion = Completion::default();
        // The offer was about the work this prompt now asks for. It comes back
        // only if the checklist still has something runnable once the turn
        // settles, so a submitted prompt never leaves stale work on screen.
        self.suggestion = None;
        Action::Submit { text, attachments }
    }

    /// Replace every paste placeholder with the text it stands for.
    ///
    /// Substitution is textual because the operator may have moved or edited
    /// the surrounding draft; a placeholder deleted from the text simply has
    /// nothing left to expand, which is the behaviour a person expects from
    /// removing a token.
    fn expand_pastes(&self, text: &str) -> String {
        let mut expanded = text.to_string();
        for (placeholder, content) in &self.pastes {
            expanded = expanded.replace(placeholder.as_str(), content);
        }
        expanded
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
        match read_local_attachment(&self.workspace, text) {
            Some(LocalAttachment::Text(content)) => {
                self.editor.insert_str(&normalize_paste(&content));
            }
            Some(LocalAttachment::Binary { mime, data, name }) => {
                self.attach_binary(&mime, &data, &name);
            }
            None => {
                let normalized = normalize_paste(text);
                // Three lines or 150 characters is where a paste stops reading
                // as something the operator typed; it is the same threshold the
                // TypeScript prompt uses.
                let lines = normalized.lines().count();
                if lines >= 3 || normalized.chars().count() > 150 {
                    let placeholder = format!("[Pasted ~{lines} lines]");
                    self.pastes.push((placeholder.clone(), normalized));
                    self.editor.insert_str(&placeholder);
                } else {
                    self.editor.insert_str(&normalized);
                }
            }
        }
        self.refresh_completion();
    }

    /// Show an image as `[Image N] ` and keep its bytes for the next prompt.
    /// Returns the new attachment count.
    pub fn attach_image(&mut self, mime: &str, data: &str) -> usize {
        self.attach_binary(mime, data, "")
    }

    /// Attach bytes under a marker the operator can see: an image counts as
    /// `[Image N]`, anything else (a PDF) carries its file name, because the
    /// engine sends it as a file part rather than a picture.
    pub fn attach_binary(&mut self, mime: &str, data: &str, name: &str) -> usize {
        let images = self
            .attachments
            .iter()
            .filter(|attachment| {
                attachment
                    .get("mime")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/"))
            })
            .count();
        let marker = if mime.starts_with("image/") {
            format!("[Image {}] ", images + 1)
        } else if name.is_empty() {
            "[File] ".to_string()
        } else {
            format!("[File {name}] ")
        };
        self.editor.insert_str(&marker);
        self.attachments.push(json!({ "mime": mime, "data": data }));
        self.refresh_completion();
        images + 1
    }

    /// Take the marker the cursor touches as one unit, and the payload it
    /// stands for with it. Erasing a marker one character at a time left the
    /// bytes attached with nothing on screen saying so, and the operator had to
    /// spell out `] ` before the picture was actually gone.
    fn delete_placeholder(&mut self, forward: bool) -> bool {
        if self.editor.selecting() {
            return false;
        }
        let edge = if forward {
            self.editor.placeholder_after()
        } else {
            self.editor.placeholder_before()
        };
        let Some((start, end, kind, marker)) = edge else {
            return false;
        };
        let rank = self.editor.placeholder_rank(start, kind, &marker);
        match kind {
            Placeholder::Attachment => {
                if rank < self.attachments.len() {
                    self.attachments.remove(rank);
                }
            }
            Placeholder::Paste => {
                // The paste list holds the marker as the draft shows it; the
                // scan hands back the label inside the brackets.
                let index = self
                    .pastes
                    .iter()
                    .enumerate()
                    .filter(|(_, (placeholder, _))| {
                        placeholder.trim_start_matches('[').trim_end_matches(']') == marker
                    })
                    .map(|(index, _)| index)
                    .nth(rank);
                if let Some(index) = index {
                    self.pastes.remove(index);
                }
            }
        }
        self.editor.remove_span(start, end);
        self.refresh_completion();
        true
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

    /// Whether the draft has an editing step to take back, so a shared stroke
    /// belongs to the composer rather than to the page.
    pub fn can_undo(&self) -> bool {
        self.editor.can_undo()
    }

    /// Whether the draft has a step to re-apply.
    pub fn can_redo(&self) -> bool {
        self.editor.can_redo()
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

/// A pasted path that names a file this composer can carry: text it inlines,
/// binary it attaches. `None` means "not one of those", so the path stays text.
enum LocalAttachment {
    Text(String),
    Binary {
        mime: String,
        data: String,
        name: String,
    },
}

/// The mime a pasted path carries, from the same table the TypeScript composer
/// uses. An extension that is not in it is left as plain text rather than
/// attached as an opaque blob.
fn attachment_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "avif" => "image/avif",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// How large a pasted file may be before it is not worth attaching. A prompt is
/// a message, not a transfer channel.
const ATTACHMENT_LIMIT: u64 = 20 * 1024 * 1024;

fn read_local_attachment(workspace: &Path, text: &str) -> Option<LocalAttachment> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') || trimmed.len() > 4096 {
        return None;
    }
    let path = Path::new(trimmed);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };
    let mime = attachment_mime(&resolved)?;
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_file() || meta.len() > ATTACHMENT_LIMIT {
        return None;
    }
    let name = resolved
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| trimmed.to_string());
    if mime == "image/svg+xml" {
        // An SVG is text an author can edit, so it goes in as content rather
        // than as an opaque attachment.
        return std::fs::read_to_string(&resolved)
            .ok()
            .map(LocalAttachment::Text);
    }
    let bytes = std::fs::read(&resolved).ok()?;
    let data = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };
    Some(LocalAttachment::Binary {
        mime: mime.to_string(),
        data,
        name,
    })
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

/// A cheap entropy source for the placeholder pick: wall-clock nanoseconds
/// scrambled by the golden-ratio multiplier. The TS prompt uses `Math.random`
/// on mount; this matches the observable behavior — a different example per
/// launch, stable within it — without pulling in a rand dependency.
fn random_pick() -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as usize ^ duration.as_secs() as usize)
        .unwrap_or(0);
    now.wrapping_mul(0x9E3779B97F4A7C15).swap_bytes()
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
            phase_elapsed: None,
            phase_alert: false,
            placeholder: 0,
            suggestion: None,
            attachments: Vec::new(),
            pastes: Vec::new(),
            history: Vec::new(),
            history_index: None,
            draft: String::new(),
            draft_mode: Mode::Normal,
            files: Some(Vec::new()),
            commands: Vec::new(),
            details: HashMap::new(),
            workspace: dir.to_path_buf(),
            history_path: dir.join("history.json"),
        }
    }

    /// A run of typing is one step: undo takes back the word the operator just
    /// typed, not one character of it.
    #[test]
    fn a_typing_run_undoes_as_one_step() {
        let mut editor = Editor::new();
        for c in "hello".chars() {
            editor.insert_char(c);
        }
        assert_eq!(editor.text(), "hello");
        assert!(editor.undo());
        assert_eq!(editor.text(), "", "the whole run came back off");
        assert!(!editor.undo(), "nothing else to take back");
    }

    /// Undo then redo round-trips the text and the cursor, so a mistake in the
    /// middle of a prompt can be taken back and re-applied.
    #[test]
    fn undo_and_redo_restore_text_and_cursor() {
        let mut editor = Editor::new();
        editor.insert_str("one two");
        editor.move_word_backward();
        editor.insert_str("and ");
        assert_eq!(editor.text(), "one and two");
        let cursor = editor.cursor();
        assert!(editor.undo());
        assert_eq!(editor.text(), "one two");
        assert!(editor.redo());
        assert_eq!(editor.text(), "one and two");
        assert_eq!(editor.cursor(), cursor, "redo puts the cursor back too");
    }

    /// A different kind of edit starts a new step, so undo does not swallow the
    /// deletion together with the typing that preceded it.
    #[test]
    fn a_new_kind_of_edit_starts_its_own_step() {
        let mut editor = Editor::new();
        editor.insert_str("abc");
        editor.backspace();
        assert_eq!(editor.text(), "ab");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc", "only the deletion came back");
        assert!(editor.undo());
        assert_eq!(editor.text(), "", "then the typing run");
    }

    /// Clearing the draft is an editing step too: `ctrl+c` on a long prompt
    /// has to be something `ctrl+z` can take back.
    #[test]
    fn clearing_the_draft_is_undoable() {
        let mut editor = Editor::new();
        editor.insert_str("a prompt worth keeping");
        editor.clear();
        assert_eq!(editor.text(), "");
        assert!(editor.undo());
        assert_eq!(editor.text(), "a prompt worth keeping");
    }

    /// A recalled prompt (history, stash, a restored draft) is not an editing
    /// step: undoing into the previous session's text would be a surprise.
    #[test]
    fn a_recalled_prompt_forgets_the_undo_stack() {
        let mut editor = Editor::new();
        editor.insert_str("typo");
        editor.set_text("recalled from history");
        assert!(!editor.undo(), "the recalled text is the baseline");
        assert_eq!(editor.text(), "recalled from history");
    }

    /// A pasted path that names an image becomes an attachment the engine can
    /// send, instead of a line of text naming a file the model cannot see.
    #[test]
    fn pasting_an_image_path_attaches_it() {
        let dir = std::env::temp_dir().join(format!("miao-paste-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("shot.png");
        std::fs::write(&path, [0x89u8, b'P', b'N', b'G']).expect("write png");
        let mut composer = composer(&dir);
        composer.paste(&path.display().to_string());
        assert_eq!(composer.editor.text(), "[Image 1] ");
        assert_eq!(composer.attachments.len(), 1);
        let attachment = &composer.attachments[0];
        assert_eq!(attachment["mime"], "image/png");
        let decoded = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(attachment["data"].as_str().expect("data"))
                .expect("base64")
        };
        assert_eq!(decoded, vec![0x89, b'P', b'N', b'G']);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An SVG is text: it goes into the prompt as content, not as a binary blob.
    #[test]
    fn pasting_an_svg_inlines_its_text() {
        let dir = std::env::temp_dir().join(format!("miao-paste-svg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("icon.svg"), "<svg></svg>").expect("write svg");
        let mut composer = composer(&dir);
        // A relative path resolves against the workspace, which is what the
        // operator sees in the composer.
        composer.paste("icon.svg");
        assert_eq!(composer.editor.text(), "<svg></svg>");
        assert!(composer.attachments.is_empty(), "an SVG is not attached");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A PDF carries its file name, because the engine sends it as a file part
    /// rather than a picture.
    #[test]
    fn pasting_a_pdf_names_the_attachment() {
        let dir = std::env::temp_dir().join(format!("miao-paste-pdf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("plan.pdf"), b"%PDF-1.4").expect("write pdf");
        let mut composer = composer(&dir);
        composer.paste("plan.pdf");
        assert_eq!(composer.editor.text(), "[File plan.pdf] ");
        assert_eq!(composer.attachments.len(), 1);
        assert_eq!(composer.attachments[0]["mime"], "application/pdf");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Anything else stays text: a path to a source file is a reference the
    /// model can read with a tool, not a payload to upload.
    #[test]
    fn pasting_an_unknown_file_keeps_the_path() {
        let dir = std::env::temp_dir().join(format!("miao-paste-unknown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("main.rs"), "fn main() {}").expect("write rs");
        let mut composer = composer(&dir);
        composer.paste("src/main.rs");
        assert_eq!(composer.editor.text(), "src/main.rs");
        assert!(composer.attachments.is_empty());
        // A multi-line paste is never a path, so it is inserted as text.
        composer.clear();
        composer.paste("one\ntwo");
        assert_eq!(composer.editor.text(), "one\ntwo");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `shift` motions extend from where the selection started, and a plain
    /// motion ends it, which is what every editor does.
    #[test]
    fn shift_motions_extend_a_selection_and_plain_motions_end_it() {
        let mut editor = Editor::new();
        editor.insert_str("hello world");
        editor.move_word_backward();
        editor.extending(|editor| editor.move_left());
        assert_eq!(editor.selected_text(), Some(" "), "the anchor held");
        editor.extending(|editor| editor.move_word_backward());
        assert_eq!(editor.selected_text(), Some("hello "));
        editor.move_right();
        assert!(!editor.selecting(), "a plain motion ends the selection");
        assert_eq!(editor.selected_text(), None);
    }

    /// Typing over a selection replaces it, and one undo brings the text back.
    #[test]
    fn typing_replaces_the_selection_in_one_step() {
        let mut editor = Editor::new();
        editor.insert_str("hello world");
        editor.select_all();
        editor.insert_char('x');
        assert_eq!(editor.text(), "x");
        assert!(editor.undo());
        assert_eq!(editor.text(), "hello world", "one undo restores it all");
    }

    /// A paste over a selection replaces it too, rather than inserting beside it.
    #[test]
    fn pasting_replaces_the_selection() {
        let mut editor = Editor::new();
        editor.insert_str("old text");
        editor.select_all();
        editor.insert_str("new");
        assert_eq!(editor.text(), "new");
    }

    /// `backspace` and `delete` remove the selected run, not one more character.
    #[test]
    fn deletion_takes_the_selection_first() {
        let mut editor = Editor::new();
        editor.insert_str("keep DROP keep");
        // Park the cursor just before the run, then extend over it.
        for _ in 0..5 {
            editor.move_left();
        }
        for _ in 0..5 {
            editor.extending(|editor| editor.move_left());
        }
        assert_eq!(editor.selected_text(), Some(" DROP"));
        assert!(editor.backspace());
        // Only the selected run went: the trailing " keep" is still there.
        assert_eq!(editor.text(), "keep keep");

        let mut editor = Editor::new();
        editor.insert_str("aDROPa");
        for _ in 0..5 {
            editor.extending(|editor| editor.move_left());
        }
        assert_eq!(editor.selected_text(), Some("DROPa"));
        assert!(editor.delete_forward());
        assert_eq!(editor.text(), "a");
    }

    /// The renderer needs cells, not bytes: a selection over CJK text covers the
    /// width the terminal shows, on every line it touches.
    #[test]
    fn selection_cells_are_measured_in_display_columns() {
        let mut editor = Editor::new();
        editor.insert_str("ab\n你好\ncd");
        editor.select_all();
        let cells = editor.selection_cells();
        assert_eq!(cells, vec![(0, 0, 2), (1, 0, 4), (2, 0, 2)]);
        // From the end, up then line-start covers the CJK line and the last
        // one, and the double-width characters keep their two cells each.
        editor.set_text("ab\n你好\ncd");
        editor.extending(|editor| editor.move_up());
        editor.extending(|editor| editor.move_line_start());
        assert_eq!(editor.selection_cells(), vec![(1, 0, 4), (2, 0, 2)]);
    }

    /// A multi-line or wrapped draft needs more display rows than it has
    /// logical lines, which is what lets the composer show the whole prompt.
    #[test]
    fn display_rows_counts_logical_lines_and_wrapping() {
        let mut editor = Editor::new();
        assert_eq!(editor.display_rows(20), 1, "an empty draft is one row");
        editor.insert_str("first\nsecond");
        assert_eq!(editor.display_rows(20), 2);
        editor.set_text("x");
        assert_eq!(editor.display_rows(20), 1);
        // Ten CJK characters are twenty cells, so they fill a twenty-one-cell
        // row and spill onto a second one.
        editor.set_text("你好世界你好世界你好世界你好世界你好世界");
        assert_eq!(editor.display_rows(21), 2, "wide text wraps by cells");
    }

    /// A draft that fills its row exactly keeps a cell for the caret on the
    /// next row, so the caret never disappears at the wrap point.
    #[test]
    fn a_full_row_leaves_the_caret_a_row_of_its_own() {
        let mut editor = Editor::new();
        editor.set_text("abcd");
        assert_eq!(editor.display_rows(4), 2);
        assert_eq!(editor.display_cursor(4), (1, 0));
    }

    /// The composer scrolls the wrapped rows and puts the caret where the
    /// terminal shows it, so a long draft reads instead of sliding sideways.
    #[test]
    fn display_cursor_follows_the_wrapped_rows() {
        let mut editor = Editor::new();
        editor.set_text(&"x".repeat(30));
        assert_eq!(editor.display_cursor(20), (1, 10));
        // A wide character that would straddle the edge moves whole onto the
        // next row, and the caret counts from where that row starts.
        editor.set_text(&format!("{}你", "x".repeat(19)));
        assert_eq!(editor.display_lines(20)[1], (0, 19, "你".to_string()));
        assert_eq!(editor.display_cursor(20), (1, 2));
    }

    /// CJK and emoji are edited by grapheme, not by byte: undo takes back the
    /// character the terminal showed.
    #[test]
    fn undo_takes_back_a_whole_cjk_grapheme() {
        let mut editor = Editor::new();
        editor.insert_char('你');
        editor.insert_char('好');
        assert_eq!(editor.text(), "你好");
        assert!(editor.undo());
        assert_eq!(editor.text(), "");
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

    /// A long paste must not push the draft out of view. The composer holds
    /// one placeholder line; the text waits until submit.
    #[test]
    fn a_long_paste_collapses_to_one_placeholder_line() {
        let dir = std::env::temp_dir().join(format!("miao-tui-paste-{}", std::process::id()));
        let mut composer = composer(&dir);
        let pasted = (1..=200)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        composer.paste(&pasted);
        assert_eq!(composer.editor.text(), "[Pasted ~200 lines]");
        let Action::Submit { text, .. } = composer.submit() else {
            panic!("a placeholder keeps the composer non-empty");
        };
        assert_eq!(text, pasted, "the full text must reach the prompt");
    }

    #[test]
    fn a_short_paste_is_inserted_as_typed() {
        let dir = std::env::temp_dir().join(format!("miao-tui-paste-short-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.paste("two words");
        assert_eq!(composer.editor.text(), "two words");
    }

    /// The threshold is line count or length, matching the TypeScript prompt:
    /// three lines is where a block stops reading as something typed.
    #[test]
    fn three_lines_collapse_but_two_do_not() {
        let dir = std::env::temp_dir().join(format!("miao-tui-paste-edge-{}", std::process::id()));
        let mut two = composer(&dir);
        two.paste("a\nb");
        assert_eq!(two.editor.text(), "a\nb");
        let mut three = composer(&dir);
        three.paste("a\nb\nc");
        assert_eq!(three.editor.text(), "[Pasted ~3 lines]");
    }

    /// Deleting the placeholder drops the paste with it: a token the operator
    /// removed must not reappear at submit.
    #[test]
    fn removing_the_placeholder_drops_the_pasted_text() {
        let dir = std::env::temp_dir().join(format!("miao-tui-paste-drop-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.paste("x\ny\nz");
        composer.editor.select_all();
        composer.editor.insert_str("replaced");
        let Action::Submit { text, .. } = composer.submit() else {
            panic!("composer is non-empty");
        };
        assert_eq!(text, "replaced");
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

    /// An image marker reads as one thing, so `backspace` takes the marker and
    /// the bytes with it instead of spelling `] ` out one cell at a time.
    #[test]
    fn backspace_takes_an_image_marker_as_one_unit() {
        let dir = std::env::temp_dir().join(format!("miao-tui-marker-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.attach_image("image/png", "cG5n");
        composer.attach_image("image/png", "cG5n");
        let keymap = Keymap::default();
        composer.handle_edit_key(
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &keymap,
        );
        assert_eq!(composer.editor.text(), "[Image 1] ");
        assert_eq!(
            composer.attachments.len(),
            1,
            "the second image went with its marker"
        );
        composer.handle_edit_key(
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &keymap,
        );
        assert_eq!(composer.editor.text(), "");
        assert!(composer.attachments.is_empty());
    }

    /// `delete` in front of a marker takes it the same way.
    #[test]
    fn delete_takes_the_marker_in_front_of_the_cursor() {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-marker-forward-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.attach_image("image/png", "cG5n");
        composer.editor.move_line_start();
        composer.handle_edit_key(
            KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
            &Keymap::default(),
        );
        assert_eq!(composer.editor.text(), "");
        assert!(composer.attachments.is_empty());
    }

    #[test]
    fn backspace_takes_a_paste_marker_and_drops_its_text() {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-paste-marker-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.paste("x\ny\nz");
        composer.handle_edit_key(
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &Keymap::default(),
        );
        assert_eq!(composer.editor.text(), "");
        assert!(
            composer.pastes.is_empty(),
            "the pasted block goes with its marker"
        );
    }

    /// Bracketed prose the operator typed is still ordinary text: only the
    /// markers the composer writes read as one unit.
    #[test]
    fn typed_brackets_still_delete_one_character_at_a_time() {
        let dir = std::env::temp_dir().join(format!("miao-tui-brackets-{}", std::process::id()));
        let mut composer = composer(&dir);
        composer.editor.insert_str("[note]");
        composer.handle_edit_key(
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &Keymap::default(),
        );
        assert_eq!(composer.editor.text(), "[note");
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

    /// A settled turn offers the Session's next todo in the empty composer.
    /// `Tab` spends the keystroke on it instead of the two spaces it otherwise
    /// types, and a draft already being written is never overwritten.
    #[test]
    fn tab_promotes_the_offered_task_into_the_draft() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-t", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        assert!(matches!(
            composer.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &keys),
            Action::None
        ));
        // With nothing offered, Tab is still the indent it always was.
        assert_eq!(composer.editor.text(), "  ");

        composer.editor.clear();
        composer.set_suggestion(Some("fix the login redirect".into()));
        composer.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &keys);
        assert_eq!(composer.editor.text(), "fix the login redirect");
        // The caret waits after the accepted text, ready to append.
        assert_eq!(composer.editor.cursor(), "fix the login redirect".len());

        // A draft in progress keeps the keystroke: Tab indents it rather than
        // replacing work the operator already wrote.
        composer.editor.set_text("half a thought");
        composer.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &keys);
        assert_eq!(composer.editor.text(), "half a thought  ");
    }

    /// Enter with a highlighted command runs it in one stroke — the TypeScript
    /// prompt never asked for a second Return after the list closed. Tab keeps
    /// pure completion for an operator who only wants the text.
    #[test]
    fn enter_on_a_command_completion_submits_in_one_stroke() {
        let dir = std::env::temp_dir().join(format!("miao-tui-editor-{}-e", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut composer = composer(&dir);
        let keys = Keymap::default();
        composer.set_commands(vec!["status".into(), "theme".into()]);
        composer.editor.insert_str("/theme");
        composer.refresh_completion();
        assert_eq!(composer.completion.items, vec!["theme".to_string()]);
        let action = composer.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), &keys);
        let Action::Submit { text, .. } = action else {
            panic!("a fully typed command submits on Enter");
        };
        assert_eq!(text, "/theme");
        assert!(composer.editor.is_empty());

        // Tab completes without submitting.
        composer.set_commands(vec!["theme".into()]);
        composer.editor.set_text("/th");
        composer.refresh_completion();
        assert!(composer.completion.active());
        let action = composer.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &keys);
        assert!(matches!(action, Action::None));
        assert_eq!(composer.editor.text(), "/theme ");
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
