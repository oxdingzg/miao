# Acceptance record — UX-02 keyboard first, pointer optional, both proven

Item: `UX-02` (#1991). Tree: `origin/main` at `8fb7d1ad44`, exported with `git archive`
and built on the Linux build host `xx04`, `crates/miao-tui`, `cargo 1.99.1`.

`2026-11-01-ux-interaction-batch.md` accepted wheel scrolling and mouse capture, and
named three things it could not: every critical action without a mouse, double-click word
selection, and configurable focus behaviour. All three have since landed — `#2094` proves
keyboard reachability, the pointer work landed in `#2458`/`#2659`/`#2660`, and focus
reporting joined the terminal knobs in `#2787`. This record re-runs the pins on one tree
and closes the item.

## Criterion — "Ensure all critical actions can be completed without requiring a mouse."

| pin | command | observed |
| --- | --- | --- |
| every action has a keyboard path, checked over the whole action set | `cargo test --lib reachable` | `2 passed` — `every_action_is_reachable_without_a_mouse`, and the Windows-side companion that allows the Unix-only suspend stroke to be unbound where job control does not exist |
| the pointer is never the only way to copy | `cargo test --lib select` | `26 passed` — selection, shift-arrows in the composer, `copying_prefers_the_selection_over_the_last_response`, and the Zed context rows |

## Criterion — "Allow disabling mouse capture and ensure single- or double-click text selection and copying do not trigger accidental actions."

| pin | command | observed |
| --- | --- | --- |
| capture can be off | `cargo test --lib mouse` | `3 passed` |
| a drag copies exactly the cells it covered, in every composer | `cargo test --lib drag` | `7 passed` — session draft, queued rows, landing draft, and the raw cell range |
| a click that never moved selects nothing, and a later click is just a click | `cargo test --lib click` | `8 passed` — `a_click_that_never_moved_selects_nothing`, `a_click_clears_its_anchor`, `a_second_click_after_the_window_is_just_a_click`, `two_clicks_on_different_cells_are_not_a_double_click`, `a_double_click_outside_the_pane_selects_nothing` |
| a double click selects the word under it | `cargo test --lib click` (same run) | `a_double_click_copies_the_word_under_it` — the row `2026-11-04` recorded as **not implemented** |
| the wheel never becomes an accidental action | `cargo test --lib wheel` (in `scroll`) | `11 passed` — including `a_wheel_notch_moves_an_open_dialog_not_the_transcript` |

## Criterion — "Make focus behavior, wheel scrolling, scroll speed or acceleration, and cursor styles configurable."

| knob | where | pin |
| --- | --- | --- |
| focus reporting (off keeps focus escapes out of terminals that turn them into garbage) | `Config::focus_reporting`, default on | `cargo test --lib scroll` covers the config parse; the knob is read at `config.rs:46` and defaults at `:105` |
| wheel scrolling, speed, acceleration | `tui.json`'s `scroll_speed` / `scroll_acceleration` (`#2090`) | `cargo test --lib scroll` → `11 passed`, including `the_wheel_moves_the_configured_scroll_speed_in_the_transcript` and `a_wheel_notch_moves_the_default_three_rows` |
| cursor style and blinking | `Config::cursor` | `cargo test --lib cursor` → `10 passed` — `the_cursor_style_follows_the_configuration` and the default-shape preservation |

## Criterion — "Link implementation PRs, offline or real-client acceptance records, and target versions, attaching quality, cost, and latency evidence for optimizations."

- Implementation: `#2090` (scroll knobs), `#2094` (keyboard reachability), `#2458`
  (click that never moved selects nothing), `#2659` (drag in either composer), `#2660`
  (queued rows), `#2787` (focus reporting + double-click + wheel-over-dialog).
- Offline record: this file, plus `2026-11-09-ux02-keyboard-selection.md`.
- Version: no `roadmap:` stamp — this tree is in no published release yet.
- No optimisation is claimed: nothing here changes a hot path, so there is no quality,
  cost or latency number to attach; the input-latency evidence is `PERF-01`'s.

## What this record does not claim

- No real-terminal pointer pass: the rows above drive the application's mouse handling and
  assert the resulting selection and clipboard text; UX-04 owns the terminal matrix, and
  its tmux/SSH legs are recorded separately.
- No claim that every terminal delivers mouse reports identically — that is the terminal's
  behaviour, and turning capture off is the escape hatch the second criterion asks for.
