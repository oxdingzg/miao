# Acceptance record — INP-07 keybinding conflicts across modes

Item: `INP-07`. Tree: `main` at `c13275e9a6` (`#2676`). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that
tree.

## The criterion this record accepts

**Keybinding conflicts are eliminated across global, input, completion, dialog
and approval modes.** The default keymap builds a stroke → action ownership
table and asserts that the only strokes reaching two actions are the four
documented dual-purpose pairs — `ctrl+c` (clear a draft in the composer / quit
outside it), `ctrl+d` (delete forward / quit), `up` and `down` (walk prompt
history / move inside a multi-line draft). A new accidental overlap fails the
test instead of an operator's hands. A separate regression pins that a `super`
chord no longer claims the bare letter (typing a word with a `z` used to undo
the run).

Completion, dialog and approval surfaces route their keys through their own
handlers rather than user bindings, so the bindable surface is exactly the one
the ownership table covers; the help and which-key listings stay synchronized
with these bindings (the sibling criterion already accepted, #2651's live-chord
rendering included).

## Suites

| what | command | observed |
| --- | --- | --- |
| the only shared strokes are the documented dual-purpose ones | `cargo test --lib the_only_shared_strokes` (from `crates/miao-tui/`) | `1 passed; 0 failed` |
| a super chord does not claim the bare key | `cargo test --lib a_super_chord` | `1 passed; 0 failed` |

## What this record does not claim

- A user-authored keymap can still bind one stroke twice; the elimination is of
  conflicts in the shipped default, and the test is the guard that keeps it
  that way.
- Windows unexercised, as before.
