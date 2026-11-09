# Acceptance record — UX-04 screen-clearing redraw

Item: `UX-04`. Tree: `7136a00620` (branch `test/ux04-clear-redraw`, rebased on `main`
2026-11-09; two commits: `3dbf1529ae` fixes the redraw to clear the screen,
`7136a00620` pins it). The commands below are the cargo invocations the pull request's CI workflow
runs on ubuntu-24.04 from the crate directory on this recorded tree; the
observed cells cite that run, and a Linux build-host run cross-checks them
when the host is idle.

## Criterion — support screen-clearing redraws

A requested redraw (Ctrl+L, the redraw command, resume-after-suspend) relied on
`Terminal::clear`, whose semantics snapshot the cursor through stdin and race the
dedicated input reader. `3dbf1529ae` replaces it: the fullscreen viewport is resized
in place, which issues the backend's Clear-All sequence and resets the backing
buffers, so the next frame repaints every row without touching stdin. `redraw` is now
generic over the backend so tests drive the same path against a captured writer or
ratatui's `TestBackend`.

Pinned by `tests/redraw_clear.rs`:

- `a_requested_redraw_clears_the_screen_and_repaints_every_row` — after content is on
  screen, a redraw wipes the captured backend (Clear-All present) and the following
  frame repaints every row that was on screen.
- `a_requested_redraw_wipes_the_backend_screen_before_the_next_frame` — the wipe
  strictly precedes the next frame's draw commands.

| command | observed |
| --- | --- |
| `cargo test --test redraw_clear` | ok — `a_requested_redraw_clears_the_screen_and_repaints_every_row` and
  `a_requested_redraw_wipes_the_backend_screen_before_the_next_frame` both pass (CI run 42628060816) |

## Full-suite result

| command | observed |
| --- | --- |
| `CARGO_INCREMENTAL=0 cargo test --no-run --tests` | ok (CI run 42628060816) |
| `CARGO_INCREMENTAL=0 cargo test --tests` | ok — the tui lib suite ran 573 passed; 0 failed |

## Criterion 4 — link the implementation PR, the acceptance record, and applicable versions

- Implementation: #2766 (squash-merged after one README-table rebase).
- Acceptance record: this file, run on tree `7136a00620`.
- Versions: applies from the release that first ships the merged tree; stamped per
  the repository convention when that release cuts.

**Recorded open, not hidden:** the remaining UX-04 criteria — raw-mode and alternate
screen restoration on panics, process suspension hooks beyond the resume path, window
title toggle settings, and real-terminal validation across tmux, SSH, Windows
Terminal, and carriage-return-only pasting — are not covered by this slice and stay
open on the issue.
