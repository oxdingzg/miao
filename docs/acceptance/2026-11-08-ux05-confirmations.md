# Acceptance record — UX-05 confirmations match the blast radius

Item: `UX-05`. Tree: `main` at `c13275e9a6` (`#2676`). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that
tree.

## The criterion this record accepts

**Common reversible actions do not confirm redundantly, and destructive
operations show their true blast radius.**

- Reversible actions run without a confirmation: undo previews the newest user
  turn before rewinding it and waits for a running turn to stop instead of
  asking; redo, stash restore, rename and tag follow the same no-question path.
  The undo/redo ledger itself is the safety net.
- Destructive operations ask with the blast radius in hand: the worktree
  remove dialog names what is deleted and moves Sessions still working there
  back to the checkout; session delete goes through its own confirmation; a
  lapsed escape confirmation asks again rather than silently firing.

## Suites

| what | command | observed |
| --- | --- | --- |
| destructive asks carry the blast radius | `cargo test --lib a_destructive_action_asks_with_the_blast_radius_in_hand` (from `crates/miao-tui/`) | `1 passed; 0 failed` |
| reversible undo runs without a redundant question | `cargo test --lib undo_previews_the_newest_user_turn undo_waits_for_the_running_turn_to_stop` | both `1 passed; 0 failed` |
| confirmations cannot fire stale or unconfirmed | `cargo test --lib a_lapsed_escape_confirmation_asks_again the_session_dialog_reaches_rename_and_delete_confirmation` | both `1 passed; 0 failed` |

## What this record does not claim

- Screen-reader and plain-text navigation paths belong to UX-03, not here.
- Windows unexercised, as before.
