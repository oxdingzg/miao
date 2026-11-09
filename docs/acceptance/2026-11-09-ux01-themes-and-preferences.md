# Acceptance record — UX-01 theme modes and persisted preferences

Item: `UX-01`. Tree: the head of `feat/ux01-themes-prefs` (rebased on `main`
2026-11-09; the assets port plus its pins land through PR #2781). The commands
below are the cargo invocations the pull request's CI workflow runs on
ubuntu-24.04 from the crate directory on this recorded tree; the observed cells
cite that run (run 42673535003, green after one infra rerun for an abandoned
unit call), and a Linux build-host run cross-checks them when the host is idle.

## Criterion 1 — complete built-in and custom themes with light, dark, and locked mode selection

The hand-written catalog (~1600 lines) is replaced by the TypeScript host's 34
`assets/*.json` files carried verbatim with `include_str!`; every palette
resolves under the operator's pinned mode, and custom `themes/*.json` files
overlay built-ins in place.

| command | observed |
| --- | --- |
| `cargo test --lib every_builtin_resolves_under_both_modes_without_warnings` | ok — all 34 assets resolve under Dark and Light with an empty warning list |
| `cargo test --lib pinning_light_recolours_the_built_in_catalog` | ok — both modes ship the same menu; the default theme recolours under a pinned Light catalog |
| `cargo test --lib a_pinned_light_mode_recolours_the_default_theme_on_reload` | ok — the persisted mode lock recolours the default theme on reload, and clearing it returns to Dark |
| `cargo test --lib every_typescript_theme_is_available` | ok (pre-existing coverage, carried) |

## Criterion 2 — consistency across the config chains, JSONC parsing, leader_timeout, and input dimensions

Carried coverage pins the chain and parser behaviour; the assets port does not
touch it.

| command | observed |
| --- | --- |
| `cargo test --lib jsonc` | ok — comments, commas, source positions, unterminated comments (five pins) |
| `cargo test --lib merge_selects_theme_and_reports_unknown_fields` | ok |
| `cargo test --lib broken_config_is_skipped_not_fatal` | ok |

## Criterion 3 — preferences persist across restarts; diagnostics for unknown keys

| command | observed |
| --- | --- |
| `cargo test --lib the_mode_lock_roundtrips_and_an_unknown_lock_falls_back_to_dark` | ok — the lock persists through the state dir, an unknown lock warns and falls back to Dark |
| `cargo test --lib theme_and_config_read_one_chain` | ok (pre-existing coverage, carried) |

## Full-suite result

| command | observed |
| --- | --- |
| `cargo test --lib` (tui leg of CI run 42673535003) | ok — 575+ lib tests, 0 failed |
| `cargo test --tests` (cli leg of the same run) | ok |

## Criterion 4 — link the implementation PRs, acceptance records, and target versions

- Implementation: #2781 (the assets port, the mode-resolving catalog, and the
  pins; the earlier preferences groundwork landed through the UX-01 WIP commit
  this branch carried).
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** terminal auto-detection (a luma probe or OSC
query picking light/dark automatically — the TS host had it through
`renderer.themeMode`) stays open; the real-client visual pass over the 34
themes in real terminals stays open; six themes are authored with one
background across modes and intentionally do not change when pinned.
