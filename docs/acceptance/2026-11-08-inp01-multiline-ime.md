# Acceptance record — INP-01 multi-line editing with CJK and IME

Item: `INP-01`. Tree: `main` including #2690. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that tree.

## The criteria this record accepts

**Character, word, logical-line and visual-line navigation, selection,
deletion and undo/redo; CJK composition and emoji graphemes across newline
styles; cursor and selection stable during resize and streaming load.**

- *Navigation, selection, deletion, undo/redo*: the editor's suite pins
  char/word boundaries (`typing_and_backspace_walk_char_boundaries`,
  `word_motion_skips_whitespace_and_the_word`, `ctrl_w_deletes_the_word_before_the_cursor`),
  line motions, visual wrapping with the caret following wrapped rows
  (`display_rows_counts_logical_lines_and_wrapping`,
  `display_cursor_follows_the_wrapped_rows`), selection extension and
  replacement (`shift_motions_extend_a_selection_and_plain_motions_end_it`,
  `typing_replaces_the_selection_in_one_step`), and grouped undo/redo
  (`a_typing_run_undoes_as_one_step`, `undo_and_redo_restore_text_and_cursor`).
- *CJK/emoji and newline styles*: grapheme-based editing
  (`undo_takes_back_a_whole_cjk_grapheme`, image markers deleted as one unit),
  and paste normalization across newline styles
  (`paste_normalizes_crlf_and_cr`).
- *Stability*: #2690's regression holds a wrapped draft across a width change —
  more rows at the narrower width while the caret's logical position and the
  selection stay identical (`a_resize_rewraps_rows_but_the_caret_keeps_its_text`);
  streaming-side, the draft survives a live answer
  (`a_streamed_answer_appears_before_the_turn_commits` and the reasoning/text
  channel split).

## Suites

| what | command | observed |
| --- | --- | --- |
| the editor suite (52 tests) | `cargo test --lib editor` (from `crates/miao-tui/`) | `52 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `547 passed; 0 failed` |

## What this record does not claim

- A real IME (input method) process was not attached on Windows/macOS
  build hosts; the CJK claims are about grapheme-safe editing of composed
  text once it reaches the terminal, which is the editor's contract.
- Windows unexercised, as before.
