# Acceptance record — INP-05 the IDE context is visible and editable in the composer

Item: `INP-05`, closing the criterion `2026-11-01-inp05.md` recorded as
**Not accepted — the claim was wrong**: the Zed selection was prepended inside
`submit`, so the operator never saw it before sending and could not remove it
by editing. Tree: `1ba5bce210` (branch `fix/inp05-visible-context`). Commands
ran from `crates/miao-tui/` on the Linux build host (`cargo 1.99.1`, debug
profile). A reviewer runs the same commands from the same directory anywhere.

## What changed

`App::zed_selection_key` became `zed_context: Option<(key, prefix)>` plus a
`zed_probe` field carrying the probe: every keystroke first probes Zed
(throttled to once per 500 ms) and drops the selection's context into the
composer draft, where it is ordinary text the operator reads, edits, or
deletes before sending. `submit` attaches the selection only for a flow that
never met the keyboard (a startup prompt, the editor's return), and a draft
still carrying the prefix it supersedes swaps it — a changed selection
replaces its own text instead of stacking a second reminder, and a removed
one stays removed.

## The criteria this record accepts

**Allow users to inspect and remove automatically attached context; prevent
draft loss and duplicate injection across editor failure.**

| criterion | command | observed |
| --- | --- | --- |
| the selection sits in the composer before sending, and the wire carries the draft as it stands, once | `cargo test --lib the_zed_selection_sits_in_the_composer` | 1 passed — the draft gains `<system-reminder>` `#12` around the typed text, `submit` admits exactly that text, and the prompt counts one `<system-reminder>` |
| deleting the context keeps it deleted; the same selection is not re-attached behind the operator's back | `cargo test --lib deleting_the_context_keeps_it_deleted` | 1 passed — after the reminder is deleted, the re-probe leaves the draft alone and the request carries no `<system-reminder>` |
| a changed selection replaces the context it supersedes instead of stacking | `cargo test --lib a_changed_selection_replaces_the_context` | 1 passed — after `#12` then `#30`, the draft holds one `<system-reminder>` and it names `#30` |
| a Zed failure (no terminal, no database, missing sqlite3) leaves the draft alone and sends it unchanged | `cargo test --lib a_zed_failure_leaves_the_draft` | 1 passed — the probe answers `None`, the draft neither gains a reminder nor loses a byte, and the request equals the draft |
| a slash draft is a command and carries no context | `cargo test --lib a_slash_draft_does_not_carry` | 1 passed |
| a flow that never met the keyboard (a startup prompt) still attaches the selection once | `cargo test --lib a_startup_prompt_still_carries` | 1 passed — the admitted prompt counts exactly one `<system-reminder>` |
| the whole crate around it | `cargo test --lib` | 561 passed; 0 failed |
| the suites the older INP-05 record cites still hold | `cargo test --lib zed`, `cargo test --lib editor` | 11 passed; 0 failed and 52 passed; 0 failed |
| the pre-key probe does not tax the keystroke (the INP gate) | `cargo test --test input_latency` | 5 passed; 0 failed; 1 ignored (the 20k-message fold runs only with `--ignored`) |

## What this record does not claim

- No live Zed was driven: the six tests feed a fixture probe instead of the
  operator's Zed database. A real Zed session — the context appearing in the
  composer while typing in Zed beside the TUI — is the product-acceptance
  step and stays open; with the target-version line it is why the pull
  request references #1981 rather than closing it.
- The probe reads Zed's database through the sqlite3 CLI. The failure test
  covers the CLI's absence as "no selection", but no test here installs a
  fake database to exercise the parse of a real one; that formation remains
  the `platform::zed` suite cited by the 2026-11-01 record.
- Windows unexercised, as before.
