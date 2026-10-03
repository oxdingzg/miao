# Changelog

All notable changes to **miao** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and miao adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tagged `vX.Y.Z`. GitHub release notes are generated from Conventional
Commits by `script/changelog.ts`; run `bun script/changelog.ts --version X.Y.Z --write`
to add a section here.

## [Unreleased]

### Removed

- **core**: the V1 session runtime (`packages/miao/src/session`), the legacy tools
  (`packages/miao/src/tool`), and the `/session/*`, `/permission/*`, `/question/*`, and `/sync/*`
  routes. Every shipped client now runs V2. The migration readers (`miao db backfill` / `compact` /
  `restore`) and old-shape config reading remain.
- **miao**: the `miao github` command; use `miao pr`.

### Changed

- **core**: the OS sandbox for `bash` is part of the V2 tool, opt-in through `sandbox` config or
  `MIAO_SANDBOX=1`.

## [0.0.15] - 2026-09-30

Published release: [v0.0.15](https://github.com/oxdingzg/miao/releases/tag/v0.0.15).

### Fixed

- **core**: generate OpenAI reasoning variants from inherited provider APIs, resolve standard variants during startup, route ChatGPT OAuth through Codex, and persist model resolution failures in the conversation.
- **core**: refresh cached assistant history when durable events update reply text or completion state.

- **tui**: switching away from a custom question answer restores Enter and Esc; failed replies and dismissals display an error.
- **server**: load the embedded web UI using the generated miao asset module name.
- **build**: root package.json is the single version source for builds, source runtime, and synchronized workspace manifests; inconsistent overrides fail before building.

### Added

- **core**: prompt-cache telemetry now reports `warm`, `expectedRebuild`, and `cacheMiss` per turn; `cache.ttl_seconds` can extend the prompt-cache TTL.
- **core**: opt-in per-session cost budget (`cost.budget_usd`) that warns and stops scheduling further turns once exceeded.
- **core**: opt-in tool-output pruning (`compaction.prune`) that clears older tool results from provider requests only.

### Changed

- **core**: compaction summaries use the session model by default again; the cheap model is opt-in via `compaction.summarize_small`.
- **core**: the native edit/patch paths are on by default; set `MIAO_NATIVE=0` to fall back to the TypeScript implementations.

### Internal

- **native (PoC; edit/patch wired on by default, the rest not wired)**: added `gitRevParse` / `gitBlob` / `gitWorktreeChanges` / `gitMergeBase` / `gitDiff`, line-ending detection and normalization, BPE token counting (o200k/cl100k), `.gitignore`-aware file walking, sha256/blake3 hashing, shell command analysis (bash/powershell via native tree-sitter), and Linux landlock sandbox enforcement (write allowlist + TCP denied by default). Each ships with Rust unit tests and JS parity tests (`gitDiff` is verified by a `git apply` round-trip).

## [0.0.12] - 2026-09-29

Published release: [v0.0.12](https://github.com/oxdingzg/miao/releases/tag/v0.0.12). Release notes for 0.0.5–0.0.12 are available on GitHub.

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
