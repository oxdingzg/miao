# Acceptance record — UX-02/03/05: list interaction, colour and discovery

Tree: `ccf704c281` (main after #2230, #2231, #2238, #2247, #2249, #2253, #2255,
#2256 and #2258).

Commands were run from `crates/miao-tui/` on the macOS build host (`cargo
1.99.1`, debug profile). A reviewer runs the same command from the same
directory anywhere; the counts below are what those runs printed. The whole
library suite at this tree is `cargo test --lib -- --test-threads=1` →
**359 passed, 0 failed**.

## UX-02 — keyboard-first navigation with optional mouse and selection

| criterion | command | observed |
| --- | --- | --- |
| a row can be selected with the pointer | `cargo test --lib -- a_click` | 2 passed: `pane::tests::a_click_names_the_row_that_was_painted_on_that_line` walks a real frame and requires every anchor to hold the label painted on that line, including after the window scrolls; `app::tests::a_click_on_the_list_selects_the_row_it_landed_on` clicks the second row of a frame, then proves `j` continues from there and the footer switched to `tab prompt` |
| paging and the ends of the list are one keystroke away | `cargo test --lib -- screenful` and `-- home_and_end` | 1 + 1 passed: one screenful is one viewport (eighteen rows on a twenty-row frame since #2234 removed the border), `space`/`PageDown` move 18 → 36 and stop at the last row, `PageUp` walks back 39 → 21 → 3 → 0, and `Home`/`End` jump to either end |
| the wheel, focus and cursor stay configurable | `cargo test --lib -- config` | passes: `scroll_speed`, `scroll_acceleration`, `mouse` and `cursor` are read from `tui.json`; `config::tests::mouse_and_cursor_come_from_the_same_files` pins that the two files agree |

## UX-03 — narrow screens and colour accessibility

| criterion | command | observed |
| --- | --- | --- |
| state is not conveyed by colour alone | `cargo test --lib -- status_warning` | 1 passed: a status hint that waits on the operator carries a leading `!`, so it reads without the warning tone (`#2255`) |
| the landing footer holds forty columns | `cargo test --lib -- narrow_frame` and `-- hint` | 1 + 3 passed: the key set falls back with the room (`/ filter · p pin · tab list · n new · 1-9 open · space page · ? help` → `/ filter · tab prompt · ? help` → `? help`), nothing is cut mid-word, and the footer names the side the next `Tab` reaches (`#2231`, `#2249`) |
| a wide terminal does not stretch a row | `cargo test --lib -- wide_home` | 1 passed: the list keeps a 96-column measure and centres it, the margins stay empty and the age ends on the column edge (`#2230`) |
| one row per Session, preview only under the cursor | `cargo test --lib -- only_the_selected` | 2 passed: the selected row shows its preview and the others do not (`#2230`) |

## UX-05 — command discovery and contextual help

| criterion | command | observed |
| --- | --- | --- |
| the leader names what it reaches while it waits | `cargo test --lib -- leader_hint` and `-- leader_menu` | 1 + 1 passed: the menu is built from the live keymap (`ctrl+x · q app exit · n session new · …`), follows an override, replaces the footer, and the chord still runs (`#2253`) |
| the key list can be searched | `cargo test --lib -- help_list` | 3 passed, of which `dialogs::tests::typing_narrows_the_help_list_and_enter_still_closes` narrows three rows to `theme_list` by typing, keeps `Enter` as close, and restores the table with `Backspace` (`#2256`) |
| the footer advertises keys that exist | `cargo test --lib -- hint` | 3 passed: `? help` opens the key list, `?` typed into a filter stays a query character, and the `tab` hint names the side without the keyboard (`#2231`) |

## Rendering evidence

Frames were rendered with `ratatui`'s `TestBackend` on the same host at
150×14 and 80×10; the landing list and its footer read:

```
Today
  ▸ Single-word "ok" reply request                    just now
      ok
    issue 1979 inp01-multiline                          8h ago
    issue 1984 his03-undo-redo                          8h ago
 / filter · p pin · tab list · n new · 1-9 open · space page · ? help
```

## Still unaccepted

- UX-02: a double-click is not distinguished from a single click, and the
  pointer cannot drag a selection inside the list (the transcript already
  supports drag-to-copy).
- UX-03: no screen-reader path exists; the TUI paints cells and nothing has been
  designed for spoken output.
- UX-05: the which-key menu lists every leader chord on one row, so a very long
  menu is clipped rather than grouped; `/help` filters but does not yet group by
  scope.
- None of this measures an operator: time-to-state and mistakes for these tasks
  still belong to VAL-03's measurement protocol.
