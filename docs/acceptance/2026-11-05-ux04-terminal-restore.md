# Acceptance record — UX-04 terminal restore and title

Item: `UX-04`. Tree: `9d8ac06104`. Commands ran on the Linux build host from
`crates/miao-tui`, driving the real TUI binary through a pty harness
(`crates/miao-tui/tests/smoke.rs`).

## Criterion 1 — raw mode and the alternate screen restored on startup, exit and panic

| command | observed |
| --- | --- |
| `cargo test --test smoke restore` | `4 passed` — `panic_restores_terminal`, `exit_signals_restore_the_terminal`, `shell_job_control_restores_the_terminal_and_preserves_the_draft` (plus `recall_restores_an_elided_tool_output`, unrelated to this criterion) |

The panic and signal cases assert the leave-alternate-screen sequence
(`\x1b[?1049l`) reaches the pty, which is the observable half of "restored cleanly": a
terminal left in raw mode keeps the sequence from being printed at all.

## Criterion 2 — redraw, suspension/resumption, window title

| behaviour | command | observed |
| --- | --- | --- |
| suspension and resumption | `cargo test --test smoke shell_job_control` | `1 passed` — the draft survives the round trip |
| window title toggle, its persistence and the environment override | `cargo test --test smoke terminal_title` | `1 passed` — `terminal_title_toggle_persists_across_restart_and_an_environment_disable_wins` |
| title payload safety | `cargo test --lib terminal_title::` | `6 passed` — a control sequence cannot terminate or inject a title, and a long title is cut to what a tab strip shows |

**Not evidenced:** no case asserts a screen-clearing redraw (a full clear instead of a
differential update) as its subject; the frame tests in `scroll_frames` cover windowing,
not clearing.

## Criterion 3 — real-world terminal matrix

**Not accepted.** tmux, SSH, Windows Terminal and carriage-return-only pasting are not
exercised. `multiline_paste_reaches_the_engine_verbatim` (`1 passed`) proves a multi-line
paste arrives verbatim, which is the CR/LF-adjacent case, but it is not a
carriage-return-only terminal test and it does not run under tmux or over SSH.

Result: criterion 1 **accepted**; criterion 2 accepted for suspension/resumption and the
title toggle, with clearing redraws open; criterion 3 open.
