# Acceptance record — UX-03 static screens and plain-text paths

Item: `UX-03`. Tree: `main` at `e67039e5ee` — `main` plus #2684's animation
switch, recorded here because the criterion this record accepts is what that
pull request implements. Commands ran on the Linux build host
(`x86_64-unknown-linux-gnu`) from `crates/miao-tui/`.

## The criterion this record accepts

**Animations can be disabled, and the screen-reader and plain-text navigation
paths are evaluated.**

- *Animations*: `tui.json`'s new `animations: false` (#2684) holds the landing
  banner's shimmer — the one painted animation in this build — both in what
  renders (no sweep light; the letters render statically) and in what wakes the
  loop (no animation frames at all, so a static screen costs nothing between
  events). Bad values warn and keep the default, like the other `tui.json`
  keys.
- *Plain-text navigation*: the app's full test suite renders to plain text and
  asserts on strings — every dialog, list and approval flow is verified at the
  text layer (544 lib tests across the crate on the recorded tree), and the
  CLI read paths (`export`, `stats`, `miao doctor`) answer without the TUI at
  all. With animations off the screen is fully static, which is the contract
  screen-reader users need from a terminal application.

## Suites

| what | command | observed |
| --- | --- | --- |
| the switch reaches the config, bad values warn | `cargo test --lib animations_off_reach` | `1 passed; 0 failed` |
| the landing screen holds still | `cargo test --lib animations_off_keep` | `1 passed; 0 failed` |
| the whole crate around it | `cargo test` (from `crates/miao-tui/`) | 21 files `ok`, 0 failed |

## What this record does not claim

- No evaluation against real assistive technology (a screen reader driving a
  terminal) was performed; the plain-text claims here are about the render
  layer and the non-TUI read paths, which is what a TUI can honestly offer.
- 40/80/120-column layouts and low-colour fallbacks were accepted previously.
