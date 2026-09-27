# miao versioning and release

**Language:** [English](release.en.md) | [中文](release.zh.md)

## Version scheme

- miao uses its **own versioning**, starting at `0.0.1`, semver, Git tag `vX.Y.Z`.
- The **source of truth** is the latest GitHub release tag of `oxdingzg/miao`; the next version is that tag bumped (patch/minor/major) in `packages/script/src/index.ts`.
- **Dev/preview builds** look like `0.0.1-<channel>-<timestamp>` (channel is the branch name) and are **never released**; `Installation.isPreview()` is true for them, so they skip the self-update check.
- **Release builds** use channel `latest`; the version is the release tag, embedded at build time via `MIAO_VERSION`, so `miao --version` reports it.
- The `version` in `packages/*/package.json` is only an in-repo placeholder (currently `0.0.1`). Before releasing you can sync every package with `bun script/set-version.ts <version>` and then `bun install --lockfile-only` (recommended, not required: the artifact version comes from the release tag).

## Release process

1. **Make sure main is green**: `bun typecheck`, the relevant `bun test` suites, and the native CI `.github/workflows/native.yml`.
2. **Trigger**: `./script/release patch` (or `minor` / `major`), equivalent to `gh workflow run release.yml -f bump=patch`. You can also dispatch from the Actions UI with an explicit version.
3. **Workflow `.github/workflows/release.yml`**:
   - `version`: runs `script/version.ts`, bumps from the latest release tag, creates a **draft** release `vX.Y.Z`, and outputs `version/release/tag/repo`.
   - `cli`: matrix `macos-14`(arm64) / `macos-13`(x64) / `ubuntu-latest`(x64) / `ubuntu-24.04-arm`(arm64) / `windows-2025`(x64). Each platform runs `bun install` + installs Rust, then `packages/miao/script/build.ts --single` builds the host binary (building and embedding the host native addon first) and uploads `miao-<target>.zip|tar.gz` to the draft release.
   - `publish`: after all platforms succeed, `gh release edit --draft=false` publishes the release.
4. **Assets**: `miao-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}.{zip,tar.gz}`, matching the `install` script and the updater (`Installation.latest` -> `oxdingzg/miao/releases/latest`).

## Changelog

- `CHANGELOG.md` at the repo root is the **browsable version history** (Keep a Changelog format), with a new section per release.
- GitHub release notes are generated **deterministically** from Conventional Commits by `script/changelog.ts` (no LLM / `opencode` CLI): `feat -> Added`, `fix`/`revert -> Fixed`, `perf -> Performance`, `refactor -> Changed`; `chore`/`ci`/`test`/`docs`/`style`/`build` are skipped.
- Preview and write:
  - Preview a range: `bun script/changelog.ts --from <previous> --to HEAD --version <x.y.z> --print`
  - Write into `CHANGELOG.md`: add `--write`
  - At release time `script/version.ts` calls it with `--to <sha>` to produce `UPCOMING_CHANGELOG.md`, which becomes the release notes.

## Pre-release checklist

- [ ] Windows real-machine VT verification: PowerShell 5.1 legacy console / Windows Terminal / pwsh 7 (the logic is only verified on macOS so far).
- [ ] `curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash` installs that release.
- [ ] `miao upgrade` and the startup update check point at `oxdingzg/miao` and detect the new version.
- [ ] Native paths are off by default (no `MIAO_NATIVE` -> pure TS), so a release is not affected by the open native PoC risks.
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
