# Acceptance record — MEDIA-03 attention is configurable end to end

Item: `MEDIA-03`. Tree: `main` at `c13275e9a6` (`#2676`). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that
tree.

## The criterion this record accepts

**Volume, mute states, system permissions and fallback mechanisms are fully
configurable.** `AttentionConfig` (`crates/miao-tui/src/config.rs`) carries the
master `enabled` mute plus separate `notifications` and `sound` mutes, a
`volume` clamped to `[0, 1]` and applied to the player (`afplay -v` on macOS),
and a `sound_pack` with a per-event `sounds` map whose relative paths resolve
against the config file that named them. Every field is settable from the
config file and from `/config` (`attention.enabled` / `.notifications` /
`.sound` / `.volume` / `.sound_pack` / `.sounds`).

The fallback chain lives in `crates/miao-tui/src/platform/attention.rs`: a
missing or failed sound file rings the terminal bell instead of going silent; a
notification that cannot be emitted reports `false` in `Notified` rather than
claiming success; and notifications are emitted only while the TUI is blurred,
so a focused terminal is never interrupted (the already-accepted
foreground/background criterion). Permission is a fact of the OS, not a knob:
the code treats an emission failure as the fallback signal, which is the honest
contract a terminal application can offer.

## Suites

| what | command | observed |
| --- | --- | --- |
| the attention module: kinds, focus suppression, bell fallback, volume | `cargo test --lib platform::attention` (from `crates/miao-tui/`) | `7 passed; 0 failed` |
| the config merge: every attention field, relative sound resolution | `cargo test --lib config` (29 tests, including `attention_fields_merge_and_sounds_resolve_relative_to_the_file`) | `29 passed; 0 failed` |

## What this record does not claim

- Event kinds done/error/question/permission/subagent_done and the
  foreground-suppression rule were accepted previously; this record re-runs
  their suites on the recorded tree.
- Windows unexercised, as before.
