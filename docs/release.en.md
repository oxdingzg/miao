# miao versioning and release

**Language:** [English](release.en.md) | [中文](release.zh.md)

## Version scheme

- miao uses its **own versioning**, starting at `0.0.1`, semver, Git tag `vX.Y.Z`.
- **The root `package.json` `version` is the single source of truth.** `bun script/set-version.ts X.Y.Z` updates it and synchronizes every workspace `package.json`; run it without an argument to only synchronize. Builds and source runs read that version; `MIAO_VERSION` may only assert the same value, and automatic bumps or timestamp versions are not supported.
- **The channel decides whether a build is a release**: release builds use channel `latest`. Every other build (`local` for `miao-dev`, the branch name for `miao-preview`) is a preview: `Installation.isPreview()` is true, it skips the self-update check, and it keeps its own database file.
- Release builds use `miao.db`; preview builds use `miao-<channel>.db`.
- `CHANGELOG.md` and GitHub releases record publication history; they are not the source of the current development version.

## Release process

1. **Make sure main is green**: `bun typecheck`, the relevant `bun test` suites, and the native CI `.github/workflows/native.yml`. Build and smoke-test `miao-preview` with `./script/install-local.sh` before releasing.
2. **Trigger**: on a clean main, run `./script/release X.Y.Z`. It runs `bun script/set-version.ts X.Y.Z`, commits `chore: release X.Y.Z`, pushes, then runs `gh workflow run release.yml --ref main`. The workflow takes **no inputs**; the version comes entirely from the root `package.json`, including when dispatched from the Actions UI.
3. **Workflow `.github/workflows/release.yml`**:
   - `version`: runs `script/version.ts`, creates a **draft** release `vX.Y.Z` for the root `package.json` version with generated release notes, and outputs `version/release/tag/repo`.
   - `cli`: matrix `macos-26`(darwin-arm64) / `macos-26-intel`(darwin-x64) / `ubuntu-latest`(linux-x64) / `ubuntu-24.04-arm`(linux-arm64) / `windows-2025`(windows-x64). Each platform runs `bun install` + installs Rust, then `packages/miao/script/build.ts --single` builds the host binary (building and embedding the host native addon first) and uploads `miao-<target>.zip|tar.gz` to the draft release.
   - `publish`: after all platforms succeed, it appends the Windows signing status to the release body and runs `gh release edit --draft=false` to publish the release.
4. **Assets**: `miao-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}.{zip,tar.gz}`, matching the `install` script and the updater (`Installation.latest` -> `oxdingzg/miao/releases/latest`).

The release workflow above is the maintained publication path. Each build loads the model catalog through `packages/miao/script/generate.ts` from `https://models.dev/api.json`, or from a local file selected by `MODELS_DEV_API_JSON`. There is no separate workflow that commits model snapshots to the repository; the runtime refreshes its cached catalog independently.

Windows binaries are currently unsigned. The `publish` step records this status on the download page.

## Changelog

- `CHANGELOG.md` at the repo root is the **browsable version history** (Keep a Changelog format), with a new section per release.
- GitHub release notes are generated **deterministically** from Conventional Commits by `script/changelog.ts` (no LLM / `opencode` CLI): `feat -> Added`, `fix`/`revert -> Fixed`, `perf -> Performance`, `refactor -> Changed`; `chore`/`ci`/`test`/`docs`/`style`/`build` are skipped.
- Preview and write:
  - Preview a range: `bun script/changelog.ts --from <previous> --to HEAD --version <x.y.z> --print`
  - Write into `CHANGELOG.md`: add `--write`
  - At release time `script/version.ts` calls it with `--to <sha>` to produce `UPCOMING_CHANGELOG.md`, which becomes the release notes.
- Release notes are **English and always link to a Simplified Chinese mirror**:
  `docs/releases/<tag>.zh.md`, linked as `[简体中文](…)` under the first
  heading. Write the mirror before dispatching a release — `script/release-notes.ts`
  fails the publish job when it is missing. The same rule applies to every miao
  project, including `miao-term`.

## Pre-release checklist

- [ ] `docs/releases/<x.y.z>.zh.md` exists: the Simplified Chinese mirror the release body links to.
- [ ] Windows real-machine VT verification: PowerShell 5.1 legacy console / Windows Terminal / pwsh 7 (the logic is only verified on macOS so far).
- [ ] `curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash` installs that release.
- [ ] `miao upgrade` and the startup update check point at `oxdingzg/miao` and detect the new version.
- [ ] Native addon: confirm the built addon loads on each platform and `MIAO_NATIVE=0` falls back, so the OS sandbox runner and the other native helpers are not affected by the open native PoC risks.
- [ ] No credentials/secrets committed; no `auth.json` / `.env` in the artifact.
- [ ] LICENSE and attribution (based on opencode, MIT).
- [ ] Version matches in all three places: git tag, GitHub release, binary `miao --version`.

## Rollback

- Delete and redo: `gh release delete vX.Y.Z`, then dispatch again.
- Local rollback to the previous preview build: `ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`.

## Known limitations

- Only gnu linux + mainstream mac/win; musl / baseline / windows-arm64 are not produced yet.
- The native addon is **not cross-compiled**: each platform builds it on its own runner.
- Publishing is a production action: per this repo's rules it requires **explicit confirmation** before running.
