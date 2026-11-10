# Acceptance record — UX-02 keyboard-first navigation, optional mouse, and selection

Item: `UX-02` (#1991). Tree: the head of `feat/ux02-keyboard-coverage` (PR
#2787, squash `86b279ee02` on `main`). The implementation merged before this
record was written, the way #2788 filled INP-03 and AGT-05 in; the commands
below are the cargo invocations the pull request's CI workflow runs on
ubuntu-latest from `crates/miao-tui/` on this recorded tree, and the observed
cells cite that run (run 42694010181: tui, cli, unit, typecheck, and ci-gate
green; three earlier runs failed on the way there and are named where they
taught something). The `cli` job on the same run re-builds the TUI library
into the release binary and passed with it.

The 2026-11-01 status comment and the 2026-11-04 acceptance evidence left
three gaps open: double-click word selection, configurable focus behaviour,
and fresh evidence for keyboard-only reachability. This record covers those
three and re-states the mouse criteria the `2026-11-01-tui-batch.md` record
accepted, re-run on this tree.

## Criterion 1 — all critical actions can be completed without requiring a mouse

| command | observed |
| --- | --- |
| `cargo test --locked --no-fail-fast -- --test-threads=1` | ok. lib suite: 604 passed; 0 failed (CI run 42694010181, job `tui (ubuntu-latest)`) |

Pinned by two guards inside that suite, both unchanged by the PR — no new
action or command was added:

- `every_action_is_reachable_without_a_mouse` (`keybinds.rs`, landed in
  #2094) — every action the TUI knows carries a default stroke, and the
  deliberate `none` exceptions (terminal title toggle; suspend off Unix) must
  really be unbound, so the exception list cannot go stale.
- `every_shortcut_command_resolves_to_a_bound_chord` (`app.rs`) — every
  palette command that advertises a chord resolves to a stroke the live
  keymap binds.

## Criterion 2 — disabling mouse capture, and single- or double-click selection and copying that do not misfire

| command | observed |
| --- | --- |
| `cargo test --locked --no-fail-fast -- --test-threads=1` | ok — the suite carries every row below (same run) |

- `tui.json` `mouse: false` still disables capture, and cursor settings still
  arrive from the same files — `mouse_and_cursor_come_from_the_same_files`
  (`config.rs`), re-run here.
- A press that never moved is not a selection —
  `a_click_that_never_moved_selects_nothing`.
- A drag copies the cells it covered, on the transcript, the queued rows, the
  Session draft and the landing draft —
  `a_mouse_drag_copies_the_cells_it_covered`,
  `a_drag_over_the_session_draft_copies_what_it_covered`,
  `a_drag_over_the_queued_rows_copies_them`,
  `a_drag_over_the_landing_draft_copies_what_it_covered`,
  `a_drag_still_returns_the_cells_it_covered`.
- **New: a double click selects the word under it and copies it on release** —
  `a_double_click_selects_the_word_under_the_cell` (the run keeps `joins_word`
  whole, so `crates/tui` comes out as one piece),
  `a_double_click_on_a_gap_selects_nothing` (a gap is not a word; the press
  stays a click), `a_double_click_outside_the_pane_selects_nothing`,
  `a_double_click_copies_the_word_under_it` (the four-event gesture copies
  through the release path and reports it),
  `a_second_click_after_the_window_is_just_a_click` (a second press past the
  500 ms window is not a double click),
  `two_clicks_on_different_cells_are_not_a_double_click`. The gesture's first
  red CI attempt taught two real constraints the final code honours: the pane
  snapshots its cells only while a selection is live, and a claimed selection
  has to hand the release to the surface that owns it, or nothing copies.

**Recorded open, not hidden:** the word run covers one wrapped screen row — a
word broken across a wrap boundary selects the visible part, and the composer
draft still has drag-only selection (a double click there falls back to the
click that copies nothing). Word runs over logical lines, composer
double-click, and triple-click line selection stay open.

## Criterion 3 — focus behaviour, wheel scrolling, scroll speed or acceleration, and cursor styles configurable

| command | observed |
| --- | --- |
| `cargo test --locked --no-fail-fast -- --test-threads=1` | ok — the suite carries every row below (same run) |

- **New: `tui.json` reads `focus_reporting`** (default on, the old
  behaviour); a valid `false` is taken silently and a non-boolean warns while
  keeping the default — `focus_reporting_comes_from_the_same_files`. The
  field is registered with UX-01's diagnostics, so a valid value is not
  reported as an unsupported one. Off means the terminal is never asked for
  focus changes; notifications gated on focus then stay silent while sounds
  keep playing.
- Wheel scrolling, speed and acceleration —
  `an_unaccelerated_wheel_moves_the_configured_rows_every_time`,
  `the_configured_speed_replaces_the_default_step`,
  `acceleration_grows_inside_a_burst_and_stops_at_the_cap`,
  `a_pause_or_a_reversal_starts_the_burst_over` (`scroll.rs`), plus
  `the_wheel_moves_the_configured_scroll_speed_in_the_transcript`,
  `a_wheel_notch_moves_the_default_three_rows`,
  `a_background_reprojection_keeps_a_scrolled_transcript_where_it_is`
  (`app.rs`).
- **New: the wheel moves the open dialog** the `handle_mouse` documentation
  always claimed — `a_wheel_notch_moves_a_list_dialog_selection` (one row per
  notch, clamped at both ends, header-skipping through `move_cursor`),
  `a_wheel_notch_scrolls_a_text_dialog_without_underflow`,
  `a_wheel_notch_moves_an_open_dialog_not_the_transcript` (the transcript
  behind an open dialog does not move). Rename, sign-in, worktree-new and
  confirm dialogs have nothing to scroll and keep the notch.
- Cursor styles — `the_cursor_style_follows_the_configuration`
  (`terminal.rs`), re-run here.

**Recorded open, not hidden:** dialog notches move one row each and do not
follow `scroll_speed`/`scroll_acceleration` — the configured speed describes
the transcript wheel. A real-terminal matrix for focus escapes (multiplexer
and SSH hops) was not run; it belongs with UX-04's real-client pass.

## Criterion 4 — link the implementation PR, the acceptance records, and target versions

- Implementation: #2787, squash `86b279ee02` on `main` (the branch tip was
  `9cdbd5ca7a` after the fmt and snapshot fixes).
- Acceptance records: this file, run on tree `9cdbd5ca7a`;
  `2026-11-01-tui-batch.md` remains the evidence for the scroll-speed and
  mouse-capture rows it accepted, re-run within this suite.
- Versions: applies from the release that first ships `86b279ee02`; stamped
  per the repository convention when that release cuts.
