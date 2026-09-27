# Changelog

All notable changes to **miao** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and miao adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tagged `vX.Y.Z`. GitHub release notes are generated from Conventional
Commits by `script/changelog.ts`; run `bun script/changelog.ts --version X.Y.Z --write`
to add a section here.

## [Unreleased]

### Added

- **core**: prompt-cache telemetry now reports `warm`, `expectedRebuild`, and `cacheMiss` per turn; `cache.ttl_seconds` can extend the prompt-cache TTL.
- **core**: opt-in per-session cost budget (`cost.budget_usd`) that warns and stops scheduling further turns once exceeded.
- **core**: opt-in tool-output pruning (`compaction.prune`) that clears older tool results from provider requests only.

### Changed

- **core**: compaction summaries use the session model by default again; the cheap model is opt-in via `compaction.summarize_small`.

### Internal

- **native (PoC, opt-in, not in production)**: added `gitRevParse` / `gitBlob` / `gitWorktreeChanges` / `gitMergeBase` / `gitDiff`, line-ending detection and normalization, BPE token counting (o200k/cl100k), `.gitignore`-aware file walking, and sha256/blake3 hashing. Each ships with Rust unit tests and JS parity tests (`gitDiff` is verified by a `git apply` round-trip).

## [0.0.4] - 2026-09-27

### Added

- **core**: per-turn TTFT and prompt-cache hit-rate telemetry; the TUI sidebar now shows `NN% cached`.
- **core**: experimental Code Mode behind `MIAO_EXPERIMENTAL_CODE_MODE` — the tool set collapses behind one `execute` tool with a budgeted catalog.
- **core**: opt-in hot-prefix compaction (`compaction.hot_prefix`) that reuses the warm prompt-cache prefix for summaries.
- **core**: opt-in BPE token counting (`compaction.precise_tokens`) for accurate compaction thresholds.
- **tui**: `/currency` cost display toggle; the choice is persisted and defaults to USD.
- **currency**: providers can declare native prices and a `currency` so displayed cost matches the provider's real bill.

### Changed

- **core**: compaction summaries run on the catalog's cheap model when they fit, falling back to the session model.
- **tui**: the model picker lists configured/paid providers before free models.

### Fixed

- **core**: V2 sessions now compute real cost and usage totals instead of `cost: 0`.
- **core**: V2 credentials are seeded from the legacy `auth.json`, so already-connected providers are no longer re-prompted.
- **install**: local builds install as `miao-preview` without shadowing the release-managed `miao`.

## [0.0.3] - 2026-09-27

### Changed

- **install**: warm gradient banner with a `NO_COLOR`/non-TTY fallback.

### Fixed

- **tui**: exit banner matches the installer cat + MIAO wordmark.
- **install**: MIAO wordmark is drawn as solid block letters.

## [0.0.2] - 2026-09-27

### Added

- **upgrade**: background auto-update with a non-blocking "restart to apply" notice.

### Changed

- **release**: add `darwin-x64` and Windows `.exe` install support, plus the VT verification checklist.

## [0.0.1] - 2026-09-27

### Added

- Initial miao release, forked from opencode: independent versioning and update source (`oxdingzg/miao`), rebrand, and the `install` script.
- **native** (PoC, opt-in): the `miao-native` addon with the landlock sandbox backend.
