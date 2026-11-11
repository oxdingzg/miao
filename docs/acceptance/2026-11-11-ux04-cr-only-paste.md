# Acceptance record — UX-04 a carriage-return-only paste stays a draft

Item: `UX-04` (#1993). Tree: the pull-request head for branch `test/ux04-cr-paste`,
parent `origin/main` `c281de84dc`. Commands ran on the Linux build host `xx04` from
`crates/miao-tui`, `cargo 1.99.1`.

The item's third criterion asks for validation "across tmux, SSH, Windows Terminal, and
**carriage-return-only pasting**". `2026-11-11-ux04-terminal-matrix.md` measured the tmux
and SSH legs. This is the paste leg. It does not close the item: three legs remain, named
at the end.

## What already existed

`crates/miao-tui/src/editor.rs`'s `normalize_paste` maps `\r\n` and a bare `\r` to `\n`
before anything reaches the composer, and a test pinned the mapping
(`paste_normalizes_crlf_and_cr`: `"a\r\nb\rc"` reads `"a\nb\nc"`). What was missing is the
half that matters to an operator: a paste — of any shape — must never *submit*. A prompt
that arrived as a paste would start a turn before the text was read.

## What this tree adds

Two application-level pins, because the editor's own test says how text is normalized but
not what the app does with a paste:

| behaviour | command (`crates/miao-tui`) | observed |
| --- | --- | --- |
| a two-line CR paste lands inline as a draft and opens nothing | `cargo test --lib a_paste_with_only_carriage_returns_stays_a_draft` | `ok` — the composer reads `one\ntwo` and no dialog is open |
| a paste past the editor's block threshold becomes a visible marker, still without submitting | the same test | `ok` — three CR-separated lines read `[Pasted ~3 lines]` (the threshold is three lines or 150 characters, the same one the TypeScript prompt used) |
| a CR paste on the landing screen does not create and submit a Session by itself | `cargo test --lib a_carriage_return_paste_on_the_landing_screen_does_not_submit` | `ok` — the draft reads `one\ntwo` and the app is still on the landing screen |
| the paste paths around them are unchanged | `cargo test --lib paste` | `15 passed` |
| the crate around it | `cargo test --lib` | `644 passed; 0 failed` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

## What this record does not claim

- No real terminal delivered the paste: these rows drive `AppEvent::Paste` with the bytes a
  terminal would send. Whether a given terminal sends `\r`, `\n`, or a bracketed paste is
  the terminal's behaviour, and that is what the remaining legs would exercise.
- The Windows Terminal leg is not covered by this file; that leg needs a Windows Terminal
  window (host `96` is a Windows build host reached over SSH, whose ConPTY is not one).

## Still open on this item

- **Windows Terminal**.
- **Suspend/resume from a non-composer focus** (`ctrl+z` in the composer is undo by design,
  so the two attempts recorded earlier proved nothing) and a real-terminal **panic** path.

## Version

No `roadmap:` stamp: this tree is in no published release, and the item is not fully
accepted.
